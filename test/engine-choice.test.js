// Lot 2 : choix du moteur par agent ou mission, moteur figé, aucun repli. Runners simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogReason, parseEngine, resolveEngine } from '../src/engines.js';

const claude = (model) => ({ provider: 'claude', model });

test('catalogue fermé : Codex désactivé, modèle ou fournisseur inconnu refusé', () => {
  assert.equal(catalogReason(claude('haiku')), '');
  assert.match(catalogReason({ provider: 'codex', model: 'x' }), /Codex.*Désactivé/);
  assert.match(catalogReason(claude('autre')), /Modèle inconnu/);
  assert.match(catalogReason({ provider: 'ailleurs', model: 'x' }), /Fournisseur inconnu/);
  assert.equal(parseEngine(null), null);
  assert.deepEqual(parseEngine({ provider: 'claude', model: 'opus', command: 'x' }), claude('opus'));
  for (const bad of [undefined, 'opus', {}, { provider: 'codex', model: 'x' }, claude('autre')]) assert.throws(() => parseEngine(bad), { status: 400 });
});

test('priorité : mission, puis agent, puis fiche', () => {
  const all = { mission: claude('haiku'), agent: claude('opus'), fiche: claude('sonnet') };
  assert.deepEqual(resolveEngine(all), { ...claude('haiku'), source: 'mission' });
  assert.deepEqual(resolveEngine({ ...all, mission: null }), { ...claude('opus'), source: 'agent' });
  assert.deepEqual(resolveEngine({ fiche: claude('sonnet') }), { ...claude('sonnet'), source: 'fiche' });
  assert.equal(resolveEngine({}), null);
});

import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}, file = ':memory:') {
  const studio = createStudio(file, options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, engines: studio.engines, ids };
}

test('magasin : mission, agent, fiche ; refus côté serveur', () => {
  const { studio, engines, ids } = setup();
  assert.deepEqual(engines.resolve(ids.lucas), { ...claude('sonnet'), source: 'fiche' });
  engines.setAgentChoice(ids.lucas, claude('opus'));
  assert.deepEqual(engines.resolve(ids.lucas), { ...claude('opus'), source: 'agent' });
  const m = studio.createMission({ title: 'Mission', assignedTo: ids.lucas });
  engines.setMissionChoice(m.id, claude('haiku'));
  assert.deepEqual(engines.resolve(ids.lucas, m.id), { ...claude('haiku'), source: 'mission' });
  engines.setMissionChoice(m.id, null);
  assert.equal(engines.resolve(ids.lucas, m.id).source, 'agent');
  assert.throws(() => engines.setAgentChoice(ids.lucas, { provider: 'codex', model: 'x' }), /Codex/);
  assert.throws(() => engines.setMissionChoice('absente', claude('opus')), { status: 404 });
  const hired = studio.hireAgent({ name: 'Sans fiche', role: 'Test', departmentId: studio.listDepartments()[0].id });
  assert.throws(() => engines.setAgentChoice(hired.id, claude('opus')), { status: 409 });
});

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentOutput } from '../src/comm-core.js';

const asAgent = (comm, agentId, taskId) => ({ type: 'agent', agentId, runId: comm.startRun({ agentId, kind: 'task', taskId }).id });

test('moteur figé à la création : changer le choix ensuite ne touche pas la tâche', () => {
  const { comm, engines, ids } = setup();
  engines.setAgentChoice(ids.lucas, claude('opus'));
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  engines.setAgentChoice(ids.lucas, claude('haiku'));
  assert.deepEqual([comm.task(t.id).model, comm.task(t.id).engineSource], ['opus', 'agent']);
});

test('mission : les sous-tâches héritent ; un agent ne choisit jamais', () => {
  const { comm, ids } = setup();
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Coordonner', engine: claude('haiku') }).task;
  assert.equal(root.engineSource, 'mission');
  const child = comm.createTask({ assigneeId: ids.noah, instruction: 'Veille', parentTaskId: root.id, engine: claude('opus') }, asAgent(comm, ids.alexander, root.id)).task;
  assert.deepEqual([child.model, child.engineSource], ['haiku', 'mission']);
  const free = comm.createTask({ assigneeId: ids.alexander, instruction: 'Autre demande' }).task;
  const other = comm.createTask({ assigneeId: ids.noah, instruction: 'Autre veille', parentTaskId: free.id, engine: claude('opus') }, asAgent(comm, ids.alexander, free.id)).task;
  assert.deepEqual([other.model, other.engineSource], ['sonnet', 'fiche']);
  const parsed = parseAgentOutput(JSON.stringify({ report: 'ok', delegate: [{ to: 'Noah', task: 'x', engine: claude('opus') }] }));
  assert.equal('engine' in parsed.delegate[0], false);
});

test('doublons : deux moteurs font deux demandes', () => {
  const { comm, ids } = setup();
  const ask = (extra) => comm.createTask({ assigneeId: ids.lucas, instruction: 'Même demande', ...extra });
  assert.equal(ask({}).created, true);
  assert.equal(ask({ engine: claude('opus') }).created, true);
  assert.equal(ask({ engine: claude('opus') }).reused, 'open');
  assert.equal(ask({ engine: claude('sonnet') }).reused, 'open', 'le modèle de la fiche garde l’empreinte d’origine');
});

test('automatisation : un résultat d’un autre moteur n’est pas réutilisé', () => {
  const { comm, engines, ids } = setup();
  comm.setAutomationGate(() => true);
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Contrôle', cacheKey: 'k' }, { type: 'automation', runId: 'r1' }).task;
  const run = comm.startRun({ agentId: ids.lucas, kind: 'task', taskId: t.id }); comm.endRun(run.id, { state: 'done' });
  comm.setTaskState(t.id, 'running');
  comm.recordResult(t.id, { agentId: ids.lucas, runId: run.id, body: 'ok', verified: true, level: 'run', verification: 'simulé' });
  comm.setTaskState(t.id, 'done');
  assert.ok(comm.reusableAutomation('lucas', 'k', 3_600_000));
  engines.setAgentChoice(ids.lucas, claude('opus'));
  assert.equal(comm.reusableAutomation('lucas', 'k', 3_600_000), null);
  assert.throws(() => comm.setTaskEngine(t.id, claude('haiku')), /automatisation/);
});

test('moteur indisponible : la tâche attend avec le motif, sans essai consommé', () => {
  const { comm, ids } = setup();
  const t = comm.createTask({ assigneeId: ids.ryan, instruction: 'Code' }).task;
  assert.equal(comm.claimNext({ blocked: () => 'Opus indisponible' }).task, null);
  const waiting = comm.task(t.id);
  assert.deepEqual([waiting.state, waiting.attempts, waiting.stateNote], ['queued', 0, 'Opus indisponible']);
  assert.equal(comm.claimNext({ blocked: () => '' }).task.id, t.id);
});

test('changement manuel : seulement sur une tâche non partie, tracé dans le fil', () => {
  const { comm, ids } = setup();
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  const changed = comm.setTaskEngine(t.id, claude('opus'));
  assert.deepEqual([changed.model, changed.engineSource], ['opus', 'task']);
  assert.ok(comm.listMessages(t.threadId, null, 100).items.some((m) => /Moteur changé/.test(m.body)));
  assert.equal(comm.setTaskEngine(t.id, null).engineSource, 'fiche');
  comm.setTaskState(t.id, 'running');
  assert.throws(() => comm.setTaskEngine(t.id, claude('opus')), /ne se change que/);
});

test('journal : le moteur voyage ; absent il est conservé, inconnu il est gardé tel quel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot2-'));
  try {
    const a = setup({ commJournalDir: dir, device: 'pc-a' }), b = setup({ commJournalDir: dir, device: 'pc-b' });
    const t = a.comm.createTask({ assigneeId: a.ids.lucas, instruction: 'Audit', engine: claude('opus') }).task;
    b.comm.importJournal();
    assert.deepEqual([b.comm.task(t.id).model, b.comm.task(t.id).engineSource], ['opus', 'mission']);
    assert.equal(b.engines.resolve(b.ids.lucas, t.missionId).model, 'opus');
    const last = readFileSync(join(dir, 'pc-a.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'task').at(-1);
    const send = (n, data) => { writeFileSync(join(dir, `pc-z${n}.jsonl`), `${JSON.stringify({ ...last, eid: `z-${n}`, device: 'pc-z', at: new Date(Date.now() + n * 1000).toISOString(), rev: 90 + n, data })}\n`); b.comm.importJournal(); };
    const old = { ...last.data }; delete old.provider; delete old.model; delete old.engineSource;
    send(1, old);
    assert.equal(b.comm.task(t.id).model, 'opus');
    send(2, { ...last.data, provider: 'codex', model: 'x' });
    assert.equal(b.comm.task(t.id).provider, 'codex');
    assert.match(b.engines.reason(b.engines.ofTask(b.comm.task(t.id))), /Codex/);
    a.studio.close(); b.studio.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { createOrchestrator } from '../src/comm-run.js';
import { createApp } from '../src/app.js';

test('lanceur : le moteur figé est celui appelé ; indisponible, rien ne part', async () => {
  const { studio, comm, ids } = setup(); const models = []; let down = true;
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: async (o) => { models.push(o.model); return JSON.stringify({ report: 'ok' }); }, engineReason: (e) => (down && e?.model === 'opus' ? 'Opus indisponible' : '') });
  const opus = comm.createTask({ assigneeId: ids.ryan, instruction: 'Code' }).task;
  const haiku = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit', engine: claude('haiku') }).task;
  orch.pump(); await orch.idle();
  assert.deepEqual(models, ['haiku']);
  assert.equal(comm.task(opus.id).state, 'queued'); assert.equal(comm.task(opus.id).attempts, 0);
  assert.equal(comm.runsOfTask(haiku.id)[0].model, 'haiku');
  down = false; orch.pump(); await orch.idle();
  assert.deepEqual(models, ['haiku', 'opus']);
});

async function withApp(options, fn) {
  const { studio, comm, engines, ids } = setup(); const models = [];
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async (o) => { models.push(o.model); return 'ok'; }, agentFiles: { profiles }, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, data, headers = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text.trim().split('\n').at(-1)) : null }; };
  try { await fn({ studio, comm, engines, ids, models, call, orch: server.orchestrator }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); studio.close(); }
}

test('API : choisir, refuser, appliquer à la discussion, à la mission et à la tâche', () => withApp({}, async ({ studio, ids, models, call, orch }) => {
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, { engine: claude('opus') })).status, 200);
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, { engine: { provider: 'codex', model: 'x' } })).status, 400);
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, {})).status, 400);
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, { engine: null }, { origin: 'https://evil.invalid' })).status, 403);
  await call('POST', `/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
  await call('POST', `/api/agents/${ids.lucas}/reply`, {});
  assert.equal(models.at(-1), 'opus');
  const m = studio.createMission({ title: 'Mission', assignedTo: ids.lucas });
  assert.equal((await call('PUT', `/api/missions/${m.id}/engine`, { engine: claude('haiku') })).body.choice.model, 'haiku');
  await call('POST', `/api/missions/${m.id}/discussion`, { body: 'Un point ?' });
  await call('POST', `/api/missions/${m.id}/discussion/reply/${ids.lucas}`, {});
  assert.equal(models.at(-1), 'haiku');
  const made = await call('POST', '/api/comm/delegations', { assigneeId: ids.noah, instruction: 'Veille', engine: claude('opus'), requiresApproval: false });
  assert.equal(made.body.task.model, 'opus');
  await orch.idle();
  const view = (await call('GET', '/api/engines')).body;
  assert.equal(view.catalog.find((p) => p.provider === 'codex').state, 'disabled');
  assert.equal(view.agents.find((a) => a.slug === 'lucas').effective.source, 'agent');
}));

test('API : un appel immédiat sur un moteur indisponible est refusé clairement', () => withApp({ engineReason: () => 'Moteur indisponible.' }, async ({ ids, models, call }) => {
  await call('POST', `/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
  const r = await call('POST', `/api/agents/${ids.lucas}/reply`, {});
  assert.equal(r.status, 409); assert.equal(r.body.error, 'Moteur indisponible.'); assert.equal(models.length, 0);
  const made = await call('POST', '/api/comm/delegations', { assigneeId: ids.lucas, instruction: 'Audit' });
  assert.equal((await call('POST', `/api/comm/tasks/${made.body.task.id}/engine`, {})).status, 400);
  assert.equal((await call('POST', `/api/comm/tasks/${made.body.task.id}/engine`, { engine: claude('haiku') })).body.model, 'haiku');
}));

import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';
import { runWorkerOnce } from '../src/worker-client.js';

test('central : sans worker pour le modèle choisi la tâche attend ; un worker adapté la prend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot2-c-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), port: 0, env: {} });
  try {
    const { comm, engines } = runtime.studio;
    const lucas = runtime.studio.listAgentFiles().find((f) => f.slug === 'lucas').agentId;
    runtime.broker.heartbeat(runtime.broker.enroll({ name: 'sonnet', models: ['sonnet'] }).id);
    engines.setAgentChoice(lucas, claude('haiku'));
    const t = comm.createTask({ assigneeId: lucas, instruction: 'Résumer' }).task;
    runtime.app.orchestrator.pump();
    assert.equal(comm.task(t.id).state, 'queued'); assert.match(comm.task(t.id).stateNote, /haiku/);
    const h = runtime.broker.enroll({ name: 'haiku', models: ['haiku'] }); runtime.broker.heartbeat(h.id);
    runtime.app.orchestrator.pump();
    await runWorkerOnce({ baseUrl: runtime.origin, token: h.token, models: ['haiku'], runner: async (o) => { assert.equal(o.model, 'haiku'); return JSON.stringify({ report: 'ok' }); } });
    await runtime.app.orchestrator.idle();
    assert.equal(comm.task(t.id).state, 'done');
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

import { engineLabel, engineFromValue, engineOptions, affectedAutomations } from '../public/engine-view.js';

test('écran : libellés, options et automatisations concernées', () => {
  assert.equal(engineLabel(claude('opus')), 'Claude Opus');
  assert.equal(engineLabel(null), 'Moteur inconnu');
  assert.deepEqual(engineFromValue('claude:haiku'), claude('haiku')); assert.equal(engineFromValue(''), null);
  const options = engineOptions([{ provider: 'claude', label: 'Claude', state: 'available', models: [{ model: 'opus', reason: 'x' }] }, { provider: 'codex', label: 'Codex', state: 'disabled', reason: 'Désactivé.', models: [] }], 'Fiche');
  assert.deepEqual(options.map((o) => [o.value, o.disabled]), [['', false], ['claude:opus', false], ['codex:', true]]);
  assert.match(options[1].label, /indisponible/);
  assert.deepEqual(affectedAutomations([{ name: 'A', enabled: true, allowAi: true, agentSlug: 'lucas' }, { name: 'B', enabled: false, allowAi: true, agentSlug: 'lucas' }], 'lucas'), ['A']);
});

test('à vérifier : un résultat ne se valide pas sous un autre moteur que celui qui l’a produit', () => {
  const { comm, ids } = setup();
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  const run = comm.startRun({ agentId: ids.lucas, kind: 'task', taskId: t.id, model: 'sonnet' }); comm.endRun(run.id, { state: 'done' });
  comm.setTaskState(t.id, 'running');
  comm.recordResult(t.id, { agentId: ids.lucas, runId: run.id, body: 'ok', verified: false, level: 'none', verification: 'simulé' });
  comm.setTaskState(t.id, 'review');
  comm.setTaskEngine(t.id, claude('opus'));
  assert.throws(() => comm.verifyTask(t.id), /autre moteur/);
  assert.equal(comm.task(t.id).state, 'review');
  comm.setTaskEngine(t.id, null);
  assert.equal(comm.verifyTask(t.id).state, 'done');
});
