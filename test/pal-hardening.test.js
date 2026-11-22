import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { createEngineProvider } from '../src/engine-provider.js';
import { runCodex } from '../src/codex-runner.js';
const root = resolve('.');
const guard = resolve('tools/pal-hardening/guard-clink.mjs');
const gate = resolve('tools/pal-hardened/pal-analysis-gate.mjs');
const configPath = resolve('tools/pal-hardened/cli_clients/codex.json');
const clean = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const run = (file, args = [], input = '', env = clean, cwd = root) => spawnSync(process.execPath, [file, ...args], { input, env, cwd, encoding: 'utf8', timeout: 7000, windowsHide: true });
const hook = (cli, extra = {}, name = 'mcp__pal__clink') => JSON.stringify({ tool_name: name, tool_input: { cli_name: cli, ...extra } });
function scratch(t) {
  const dir = mkdtempSync(join(root, 'tools/pal-hardening/probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('hook réel : Codex, alias inconnus, casse, espaces, rôles et continuation ne contournent pas le refus', () => {
  for (const cli of ['codex', ' CODEX ', 'CoDeX', 'codex.cmd', 'codex.exe', 'openai', 'codex-analyse', '', 'claude codex', 'Ｃｏｄｅｘ']) {
    for (const name of ['mcp__pal__clink', 'mcp__pal-hardened__clink']) {
      const out = run(guard, [], hook(cli, { role: 'codereviewer', continuation_id: 'fictif' }, name));
      assert.equal(out.status, 2, `${cli}: ${out.stderr}`); assert.match(out.stderr, /bloquée/); assert.equal(out.stdout, '');
    }
  }
});

test('hook : autres clients et outils passent sans approbation implicite ni transformation', () => {
  for (const cli of ['claude', 'gemini', 'agy', ' GEMINI ']) {
    const out = run(guard, [], hook(cli, { continuation_id: 'fictif', role: 'planner' }));
    assert.equal(out.status, 0, out.stderr); assert.equal(out.stdout + out.stderr, '');
  }
  for (const event of [{ tool_name: 'Read' }, { tool_name: 'mcp__pal__listmodels', tool_input: null }]) {
    assert.equal(run(guard, [], JSON.stringify(event)).status, 0);
  }
  assert.equal(run(guard, [], JSON.stringify({ tool_name: 'mcp__pal__chat', tool_input: null })).status, 2, 'route API sans entrée exploitable : refus');
});

test('hook : entrée invalide ou clink inattendu refusé, même tronqué ou trop volumineux', () => {
  for (const input of ['{', '', 'null', '[]', '{}', '{"tool_name":"mcp__pal__clink"}',
    JSON.stringify({ tool_name: 'mcp__pal__clink', tool_input: { cli_name: null } }),
    JSON.stringify({ tool_name: 'mcp__pal__clink', tool_input: 'codex' }), 'x'.repeat(262145)]) {
    assert.equal(run(guard, [], input).status, 2);
  }
});

test('gate : flags dangereux et refus par défaut ; faux codex jamais lancé même avec accord/profil fictifs', t => {
  const dir = scratch(t), counter = join(dir, 'executions');
  writeFileSync(join(dir, 'codex.cmd'), '@echo execution>>"' + counter + '"\r\n');
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho execution >> "' + counter.replaceAll('\\', '/') + '"\n', { mode: 0o700 });
  const witness = join(dir, 'codex.cjs');
  writeFileSync(witness, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'execution');`);
  assert.equal(run(witness, [], '', clean, dir).status, 0);
  assert.equal(readFileSync(counter, 'utf8'), 'execution', 'témoin positif du compteur');
  rmSync(counter);
  writeFileSync(join(dir, 'owner-approval.local.json'), JSON.stringify({ approved: true, expiresAt: '2099-01-01T00:00:00Z' }));
  writeFileSync(join(dir, 'verified-isolation.local.json'), '{"verified":true}');
  const env = { ...clean, PATH: dir, HOME: dir, USERPROFILE: dir, CODEX_HOME: dir,
    PAL_CODEX_APPROVED: 'true', PAL_VERIFIED_PROFILE: 'fictif', FAKE_API_KEY: 'FAUX-SECRET-DE-TEST' };
  const flags = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-other', '--yolo', 'danger-full-access', '--full-auto',
    '--add-dir=ailleurs', '--enable=web_search', 'web_search="live"', '--search'];
  for (const args of [[], ['exec'], ['exec', '--json'], ...flags.map(f => ['exec', f])]) {
    const out = run(gate, args, 'contexte fictif', env, dir);
    assert.equal(out.status, 2, out.stderr);
    const result = JSON.parse(out.stderr); assert.equal(result.spawned, false);
    assert.equal(result.workFiles, 0); assert.deepEqual(result.envNames, Object.keys(clean).sort());
    assert.equal(result.code, flags.includes(args[1]) ? 'forbidden_arguments' : 'isolation_unverified');
    assert.equal(out.stdout, ''); assert.ok(!out.stderr.includes('FAUX-SECRET'));
  }
  assert.equal(existsSync(counter), false, 'compteur exécutions = 0');
});

test('config proposée : commande gate, rôles sans échappatoire, web désactivé, aucun flag PAL dangereux', () => {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(cfg.name, 'codex'); assert.match(cfg.command, /pal-analysis-gate\.mjs$/);
  assert.deepEqual(cfg.env, {}); assert.equal(cfg.output_to_file, undefined);
  const args = [...cfg.additional_args, ...Object.values(cfg.roles).flatMap(r => r.role_args)];
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!/--dangerously-|--yolo|danger-full-access|--full-auto|--add-dir|--enable/.test(args.join(' ')));
  for (const r of Object.values(cfg.roles)) assert.deepEqual(r.role_args, []);
  const snippet = JSON.parse(readFileSync('tools/pal-hardening/settings-hook.proposed.json', 'utf8'));
  assert.equal(snippet.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
});

test('lanceur : dry-run sans valeurs sensibles, aucun démarrage réel possible', () => {
  const file = resolve('tools/pal-hardened/start-instance.mjs');
  for (const args of [[], ['--start'], ['--dry-run', '--start']]) assert.equal(run(file, args).status, 2);
  const out = run(file, ['--dry-run'], '', { ...clean, FAKE_API_KEY: 'FAUX-SECRET-DE-TEST' });
  assert.equal(out.status, 0); const plan = JSON.parse(out.stdout);
  assert.equal(plan.active, false); assert.equal(plan.server, 'pal-hardened');
  assert.ok(plan.envNames.includes('CLI_CLIENTS_CONFIG_PATH'));
  assert.ok(!plan.envNames.some(k => /KEY|TOKEN|NODE_OPTIONS|PYTHONPATH|PROXY/.test(k)));
  assert.ok(!out.stdout.includes('FAUX-SECRET'));
});

test('Archipel : dix agents restent Claude ; tâche Codex bloquée par le vrai runner sur CLI fictif, sans tour modèle', async t => {
  const { profiles } = loadAgentFiles(resolve('.claude/agents'));
  const studio = createStudio(':memory:'); t.after(() => studio.close()); studio.syncAgentFiles(profiles);
  const agents = studio.listAgentFiles(); assert.equal(agents.length, 10);
  const dir = scratch(t), fake = join(dir, 'fake.cjs'), calls = join(dir, 'calls');
  writeFileSync(fake, `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); console.log(process.argv.includes('--version')?'codex-fictif':'--json --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --config --cd');`);
  let claude = 0;
  const provider = createEngineProvider({ claude: async () => { claude++; return JSON.stringify({ status: 'done', report: 'Analyse fictive terminée.' }); },
    codex: opts => runCodex({ ...opts, command: { file: process.execPath, args: [fake] }, source: { ...clean, CODEX_HOME: dir } }) });
  const orch = createOrchestrator({ studio, profiles: () => profiles, provider });
  for (const a of agents) {
    assert.equal(studio.comm.agentEngine(a.agentId), 'claude');
    studio.comm.createTask({ assigneeId: a.agentId, instruction: 'Analyse fictive' });
  }
  orch.pump(); await orch.idle(); assert.equal(claude, 10);
  const task = studio.comm.createTask({ assigneeId: agents[0].agentId, engine: 'codex', instruction: 'Seconde analyse fictive' }).task;
  orch.pump(); await orch.idle(); assert.equal(claude, 10);
  assert.equal(studio.comm.task(task.id).state, 'blocked');
  const runResult = studio.comm.recentRuns().find(r => r.engine === 'codex');
  assert.ok(runResult); assert.equal(runResult.costUsd, null);
  const probes = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(probes, [['--version'], ['exec', '--help']]);
});

test('PAL optionnel : chargeur réel accepte la proposition et rejette un client inconnu, sans .env ni CLI', t => {
  const pal = join(homedir(), 'tools/pal-mcp-server'), python = join(pal, '.pal_venv/Scripts/python.exe');
  if (!existsSync(python) || !existsSync(join(pal, 'clink/registry.py'))) return t.skip('PAL/Python local absent : validation chargeur indisponible.');
  const script = resolve('tools/pal-hardening/check-pal-loader.py');
  const out = spawnSync(python, ['-I', '-B', script, pal, configPath], { env: clean, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(out.status, 0, out.stderr); assert.deepEqual(JSON.parse(out.stdout), { accepted: true, unknownRejected: true, dangerousDefaults: false });
});

// --- Installation du hook dans les réglages LOCAUX du projet (.claude/settings.json) ----------------------------------------------------
const installed = () => JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
const HOOK = () => installed().hooks.PreToolUse.find((h) => new RegExp(`^(?:${h.matcher})$`).test('mcp__pal__clink')).hooks[0];
const viaSettings = (event) => spawnSync(process.env.SHELL ?? 'bash', ['-c', HOOK().command], { input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, timeout: 15000 });

test('hook installé : réglages existants conservés, hook ciblé sur clink, aucun refus global des autres clients', () => {
  const s = installed();
  assert.equal(s.permissions.deny.filter((d) => /^Bash\(shopify theme (push|publish|delete|rename|share|dev|duplicate):\*\)$/.test(d)).length, 7, 'refus Shopify d\'origine intacts');
  assert.ok(!s.permissions.deny.includes('mcp__pal__clink'), 'pas de refus grossier : les autres clients restent possibles');
  assert.deepEqual(Object.keys(s).sort(), ['hooks', 'permissions']); assert.deepEqual(Object.keys(s.hooks), ['PreToolUse']); assert.equal(s.hooks.PreToolUse.length, 1);
  assert.match(HOOK().command, /\$CLAUDE_PROJECT_DIR\/tools\/pal-hardening\/guard-clink\.mjs" \|\| exit 2$/); // fail-closed : un échec de lancement bloque aussi
  assert.equal(s.permissions.deny.length, 19, 'refus Shopify (7) + refus codex direct (12)'); assert.equal(HOOK().timeout, 30, 'timeout supérieur à la minuterie interne du garde (3 s)'); assert.equal(HOOK().type, 'command');
  for (const tool of ['mcp__pal__clink', 'mcp__pal__chat', 'mcp__pal__consensus', 'mcp__pal__analyze', 'Bash', 'PowerShell', 'mcp__terminal__run_in_terminal']) assert.ok(new RegExp(`^(?:${s.hooks.PreToolUse[0].matcher})$`).test(tool), `le matcher couvre ${tool}`);
  assert.ok(!/<PROJET>|C:\|adamg/i.test(JSON.stringify(s)), 'aucun chemin personnel ni espace réservé');
  assert.ok(!existsSync('.mcp.json'), 'instance durcie non installée'); assert.ok(!existsSync('tools/pal-hardening/owner-approval.local.json'), 'aucun accord temporaire');
});

test('hook installé, exécuté EXACTEMENT comme la commande des réglages : Codex et variantes bloqués, autres clients reconnus passent', () => {
  const clink = (cli_name, extra = {}) => ({ tool_name: 'mcp__pal__clink', tool_input: { cli_name, prompt: 'x', ...extra } });
  for (const name of ['codex', 'CODEX', ' Codex ', 'cOdEx\n', 'codex ', 'codex\u200b', 'codex.cmd', 'codex-analyse', '', 'inconnu']) assert.equal(viaSettings(clink(name)).status, 2, JSON.stringify(name));
  for (const e of [clink(undefined), { tool_name: 'mcp__pal__clink' }, { tool_name: 'mcp__pal__clink', tool_input: null }, { tool_name: 'mcp__pal__clink', tool_input: [] }, { tool_name: 'mcp__pal__clink', tool_input: { cli_name: ['codex'] } }, { tool_name: 'mcp__pal__clink', tool_input: { cli_name: { x: 1 } } }, { tool_name: 'mcp__autre__clink', tool_input: { cli_name: 'codex' } }, { tool_name: 'MCP__PAL__CLINK', tool_input: { cli_name: 'codex' } }, clink('codex', { continuation_id: 'abc', role: 'codereviewer', absolute_file_paths: ['C:/x'] })]) assert.equal(viaSettings(e).status, 2, JSON.stringify(e).slice(0, 90));
  for (const bad of ['', 'pas du json', '[]', 'null', '{"tool_name":', '{"tool_name":42}', 'x'.repeat(300000)]) assert.equal(viaSettings(bad).status, 2, bad.slice(0, 20));
  for (const ok of ['claude', 'gemini', 'agy']) assert.equal(viaSettings(clink(ok)).status, 0, ok);
  for (const other of ['Read', 'Write', 'mcp__pal__listmodels', 'mcp__pal__version']) assert.equal(viaSettings({ tool_name: other, tool_input: { command: 'ls', cli_name: 'codex' } }).status, 0, `${other} hors périmètre du hook`);
  const blocked = viaSettings(clink('codex')); assert.equal(blocked.stdout, ''); assert.match(blocked.stderr, /Aucun CLI lancé/);
});

test('hook installé : un faux Codex placé dans le PATH n\'est jamais exécuté (compteur à zéro)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-fake-codex-')), counter = join(dir, 'count.txt'); writeFileSync(counter, '0');
  writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\necho x>> "${counter}.runs"\r\n`); writeFileSync(join(dir, 'codex'), `#!/bin/sh\necho x >> "${counter}.runs"\n`);
  try {
    for (const name of ['codex', 'CODEX', ' codex ']) assert.equal(spawnSync('bash', ['-c', HOOK().command], { input: JSON.stringify({ tool_name: 'mcp__pal__clink', tool_input: { cli_name: name } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` }, timeout: 15000 }).status, 2);
    assert.equal(existsSync(`${counter}.runs`), false, 'faux Codex exécuté');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Passe « fail-closed + autres routes » ---------------------------------------------------------------------------------------------
test('fail-open éliminé : si node est introuvable ou plante, le hook installé bloque (code 2) au lieu de laisser passer (127)', () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, PATH: '/nonexistent' }; const ev = JSON.stringify({ tool_name: 'mcp__pal__clink', tool_input: { cli_name: 'gemini' } });
  const bash = process.env.SHELL ?? 'bash';
  assert.equal(spawnSync(bash, ['-c', HOOK().command], { input: ev, env, encoding: 'utf8', timeout: 15000 }).status, 2, 'node introuvable');
  assert.equal(spawnSync(bash, ['-c', 'node "$CLAUDE_PROJECT_DIR/tools/pal-hardening/guard-clink.mjs"'], { input: ev, env, encoding: 'utf8', timeout: 15000 }).status, 127, 'témoin : sans le garde-fou, l\'échec de lancement n\'était PAS bloquant');
  const broken = mkdtempSync(join(tmpdir(), 'archipel-broken-')); writeFileSync(join(broken, 'guard.mjs'), 'syntax error (((');
  try { assert.equal(spawnSync(bash, ['-c', 'node "$D/guard.mjs" || exit 2'], { input: ev, env: { ...process.env, D: broken }, encoding: 'utf8', timeout: 15000 }).status, 2); } finally { rmSync(broken, { recursive: true, force: true }); }
});

test('routes API de PAL : liste d\'autorisation de modèles non-OpenAI ; alias, auto, absent et inconnus refusés', () => {
  const api = (tool, input) => viaSettings({ tool_name: `mcp__pal__${tool}`, tool_input: input });
  for (const m of ['gpt-5-codex', 'codex', 'GPT-6', 'openai/gpt-5', 'o3', 'o4-mini', 'O3-mini', 'chatgpt-4o', 'gpt-6.2-astra', ' codex ', 'ｃｏｄｅｘ']) for (const tool of ['chat', 'codereview', 'thinkdeep', 'consensus', 'precommit', 'debug', 'planner', 'challenge']) assert.equal(api(tool, { model: m, prompt: 'x' }).status, 2, `${tool} ${m}`);
  assert.equal(api('consensus', { models: [{ model: 'flash' }, { model: 'o3-mini' }] }).status, 2); assert.equal(api('consensus', { models: ['gemini-2.5-pro', 'gpt-5'] }).status, 2);
  assert.equal(api('chat', { model: ['codex'] }).status, 2, 'type inattendu = refus'); assert.equal(api('chat', { model: 42 }).status, 2);
  for (const ok of ['gemini-2.5-pro', 'flash', 'pro', 'grok-4', 'sonnet', 'google/gemini-2.5-pro']) assert.equal(api('chat', { model: ok, prompt: 'x' }).status, 0, ok);
  for (const bad of ['o3mini', 'o4mini', 'o3pro', 'o1pro', 'mini', 'nano', '4o', 'auto', 'AUTO', '', 'openrouter/openai/gpt-5', 'deployment-azure-1', 'g\u200bpt-5', 'gpt\u200b-5']) assert.equal(api('chat', { model: bad, prompt: 'x' }).status, 2, JSON.stringify(bad));
  for (const tool of ['analyze', 'refactor', 'secaudit', 'docgen', 'tracer', 'testgen']) assert.equal(api(tool, { model: 'o3' }).status, 2, tool);
  assert.equal(api('listmodels', { model: 'gpt-5' }).status, 0, 'listmodels et apilookup restent hors périmètre'); assert.equal(api('chat', { prompt: 'sans modèle' }).status, 2, 'modèle absent : refusé (PAL choisirait le fournisseur)'); assert.equal(api('chat', { prompt: 'x', continuation_id: 'abc' }).status, 2, 'continuation sans modèle : refusé');
  assert.equal(api('consensus', { models: [{ model: 'flash' }, { model: 'gemini-2.5-pro' }] }).status, 0);
});

test('Codex direct par le shell : refus de permission installés pour les formes courantes (limites documentées)', () => {
  const deny = installed().permissions.deny; for (const r of ['Bash(codex:*)', 'Bash(codex.cmd:*)', 'Bash(codex.exe:*)', 'Bash(npx codex:*)', 'Bash(npx @openai/codex:*)', 'Bash(npm exec codex:*)']) assert.ok(deny.includes(r), r);
  assert.ok(!deny.some((d) => /\*codex\*/.test(d)), 'pas de motif trop large qui bloquerait un simple message de commit');
});

test('shell : lancement direct du CLI Codex refusé (Bash, PowerShell, terminal MCP) ; commandes ordinaires et messages de commit intacts', () => {
  const sh = (tool, command) => viaSettings({ tool_name: tool, tool_input: { command } });
  for (const tool of ['Bash', 'PowerShell', 'mcp__terminal__run_in_terminal']) for (const c of ['codex exec --json x', 'echo hi && codex exec', 'x; codex login', 'cmd /c codex exec', 'cmd.exe /c "codex exec"', 'bash -c "codex exec"', 'env codex exec', 'npx -y @openai/codex exec', 'pnpm dlx @openai/codex', 'bunx @openai/codex', 'yarn dlx @openai/codex', 'node C:/x/node_modules/@openai/codex/bin/codex.js exec', 'C:/x/codex.cmd exec', 'codex.exe exec', '(codex exec)']) assert.equal(sh(tool, c).status, 2, `${tool}: ${c}`);
  for (const c of ['git status', 'git commit -m "Codex First via PAL"', 'ls codex-notes.md', 'node --test', 'echo codexterite']) assert.equal(sh('Bash', c).status, 0, c);
});

test('fail-closed : stdin jamais fermé = refus par la minuterie interne (≈3 s), bien avant le timeout de 30 s du hook', async () => {
  const { spawn } = await import('node:child_process');
  const t0 = Date.now(); const child = spawn(process.execPath, [resolve('tools/pal-hardening/guard-clink.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((res) => { const kill = setTimeout(() => { child.kill('SIGKILL'); res('tué par le test (minuterie absente)'); }, 10000); child.on('exit', (c) => { clearTimeout(kill); res(c); }); });
  assert.equal(code, 2); assert.match(err, /bloquée/); assert.ok(Date.now() - t0 < 6000, 'la minuterie interne répond avant 6 s');
});

// --- Neutraliser la clé OpenAI de PAL sans la supprimer (proposition, rien d'installé) ----------------------------------------------------
test('clé OpenAI de PAL : proposition sans secret ; l\'environnement du processus l\'emporte sur un .env FICTIF (python-dotenv, comportement par défaut de PAL)', (t) => {
  const prop = JSON.parse(readFileSync('tools/pal-hardening/mcp-pal-no-openai.proposed.json', 'utf8'));
  assert.deepEqual(Object.keys(prop.mcpServers.pal.env).sort(), ['AZURE_OPENAI_API_KEY', 'OPENAI_API_KEY']); assert.ok(Object.values(prop.mcpServers.pal.env).every((v) => v === 'your_openai_api_key_here'), 'seule la valeur « absente » reconnue par PAL');
  assert.ok(!/GEMINI|XAI|OPENROUTER|DIAL/.test(JSON.stringify(prop.mcpServers.pal.env)), 'les autres fournisseurs gardent leurs clés'); assert.ok(!existsSync('.mcp.json'), 'non installé');
  const py = join(homedir(), 'tools', 'pal-mcp-server', '.pal_venv', 'Scripts', 'python.exe'); if (!existsSync(py)) return t.skip('PAL absent : vérification python-dotenv ignorée');
  const r = spawnSync(py, [resolve('tools/pal-hardening/check-env-precedence.py')], { encoding: 'utf8', timeout: 20000 }); assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(out, { openai_neutralisee_par_l_env_du_processus: true, azure_neutralisee: true, gemini_toujours_lue_depuis_dotenv: true, avec_override_true_le_dotenv_gagnerait: true });
});
