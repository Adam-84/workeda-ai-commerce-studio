// Régressions trouvées à la relecture du choix du moteur : dépense supplémentaire, budget, automatisations et écrans.
// Bases temporaires, runners et workers simulés : aucun appel IA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { createAutomationRunner } from '../src/automation-run.js';
import { observeTools } from '../src/comm-core.js';
import { cleanSignal } from '../src/engines.js';
import { runWorkerOnce } from '../src/worker-client.js';
import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';
import * as engineView from '../public/engine-view.js';
import { buildDashboard } from '../public/dashboard-view.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}) {
  const studio = createStudio(':memory:', { env: {}, shopConnector: null, ...options }); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, engines: studio.engines, ids };
}
const soon = () => Math.floor(Date.now() / 1000) + 3600;
const event = (info) => ({ type: 'rate_limit_event', rate_limit_info: info });
const model = (name) => ({ provider: 'claude', model: name });
const quota = (extra = {}) => ({ status: 'allowed', window: 'five_hour', utilization: null, resetsAt: new Date(soon() * 1000).toISOString(), source: 'local', ...extra });

test('dépense supplémentaire : seul un « non » explicite de la même fenêtre lève la retenue', () => {
  const { studio, comm, engines, ids } = setup();
  try {
    const resetsAt = soon(), seen = observeTools();
    seen.feed(event({ status: 'allowed', rateLimitType: 'five_hour', resetsAt, isUsingOverage: true }));
    seen.feed(event({ status: 'allowed', rateLimitType: 'seven_day', resetsAt }));
    seen.feed(event({ status: 'allowed', rateLimitType: 'five_hour', resetsAt })); // même fenêtre, information absente
    const run = comm.startRun({ agentId: ids.lucas, kind: 'task', model: 'sonnet' });
    comm.endRun(run.id, { quota: seen.state.quota });
    assert.match(engines.reason(model('sonnet')), /Dépense supplémentaire/);
    const same = new Date(resetsAt * 1000).toISOString();
    engines.recordSignals('claude', [quota({ window: 'seven_day', resetsAt: same, overage: false })]);
    engines.recordSignals('claude', [quota({ resetsAt: same })]);
    assert.match(engines.reason(model('sonnet')), /Dépense supplémentaire/);
    engines.recordSignals('claude', [quota({ resetsAt: same, overage: false })]);
    assert.equal(engines.reason(model('sonnet')), '');
  } finally { studio.close(); }
});

test('dépense supplémentaire sur une fenêtre Opus : tous les modèles attendent, la confirmation les libère', () => {
  const { studio, engines } = setup();
  try {
    engines.recordSignals('claude', [quota({ window: 'seven_day_opus', overage: true })]);
    for (const name of ['opus', 'sonnet', 'haiku']) assert.match(engines.reason(model(name)), /Dépense supplémentaire/, name);
    assert.equal(engines.signals()[0].resumable, true);
    engines.resume('claude', 'local');
    assert.equal(engines.reason(model('sonnet')), '');
    engines.recordSignals('claude', [quota({ window: 'seven_day_opus', status: 'rejected', overage: true })]);
    assert.match(engines.reason(model('sonnet')), /Dépense supplémentaire/);
    assert.match(engines.reason(model('opus')), /reprise après/);
    assert.equal(engines.signals()[0].resumable, true);
    engines.resume('claude', 'local');
    assert.equal(engines.reason(model('sonnet')), '');
    assert.match(engines.reason(model('opus')), /reprise après/, 'la confirmation ne lève pas le refus daté');
  } finally { studio.close(); }
});

test('worker : un second relevé sans l’information garde la dépense signalée', async (t) => {
  let reported;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/worker/claim') return res.end(JSON.stringify({ job: { id: 'job', type: 'claude.text', leaseToken: 'lease', payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'q', tools: [], timeoutMs: 2000 } } }));
    if (req.url.endsWith('/complete')) reported = JSON.parse(body).result;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  await runWorkerOnce({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'token', models: ['sonnet'], runner: async (o) => {
    o.onEvent(event({ status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: true }));
    o.onEvent(event({ status: 'allowed', rateLimitType: 'five_hour' }));
    return 'ok';
  } });
  assert.equal(reported.quota[0].overage, true);
});

const refusing = (extra = () => {}) => async (o) => { extra(o); o.onEvent(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() })); throw new Error('Limite d’utilisation de Claude atteinte.'); };

test('budget : une demande refusée par Claude avant toute réponse ne coûte rien', async () => {
  const { studio, comm, ids } = setup();
  try {
    const orch = createOrchestrator({ studio, profiles: () => profiles, runner: refusing() });
    const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit refusé', budgetUsd: 0.5 }).task;
    orch.pump(); await orch.idle();
    assert.deepEqual([comm.task(t.id).spentUsd, comm.task(t.id).unreportedRuns, comm.recentRuns()[0].state], [0, 0, 'refused']);
  } finally { studio.close(); }
});

test('budget : un refus après le début d’une réponse reste estimé', async () => {
  const { studio, comm, ids } = setup();
  try {
    const orch = createOrchestrator({ studio, profiles: () => profiles, runner: refusing((o) => o.onEvent({ type: 'assistant', message: { model: 'claude-sonnet-5', content: [] } })) });
    const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit interrompu', budgetUsd: 0.5 }).task;
    orch.pump(); await orch.idle();
    assert.deepEqual([comm.task(t.id).spentUsd, comm.recentRuns()[0].state], [0.25, 'error']);
  } finally { studio.close(); }
});

test('budget : une réponse refusée dans un fil ne coûte rien non plus', async () => {
  const { studio, comm, ids } = setup();
  try {
    const orch = createOrchestrator({ studio, profiles: () => profiles, runner: refusing() });
    const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Fil', budgetUsd: 0.5, requiresApproval: false }).task;
    comm.cancelTask(t.id, 'test');
    const thread = comm.createThread({ kind: 'direct', members: [ids.lucas] });
    comm.postMessage(thread.id, { body: 'Bonjour' });
    orch.replyInThread(thread.id, ids.lucas); await orch.idle();
    assert.equal(comm.recentRuns()[0].state, 'refused');
  } finally { studio.close(); }
});

test('automatisation : une analyse retenue par le quota repart quand le moteur revient', async () => {
  const { studio, engines } = setup({ automationIdentity: 'pc' });
  try {
    const a = studio.automation; a.designate({ confirm: true });
    const d = a.save({ name: 'Suivi', agentSlug: 'olivia', objective: 'Résumer', sources: ['missions'], allowAi: true, trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } });
    a.activate(d.id, { confirm: true, ai: true }); const r = a.manual(d.id, { confirm: true });
    const resetsAt = new Date(soon() * 1000).toISOString();
    engines.recordSignals('claude', [quota({ status: 'rejected', resetsAt })]);
    const runner = createAutomationRunner({ studio });
    await runner.tick(); await runner.tick();
    assert.equal(a.run(r.id).state, 'waiting_ai');
    engines.recordSignals('claude', [quota({ resetsAt })]);
    await runner.tick();
    assert.equal(a.run(r.id).state, 'dispatched', a.run(r.id).note);
  } finally { studio.close(); }
});

const signal = (extra = {}) => ({ provider: 'claude', source: 'local', window: 'seven_day_opus', status: 'rejected', utilization: null, resetsAt: new Date(soon() * 1000).toISOString(), overage: false, observedAt: new Date().toISOString(), stale: false, blocking: 'x', ...extra });
const catalog = (held = []) => [{ provider: 'claude', label: 'Claude', state: 'available', models: ['opus', 'sonnet', 'haiku'].map((m) => ({ model: m, reason: held.includes(m) ? 'retenu' : '' })) }];
const card = (engines) => buildDashboard({ engines }).find((c) => c.id === 'quotas');

test('tableau de bord : le blocage annoncé est limité aux modèles réellement retenus', () => {
  assert.equal(card({ signals: [signal()], catalog: catalog(['opus']) }).value, 'Claude Opus en attente');
  assert.equal(card({ signals: [signal()], catalog: catalog(['opus', 'haiku']) }).value, 'Claude Opus et Haiku en attente');
  assert.equal(card({ signals: [signal()], catalog: catalog(['opus', 'sonnet', 'haiku']) }).value, 'Claude en attente');
  const elsewhere = card({ signals: [signal({ source: 'worker-a' })], catalog: catalog() });
  assert.equal(elsewhere.value, 'Claude autorisé'); assert.equal(elsewhere.tone, 'warn'); assert.match(elsewhere.detail, /Une source est retenue/);
});

test('serveur central : les relevés d’un worker révoqué ne sont plus affichés', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-revue-'));
  const password = 'test-only-password-long';
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword(password), env: {} });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = (path, init = {}) => fetch(runtime.origin + path, { ...init, headers: { origin: runtime.origin, 'content-type': 'application/json', ...init.headers } });
  const cookie = (await call('/auth/login', { method: 'POST', body: JSON.stringify({ password }) })).headers.get('set-cookie').split(';')[0];
  const [kept, gone] = ['a', 'b'].map((name) => runtime.broker.enroll({ name, models: ['sonnet'] }));
  for (const w of [kept, gone]) runtime.studio.engines.recordSignals('claude', [quota({ source: w.id, status: 'rejected' })]);
  runtime.broker.revoke(gone.id);
  const body = await (await call('/api/engines', { headers: { cookie } })).json();
  assert.deepEqual(body.signals.map((s) => s.source), [kept.id]);
});

test('formulaire de tâche : le bouton reste inactif tant que le choix affiché n’a pas changé', () => {
  const select = { value: 'claude:opus' }, button = { disabled: false };
  engineView.armOnChange(select, button); assert.equal(button.disabled, true);
  select.value = ''; select.onchange(); assert.equal(button.disabled, false);
  select.value = 'claude:opus'; select.onchange(); assert.equal(button.disabled, true);
  const ui = readFileSync(new URL('../public/comm-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /optionNodes\(h, d\.catalog, t\.model \? t : null, 'Choix par défaut'\)\); armOnChange\(select, apply\);/);
});

test('quota : le taux est une fraction, toute autre unité reste inconnue', () => {
  assert.equal(cleanSignal({ status: 'allowed', utilization: 0.42 }).utilization, 0.42);
  assert.equal(cleanSignal({ status: 'allowed', utilization: 1 }).utilization, 1);
  assert.equal(cleanSignal({ status: 'allowed', utilization: 42 }).utilization, null);
});
