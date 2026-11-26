import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createWorkerBroker } from '../src/worker-broker.js';
import { runWorkerOnce, runWorkerLoop } from '../src/worker-client.js';

const payload = (overrides = {}) => ({ provider: 'claude', model: 'sonnet', system: 'System', prompt: 'Question', tools: [], timeoutMs: 2000, ...overrides });
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); let time = 1000;
  const broker = createWorkerBroker(db, { models: ['sonnet', 'haiku'], now: () => time, leaseMs: 100, ...options });
  t.after(() => db.close());
  return { broker, at: (value) => { time = value; } };
}
const enroll = (b, name = 'simulation', models = ['sonnet']) => b.enroll({ name, models });

// These tests own persistence, credential isolation, lease fencing and admission;
// transport tests below separately own heartbeat and redirect credential safety.
test('individual credentials persist hashed, never surface in status, and revoke independently', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-broker-'));
  const file = join(dir, 'control.db'); let db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let b = createWorkerBroker(db, { models: ['sonnet'] }); const a = enroll(b), other = enroll(b, 'second');
  assert.equal(b.authenticate(a.token).id, a.id); assert.equal(b.authenticate('invalid'), null);
  assert.ok(!JSON.stringify(b.status()).includes(a.token)); db.close();
  assert.ok(!readFileSync(file).includes(Buffer.from(a.token)));
  db = new DatabaseSync(file); b = createWorkerBroker(db, { models: ['sonnet'] });
  assert.equal(b.authenticate(a.token).id, a.id); b.revoke(a.id);
  assert.equal(b.authenticate(a.token), null); assert.equal(b.authenticate(other.token).id, other.id);
});

test('typed jobs reject executable fields, tools, unsupported models and unbounded input', (t) => {
  const { broker: b } = fixture(t);
  for (const p of [payload({ command: 'shell' }), payload({ provider: 'codex' }), payload({ tools: ['Bash'] }), payload({ model: 'unknown' }), payload({ timeoutMs: 0 }), payload({ timeoutMs: 300001 }), payload({ prompt: 'x'.repeat(200001) })]) {
    assert.throws(() => b.enqueue({ key: 'bad', payload: p }), { code: 'INVALID_JOB' });
  }
  assert.throws(() => b.enqueue({ payload: payload() }), { code: 'INVALID_JOB' });
  assert.throws(() => enroll(b, 'invalid', ['unknown']), { code: 'INVALID_WORKER' });
  const emptyDb = new DatabaseSync(':memory:'); t.after(() => emptyDb.close()); const empty = createWorkerBroker(emptyDb);
  assert.throws(() => empty.enqueue({ key: 'none', payload: payload() }), { code: 'INVALID_JOB' });
});

test('duplicate keys preserve their original payload and completed result', (t) => {
  const { broker: b } = fixture(t); const w = enroll(b);
  const first = b.enqueue({ key: 'same', payload: payload() });
  assert.equal(b.enqueue({ key: 'same', payload: payload({ prompt: 'changed' }) }).id, first.id);
  const claim = b.claim(w.id); b.complete(w.id, claim.id, claim.leaseToken, { status: 'done', output: 'answer', usage: { input_tokens: 3, output_tokens: 2 }, costUsd: 0.001 });
  const repeated = b.enqueue({ key: 'same', payload: payload({ prompt: 'changed again' }) });
  assert.equal(repeated.payload.prompt, 'Question'); assert.equal(repeated.result.output, 'answer'); assert.equal(repeated.result.costUsd, 0.001);
});

test('concurrent database connections claim exclusively and workers run only one job', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-claims-'));
  const db1 = new DatabaseSync(join(dir, 'control.db')), db2 = new DatabaseSync(join(dir, 'control.db'));
  t.after(() => { db1.close(); db2.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = createWorkerBroker(db1, { models: ['sonnet', 'haiku'] }), b = createWorkerBroker(db2, { models: ['sonnet', 'haiku'] });
  const w1 = enroll(a), w2 = enroll(b, 'second'), unsupported = enroll(b, 'haiku only', ['haiku']); const first = a.enqueue({ key: 'one', payload: payload() });
  assert.equal(b.claim(unsupported.id), null);
  const barrier = new SharedArrayBuffer(4), ready = [];
  const contenders = [w1, w2].map(worker => new Promise((resolve, reject) => {
    const thread = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      import(workerData.module).then(({createWorkerBroker}) => {
        const db = new DatabaseSync(workerData.path), broker = createWorkerBroker(db, {models:['sonnet','haiku']});
        parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        const job = broker.claim(workerData.id); db.close(); parentPort.postMessage(job);
      });`, { eval: true, workerData: { module: new URL('../src/worker-broker.js', import.meta.url).href, path: join(dir, 'control.db'), id: worker.id, barrier } });
    thread.on('message', value => {
      if (value === 'ready') { ready.push(true); if (ready.length === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); } }
      else resolve(value);
    }); thread.on('error', reject);
  }));
  const claims = await Promise.all(contenders); assert.equal(claims.filter(Boolean).length, 1);
  const held = claims.find(Boolean), winner = held.workerId, loser = winner === w1.id ? w2.id : w1.id; assert.equal(held.id, first.id);
  a.enqueue({ key: 'two', payload: payload() }); assert.equal(b.claim(winner), null);
  assert.throws(() => b.complete(loser, held.id, held.leaseToken, { status: 'done', output: 'stolen' }), { code: 'STALE_LEASE' });
  assert.throws(() => b.complete(winner, held.id, 'wrong', { status: 'done', output: 'stale' }), { code: 'STALE_LEASE' });
  b.complete(winner, held.id, held.leaseToken, { status: 'done', output: 'ok' }); assert.ok(a.claim(winner));
});

test('a missed heartbeat makes a live job uncertain before its absolute timeout', (t) => {
  const { broker: b, at } = fixture(t); const w = enroll(b), other = enroll(b, 'other');
  b.enqueue({ key: 'missed-heartbeat', payload: payload() }); const held = b.claim(w.id);
  at(1101); assert.equal(b.claim(other.id), null); assert.equal(b.job(held.id).status, 'uncertain');
  assert.throws(() => b.complete(w.id, held.id, held.leaseToken, { status: 'done', output: 'late' }), { code: 'STALE_LEASE' });
});

test('heartbeat renews leases only before expiry and never extends the job deadline', (t) => {
  const { broker: b, at } = fixture(t); const w = enroll(b), other = enroll(b, 'other');
  b.enqueue({ key: 'one', payload: payload({ timeoutMs: 250 }) }); const held = b.claim(w.id);
  at(1050); b.heartbeat(w.id, { jobId: held.id, leaseToken: held.leaseToken });
  at(1140); b.heartbeat(w.id, { jobId: held.id, leaseToken: held.leaseToken });
  at(1230); b.heartbeat(w.id, { jobId: held.id, leaseToken: held.leaseToken });
  at(1251); assert.equal(b.expire(), 1); assert.equal(b.job(held.id).status, 'uncertain');
  assert.equal(b.claim(other.id), null); b.enqueue({ key: 'next', payload: payload() }); assert.equal(b.claim(w.id), null);
  assert.throws(() => b.heartbeat(w.id, { jobId: held.id, leaseToken: held.leaseToken }), { code: 'STALE_LEASE' });
  assert.throws(() => b.complete(w.id, held.id, held.leaseToken, { status: 'done', output: 'late' }), { code: 'STALE_LEASE' });
});

test('revoking a worker fences its in-flight result without automatic reassignment', (t) => {
  const { broker: b } = fixture(t); const w = enroll(b), other = enroll(b, 'other');
  b.enqueue({ key: 'one', payload: payload() }); const held = b.claim(w.id); b.revoke(w.id);
  assert.equal(b.job(held.id).status, 'uncertain'); assert.equal(b.claim(other.id), null);
  assert.throws(() => b.complete(w.id, held.id, held.leaseToken, { status: 'done', output: 'late' }), { code: 'WORKER_REVOKED' });
});

test('operator stop cancels unclaimed jobs and fences running work as uncertain', (t) => {
  const { broker: b } = fixture(t); const w = enroll(b);
  const first = b.enqueue({ key: 'first', payload: payload() }); const held = b.claim(w.id);
  const queued = b.enqueue({ key: 'queued', payload: payload() });
  assert.equal(b.cancel(queued.id).status, 'cancelled'); assert.equal(b.cancelAll(), 1);
  assert.equal(b.job(first.id).status, 'uncertain'); assert.equal(b.claim(w.id), null);
  assert.throws(() => b.complete(w.id, held.id, held.leaseToken, { status: 'done', output: 'after stop' }), { code: 'STALE_LEASE' });
  assert.equal(b.cancelAll(), 0);
});

async function server(t, handler) {
  const app = createServer(handler); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return `http://127.0.0.1:${app.address().port}`;
}
test('simulated client keeps its lease alive, uses local model policy and submits accounting', async (t) => {
  const { broker: b } = fixture(t, { now: Date.now, leaseMs: 1000 }); const w = enroll(b);
  b.enqueue({ key: 'client', payload: payload({ timeoutMs: 5000 }) }); let heartbeats = 0;
  const baseUrl = await server(t, async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    assert.equal(req.headers.authorization, `Bearer ${w.token}`); const data = JSON.parse(body || '{}'); let result;
    if (req.url === '/worker/heartbeat') { heartbeats++; result = b.heartbeat(w.id, data); }
    if (req.url === '/worker/claim') result = b.claim(w.id);
    if (req.url.endsWith('/complete')) result = b.complete(w.id, req.url.split('/')[3], data.leaseToken, data.result);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  const result = await runWorkerOnce({ baseUrl, token: w.token, models: ['sonnet'], runner: async (options) => {
    assert.deepEqual(options.tools, []); assert.equal(options.model, 'sonnet');
    await new Promise(resolve => setTimeout(resolve, 2200)); options.onEvent({ type: 'result', usage: { input_tokens: 1 }, total_cost_usd: 0.001 }); return 'simulated';
  } });
  assert.equal(result.status, 'done'); assert.equal(result.result.output, 'simulated'); assert.equal(result.result.costUsd, 0.001); assert.ok(heartbeats >= 3);
});

test('client rejects remote HTTP and redirect responses before leaking credentials or running AI', async (t) => {
  let calls = 0; const runner = async () => { calls++; return 'never'; };
  await assert.rejects(runWorkerOnce({ baseUrl: 'http://example.com', token: 'secret', models: ['sonnet'], runner }), /HTTPS/);
  let leaked = 0; const destination = await server(t, (req, res) => { leaked++; res.end('{}'); });
  const baseUrl = await server(t, (req, res) => { res.writeHead(302, { Location: destination }); res.end(); });
  await assert.rejects(runWorkerOnce({ baseUrl, token: 'secret', models: ['sonnet'], runner }), /redirect/i);
  assert.equal(leaked, 0); assert.equal(calls, 0);
});

test('client refuses a job outside locally configured models without invoking runner', async (t) => {
  let calls = 0; const completed = [];
  const baseUrl = await server(t, async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    let value = {};
    if (req.url === '/worker/claim') value = { id: 'job', type: 'claude.text', leaseToken: 'lease', payload: payload({ model: 'opus' }), heartbeatIntervalMs: 1000 };
    if (req.url.endsWith('/complete')) completed.push(JSON.parse(body));
    res.end(JSON.stringify(value));
  });
  await runWorkerOnce({ baseUrl, token: 'secret', models: ['sonnet'], runner: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(completed[0].result.status, 'failed');
});

test('the worker loop serves jobs with its runner, retries transient failures and stops once revoked', async (t) => {
  const seen = [];
  const stop = new AbortController();
  let polls = 0, completed = 0;
  const server = createServer((req, res) => {
    seen.push(req.url);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    req.resume();
    if (req.url === '/worker/heartbeat') return send(200, {});
    if (req.url === '/worker/claim') {
      polls += 1;
      if (polls === 1) return send(503, {});
      if (polls === 2) return send(200, { job: { id: 'job-1', type: 'claude.text', leaseToken: 'lease', payload: payload() } });
      return send(401, {});
    }
    completed += 1; return send(200, { status: 'done' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const notes = [];
  await assert.rejects(runWorkerLoop({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'token', models: ['sonnet'], runner: async () => 'réponse simulée', idleMs: 5, signal: stop.signal, log: (m) => notes.push(m) }), /401/);
  assert.equal(completed, 1);
  assert.equal(polls, 3);
  assert.ok(notes.some((m) => m.includes('503')));
});

// Serveur de substitution : un courtier réel, avec des pannes réseau injectées par `fail`.
async function brokerServer(t, b, w, fail = () => null) {
  const calls = { heartbeat: 0, complete: 0 };
  const baseUrl = await server(t, async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const data = JSON.parse(body || '{}'); const route = req.url.endsWith('/complete') ? 'complete' : req.url.split('/')[2];
    if (route === 'complete' || data.jobId) calls[route] += 1;
    const status = fail(route, data, calls);
    if (status) { res.writeHead(status); return res.end('{}'); }
    let value;
    if (route === 'heartbeat') value = b.heartbeat(w.id, data);
    if (route === 'claim') value = b.claim(w.id);
    if (route === 'complete') value = b.complete(w.id, req.url.split('/')[3], data.leaseToken, data.result);
    res.end(JSON.stringify(value));
  });
  return { baseUrl, calls };
}
const slow = (ms) => async () => { await new Promise(resolve => setTimeout(resolve, ms)); return 'travail terminé'; };

test('a missed heartbeat request does not discard finished work', async (t) => {
  const { broker: b } = fixture(t, { now: Date.now, leaseMs: 600 }); const w = enroll(b);
  b.enqueue({ key: 'blip', payload: payload({ timeoutMs: 5000 }) });
  const s = await brokerServer(t, b, w, (route, data, calls) => route === 'heartbeat' && data.jobId && calls.heartbeat === 1 ? 503 : null);
  const done = await runWorkerOnce({ baseUrl: s.baseUrl, token: w.token, models: ['sonnet'], runner: slow(1500) });
  assert.equal(done.result.output, 'travail terminé'); assert.ok(s.calls.heartbeat >= 2, 'les battements reprennent');
});

test('delivery of a result is retried without running the job again', async (t) => {
  const { broker: b } = fixture(t, { now: Date.now, leaseMs: 600 }); const w = enroll(b);
  b.enqueue({ key: 'delivery', payload: payload({ timeoutMs: 5000 }) }); let runs = 0;
  const s = await brokerServer(t, b, w, (route, data, calls) => route === 'complete' && calls.complete < 3 ? 503 : null);
  const done = await runWorkerOnce({ baseUrl: s.baseUrl, token: w.token, models: ['sonnet'], runner: async () => { runs += 1; return 'une seule fois'; } });
  assert.equal(done.status, 'done'); assert.equal(s.calls.complete, 3); assert.equal(runs, 1);
});

test('an explicit lease refusal ends the delivery', async (t) => {
  const { broker: b } = fixture(t, { now: Date.now, leaseMs: 600 }); const w = enroll(b);
  b.enqueue({ key: 'refused', payload: payload({ timeoutMs: 5000 }) });
  const s = await brokerServer(t, b, w, (route) => route === 'complete' ? 409 : null);
  await assert.rejects(runWorkerOnce({ baseUrl: s.baseUrl, token: w.token, models: ['sonnet'], runner: async () => 'x' }), /409/);
  assert.equal(s.calls.complete, 1);
});

test('an operator releases a blocked identity without erasing the uncertain job', (t) => {
  const { broker: b } = fixture(t); const w = enroll(b);
  const first = b.enqueue({ key: 'first', payload: payload() }); const held = b.claim(w.id); b.cancelAll();
  assert.equal(b.isBlocked(w.id), true); b.enqueue({ key: 'next', payload: payload() }); assert.equal(b.claim(w.id), null);
  assert.equal(b.release(w.id).blocked, false);
  assert.equal(b.status().workers[0].blocked, false); assert.equal(b.job(first.id).status, 'uncertain');
  assert.throws(() => b.complete(w.id, held.id, held.leaseToken, { status: 'done', output: 'tardif' }), { code: 'STALE_LEASE' });
  assert.ok(b.claim(w.id));
});

test('the operator tool releases an identity only once the process is declared stopped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-release-')); const file = join(dir, 'control.db');
  let db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let b = createWorkerBroker(db, { models: ['sonnet'] }); const w = enroll(b);
  b.enqueue({ key: 'one', payload: payload() }); b.claim(w.id); b.cancelAll(); db.close();
  const tool = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../tools/workers.mjs', import.meta.url)), 'release', '--id', w.id, '--db', file, ...args], { encoding: 'utf8' });
  const refused = tool(); assert.equal(refused.status, 1); assert.match(refused.stderr, /--process-stopped/);
  const accepted = tool('--process-stopped'); assert.equal(accepted.status, 0, accepted.stderr);
  db = new DatabaseSync(file); b = createWorkerBroker(db, { models: ['sonnet'] }); assert.equal(b.status().workers[0].blocked, false);
});

test('the worker loop announces a blocked identity once', async (t) => {
  let polls = 0; const stop = new AbortController(); const notes = [];
  const baseUrl = await server(t, (req, res) => {
    req.resume();
    if (req.url === '/worker/claim') { polls += 1; if (polls === 4) stop.abort(); return res.end(JSON.stringify({ job: null, blocked: true })); }
    res.end('{}');
  });
  await runWorkerLoop({ baseUrl, token: 'token', models: ['sonnet'], runner: async () => 'jamais', idleMs: 2, signal: stop.signal, log: (m) => notes.push(m) });
  assert.equal(polls, 4); assert.equal(notes.length, 1, notes.join(' | ')); assert.match(notes[0], /workers\.mjs release/);
});
