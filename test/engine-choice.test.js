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
