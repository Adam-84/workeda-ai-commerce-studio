import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';

async function withApp(fn) {
  const studio = createStudio(':memory:');
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  try { await fn({ studio, call }); } finally { server.close(); studio.close(); }
}

test('a style is saved as a full replacement, listed, journaled and reset', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  assert.deepEqual((await call('GET', '/api/island-styles')).data, []);
  const put = await call('PUT', `/api/departments/${dept.id}/style`, { accent: 'teal', ground: 'snow', lanterns: false, label: 'Pilotage' });
  assert.equal(put.status, 200);
  assert.deepEqual([put.data.accent, put.data.ground, put.data.lanterns, put.data.label, put.data.floor], ['teal', 'snow', false, 'Pilotage', null]);
  const lit = await call('PUT', `/api/departments/${dept.id}/style`, { lanterns: true });
  assert.equal(lit.data.lanterns, true);
  assert.equal((await call('GET', '/api/island-styles')).data[0].lanterns, true);
  const second = await call('PUT', `/api/departments/${dept.id}/style`, { tree: 'palm' });   // remplacement complet : le reste revient à « défaut »
  assert.deepEqual([second.data.tree, second.data.accent, second.data.label, second.data.lanterns], ['palm', null, null, null]);
  const list = (await call('GET', '/api/island-styles')).data;
  assert.equal(list.length, 1); assert.equal(list[0].departmentId, dept.id); assert.equal(list[0].lanterns, null);
  const updated = studio.listIslandEvents()[0];
  assert.equal(updated.kind, 'island.style.updated');
  assert.equal(updated.source, 'manual');
  assert.ok(updated.detail.includes(dept.name));
  assert.equal((await call('DELETE', `/api/departments/${dept.id}/style`)).status, 200);
  assert.equal(studio.listIslandEvents()[0].kind, 'island.style.reset');
  assert.deepEqual((await call('GET', '/api/island-styles')).data, []);
}));

test('invalid values are refused (400), unknown departments are 404, existing data untouched', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const before = JSON.stringify(studio.listDepartments());
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { accent: '#ff0000' })).status, 400);
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { label: 'Création & Co' })).status, 400);
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { couleur: 'gold' })).status, 400);
  assert.equal((await call('PUT', '/api/departments/inconnu/style', { accent: 'gold' })).status, 404);
  assert.equal((await call('DELETE', '/api/departments/inconnu/style')).status, 404);
  assert.deepEqual((await call('GET', '/api/island-styles')).data, []);
  assert.equal(JSON.stringify(studio.listDepartments()), before);
  assert.equal(studio.listIslandEvents().length, 0);
}));
