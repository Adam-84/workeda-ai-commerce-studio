// Régressions du serveur central : arrêt général, redémarrage, disponibilité des workers, sauvegardes.
// Bases temporaires et workers simulés : aucun appel IA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudRuntime } from '../src/cloud-server.js';
import { createStudio } from '../src/studio.js';
import { createWorkerBroker } from '../src/worker-broker.js';
import { hashPassword } from '../src/cloud-auth.js';

const PASSWORD = 'test-only-password-long';
const passwordHash = await hashPassword(PASSWORD);

const scopes = new WeakMap(); // un seul nettoyage par test : fermer les serveurs AVANT de supprimer les dossiers (verrous Windows)
function scope(t) {
  if (!scopes.has(t)) {
    const s = { closers: [], dirs: [] }; scopes.set(t, s);
    t.after(async () => { for (const close of s.closers) await close(); for (const dir of s.dirs) rmSync(dir, { recursive: true, force: true }); });
  }
  return scopes.get(t);
}

async function central(t, { dir: existing, ...options } = {}) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'archipel-ops-'));
  if (!existing) scope(t).dirs.push(dir);
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash, env: {}, ...options });
  let open = true;
  const close = async () => { if (!open) return; open = false; await runtime.close(); };
  scope(t).closers.push(close);
  const call = async (path, data, headers = {}) => {
    const response = await fetch(runtime.origin + path, { method: data === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { ...(data === undefined ? {} : { origin: runtime.origin, 'content-type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json().catch(() => null) };
  };
  const { cookie } = await call('/auth/login', { password: PASSWORD });
  const api = (path, data) => call(path, data, { cookie });
  const agent = (slug) => runtime.studio.comm.agentOfSlug(slug);
  const delegate = async (slug, instruction) => {
    const res = await api('/api/comm/delegations', { assigneeId: agent(slug), instruction });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return () => runtime.studio.comm.task(res.body.task.id);
  };
  const worker = (models = ['sonnet']) => {
    const w = runtime.broker.enroll({ name: `sim-${models.join('-')}`, models });
    runtime.broker.heartbeat(w.id);
    return w;
  };
  return { dir, runtime, close, call, api, delegate, worker };
}

test('general stop survives a restart and resuming keeps the owner calendar suspension', async (t) => {
  const first = await central(t);
  first.runtime.studio.automation.designate({ confirm: true });
  first.runtime.studio.automation.pause(true); // suspension voulue par le propriétaire, avant l'arrêt général
  assert.equal((await first.api('/api/operations/stop', { halted: true })).body.halted, true);
  await first.close();

  const second = await central(t, { dir: first.dir });
  assert.equal((await second.api('/api/operations')).body.halted, true);
  second.worker();
  const task = await second.delegate('olivia', 'Contrôle fictif pendant l’arrêt');
  assert.equal(task().state, 'queued');
  assert.equal((await second.api('/api/operations/stop', { halted: false })).body.halted, false);
  assert.equal(second.runtime.studio.automation.status().paused, true);
});

test('while stopped, reopening calendars does not run deterministic automations', async (t) => {
  const s = await central(t);
  const { automation } = s.runtime.studio;
  automation.designate({ confirm: true });
  await s.api('/api/operations/stop', { halted: true });
  automation.pause(false);
  const rule = automation.save({ name: 'Déterministe', agentSlug: 'olivia', objective: 'Contrôler les missions', sources: ['missions'], trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } });
  automation.manual(rule.id, { confirm: true });
  await s.runtime.app.automationRunner.tick();
  assert.equal(automation.history()[0].state, 'queued');
});

test('a task stays queued until a worker offers its model', async (t) => {
  const s = await central(t);
  s.worker(['sonnet']);
  const opus = await s.delegate('alexander', 'Synthèse fictive');
  assert.equal(opus().state, 'queued');
  assert.equal(opus().attempts, 0);
});

test('a worker held by an uncertain job is reported blocked and receives no new task', async (t) => {
  const s = await central(t);
  const w = s.worker();
  s.runtime.broker.enqueue({ key: 'stuck', payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'Fictif', tools: [], timeoutMs: 5000 } });
  s.runtime.broker.claim(w.id);
  s.runtime.broker.cancelAll();
  const task = await s.delegate('olivia', 'Contrôle fictif');
  assert.equal(task().state, 'queued');
  const status = (await s.api('/api/operations')).body;
  assert.equal(status.workers[0].blocked, true);
  assert.equal(status.providers.claude.state, 'waiting_worker');
});

test('time spent waiting behind another job does not abandon a queued job', async (t) => {
  const s = await central(t, { maxJobMs: 3000 });
  const w = s.worker();
  const first = await s.delegate('olivia', 'Premier contrôle fictif');
  const second = await s.delegate('lucas', 'Second contrôle fictif');
  for (let i = 0; i < 2; i += 1) {
    const job = s.runtime.broker.claim(w.id);
    assert.ok(job, `travail ${i + 1} disponible`);
    await delay(1800);
    s.runtime.broker.complete(w.id, job.id, job.leaseToken, { status: 'done', output: 'Rapport fictif.' });
    await delay(200);
  }
  await s.runtime.app.orchestrator.idle();
  assert.notEqual(first().state, 'blocked', first().stateNote);
  assert.notEqual(second().state, 'blocked', second().stateNote);
});

test('a worker can return a long report', async (t) => {
  const s = await central(t);
  const w = s.worker();
  s.runtime.broker.enqueue({ key: 'long', payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'Fictif', tools: [], timeoutMs: 60000 } });
  const job = s.runtime.broker.claim(w.id);
  const res = await s.call(`/worker/jobs/${job.id}/complete`, { leaseToken: job.leaseToken, result: { status: 'done', output: 'é'.repeat(400000) } }, { authorization: `Bearer ${w.token}` });
  assert.equal(res.status, 200, JSON.stringify(res.body)?.slice(0, 200));
});

test('restart drops orphaned queued jobs and never replays an interrupted task', async (t) => {
  const first = await central(t);
  const task = await first.delegate('olivia', 'Mission interrompue fictive');
  const id = task().id;
  await first.close();

  // État laissé par un arrêt brutal : tâche « en cours » et travail encore en file chez le courtier.
  const studio = createStudio(join(first.dir, 'workeda.db'), { env: {} });
  studio.comm.setTaskState(id, 'running');
  studio.comm.startRun({ agentId: studio.comm.task(id).assigneeId, kind: 'task', taskId: id, threadId: studio.comm.task(id).threadId, model: 'sonnet' });
  studio.close();
  const db = new DatabaseSync(join(first.dir, 'control.db'));
  const orphan = createWorkerBroker(db, { models: ['sonnet'] }).enqueue({ key: 'orphan', payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'Fictif', tools: [], timeoutMs: 5000 } });
  db.close();

  const second = await central(t, { dir: first.dir });
  assert.equal(second.runtime.broker.job(orphan.id).status, 'cancelled');
  assert.equal(second.runtime.studio.comm.task(id).state, 'blocked');
  assert.equal(second.runtime.studio.comm.activeRuns().length, 0);
});

test('an overdue backup runs at startup and its date survives a restart', async (t) => {
  const first = await central(t);
  const done = (await first.api('/api/operations')).body.backup.lastSuccessfulAt;
  assert.ok(done, 'première sauvegarde au démarrage');
  await first.close();
  const second = await central(t, { dir: first.dir });
  assert.equal((await second.api('/api/operations')).body.backup.lastSuccessfulAt, done);
  const backups = join(first.dir, 'backups');
  assert.equal(readdirSync(backups).filter((name) => existsSync(join(backups, name, 'manifest.json'))).length, 1);
});

test('dashboard counts only real decisions as approvals and reports integrations', async (t) => {
  const s = await central(t);
  s.worker();
  await s.delegate('alexander', 'En attente d’un moteur'); // ni à valider ni à vérifier
  const body = (await s.api('/api/operations')).body;
  assert.equal(body.approvals, 0);
  assert.ok(body.integrations.length > 0);
  assert.ok(body.integrations.every((i) => i.id && i.state));
});

test('the container keeps a stable hostname so the automation executor survives a recreate', () => {
  assert.match(readFileSync(new URL('../deploy/compose.yaml', import.meta.url), 'utf8'), /^ {4}hostname: \S+$/m);
});
