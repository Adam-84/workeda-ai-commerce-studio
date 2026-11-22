// Sonde SANS OpenAI : le VRAI client Codex (non confiné par MXC) parle à un FAUX fournisseur « Responses » sur 127.0.0.1.
// Aucune clé réelle (clé factice), CODEX_HOME vierge/temporaire, environnement filtré, dossiers pièges fictifs. Sert à observer ce que le client
// ENVOIE au modèle (catalogue d'outils, instructions, skills) et ce qu'il fait d'un appel d'outil FORCÉ. Observations, pas des garanties.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

export const codexEntry = () => (process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : null);
export const probeAvailable = () => process.platform === 'win32' && codexEntry() && existsSync(codexEntry());
const fwd = (p) => p.split(String.fromCharCode(92)).join('/');

export async function runProbe({ mode = 'catalog', flags = [], timeoutMs = 45000 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'archipel-probe-')), home = join(base, 'home'), codexHome = join(base, 'codexhome'), cwd = join(base, 'work'), decoy = join(base, 'decoy');
  for (const d of [home, codexHome, cwd, decoy, join(codexHome, 'skills', 'piege')]) mkdirSync(d, { recursive: true });
  const mcpMark = join(decoy, 'MCP_EXECUTE.txt'), writeMark = join(decoy, 'ECRITURE_FORCEE.txt');
  writeFileSync(join(cwd, 'AGENTS.md'), 'MARQUEUR-AGENTS-PROJET\n'); writeFileSync(join(codexHome, 'AGENTS.md'), 'MARQUEUR-AGENTS-CODEXHOME\n');
  writeFileSync(join(codexHome, 'skills', 'piege', 'SKILL.md'), '---\nname: piege\ndescription: MARQUEUR-SKILL-CODEXHOME\n---\ncorps\n');
  writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.faux]\ncommand = "${fwd(process.execPath)}"\nargs = ["-e", "require('fs').writeFileSync('${fwd(mcpMark)}','x')"]\n`);
  const requests = []; let turn = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null; try { json = JSON.parse(body); } catch { /* corps non JSON */ }
      requests.push({ url: req.url, json });
      if (req.method !== 'POST' || !req.url.includes('/responses')) { res.writeHead(404); res.end('{}'); return; }
      turn += 1; res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('response.created', { response: { id: `resp_${turn}` } });
      if (mode === 'force' && turn === 1) ev('response.output_item.done', { item: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: `const r = await tools.exec_command({ cmd: 'cmd /c echo x> "${fwd(writeMark)}"' }); text(JSON.stringify(r));` } });
      else ev('response.output_item.done', { item: { type: 'message', id: `msg_${turn}`, role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] } });
      ev('response.completed', { response: { id: `resp_${turn}`, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: base, TMP: base, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), LOCALAPPDATA: join(home, 'Local'), CODEX_HOME: codexHome, FAKE_KEY: 'cle-factice', NO_PROXY: '127.0.0.1', PATH: join(process.env.SystemRoot, 'System32') };
  const args = ['-c', 'model_provider="fake"', '-c', `model_providers.fake={ name = "fake", base_url = "http://127.0.0.1:${port}/v1", env_key = "FAKE_KEY", wire_api = "responses" }`, ...flags,
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '-s', 'read-only', '-C', cwd, 'Réponds OK.'];
  const child = spawn(process.execPath, [codexEntry(), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const external = []; const poll = setInterval(() => { try { external.push(execFileSync('netstat', ['-ano', '-n'], { encoding: 'utf8', timeout: 5000 }).split('\n').filter((l) => /ESTABLISHED|SYN_SENT/.test(l) && !/127\.0\.0\.1|\[::1\]/.test(l)).length); } catch { /* sonde best-effort */ } }, 1500);
  const kill = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* déjà terminé */ } };
  const timer = setTimeout(kill, timeoutMs);
  await new Promise((r) => child.on('exit', r)); clearTimeout(timer); clearInterval(poll); server.close();
  const first = requests.find((r) => r.json)?.json ?? null, text = first ? JSON.stringify(first) : '';
  const names = new Set(); const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.name === 'string' && ['function', 'custom', 'namespace', 'web_search', 'local_shell'].includes(v.type)) names.add(v.name); Object.values(v).forEach(walk); } };
  walk(first);
  const skillsText = (first?.input ?? []).map((i) => JSON.stringify(i)).find((t) => t.includes('<skills_instructions>')) ?? '';
  const result = {
    requestCount: requests.filter((r) => r.json).length, toolNames: [...names], model: first?.model ?? null, requestBytes: text.length,
    markers: { agentsCwd: text.includes('MARQUEUR-AGENTS-PROJET'), agentsCodexHome: text.includes('MARQUEUR-AGENTS-CODEXHOME'), skillCodexHome: text.includes('MARQUEUR-SKILL-CODEXHOME') },
    skillRootsReferenceRealProfile: fwd(skillsText).toLowerCase().includes(fwd(homedir()).toLowerCase() + '/.agents/skills'),
    mcpExecuted: existsSync(mcpMark), forcedWriteExecuted: existsSync(writeMark), toolOutput: JSON.stringify((requests.filter((r) => r.json).at(-1)?.json.input ?? []).filter((i) => /output/.test(i.type))), externalConnectionSnapshots: external,
    leftovers: readdirSync(decoy)
  };
  rmSync(base, { recursive: true, force: true });
  return result;
}
