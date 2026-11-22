// Transport indépendant, fondé sur l'aide locale de Codex. Aucun code tiers.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve, extname, delimiter } from 'node:path';
import { scrubProjectedPrompt, withoutStructuredIds, scrubContacts } from './catalog-privacy.js';
import { containsPii } from './integrations-core.js';
import { findSecret } from './memory-core.js';

export class EngineError extends Error {
  constructor(code, message) { super(message); this.name = 'EngineError'; this.code = code; this.engine = 'codex'; }
}
const error = (code, message) => new EngineError(code, message);
export const UNKNOWN_QUOTA = Object.freeze({ state: 'unknown', label: 'quota inconnu' });
export function codexContext(value) {
  const text = scrubProjectedPrompt(value);
  if (containsPii(withoutStructuredIds(text)) || findSecret(text)) throw error('privacy', 'Donnée sensible résiduelle : aucun contexte envoyé à Codex.');
  return text;
}

// Aucun héritage implicite, notamment PATH, proxy, clés API et NODE_OPTIONS.
// CODEX_HOME est seulement un chemin : les identifiants existants ne sont jamais ouverts ici.
export function filteredEnvironment(source, home) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE']) if (source[name]) env[name] = source[name];
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
    CODEX_HOME: source.CODEX_HOME || join(homedir(), '.codex') };
}

// Les shims npm sont lus comme des données : cmd.exe / powershell ne sont jamais exécutés.
export function resolveCodex(executable = 'codex', source = process.env) {
  let file = executable;
  if (!/[\\/]/.test(file)) {
    const dirs = (source.PATH || source.Path || '').split(delimiter).filter(Boolean);
    const names = process.platform === 'win32' ? [`${file}.exe`, `${file}.cmd`, file] : [file];
    file = dirs.flatMap(d => names.map(n => join(d, n))).find(p => existsSync(p));
  }
  if (!file || !existsSync(file)) throw error('unavailable', 'Codex CLI est introuvable sur ce PC. Aucun autre moteur ne sera utilisé.');
  file = resolve(file);
  if (extname(file).toLowerCase() === '.cmd') {
    const shim = readFileSync(file, 'utf8');
    const npm = /"%dp0%[\\/]([^"\r\n]+\.js)"\s+%\*/i.exec(shim);
    const simple = /^@?"[^"\r\n]+node(?:\.exe)?"\s+"%~dp0([^"\r\n]+\.(?:cjs|js))"\s+%\*\s*$/i.exec(shim.trim());
    const entry = npm?.[1] ?? simple?.[1];
    if (!entry) throw error('unavailable', 'Shim codex.cmd non reconnu : lancement sans shell impossible.');
    const script = resolve(dirname(file), entry);
    if (!existsSync(script)) throw error('unavailable', 'Le point d’entrée du shim Codex est introuvable.');
    return { file: process.execPath, args: [script] };
  }
  if (['.ps1', '.bat'].includes(extname(file).toLowerCase())) throw error('unavailable', 'Codex nécessite un exécutable natif ou un shim npm reconnu.');
  return { file, args: [] };
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise((done, reject) => {
      const env = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', env });
      killer.on('error', () => reject(error('isolation', 'Impossible d’arrêter l’arbre de processus Codex.')));
      killer.on('close', code => code === 0 || child.exitCode !== null ? done() : reject(error('isolation', 'Arrêt de l’arbre Codex non confirmé.')));
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw error('isolation', 'Arrêt de l’arbre Codex non confirmé.'); }
  }
}

// Borne le flux entier (y compris les lignes invalides), pas seulement le dernier message.
function execute(command, args, { cwd, env, input = '', signal, timeoutMs = 15_000, maxBytes = 1_000_000, onChunk } = {}) {
  return new Promise((done, reject) => {
    if (signal?.aborted) return reject(error('cancelled', 'Exécution Codex annulée.'));
    let child;
    try { child = spawn(command.file, [...command.args, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return reject(error('unavailable', 'Impossible de lancer Codex CLI.')); }
    let stdout = '', stderr = '', bytes = 0, failure = null, stopping = null;
    const stop = e => { if (failure) return; failure = e; stopping = killTree(child).catch(e => { failure = e; }); };
    const abort = () => stop(error('cancelled', 'Exécution Codex annulée.'));
    const timer = setTimeout(() => stop(error('timeout', 'Codex n’a pas répondu dans le délai autorisé.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return stop(error('output_limit', 'Sortie Codex trop volumineuse : exécution arrêtée.'));
      if (failure) return;
      if (!onChunk) stdout += chunk;
      else try { onChunk(chunk); } catch (e) { stop(e); }
    });
    child.stderr.on('data', chunk => { bytes += Buffer.byteLength(chunk); stderr = (stderr + chunk).slice(-4000); if (bytes > maxBytes) stop(error('output_limit', 'Sortie Codex trop volumineuse : exécution arrêtée.')); });
    child.on('error', () => { failure ??= error('unavailable', 'Codex CLI est indisponible sur ce PC.'); });
    child.on('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stopping) await stopping;
      failure ? reject(failure) : done({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function detectCodex({ command, executable, source = process.env, signal, timeoutMs = 15_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archipel-codex-probe-'));
  const deadline = Date.now() + timeoutMs;
  try {
    command ??= resolveCodex(executable, source);
    const env = filteredEnvironment(source, root);
    const probe = args => execute(command, args, { cwd: root, env, signal, timeoutMs: Math.max(1, deadline - Date.now()) });
    const version = await probe(['--version']);
    const help = await probe(['exec', '--help']);
    if (version.code !== 0 || help.code !== 0) throw error('unavailable', 'La détection du CLI Codex a échoué.');
    const required = ['--json', '--sandbox', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--config', '--cd'];
    const flags = required.filter(flag => new RegExp(`${flag}\\b`).test(help.stdout));
    const missing = required.filter(flag => !flags.includes(flag));
    if (!/\bread-only\b/.test(help.stdout)) missing.push('sandbox read-only');
    // Aucune option de l'aide officielle constatée ne garantit l'absence de TOUS les outils.
    // Une nouvelle version ne suffit pas : il faudra documenter et tester une capacité officielle.
    missing.push('absence de tous les outils garantie', 'réseau des outils interdit', 'instructions et hooks locaux désactivés', 'authentification ChatGPT imposée sans clé API');
    return { available: true, safe: false, version: scrubContacts(version.stdout.trim()).slice(0, 100), flags, missing, quota: UNKNOWN_QUOTA };
  } catch (e) {
    if (e.code === 'cancelled' || e.code === 'timeout') throw e;
    return { available: false, safe: false, version: null, flags: [], missing: [e.message], quota: UNKNOWN_QUOTA };
  }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function protocolError(message) {
  if (/not logged in|authenticat|credential|401|login/i.test(message)) return error('auth', 'Codex CLI n’est pas connecté avec l’abonnement ChatGPT sur ce PC. Reconnectez-le dans un terminal.');
  if (/rate.?limit|usage limit|429|quota/i.test(message)) return error('quota', 'Limite d’utilisation Codex atteinte ; quota de l’abonnement inconnu. Réessayez plus tard.');
  return error('protocol', 'Codex n’a pas fourni de résultat exploitable.');
}

// Bas niveau : testé uniquement contre un faux exécutable. Ne constitue PAS une autorisation d'exécution.
// Le seul point d'entrée de production est runCodex, qui refuse tant que l'isolation n'est pas démontrée.
export async function codexTransport({ command, executable, source = process.env, system = '', prompt = '', signal, timeoutMs = 180_000, maxTokens = null, onEvent, onText } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archipel-codex-'));
  const cwd = join(root, 'work'), home = join(root, 'home'); mkdirSync(cwd); mkdirSync(home);
  try {
    command ??= resolveCodex(executable, source);
    const input = codexContext(`${system}\n\n${prompt}`);
    let buffer = '', text = '', usage = null, completed = false, failed = null;
    const emit = event => { try { onEvent?.(event); } catch { /* observation seulement */ } };
    const parse = line => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'error' || ev.type === 'turn.failed') failed = protocolError(String(ev.error?.message ?? ev.message ?? ''));
      if ((ev.type === 'item.started' || ev.type === 'item.completed') && !['agent_message', 'reasoning', 'todo_list'].includes(ev.item?.type)) throw error('isolation', 'Codex a signalé un outil interdit ou inconnu : exécution arrêtée.');
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
      if (ev.type === 'turn.completed') {
        completed = true;
        const u = ev.usage, valid = n => Number.isSafeInteger(n) && n >= 0;
        if (u && valid(u.input_tokens) && valid(u.output_tokens)) {
          usage = { input: u.input_tokens, output: u.output_tokens }; emit({ type: 'usage', engine: 'codex', usage, costUsd: null });
          if (maxTokens !== null && usage.input + usage.output > maxTokens) throw error('budget', 'Seuil de jetons Codex atteint (usage rapporté après exécution).');
        }
      }
    };
    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--cd', cwd,
      '--config', 'approval_policy="never"', '--config', 'web_search="disabled"', '--config', 'project_doc_max_bytes=0', '-'];
    const result = await execute(command, args, { cwd, env: filteredEnvironment(source, home), input, signal, timeoutMs, onChunk(chunk) {
      buffer += chunk; let i;
      while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); parse(line); }
    } });
    if (buffer.trim()) parse(buffer);
    if (failed) throw failed;
    if (result.code !== 0 || !completed || !text.trim()) throw protocolError(result.stderr);
    try { onText?.(text); } catch { /* observation seulement */ }
    emit({ type: 'completed', engine: 'codex' });
    return { text: text.trim(), engine: 'codex', usage, costUsd: null, quota: UNKNOWN_QUOTA };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function runCodex(options = {}) {
  if (options.signal?.aborted) throw error('cancelled', 'Exécution Codex annulée.');
  const caps = await detectCodex(options);
  if (!caps.available) throw error('unavailable', caps.missing.join(' ; '));
  if (!caps.safe) throw error('capability', `Codex bloqué (${caps.version}) : isolation requise non démontrée — ${caps.missing.join(' ; ')}. Aucun repli vers Claude.`);
  return codexTransport(options);
}
