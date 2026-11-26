import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createAutomationRunner } from '../src/automation-run.js';
import { createOrchestrator } from '../src/comm-run.js';
import { fileURLToPath } from 'node:url';
const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const def = { name: 'Suivi', agentSlug: 'olivia', objective: 'Résumer les états accessibles sans délégation', sources: ['missions'], trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } };
function setup() { const studio = createStudio(':memory:', { automationIdentity: 'test-pc', shopConnector: null, env: {} }); studio.syncAgentFiles(profiles); return studio; }
test('manual deterministic execution creates one mission and no AI invocation', async () => {
  const s = setup(); try {
    s.automation.designate({ confirm: true }); const d = s.automation.save(def); s.automation.manual(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s }); await worker.tick(); await worker.tick();
    assert.equal(s.automation.history()[0].state, 'done'); assert.equal(s.listMissions().length, 1);
    assert.equal(s.comm.recentRuns().length, 0);
  } finally { s.close(); }
});
test('AI tasks are linked once and pause before claim prevents the actual runner', async () => {
  const s = setup(); let calls = 0; try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true });
    s.automation.manual(d.id, { confirm: true, ai: true }); const worker = createAutomationRunner({ studio: s }); await worker.tick();
    const r = s.automation.history()[0]; assert.equal(r.state, 'dispatched'); assert.ok(r.task_id); assert.equal(s.comm.listTasks().length, 1);
    s.automation.pause(true);
    const orch = createOrchestrator({ studio: s, profiles: () => profiles, runner: async () => { calls++; return 'Test'; } }); orch.pump(); await orch.idle();
    assert.equal(calls, 0);
  } finally { s.close(); }
});
test('grant revoked after preparation blocks integration analysis and missing sources never invoke AI', async () => {
  const s = setup(); try {
    s.automation.designate({ confirm: true });
    const d = s.automation.save({ ...def, sources: ['shopify_apps'], allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    await createAutomationRunner({ studio: s }).tick();
    assert.equal(s.automation.history()[0].state, 'blocked'); assert.equal(s.comm.listTasks().length, 0);
  } finally { s.close(); }
});
test('simulated AI runs once without tools or delegation, result awaits honest verification', async () => {
  const s = setup(); let calls = 0; try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s }); await worker.tick();
    const orch = createOrchestrator({ studio: s, profiles: () => profiles, runner: async ({ tools }) => { calls++; assert.deepEqual(tools, []); return 'Rapport simulé : aucun appel externe.'; } });
    orch.pump(); await orch.idle(); await worker.tick();
    assert.equal(calls, 1); assert.equal(s.comm.listTasks().length, 1); assert.ok(['done', 'awaiting_approval'].includes(s.automation.history()[0].state));
  } finally { s.close(); }
});
test('revoking an actual grant after enqueue stops the prepared AI task', async () => {
  const s = setup(); let calls = 0; try {
    s.integrations.apps.add({ name: 'App locale', function: 'autre', status: 'declared', billingPeriod: 'monthly', costAmount: 10, costCurrency: 'EUR' });
    s.integrations.grant('shopify_apps', 'maxime'); s.automation.designate({ confirm: true });
    const d = s.automation.save({ ...def, agentSlug: 'maxime', sources: ['shopify_apps'], allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    await createAutomationRunner({ studio: s }).tick(); assert.equal(s.comm.listTasks().length, 1);
    s.integrations.revokeGrant('shopify_apps', 'maxime');
    const orch = createOrchestrator({ studio: s, profiles: () => profiles, runner: async () => { calls++; return 'No'; } }); orch.pump(); await orch.idle(); assert.equal(calls, 0);
    await createAutomationRunner({ studio: s }).tick(); assert.equal(s.automation.history()[0].state, 'blocked');
  } finally { s.close(); }
});
test('AI interruption is uncertain and never automatically retried', async () => {
  const s = setup(); let calls = 0; try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s }); await worker.tick();
    const orch = createOrchestrator({ studio: s, profiles: () => profiles, runner: async () => { calls++; throw new Error('timeout simulé'); } }); orch.pump(); await orch.idle(); await worker.tick(); orch.pump(); await orch.idle();
    assert.equal(calls, 1); assert.equal(s.automation.status().aiPaused, true); assert.equal(s.automation.history()[0].state, 'uncertain');
  } finally { s.close(); }
});
test('verified unchanged analysis is reused even after the call quota is consumed', async () => {
  const s = setup(); let calls = 0; try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, allowAi: true, perDay: 1 }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s }); await worker.tick();
    const orch = createOrchestrator({ studio: s, profiles: () => profiles, runner: async () => { calls++; return 'Rapport simulé'; } }); orch.pump(); await orch.idle();
    const t = s.comm.listTasks()[0]; if (t.state === 'review') s.comm.verifyTask(t.id, 'Vérification simulée humaine'); await worker.tick();
    const next = s.automation.manual(d.id, { confirm: true }); await worker.tick();
    assert.equal(calls, 1); assert.equal(s.comm.listTasks().length, 1); assert.equal(s.automation.run(next.id).state, 'done');
  } finally { s.close(); }
});
test('stale-data trigger creates a metadata-only warning without analysing old content with AI', async () => {
  let time = Date.parse('2026-11-25T07:00:00Z');
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {}, clock: () => new Date(time).toISOString(), nowMs: () => time }); s.syncAgentFiles(profiles);
  try {
    s.integrations.apps.add({ name: 'Ancienne app simulée', function: 'autre', status: 'declared', billingPeriod: 'monthly', costAmount: 10, costCurrency: 'EUR' }); s.integrations.grant('shopify_apps', 'maxime'); s.automation.designate({ confirm: true });
    const d = s.automation.save({ ...def, agentSlug: 'maxime', sources: ['shopify_apps'], allowAi: true, freshnessMinutes: 5, trigger: { kind: 'condition', condition: { kind: 'stale', minutes: 5 } } }); s.automation.activate(d.id, { confirm: true, ai: true });
    time += 10 * 60000; await createAutomationRunner({ studio: s, clock: () => new Date(time).toISOString() }).tick();
    assert.equal(s.automation.history()[0].state, 'done'); assert.equal(s.listMissions().length, 1); assert.equal(s.comm.listTasks().length, 0); assert.match(s.listMissions()[0].contextText, /périmées/i);
  } finally { s.close(); }
});
test('Comms cannot reuse a verified analysis beyond the rule freshness window', async () => {
  let time = Date.parse('2026-11-25T07:00:00Z');
  const clock = () => new Date(time).toISOString();
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {}, clock, nowMs: () => time }); s.syncAgentFiles(profiles);
  try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, allowAi: true, freshnessMinutes: 60 }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s, clock }); await worker.tick();
    const task = s.comm.listTasks()[0], claimed = s.comm.claimNext().task; assert.equal(claimed.id, task.id);
    const run = s.comm.startRun({ agentId: task.assigneeId, kind: 'task', taskId: task.id, threadId: task.threadId }); s.comm.endRun(run.id, { state: 'done', costUsd: .01, usage: { input: 10, output: 10 } });
    s.comm.recordResult(task.id, { agentId: task.assigneeId, runId: run.id, summary: 'Simulé', body: 'Résultat simulé vérifié humainement', verified: true, level: 'manual', verification: 'Fixture' }); s.comm.setTaskState(task.id, 'done'); await worker.tick();
    time += 2 * 86400000; const next = s.automation.manual(d.id, { confirm: true }); await worker.tick();
    assert.equal(s.comm.listTasks().length, 2); assert.equal(s.automation.run(next.id).state, 'dispatched');
  } finally { s.close(); }
});
test('price variation uses comparable Admin observations and establishes a baseline first', async () => {
  let time = Date.parse('2026-11-25T07:00:00Z'), price = 100; const clock = () => new Date(time).toISOString();
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {}, clock, nowMs: () => time }); s.syncAgentFiles(profiles);
  try {
    s.shop.latestAdmin = () => ({ fetchedAt: clock(), domain: 'simulated.myshopify.com', products: [{ id: 'p1', currency: 'EUR', variants: [{ id: 'v1', sku: 'SIM-1', price }] }], partial: false });
    s.integrations.grant('shopify_admin', 'isabella'); s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, agentSlug: 'isabella', sources: ['shopify_admin'], trigger: { kind: 'condition', condition: { kind: 'variation', percent: 10 } } }); s.automation.activate(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s, clock }); await worker.tick(); assert.equal(s.automation.history().length, 0);
    time += 60000; price = 115; await worker.tick(); assert.equal(s.automation.history().length, 1); assert.equal(s.automation.history()[0].state, 'done');
    await worker.tick(); assert.equal(s.automation.history().length, 1);
  } finally { s.close(); }
});
test('resolved logistics anomaly does not generate a new anomaly mission', async () => {
  let time = Date.parse('2026-11-25T07:00:00Z'); const clock = () => new Date(time).toISOString();
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {}, clock, nowMs: () => time }); s.syncAgentFiles(profiles);
  try {
    s.integrations.grant('track17', 'harper'); s.automation.designate({ confirm: true }); const d = s.automation.save({ ...def, agentSlug: 'harper', sources: ['track17'], trigger: { kind: 'event', event: 'logistics.anomaly' } }); s.automation.activate(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s, clock }); const snapshot = (status) => s.integrations.store.saveSnapshot({ integration: 'track17', kind: 'packages', payload: { packages: [{ status, trackingKey: 'simulated' }] } });
    snapshot('Delivered'); await worker.tick(); time += 60000; snapshot('Exception'); await worker.tick(); assert.equal(s.automation.history().length, 1);
    time += 2 * 3600000; snapshot('Delivered'); await worker.tick(); assert.equal(s.automation.history().length, 1);
  } finally { s.close(); }
});
