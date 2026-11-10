import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { autoAppearance } from '../public/sprites.js';

async function withApp(fn) {
  const studio = createStudio(':memory:');
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  try { await fn({ studio, call }); } finally { server.close(); studio.close(); }
}

test('appearance can be saved, listed, journaled and reset', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const agent = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId: dept.id });
  const look = { ...autoAppearance(agent, dept.name), hairStyle: 'bun' };
  const saved = await call('PUT', `/api/agents/${agent.id}/appearance`, look);
  assert.equal(saved.status, 200); assert.equal(saved.data.hairStyle, 'bun');
  assert.equal((await call('GET', '/api/appearances')).data[0].agentId, agent.id);
  assert.equal(studio.listEvents(agent.id)[0].kind, 'agent.appearance.updated');
  assert.equal((await call('DELETE', `/api/agents/${agent.id}/appearance`)).status, 200);
  assert.deepEqual((await call('GET', '/api/appearances')).data, []);
}));

test('invalid values are refused (400) and unknown agents are 404', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const agent = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId: dept.id });
  const bad = { ...autoAppearance(agent, dept.name), topColor: '#000000' };
  assert.equal((await call('PUT', `/api/agents/${agent.id}/appearance`, bad)).status, 400);
  assert.equal((await call('PUT', '/api/agents/inconnu/appearance', autoAppearance(agent, dept.name))).status, 404);
  assert.equal((await call('DELETE', '/api/agents/inconnu/appearance')).status, 404);
}));
