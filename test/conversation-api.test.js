import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';

async function withApp(fn) {
  const studio = createStudio(':memory:');
  const departmentId = studio.listDepartments()[0].id;
  const agents = ['Lucas', 'Olivia', 'Ryan'].map((name) => studio.hireAgent({ name, role: 'Test', departmentId }));
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (path, data) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
    });
    return { status: res.status, data: await res.json() };
  };
  try { await fn({ studio, agents, call }); }
  finally { await new Promise((resolve) => server.close(resolve)); studio.close(); }
}

test('user messages keep long text, their real sender and the intended agent', () => withApp(async ({ agents: [lucas, olivia], call }) => {
  const path = `/api/agents/${lucas.id}/conversation`;
  const body = 'Une fiche produit\n<script>texte, jamais exécuté</script>\n' + 'é'.repeat(2400);
  const saved = await call(path, { body, senderType: 'agent' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.senderType, 'user');
  assert.equal(saved.data.body, body);
  const history = await call(path);
  assert.deepEqual(history.data.items, [saved.data]);
  assert.equal(history.data.nextCursor, null);
  assert.deepEqual((await call(`/api/agents/${olivia.id}/conversation`)).data.items, []);
}));

test('all history is reachable beyond 500 messages without losing legacy exchanges or mixing agents', () => withApp(async ({ studio, agents: [lucas, olivia, ryan], call }) => {
  const path = `/api/agents/${lucas.id}/conversation`;
  const legacy = studio.sendMessage({ fromAgentId: olivia.id, toAgentId: lucas.id, body: 'Ancien échange' });
  studio.sendMessage({ fromAgentId: olivia.id, toAgentId: ryan.id, body: 'Autre discussion' });
  const ids = [];
  for (let i = 0; i < 510; i++) {
    const result = await call(path, { body: `Message ${i}` });
    assert.equal(result.status, 200);
    ids.push(result.data.id);
  }
  let cursor = null;
  const items = [];
  do {
    const page = await call(path + (cursor ? `?before=${encodeURIComponent(cursor)}` : ''));
    assert.equal(page.status, 200);
    assert.ok(page.data.items.length <= 50);
    items.push(...page.data.items);
    cursor = page.data.nextCursor;
    assert.ok(items.length <= 511, 'pagination must terminate');
  } while (cursor);
  assert.equal(items.length, 511);
  assert.equal(new Set(items.map((m) => m.id)).size, 511);
  assert.deepEqual(new Set(items.filter((m) => m.senderType === 'user').map((m) => m.id)), new Set(ids));
  const old = items.find((m) => m.senderType === 'agent');
  assert.equal(old.fromAgentId, olivia.id);
  assert.equal(old.toAgentId, lucas.id);
  assert.equal(old.body, 'Ancien échange');
  assert.equal(studio.listRecentMessages().find((m) => m.id === legacy.id).body, 'Ancien échange');
}));

test('invalid conversation input is rejected without creating messages', () => withApp(async ({ agents: [lucas], call }) => {
  const path = `/api/agents/${lucas.id}/conversation`;
  for (const body of ['', ' \n ', 4, null, {}, []]) assert.equal((await call(path, { body })).status, 400);
  assert.equal((await call('/api/agents/missing/conversation', { body: 'Bonjour' })).status, 404);
  assert.equal((await call('/api/agents/missing/conversation')).status, 404);
  for (const cursor of ['bad', Buffer.from('{"createdAt":4}').toString('base64url')]) {
    assert.equal((await call(path + `?before=${cursor}`)).status, 400);
  }
  assert.equal((await call(path, { body: 'a'.repeat(1_000_001) })).status, 413);
  assert.deepEqual((await call(path)).data.items, []);
}));

test('opening an older database preserves agents and legacy messages, and user history survives reopening with tied timestamps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workeda-conversation-'));
  const filename = join(directory, 'studio.db');
  let studio;
  try {
    studio = createStudio(filename);
    const departmentId = studio.listDepartments()[0].id;
    const a = studio.hireAgent({ name: 'Lucas', role: 'Catalogue', departmentId });
    const b = studio.hireAgent({ name: 'Olivia', role: 'Coordination', departmentId });
    studio.sendMessage({ fromAgentId: b.id, toAgentId: a.id, body: 'Échange existant' });
    studio.close(); studio = null;
    const old = new DatabaseSync(filename);
    old.exec('DROP TABLE user_messages'); old.close();
    studio = createStudio(filename);
    assert.equal(studio.listAgents().length, 2);
    assert.equal(studio.listRecentMessages()[0].body, 'Échange existant');
    for (let i = 0; i < 61; i++) studio.sendUserMessage(a.id, { body: `Enregistré ${i}` });
    studio.close(); studio = null;
    const fixture = new DatabaseSync(filename);
    fixture.exec("UPDATE user_messages SET created_at='2026-11-17T12:00:00.000Z'; UPDATE messages SET created_at='2026-11-17T12:00:00.000Z'");
    fixture.close();
    studio = createStudio(filename);
    const first = studio.listConversation(a.id), second = studio.listConversation(a.id, first.nextCursor);
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 12);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((m) => m.id)).size, 62);
    assert.equal(studio.listAgents().length, 2);
  } finally { studio?.close(); rmSync(directory, { recursive: true, force: true }); }
});
