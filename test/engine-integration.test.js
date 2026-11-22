import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { createEngineProvider } from '../src/engine-provider.js';
import { costLine, runLine } from '../public/comm-view.js';
import { createApp } from '../src/app.js';
import http from 'node:http';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(t, opts = {}) {
  const studio = createStudio(':memory:', opts); studio.syncAgentFiles(profiles);
  t.after(() => studio.close());
  const ids = Object.fromEntries(studio.listAgentFiles().map(f => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, ids };
}

test('moteur par agent local, surcharge par tâche, choix figé et dédoublonnage par moteur', t => {
  const { comm, studio, ids } = setup(t);
  assert.equal(comm.agentEngine(ids.alexander), 'claude');
  comm.setAgentEngine(ids.alexander, 'codex');
  assert.equal(studio.listAgents().find(a => a.id === ids.alexander).engine, 'codex');
  const a = comm.createTask({ assigneeId: ids.alexander, instruction: 'Analyser' }).task;
  const b = comm.createTask({ assigneeId: ids.alexander, instruction: 'Analyser', engine: 'claude' }).task;
  assert.notEqual(a.id, b.id); assert.equal(a.engine, 'codex'); assert.equal(b.engine, 'claude');
  comm.setAgentEngine(ids.alexander, 'claude'); assert.equal(comm.task(a.id).engine, 'codex');
  assert.throws(() => comm.setAgentEngine(ids.alexander, 'constructor'), /Moteur/);
  assert.throws(() => comm.createTask({ assigneeId: ids.alexander, instruction: 'x', engine: 'toString' }), /Moteur/);
});

test('Codex indisponible : tâche bloquée, coût null, jamais de repli ni de retry silencieux', async t => {
  const { studio, comm, ids } = setup(t); let claude = 0;
  const provider = createEngineProvider({ claude: async () => { claude++; }, codex: async () => { throw Object.assign(new Error('Codex indisponible'), { code: 'unavailable' }); } });
  const orch = createOrchestrator({ studio, profiles: () => profiles, provider });
  const task = comm.createTask({ assigneeId: ids.alexander, instruction: 'Analyser', engine: 'codex' }).task;
  orch.pump(); await orch.idle();
  assert.equal(comm.task(task.id).state, 'blocked'); assert.equal(claude, 0);
  const run = comm.recentRuns()[0]; assert.equal(run.engine, 'codex'); assert.equal(run.costUsd, null);
  const current = comm.task(task.id);
  assert.equal(current.spentUsd, null); assert.equal(current.codexUsage.runs, 1);
  assert.match(runLine(run, () => 'Alexander'), /coût Codex inconnu/);
  assert.match(costLine(comm.usage()), /coût Codex inconnu/);
  assert.equal(comm.usage().today.costUsd, null); assert.equal(comm.usage().total.costUsd, null);
  assert.equal(comm.usage().byAgent[0].costUsd, null); assert.equal(comm.spentOf(task.id), null);
});

test('limites : durée, jetons et préférence survivent au redémarrage', t => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-limits-'));
  let reopened = null;
  t.after(() => { reopened?.close(); rmSync(dir, { recursive: true, force: true }); });
  const file = join(dir, 'db.sqlite');
  let at = '2026-11-22T10:00:00.000Z';
  const a = createStudio(file, { device: 'pc-test', clock: () => at }); a.syncAgentFiles(profiles);
  const id = a.listAgentFiles().find(f => f.slug === 'alexander').agentId;
  a.comm.setAgentEngine(id, 'codex'); a.comm.setCodexLimits({ durationMsPerDay: 1, tokensPerDay: 10 });
  const run = a.comm.startRun({ agentId: id, kind: 'reply', engine: 'codex' });
  at = '2026-11-22T10:00:01.000Z';
  a.comm.endRun(run.id, { usage: { input: 8, output: 3 } }); a.close();
  const b = reopened = createStudio(file, { device: 'pc-test', clock: () => at });
  assert.equal(b.comm.agentEngine(id), 'codex'); assert.equal(b.comm.codexLimits().tokensPerDay, 10);
  assert.match(b.comm.codexBlocker(), /jetons/);
  b.comm.setCodexLimits({ tokensPerDay: 100 });
  assert.match(b.comm.codexBlocker(), /Durée/);
  assert.equal(b.comm.codexStatus().today.durationMs, 1000);
  const second = b.comm.startRun({ agentId: id, kind: 'reply', engine: 'codex' });
  b.comm.endRun(second.id);
  // L'horloge de ce test est constante ; un délai minimum ne doit pas être inventé.
  assert.equal(b.comm.codexStatus().today.unknownUsage, 1);
});

test('API locale : réglage et surcharge réels, limites locales, rejet Host et Origin', async t => {
  const { studio, comm, ids } = setup(t); let calls = 0;
  const app = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), agentFiles: { profiles }, detect: () => false,
    runCodex: async () => { calls++; throw Object.assign(new Error('Codex simulé absent'), { code: 'unavailable' }); },
    runClaude: async () => { throw new Error('Repli interdit'); } });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const port = app.address().port;
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', x => text += x); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const path = `/api/comm/agents/${ids.alexander}/engine`;
    assert.equal((await call('PUT', path, { engine: 'codex' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('GET', path, undefined, { host: 'evil.example' })).status, 403);
    assert.equal((await call('PUT', path, { engine: 'constructor' })).status, 400);
    assert.equal((await call('PUT', path, { engine: 'codex' })).body.engine, 'codex');
    assert.equal((await call('GET', path)).body.engine, 'codex');
    assert.equal((await call('PUT', '/api/comm/codex/limits', { runsPerDay: 3 })).body.limits.runsPerDay, 3);
    const response = await call('POST', '/api/comm/delegations', { assigneeId: ids.alexander, instruction: 'Analyser', engine: 'codex' });
    assert.equal(response.status, 200); assert.equal(response.body.task.engine, 'codex');
    await app.orchestrator.idle(); assert.equal(calls, 1); assert.equal(comm.task(response.body.task.id).state, 'blocked');
  } finally { await new Promise(r => app.close(r)); }
});

test('contrat normalisé, usage, concurrence Codex 1 et budgets locaux persistants', async t => {
  const { studio, comm, ids } = setup(t); let calls = 0, active = 0, max = 0;
  comm.setCodexLimits({ runsPerDay: 2, timeoutMs: 1000, tokensPerDay: 30, durationMsPerDay: 5000 });
  const provider = createEngineProvider({ codex: async opts => {
    calls++; active++; max = Math.max(max, active);
    await new Promise(r => setTimeout(r, 20)); active--;
    opts.onEvent?.({ type: 'usage', usage: { input: 12, output: 7 }, costUsd: null });
    return { text: JSON.stringify({ status: 'done', report: 'Analyse terminée' }), usage: { input: 12, output: 7 }, costUsd: 0 };
  } });
  const orch = createOrchestrator({ studio, profiles: () => profiles, provider });
  for (const id of [ids.alexander, ids.noah, ids.sophia]) comm.createTask({ assigneeId: id, instruction: 'Analyser', engine: 'codex' });
  orch.pump(); await orch.idle();
  assert.equal(max, 1); assert.equal(calls, 2);
  assert.equal(comm.listTasks().filter(x => x.state === 'done').length, 2);
  assert.equal(comm.listTasks().filter(x => x.state === 'blocked').length, 1);
  assert.ok(comm.recentRuns().every(x => x.costUsd === null && x.engine === 'codex'));
  assert.equal(comm.codexStatus().today.tokens, 38); assert.equal(comm.codexStatus().subscription.state, 'unknown');
  assert.throws(() => comm.setCodexLimits({ runsPerDay: -1 }), /Limite/);
});

test('journal v4 : moteur portable, réglage local distinct, champ ancien absent conservé, invalide refusé', t => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-engine-sync-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = setup(t, { commJournalDir: dir, device: 'pc-a' }), b = setup(t, { commJournalDir: dir, device: 'pc-b' });
  a.comm.setAgentEngine(a.ids.alexander, 'codex');
  const task = a.comm.createTask({ assigneeId: a.ids.alexander, instruction: 'Analyser' }).task;
  const r = a.comm.startRun({ agentId: a.ids.alexander, taskId: task.id, kind: 'task', engine: 'codex' }); a.comm.endRun(r.id, { costUsd: 0 });
  b.comm.importJournal(); assert.equal(b.comm.task(task.id).engine, 'codex'); assert.equal(b.comm.getRun(r.id).costUsd, null);
  assert.equal(b.comm.codexStatus().today.runs, 0, 'les exécutions importées ne consomment pas les limites de ce PC');
  assert.equal(b.comm.agentEngine(b.ids.alexander), 'claude');
  const path = join(dir, `${a.comm.device}.jsonl`), events = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  const older = structuredClone(events.find(e => e.kind === 'task')); older.eid += '-old'; older.rev += 100; delete older.data.engine;
  writeFileSync(path, JSON.stringify(older) + '\n'); b.comm.importJournal(); assert.equal(b.comm.task(task.id).engine, 'codex');
  const invalid = structuredClone(older); invalid.eid += '-invalid'; invalid.rev++; invalid.data.engine = 'constructor';
  writeFileSync(path, JSON.stringify(invalid) + '\n'); b.comm.importJournal(); assert.equal(b.comm.task(task.id).engine, 'codex');
  assert.equal(b.comm.schemaVersion(), 4);
});
