// src/skills.js — bibliothèque de Skills (skills/<nom>/SKILL.md) : lecture, validation, analyse de sécurité,
// estimation du coût en jetons, compatibilité de structure, recommandation. N'exécute jamais rien.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_FILE = 64 * 1024;
const RESERVED = ['anthropic', 'claude'];
const KNOWN_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'version'];
// Champs qui accorderaient des outils, des commandes ou un autre contexte d'exécution : refusés.
const PERMISSION_KEYS = ['allowed-tools', 'tools', 'hooks', 'permissions', 'shell', 'context', 'agent', 'model'];

const normalize = (text) => String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
// Estimation grossière (environ 4 caractères par jeton) : ce n'est pas un comptage réel du modèle.
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);
export const hashText = (text) => createHash('sha256').update(text).digest('hex');

// Lit l'en-tête d'un SKILL.md. Les valeurs simples contenant « : » ou « # » doivent être entre guillemets (YAML).
export function parseSkill(text) {
  const src = normalize(text);
  const m = src.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!m) return { error: 'en-tête --- absent' };
  const head = {}, keys = [], lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const km = line.match(/^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/);
    if (!km) return { error: `ligne d'en-tête illisible : « ${line.trim()} »` };
    const key = km[1];
    let value = (km[2] ?? '').trim();
    if (Object.hasOwn(head, key)) return { error: `clé en double : ${key}` };
    const block = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i]);
    while (block.length && !block.at(-1).trim()) block.pop();
    if (/^[>|][+-]?$/.test(value)) value = block.map((l) => l.trim()).join(value[0] === '>' ? ' ' : '\n').trim();
    else if (!value && block.length) { head[key] = null; keys.push(key); continue; } // bloc imbriqué (metadata, hooks…) : non interprété
    else if (block.length) return { error: `suite inattendue sous « ${key} »` };
    else if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"') || /(?<!\\)"/.test(value.slice(1, -1))) return { error: `guillemets mal fermés dans « ${key} »` };
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'") || /(?<!')'(?!')/.test(value.slice(1, -1))) return { error: `guillemets mal fermés dans « ${key} »` };
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.includes(': ') || value.endsWith(':') || value.includes(' #')) {
      return { error: `la valeur de « ${key} » contient « : » ou « # » : entourez-la de guillemets (sinon YAML la lit mal)` };
    } else if (/^[[{&*!%@`]/.test(value) || (['name', 'description'].includes(key) && /^(?:true|false|null|yes|no|on|off|~|[-+]?[\d.]+(?:e[-+]?\d+)?)$/i.test(value))) {
      // Liste, objet, alias, booléen ou nombre : YAML ne lirait pas une chaîne. On refuse plutôt que de certifier la compatibilité.
      return { error: `la valeur de « ${key} » n'est pas du texte simple pour YAML : entourez-la de guillemets` };
    }
    head[key] = value; keys.push(key);
  }
  if (typeof head.name !== 'string' || !head.name) return { error: 'name manquant' };
  if (typeof head.description !== 'string' || !head.description) return { error: 'description manquante' };
  return { head, keys, name: head.name, description: head.description, body: m[2] };
}

const BLOCKING = [
  [/(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]*\|\s*(?:sh|bash|zsh|iex|pwsh|powershell)\b/i, 'telechargement-execute', 'télécharge puis exécute du code'],
  [/\beval\s*\(|\bInvoke-Expression\b/i, 'eval', 'évalue du code à la volée'],
  [/\brm\s+-[a-z]*r[a-z]*f|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force|\bdel\s+\/[sq]/i, 'suppression-recursive', 'supprime des fichiers de façon récursive'],
  [/base64\s+(?:-d|--decode)|-EncodedCommand|\s-enc\s/i, 'code-encode', 'exécute du code encodé'],
  [/--dangerously-skip-permissions|bypassPermissions|chmod\s+777/i, 'permissions', 'contourne ou élargit des permissions']
];
const WARNINGS = [
  [/```(?:bash|sh|shell|powershell|ps1|cmd)\b/i, 'commandes', 'contient des commandes (Archipel ne les exécute jamais)'],
  [/\b(?:npm|pnpm|yarn|pip3?|npx|uvx|brew|apt(?:-get)?|choco|winget)\s+(?:install|i|add|run|exec)\b/i, 'installation', 'demande d’installer ou de lancer un programme'],
  [/\bsudo\b/i, 'sudo', 'mentionne sudo'],
  [/shopify\s+(?:theme\s+(?:push|publish|delete|rename|share|dev|duplicate)|app\s+deploy|store\s+(?:execute|bulk))/i, 'boutique', 'cite des commandes Shopify qui modifient la boutique'],
  [/(?:ignore|oublie|ne tiens pas compte)[^\n]{0,40}(?:instructions|consignes|règles|rules)/i, 'injection', 'contient une formule qui ressemble à une injection d’instructions'],
  [/telemetry|télémétrie|phone[- ]home/i, 'telemetrie', 'mentionne de la télémétrie'],
  [/~\/\.ssh|\.env\b|\.aws\/|id_rsa|api[_-]?key\s*=/i, 'secrets', 'mentionne des fichiers ou des clés secrets']
];

// Analyse statique du texte : elle signale, elle ne prouve pas l'innocuité. « bloquant » interdit l'import.
export function scanSkill(parsed, content) {
  const findings = [];
  if (Buffer.byteLength(content) > MAX_FILE) findings.push({ severity: 'bloquant', code: 'taille', message: `fichier trop gros (plus de ${MAX_FILE / 1024} Ko)` });
  for (const key of parsed.keys ?? []) {
    if (PERMISSION_KEYS.includes(key)) findings.push({ severity: 'bloquant', code: 'permissions-entete', message: `le champ « ${key} » accorderait des outils ou un contexte d'exécution` });
    else if (!KNOWN_KEYS.includes(key)) findings.push({ severity: 'attention', code: 'champ-inconnu', message: `champ d'en-tête ignoré : ${key}` });
  }
  const text = normalize(content);
  for (const [re, code, message] of BLOCKING) if (re.test(text)) findings.push({ severity: 'bloquant', code, message });
  for (const [re, code, message] of WARNINGS) if (re.test(text)) findings.push({ severity: 'attention', code, message });
  const hosts = [...new Set([...text.matchAll(/https?:\/\/([^/\s)>"'`]+)/gi)].map((x) => x[1].toLowerCase()))];
  if (hosts.length) findings.push({ severity: 'attention', code: 'liens', message: `liens externes : ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? '…' : ''}` });
  return findings;
}

// Conformité de structure d'après les formats documentés (Claude Code, Codex). Ce n'est pas une preuve d'exécution.
export function checkCompat(parsed, dirName = null) {
  const common = [];
  const { name, description } = parsed;
  if (!NAME_RE.test(name) || name.length > MAX_NAME) common.push(`nom invalide : minuscules, chiffres et tirets, ${MAX_NAME} caractères au plus`);
  if (RESERVED.some((w) => name.includes(w))) common.push('le nom ne peut pas contenir « claude » ni « anthropic »');
  if (description.length > MAX_DESCRIPTION) common.push(`description trop longue (${description.length} caractères, ${MAX_DESCRIPTION} au plus)`);
  if (dirName && dirName !== name) common.push(`le nom « ${name} » diffère du dossier « ${dirName} »`);
  const codex = [...common];
  if (description.includes('\n')) codex.push('la description doit tenir sur une seule ligne');
  return { claude: { ok: common.length === 0, issues: common }, codex: { ok: codex.length === 0, issues: codex } };
}

// Analyse complète d'un texte de Skill (fichier du dépôt, texte collé ou importé).
export function analyzeSkill(text, dirName = null) {
  const parsed = parseSkill(text);
  if (parsed.error) return { error: parsed.error };
  const content = normalize(text);
  return {
    name: parsed.name, description: parsed.description, license: typeof parsed.head.license === 'string' ? parsed.head.license : null,
    content, hash: hashText(content), tokens: estimateTokens(content),
    findings: scanSkill(parsed, content), compat: checkCompat(parsed, dirName)
  };
}

export const hasBlocking = (findings) => findings.some((f) => f.severity === 'bloquant');

// Construit un SKILL.md à partir de champs simples (description toujours entre guillemets : YAML sûr).
export function buildSkillText({ name, title, description, body }) {
  const quoted = String(description).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\nname: ${name}\ndescription: "${quoted}"\n---\n\n# ${title || name}\n\n${String(body).trim()}\n`;
}

function findCycle(deps) {
  const state = new Map();
  const visit = (n, path) => {
    if (state.get(n) === 'done') return null;
    if (state.get(n) === 'open') return [...path.slice(path.indexOf(n)), n];
    state.set(n, 'open');
    for (const d of deps.get(n) ?? []) { const c = visit(d, [...path, n]); if (c) return c; }
    state.set(n, 'done');
    return null;
  };
  for (const n of deps.keys()) { const c = visit(n, []); if (c) return c; }
  return null;
}

// Lit skills/ : un dossier = un Skill. Seuls les SKILL.md sont lus ; tout autre fichier est signalé et jamais exécuté.
export function loadSkillLibrary(dir) {
  const library = { skills: [], categories: [], sources: [], warnings: [] };
  if (!existsSync(dir)) return library;
  let catalog = { skills: [], categories: [], sources: [] };
  const catalogFile = join(dir, 'catalog.json');
  if (existsSync(catalogFile)) {
    try { catalog = { ...catalog, ...JSON.parse(readFileSync(catalogFile, 'utf8')) }; }
    catch (e) { library.warnings.push({ file: 'skills/catalog.json', reason: `illisible (${e.message})` }); }
  }
  library.categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  library.sources = Array.isArray(catalog.sources) ? catalog.sources : [];
  const meta = new Map((Array.isArray(catalog.skills) ? catalog.skills : []).map((s) => [s.name, s]));
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); }
  catch (e) { library.warnings.push({ file: 'skills', reason: `dossier illisible (${e.code ?? e.message})` }); return library; }
  for (const name of entries) {
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file) || !statSync(file).isFile()) { library.warnings.push({ file: `skills/${name}`, reason: 'SKILL.md absent' }); continue; }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) { library.warnings.push({ file: `skills/${name}/SKILL.md`, reason: `illisible (${e.code ?? e.message})` }); continue; }
    const a = analyzeSkill(text, name);
    if (a.error) { library.warnings.push({ file: `skills/${name}/SKILL.md`, reason: a.error }); continue; }
    // Le nom sert de nom de dossier dans les copies : il doit être sûr et identique à celui du dossier source.
    if (a.name !== name || !NAME_RE.test(a.name) || a.name.length > MAX_NAME) { library.warnings.push({ file: `skills/${name}/SKILL.md`, reason: `le nom « ${a.name} » doit être identique au dossier et valide : Skill ignoré` }); continue; }
    const c = meta.get(a.name) ?? {};
    const extraFiles = readdirSync(join(dir, name)).filter((f) => f !== 'SKILL.md');
    if (extraFiles.length) library.warnings.push({ file: `skills/${name}`, reason: `fichiers annexes non utilisés et jamais exécutés : ${extraFiles.join(', ')}` });
    library.skills.push({
      ...a, title: c.title ?? a.name, category: c.category ?? null, version: c.version ?? '1.0.0',
      license: a.license ?? c.license ?? null, roles: Array.isArray(c.roles) ? c.roles : [], dependsOn: Array.isArray(c.dependsOn) ? c.dependsOn : [],
      origin: c.source ? 'importe' : (c.license?.startsWith('Workeda') ? 'workeda' : 'perso'),
      source: typeof c.source === 'string' ? c.source : null, archived: c.archived === true, extraFiles
    });
  }
  const names = new Set(library.skills.map((s) => s.name));
  for (const s of library.skills) for (const d of s.dependsOn) if (!names.has(d)) library.warnings.push({ file: `skills/${s.name}`, reason: `dépendance introuvable : ${d}` });
  const cycle = findCycle(new Map(library.skills.map((s) => [s.name, s.dependsOn.filter((d) => names.has(d))])));
  if (cycle) library.warnings.push({ file: 'skills/catalog.json', reason: `dépendances circulaires : ${cycle.join(' → ')}` });
  return library;
}

const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Mots sans valeur de recherche : articles, prépositions, verbes courants et le nom de la boutique, présent partout.
const STOPWORDS = new Set(('des les une aux par pour sur dans avec sans sous vers chez entre tout tous toute toutes cette ces ses son sont est etre avoir fait faire plus moins comme mais donc que qui quoi dont lors afin ainsi aussi leur leurs nos vos notre votre elle ils elles propos ' +
  'workeda boutique agent agents skill skills the and for with from that this').split(' '));
const stems = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.slice(0, 6));

// Recommande des Skills d'après un texte (métier, rôle) : correspondance de mots-clés, jamais un jugement de qualité.
export function recommendSkills(skills, text, { exclude = [], limit = 5 } = {}) {
  const wanted = new Set(stems(text));
  return skills
    .filter((s) => s.status !== 'archived' && s.status !== 'missing' && !exclude.includes(s.name))
    .map((s) => {
      const hits = new Set();
      let score = 0;
      for (const role of s.roles ?? []) for (const w of stems(role)) if (wanted.has(w)) { score += 3; hits.add(w); }
      for (const w of stems(`${s.title} ${s.description}`)) if (wanted.has(w) && !hits.has(w)) { score += 1; hits.add(w); }
      return { name: s.name, title: s.title, score, matched: [...hits] };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// Convertit une adresse GitHub vers un SKILL.md en adresse « raw » ; seul ce fichier est téléchargé.
export function githubRawUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('Adresse invalide.'); }
  if (u.protocol !== 'https:') throw new Error('Seules les adresses https sont acceptées.');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('Adresse invalide.');
  let raw;
  if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) raw = parts;
  else if (u.hostname === 'github.com' && parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'tree')) raw = [parts[0], parts[1], parts[3], ...parts.slice(4)];
  else throw new Error('Adresse GitHub attendue : github.com/<propriétaire>/<dépôt>/blob/<branche>/…/SKILL.md');
  if (raw.at(-1) !== 'SKILL.md') raw = [...raw, 'SKILL.md'];
  return `https://raw.githubusercontent.com/${raw.map(encodeURIComponent).join('/')}`;
}

export async function fetchSkillText(url, fetchImpl = fetch) {
  const raw = githubRawUrl(url);
  const res = await fetchImpl(raw, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status} pour ce fichier.`);
  const tooBig = () => new Error('Fichier trop gros pour un Skill.');
  if (Number(res.headers?.get?.('content-length')) > MAX_FILE) throw tooBig();
  let text;
  if (res.body?.getReader) { // lecture bornée : on s'arrête dès que la limite est dépassée
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE) { await reader.cancel().catch(() => {}); throw tooBig(); }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await res.text();
  if (Buffer.byteLength(text) > MAX_FILE) throw tooBig();
  return { text, raw };
}
