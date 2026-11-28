// Lot 3 : quota observé. Événements simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaOfEvent, signalReason } from '../src/engines.js';
import { observeTools } from '../src/comm-core.js';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const later = '2026-11-27T14:00:00.000Z', past = '2026-11-27T08:00:00.000Z';
const event = (info, extra = {}) => ({ type: 'rate_limit_event', rate_limit_info: info, ...extra });
const opus = { provider: 'claude', model: 'opus' }, sonnet = { provider: 'claude', model: 'sonnet' };
const signal = (extra = {}) => ({ status: 'allowed', window: 'five_hour', utilization: null, resetsAt: later, overage: false, ...extra });

test('événement : champs bornés, absents laissés inconnus, inconnu ignoré', () => {
  assert.deepEqual(quotaOfEvent(event({ status: 'rejected', resetsAt: Date.parse(later) / 1000, rateLimitType: 'seven_day_opus' })), { status: 'rejected', window: 'seven_day_opus', utilization: null, resetsAt: later, overage: null, source: 'local' });
  assert.equal(quotaOfEvent(event({ status: 'allowed' })).resetsAt, null);
  assert.equal(quotaOfEvent(event({ status: 'allowed', rateLimitType: 'nouvelle' })).window, 'unknown');
  assert.equal(quotaOfEvent(event({ status: 'autre' })), null);
  assert.equal(quotaOfEvent({ type: 'result' }), null);
  assert.equal(quotaOfEvent(event({ status: 'allowed' }, { archipel_source: 'worker-1' })).source, 'worker-1');
  const seen = observeTools();
  seen.feed(event({ status: 'allowed', rateLimitType: 'five_hour' })); seen.feed(event({ status: 'rejected', rateLimitType: 'five_hour' }));
  assert.deepEqual(seen.state.quota.map((q) => q.status), ['rejected']);
});

test('jugement : refus daté, fenêtre par modèle, relevé périmé, confirmations', () => {
  assert.match(signalReason(signal({ status: 'rejected' }), sonnet, NOW), /reprise après/);
  assert.equal(signalReason(signal({ status: 'rejected', window: 'seven_day_opus' }), sonnet, NOW), '');
  assert.match(signalReason(signal({ status: 'rejected', window: 'seven_day_opus' }), opus, NOW), /Limite/);
  assert.equal(signalReason(signal({ status: 'rejected', resetsAt: past }), sonnet, NOW), '');
  const open = signal({ status: 'rejected', resetsAt: null });
  assert.match(signalReason(open, sonnet, NOW), /confirmez/);
  assert.equal(signalReason({ ...open, confirmedUntil: later }, sonnet, NOW), '');
  assert.match(signalReason({ ...signal({ status: 'rejected' }), confirmedUntil: later }, sonnet, NOW), /reprise après/);
  assert.match(signalReason(signal({ overage: true }), sonnet, NOW), /Dépense supplémentaire/);
  assert.equal(signalReason({ ...signal({ overage: true }), confirmedUntil: later }, sonnet, NOW), '');
  assert.equal(signalReason(signal(), sonnet, NOW), '');
});

import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}) {
  const studio = createStudio(':memory:', options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, engines: studio.engines, ids };
}

test('stockage : aucun signal ne bloque rien ; refus enregistré à la fin d’une exécution', () => {
  const { comm, engines, ids } = setup({ clock: () => new Date(NOW).toISOString() });
  assert.deepEqual(engines.signals(), []); assert.equal(engines.reason(sonnet), '');
  const r = comm.startRun({ agentId: ids.lucas, kind: 'task', model: 'sonnet' });
  comm.endRun(r.id, { state: 'error', error: 'limite', quota: [{ ...signal({ status: 'rejected' }), source: 'local' }] });
  assert.match(engines.reason(sonnet), /reprise après/);
  assert.equal(engines.reason(sonnet, 'autre-source'), '');
  assert.equal(engines.signals()[0].resumable, false);
  assert.throws(() => engines.resume('claude', 'local'), { status: 409 });
});

test('dépassement : confirmation conservée jusqu’à la remise à zéro ; un nouveau refus rebloque', () => {
  const { engines } = setup({ clock: () => new Date(NOW).toISOString() });
  const over = [{ ...signal({ overage: true }), source: 'local' }];
  engines.recordSignals('claude', over);
  assert.match(engines.reason(opus), /Dépense/);
  engines.resume('claude', 'local');
  engines.recordSignals('claude', over);
  assert.equal(engines.reason(opus), '');
  assert.equal(engines.signals()[0].confirmedUntil, later);
  const open = [{ ...signal({ status: 'rejected', window: 'seven_day', resetsAt: null }), source: 'local' }];
  engines.recordSignals('claude', open); engines.resume('claude', 'local');
  assert.equal(engines.reason(opus), '');
  engines.recordSignals('claude', open);
  assert.match(engines.reason(opus), /confirmez/);
  engines.recordSignals('claude', [{ ...signal({ window: 'seven_day', resetsAt: null }), source: 'local' }]);
  assert.equal(engines.reason(opus), '');
});

import { createOrchestrator } from '../src/comm-run.js';
import { createApp } from '../src/app.js';

// Les tests du lanceur utilisent l'horloge réelle : la remise à zéro est dans une heure.
const soon = () => Math.floor(Date.now() / 1000) + 3600;

test('refus : la tâche retourne en file, essai rendu, et rien ne repart avant la remise à zéro', async () => {
  const { studio, comm, ids } = setup(); let calls = 0;
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: async (o) => { calls += 1; o.onEvent(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() })); throw new Error('Limite d’utilisation de Claude atteinte. Réessayez plus tard.'); } });
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  orch.pump(); await orch.idle(); orch.pump(); await orch.idle();
  const after = comm.task(t.id);
  assert.deepEqual([after.state, after.attempts, calls], ['queued', 0, 1]);
  assert.match(after.stateNote, /Limite Claude/);
});

test('dépassement : la tâche en cours se termine, la suivante attend la confirmation', async () => {
  const { studio, comm, engines, ids } = setup(); let calls = 0;
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: async (o) => { calls += 1; o.onEvent(event({ status: 'allowed', rateLimitType: 'overage', resetsAt: soon(), isUsingOverage: true })); return JSON.stringify({ report: 'ok' }); } });
  const a = comm.createTask({ assigneeId: ids.lucas, instruction: 'Un' }).task;
  orch.pump(); await orch.idle();
  const b = comm.createTask({ assigneeId: ids.noah, instruction: 'Deux' }).task;
  orch.pump(); await orch.idle();
  assert.deepEqual([comm.task(a.id).state, comm.task(b.id).state, calls], ['done', 'queued', 1]);
  engines.resume('claude', 'local'); orch.pump(); await orch.idle();
  assert.equal(comm.task(b.id).state, 'done');
});

test('API : discussion refusée pendant le blocage, reprise seulement confirmée', async () => {
  const { studio, ids } = setup();
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async () => 'ok', agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, data) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: r.status, body: JSON.parse((await r.text()).trim().split('\n').at(-1)) }; };
  try {
    studio.engines.recordSignals('claude', [{ status: 'rejected', window: 'five_hour', resetsAt: null, overage: false, source: 'local' }]);
    await call('POST', `/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
    assert.equal((await call('POST', `/api/agents/${ids.lucas}/reply`, {})).status, 409);
    assert.equal((await call('GET', '/api/engines')).body.signals[0].resumable, true);
    assert.equal((await call('POST', '/api/engines/claude/resume', { source: 'local' })).status, 400);
    assert.equal((await call('POST', '/api/engines/claude/resume', { source: 'local', confirm: true })).status, 200);
    assert.equal((await call('POST', `/api/agents/${ids.lucas}/reply`, {})).body.type, 'done');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); studio.close(); }
});

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerBroker } from '../src/worker-broker.js';
import { runWorkerOnce } from '../src/worker-client.js';
import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';

test('courtier : signal borné ; un modèle refusé n’est plus attribué à ce worker', () => {
  const db = new DatabaseSync(':memory:'), broker = createWorkerBroker(db, { models: ['sonnet'] });
  const w = broker.enroll({ name: 'w', models: ['sonnet'] });
  const add = (key) => broker.enqueue({ key, payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'q', tools: [], timeoutMs: 5000 } });
  add('a');
  assert.equal(broker.claim(w.id, { allow: () => false }), null);
  const job = broker.claim(w.id);
  assert.throws(() => broker.complete(w.id, job.id, job.leaseToken, { status: 'done', output: 'x', quota: [{ status: 'x' }] }), /quota/);
  const done = broker.complete(w.id, job.id, job.leaseToken, { status: 'done', output: 'x', quota: [{ status: 'allowed', window: 'five_hour', source: 'usurpée', extra: 1 }] });
  assert.deepEqual(done.result.quota, [{ status: 'allowed', window: 'five_hour', utilization: null, resetsAt: null, overage: null }]);
  db.close();
});

test('central : un worker refusé est mis de côté, un autre prend la tâche', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot3-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), port: 0, env: {} });
  try {
    const { comm, engines } = runtime.studio;
    const [a, b] = ['a', 'b'].map((name) => runtime.broker.enroll({ name, models: ['sonnet'] }));
    runtime.broker.heartbeat(a.id); runtime.broker.heartbeat(b.id);
    const lucas = runtime.studio.listAgentFiles().find((f) => f.slug === 'lucas').agentId;
    const t = comm.createTask({ assigneeId: lucas, instruction: 'Résumer' }).task;
    runtime.app.orchestrator.pump();
    const options = (w, runner) => ({ baseUrl: runtime.origin, token: w.token, models: ['sonnet'], runner });
    await runWorkerOnce(options(a, async (o) => { o.onEvent(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() })); throw new Error('limite simulée'); }));
    for (let i = 0; i < 100 && !runtime.broker.status().jobs.queued; i += 1) await delay(50);
    assert.equal(await runWorkerOnce(options(a, async () => 'jamais')), null);
    assert.match(engines.quotaReason(sonnet, a.id), /Limite/);
    await runWorkerOnce(options(b, async () => JSON.stringify({ report: 'ok' })));
    await runtime.app.orchestrator.idle();
    assert.equal(comm.task(t.id).state, 'done');
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

import { signalLine } from '../public/engine-view.js';
import { buildDashboard } from '../public/dashboard-view.js';

test('écran : inconnu sans relevé ou relevé périmé, jamais zéro', () => {
  const base = { provider: 'claude', source: 'local', window: 'five_hour', status: 'allowed', utilization: null, resetsAt: later, overage: false, observedAt: past, stale: false, blocking: '' };
  assert.match(signalLine(base), /Claude · cet ordinateur · fenêtre de 5 h : autorisé · consommation inconnue/);
  assert.match(signalLine({ ...base, utilization: 0.82 }), /82 % utilisés/);
  assert.match(signalLine({ ...base, stale: true }), /Inconnu \(relevé du .* périmé\)/);
  const quotas = (engines) => buildDashboard({ engines }).find((c) => c.id === 'quotas');
  assert.equal(quotas(null).value, 'Inconnu');
  assert.equal(quotas({ signals: [{ ...base, stale: true }] }).value, 'Inconnu');
  assert.equal(quotas({ signals: [base] }).value, 'Claude autorisé');
  assert.equal(quotas({ signals: [{ ...base, blocking: 'x' }] }).value, 'Claude en attente');
  assert.equal(quotas({ signals: [{ ...base, status: 'allowed_warning' }] }).tone, 'warn');
});

test('écran : carte courte, relevé le plus important d’abord, dépassement et reprise dits simplement', () => {
  const base = { provider: 'claude', source: 'local', window: 'five_hour', status: 'allowed', utilization: 0.4, resetsAt: later, overage: false, observedAt: past, stale: false, blocking: '' };
  const over = { ...base, window: 'overage', utilization: null, overage: true };
  assert.match(signalLine(over), /dépense supplémentaire : en cours/);
  assert.doesNotMatch(signalLine(over), /autorisé/);
  assert.match(signalLine({ ...over, confirmedUntil: later }), /reprise confirmée jusqu’au/);
  assert.doesNotMatch(signalLine({ ...over, confirmedUntil: later, blocking: 'x' }), /reprise confirmée/);
  const card = buildDashboard({ engines: { signals: [base, { ...over, blocking: 'x' }] }, usage: { quota: { remaining: 59, runsPerDay: 60 } } }).find((c) => c.id === 'quotas');
  assert.match(card.detail, /^dépense supplémentaire : en cours/);
  assert.match(card.detail, /1 autre relevé dans Comms/);
  assert.ok(card.detail.length < 300, `carte trop longue : ${card.detail.length} caractères`);
});
