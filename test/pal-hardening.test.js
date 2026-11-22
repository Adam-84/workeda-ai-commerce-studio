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
  for (const event of [{ tool_name: 'Read' }, { tool_name: 'mcp__pal__chat', tool_input: null }]) {
    assert.equal(run(guard, [], JSON.stringify(event)).status, 0);
  }
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
const HOOK = () => installed().hooks.PreToolUse.find((h) => h.matcher === 'mcp__.*__clink').hooks[0];
const viaSettings = (event) => spawnSync(process.env.SHELL ?? 'bash', ['-c', HOOK().command], { input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, timeout: 15000 });

test('hook installé : réglages existants conservés, hook ciblé sur clink, aucun refus global des autres clients', () => {
  const s = installed();
  assert.equal(s.permissions.deny.length, 7); assert.ok(s.permissions.deny.every((d) => /^Bash\(shopify theme (push|publish|delete|rename|share|dev|duplicate):\*\)$/.test(d)), 'refus Shopify d\'origine intacts');
  assert.ok(!s.permissions.deny.includes('mcp__pal__clink'), 'pas de refus grossier : les autres clients restent possibles');
  assert.deepEqual(Object.keys(s).sort(), ['hooks', 'permissions']); assert.deepEqual(Object.keys(s.hooks), ['PreToolUse']); assert.equal(s.hooks.PreToolUse.length, 1);
  assert.match(HOOK().command, /\$CLAUDE_PROJECT_DIR\/tools\/pal-hardening\/guard-clink\.mjs/); assert.equal(HOOK().type, 'command');
  assert.ok(new RegExp(`^${s.hooks.PreToolUse[0].matcher}$`).test('mcp__pal__clink'), 'le matcher couvre l\'outil PAL réel');
  assert.ok(!/<PROJET>|C:\|adamg/i.test(JSON.stringify(s)), 'aucun chemin personnel ni espace réservé');
  assert.ok(!existsSync('.mcp.json'), 'instance durcie non installée'); assert.ok(!existsSync('tools/pal-hardening/owner-approval.local.json'), 'aucun accord temporaire');
});

test('hook installé, exécuté EXACTEMENT comme la commande des réglages : Codex et variantes bloqués, autres clients reconnus passent', () => {
  const clink = (cli_name, extra = {}) => ({ tool_name: 'mcp__pal__clink', tool_input: { cli_name, prompt: 'x', ...extra } });
  for (const name of ['codex', 'CODEX', ' Codex ', 'cOdEx\n', 'codex ', 'codex\u200b', 'codex.cmd', 'codex-analyse', '', 'inconnu']) assert.equal(viaSettings(clink(name)).status, 2, JSON.stringify(name));
  for (const e of [clink(undefined), { tool_name: 'mcp__pal__clink' }, { tool_name: 'mcp__pal__clink', tool_input: null }, { tool_name: 'mcp__pal__clink', tool_input: [] }, { tool_name: 'mcp__pal__clink', tool_input: { cli_name: ['codex'] } }, { tool_name: 'mcp__pal__clink', tool_input: { cli_name: { x: 1 } } }, { tool_name: 'mcp__autre__clink', tool_input: { cli_name: 'codex' } }, { tool_name: 'MCP__PAL__CLINK', tool_input: { cli_name: 'codex' } }, clink('codex', { continuation_id: 'abc', role: 'codereviewer', absolute_file_paths: ['C:/x'] })]) assert.equal(viaSettings(e).status, 2, JSON.stringify(e).slice(0, 90));
  for (const bad of ['', 'pas du json', '[]', 'null', '{"tool_name":', '{"tool_name":42}', 'x'.repeat(300000)]) assert.equal(viaSettings(bad).status, 2, bad.slice(0, 20));
  for (const ok of ['claude', 'gemini', 'agy']) assert.equal(viaSettings(clink(ok)).status, 0, ok);
  for (const other of ['Bash', 'Read', 'mcp__pal__chat', 'mcp__pal__listmodels']) assert.equal(viaSettings({ tool_name: other, tool_input: { command: 'ls', cli_name: 'codex' } }).status, 0, `${other} hors périmètre du hook`);
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
