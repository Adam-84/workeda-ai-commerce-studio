import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp, cliPresent } from '../src/app.js';

async function withApp(fn, detect = (c) => c === 'codex') {
  const studio = createStudio(':memory:');
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => { const res = await fetch(base + path, body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json().catch(() => null), res }; };
  try { await fn({ studio, call, base }); } finally { server.close(); studio.close(); }
}

test('health reports real detection only', () => withApp(async ({ call }) => {
  const { data } = await call('/api/health');
  assert.deepEqual(data.connectors, { shopifyCli: false, claudeCode: false, codexCli: true, clink: false });
}));

test('cliPresent is true only when the lookup succeeds', () => {
  assert.equal(cliPresent('x', () => Buffer.from('')), true);
  assert.equal(cliPresent('x', () => { throw new Error('nope'); }), false);
});

test('events need an agentId and return the agent trail', () => withApp(async ({ call }) => {
  assert.equal((await call('/api/events')).status, 400);
  const dept = (await call('/api/departments')).data[0];
  const agent = (await call('/api/agents', { name: 'Ada', role: 'Pilotage', departmentId: dept.id })).data;
  const events = (await call(`/api/events?agentId=${agent.id}`)).data;
  assert.equal(events[0].kind, 'agent.hired');
}));

test('messages list is read-only, newest first and filterable by mission', () => withApp(async ({ call }) => {
  const departmentId = (await call('/api/departments')).data[0].id;
  const a = (await call('/api/agents', { name: 'Ada', role: 'x', departmentId })).data;
  const b = (await call('/api/agents', { name: 'Lin', role: 'y', departmentId })).data;
  const mission = (await call('/api/missions', { title: 'M', requestedBy: a.id, assignedTo: b.id })).data;
  await call('/api/messages', { fromAgentId: a.id, toAgentId: b.id, missionId: mission.id, body: 'un' });
  await call('/api/messages', { fromAgentId: a.id, toAgentId: b.id, body: 'deux' });
  assert.deepEqual((await call('/api/messages')).data.map((m) => m.body), ['deux', 'un']);
  assert.deepEqual((await call(`/api/messages?missionId=${mission.id}`)).data.map((m) => m.body), ['un']);
}));

test('HTTP activity cannot claim an external verified source', () => withApp(async ({ call }) => {
  const dept = (await call('/api/departments')).data[0];
  const agent = (await call('/api/agents', { name: 'Ada', role: 'x', departmentId: dept.id })).data;
  for (const source of ['claude', 'codex', 'shopify']) assert.equal((await call('/api/activity', { agentId: agent.id, status: 'working', source, verified: true })).status, 403);
  assert.equal((await call('/api/agents')).data[0].status, 'idle');
  const ok = await call('/api/activity', { agentId: agent.id, status: 'working', source: 'manual' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.statusSource, 'manual');
}));

test('oversized request bodies are refused with 413', () => withApp(async ({ call }) => {
  assert.equal((await call('/api/missions', { title: 'x'.repeat(1.1e6) })).status, 413);
}));

test('static files are served from public only', () => withApp(async ({ call, base }) => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/sky.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await call('/src/app.js')).status, 404);
  assert.equal((await call('/')).status, 200);
}));
