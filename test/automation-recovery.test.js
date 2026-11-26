import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAutomationStore } from '../src/studio-automation.js';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { fileURLToPath } from 'node:url';
import { createAutomationRunner } from '../src/automation-run.js';
const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const def = { name: 'Audit', agentSlug: 'lucas', objective: 'Vérifier le catalogue', sources: ['catalog'], trigger: { kind: 'daily' } };
const valid = { ...def, trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } };

test('two SQLite connections share leases and preserve a single occurrence after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-auto-')); const path = join(dir, 'test.db'); let time = '2026-11-25T08:00:00.000Z'; const options = { identity: 'pc', clock: () => time, validateAgent: () => true };
  const db1 = new DatabaseSync(path), db2 = new DatabaseSync(path);
  try {
    const a = createAutomationStore(db1, options), b = createAutomationStore(db2, options); a.designate({ confirm: true }); const d = a.save(valid); a.manual(d.id, { confirm: true });
    const first = a.claim('worker-a'); assert.equal(b.claim('worker-b'), null);
    time = '2026-11-25T08:02:00.000Z'; const recovered = b.claim('worker-b'); assert.equal(recovered.id, first.id); assert.equal(a.owns(first.id, 'worker-a'), false); assert.equal(recovered.attempts, 2);
    b.finish(first.id, 'done'); assert.equal(a.claim('worker-a'), null);
    const other = createAutomationStore(db2, { ...options, identity: 'other-pc' }); assert.equal(other.status().owner, false);
  } finally { db1.close(); db2.close(); rmSync(dir, { recursive: true }); }
});
test('pause while simulated network collection awaits prevents creation of an AI task', async () => {
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {} }); s.syncAgentFiles(profiles);
  try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...valid, allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true, collect: ['catalog'] }); s.automation.manual(d.id, { confirm: true });
    let release, entered; const started = new Promise((resolve) => { entered = resolve; }); const blocked = new Promise((resolve) => { release = resolve; });
    s.integrations.realNetworkAllowed = () => true; s.shop.refresh = async () => { entered(); await blocked; return {}; };
    const runner = createAutomationRunner({ studio: s }); const tick = runner.tick(); await started; s.automation.pause(true); release(); await tick;
    assert.equal(s.comm.listTasks().length, 0); assert.equal(s.automation.history()[0].state, 'cancelled');
  } finally { s.close(); }
});
test('failed dispatch transaction leaves no orphan mission or task and preserves the occurrence', async () => {
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {} }); s.syncAgentFiles(profiles);
  try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...valid, agentSlug: 'olivia', sources: ['missions'], allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true }); s.automation.manual(d.id, { confirm: true });
    s.automation.link = () => { throw new Error('Crash simulé après création Comms'); };
    await createAutomationRunner({ studio: s }).tick(); assert.equal(s.listMissions().length, 0); assert.equal(s.comm.listTasks().length, 0); assert.equal(s.automation.history().length, 1);
  } finally { s.close(); }
});
test('mission transitions emit once, and repeated polling does not duplicate the event', async () => {
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {} }); s.syncAgentFiles(profiles);
  try {
    s.automation.designate({ confirm: true }); const d = s.automation.save({ ...valid, agentSlug: 'olivia', sources: ['missions'], trigger: { kind: 'event', event: 'mission.done' } }); s.automation.activate(d.id, { confirm: true });
    const m = s.createMission({ title: 'Mission manuelle simulée' }); const worker = createAutomationRunner({ studio: s }); await worker.tick();
    await new Promise((r) => setTimeout(r, 2)); s.setMissionState(m.id, 'done'); s.setMissionState(m.id, 'done'); await worker.tick(); await worker.tick();
    assert.equal(s.automation.history().length, 1);
  } finally { s.close(); }
});

test('resuming during a pending collection does not revive the occurrence cancelled by pause', async () => {
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {} }); s.syncAgentFiles(profiles);
  try {
    s.automation.designate({ confirm: true }); const d = s.automation.save(valid); s.automation.activate(d.id, { confirm: true, collect: ['catalog'] }); const r = s.automation.manual(d.id, { confirm: true });
    let release, entered, available = false; const started = new Promise((resolve) => { entered = resolve; }); const pending = new Promise((resolve) => { release = resolve; });
    s.integrations.realNetworkAllowed = () => true;
    s.shop.latest = () => available ? { fetchedAt: new Date().toISOString(), products: [], collections: [] } : null;
    s.shop.refresh = async () => { entered(); await pending; available = true; };
    const tick = createAutomationRunner({ studio: s }).tick(); await started;
    s.automation.pause(true); s.automation.pause(false); release(); await tick;
    assert.equal(s.automation.run(r.id).state, 'cancelled'); assert.equal(s.listMissions().length, 0);
  } finally { s.close(); }
});

for (const restartBeforeExpiry of [true, false]) test(`interrupted AI lease closes its run and suspends new calls (restart before expiry: ${restartBeforeExpiry})`, async () => {
  let ms = Date.parse('2026-11-25T07:00:00.000Z'); const clock = () => new Date(ms).toISOString();
  const s = createStudio(':memory:', { automationIdentity: 'pc', shopConnector: null, env: {}, clock, nowMs: () => ms }); s.syncAgentFiles(profiles);
  try {
    s.automation.designate({ confirm: true });
    const d = s.automation.save({ ...valid, agentSlug: 'olivia', sources: ['missions'], allowAi: true }); s.automation.activate(d.id, { confirm: true, ai: true }); const occurrence = s.automation.manual(d.id, { confirm: true });
    const worker = createAutomationRunner({ studio: s, clock }); await worker.tick(); const task = s.comm.claimNext().task;
    const run = s.comm.startRun({ agentId: task.assigneeId, kind: 'task', taskId: task.id, threadId: task.threadId });
    if (restartBeforeExpiry) s.comm.recover();
    ms += 120000;
    if (!restartBeforeExpiry) s.comm.recover();
    s.comm.claimNext(); await worker.tick();
    assert.equal(s.comm.getRun(run.id).state, 'error'); assert.equal(s.comm.activeRuns().length, 0);
    assert.equal(s.automation.run(occurrence.id).state, 'uncertain'); assert.equal(s.automation.status().aiPaused, true);
    const other = s.automation.save({ ...d, id: undefined, name: 'Autre règle simulée' }); s.automation.activate(other.id, { confirm: true, ai: true }); const next = s.automation.manual(other.id, { confirm: true }); await worker.tick();
    assert.equal(s.automation.run(next.id).state, 'waiting_ai'); assert.equal(s.comm.listTasks().length, 1);
  } finally { s.close(); }
});
