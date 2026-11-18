import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';

// Schéma des tables d'avant l'enrichissement des missions (copie exacte).
const LEGACY = `PRAGMA foreign_keys = ON;
  CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, department_id TEXT NOT NULL REFERENCES departments(id), enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'idle', status_source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE missions (id TEXT PRIMARY KEY, title TEXT NOT NULL, requested_by TEXT REFERENCES agents(id), assigned_to TEXT REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'draft', requires_approval INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE messages (id TEXT PRIMARY KEY, from_agent_id TEXT NOT NULL REFERENCES agents(id), to_agent_id TEXT NOT NULL REFERENCES agents(id), mission_id TEXT REFERENCES missions(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE agent_appearance (agent_id TEXT PRIMARY KEY REFERENCES agents(id), hair_style TEXT NOT NULL, hair_color TEXT NOT NULL, skin TEXT NOT NULL, eyes TEXT NOT NULL, outfit TEXT NOT NULL, top_color TEXT NOT NULL, accessory TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO departments VALUES ('d1', 'Direction', 'Pilotage', 1, '2026-11-01T10:00:00.000Z');
  INSERT INTO agents VALUES ('a1', 'Olivia', 'Coordination', 'd1', 1, 'idle', 'manual', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z');
  INSERT INTO agents VALUES ('a2', 'Harper', 'Contrôle', 'd1', 1, 'idle', 'manual', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z');
  INSERT INTO missions VALUES ('m1', 'Ancienne mission', NULL, 'a1', 'draft', 1, '2026-11-02T10:00:00.000Z');
  INSERT INTO messages VALUES ('g1', 'a1', 'a2', 'm1', 'Message conservé', '2026-11-02T11:00:00.000Z');
  INSERT INTO agent_appearance VALUES ('a1', 'bun', 'h1', 's1', 'e1', 'blazer', 't1', 'glasses', '2026-11-03T10:00:00.000Z');`;

test('an existing database keeps its agents, messages, looks and missions after the upgrade, twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-missions-'));
  const file = join(dir, 'studio.db');
  try {
    const legacy = new DatabaseSync(file); legacy.exec(LEGACY); legacy.close();
    for (let open = 0; open < 2; open++) { // la seconde ouverture ne doit rien changer
      const studio = createStudio(file);
      assert.deepEqual(studio.listAgents().map((a) => a.name).sort(), ['Harper', 'Olivia']);
      assert.equal(studio.listRecentMessages()[0].body, 'Message conservé');
      assert.equal(studio.listAppearances()[0].hairStyle, 'bun');
      const [old] = studio.listMissions();
      assert.equal(old.title, 'Ancienne mission');
      assert.equal(old.assigned_to, 'a1');
      assert.equal(old.state, 'draft');
      assert.equal(old.created_at, '2026-11-02T10:00:00.000Z');
      assert.deepEqual([old.objective, old.priority, old.contextLinks, old.collaborators, old.updatedAt], ['', 'normal', [], [], null]);
      studio.close();
    }
    const studio = createStudio(file);
    const edited = studio.updateMission('m1', { objective: 'Compléter', collaborators: ['a2'] });
    assert.equal(edited.title, 'Ancienne mission'); // les champs non envoyés restent intacts
    assert.deepEqual(edited.collaborators, ['a2']);
    assert.equal(studio.listMessages('m1').length, 1);
    assert.deepEqual(studio.listMemory('m1'), []); // ancienne mission : mémoire vide
    assert.deepEqual(studio.listDiscussion('m1'), []); // et fil d'équipe vide
    assert.equal(studio.getInstructions('a1').updatedAt, null); // et aucune consigne
    assert.equal(studio.currentPlan('m1'), null); // ni plan d'action
    studio.postDiscussion('m1', { body: 'Premier message du fil' });
    studio.addMemory('m1', { kind: 'decision', body: 'Garder la copie locale', sourceAgentId: 'a2' });
    studio.close();
    const reopened = createStudio(file);
    assert.equal(reopened.listMemory('m1')[0].body, 'Garder la copie locale');
    assert.equal(reopened.listDiscussion('m1')[0].body, 'Premier message du fil');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a full mission is saved, read back and edited; invalid input is refused', () => {
  const studio = createStudio(':memory:');
  const departmentId = studio.listDepartments()[0].id;
  const [ryan, harper, chloe] = ['Ryan', 'Harper', 'Chloe'].map((name) => studio.hireAgent({ name, role: 'Test', departmentId }));
  const m = studio.createMission({ title: ' Refaire la fiche ', objective: 'Clarifier', assignedTo: ryan.id, collaborators: [harper.id, ryan.id, harper.id], priority: 'high', expectedResult: 'Une fiche relue', contextText: 'Voir la note', contextLinks: ['https://exemple.fr/page', '', 'https://exemple.fr/page'], constraints: 'Copie locale seulement', validations: 'Accord avant publication' });
  assert.equal(m.title, 'Refaire la fiche');
  assert.deepEqual(m.collaborators, [harper.id]); // dédoublonnés, sans le responsable
  assert.deepEqual(m.contextLinks, ['https://exemple.fr/page']);
  assert.equal(m.requiresApproval, true);
  assert.equal(studio.listEvents(ryan.id)[0].kind, 'mission.assigned');
  const u = studio.updateMission(m.id, { assignedTo: chloe.id, collaborators: [ryan.id], priority: 'urgent', contextLinks: [] });
  assert.deepEqual([u.assignedTo, u.collaborators, u.priority, u.contextLinks, u.objective], [chloe.id, [ryan.id], 'urgent', [], 'Clarifier']);
  assert.ok(u.updatedAt);
  assert.deepEqual(studio.listMissions()[0].collaborators, [ryan.id]);
  assert.equal(studio.createMission({ title: 'Barre rapide' }).priority, 'normal'); // barre de création existante
  for (const input of [{ title: ' ' }, { title: 'x'.repeat(121) }, { title: 'T', priority: 'max' }, { title: 'T', contextLinks: ['javascript:alert(1)'] }, { title: 'T', contextLinks: ['exemple.fr'] }, { title: 'T', contextLinks: 'https://a.fr' }, { title: 'T', collaborators: ['inconnu'] }, { title: 'T', objective: 'x'.repeat(4001) }])
    assert.throws(() => studio.createMission(input));
  assert.throws(() => studio.updateMission('inconnue', { title: 'T' }), /introuvable/);
  assert.equal(studio.listMissions().length, 2); // aucune écriture partielle
  studio.close();
});

test('creating and editing a mission over HTTP never calls the AI', async () => {
  const studio = createStudio(':memory:');
  const agent = studio.hireAgent({ name: 'Olivia', role: 'Test', departmentId: studio.listDepartments()[0].id });
  let aiCalls = 0;
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async () => { aiCalls++; return ''; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = (method, path, data) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  try {
    const created = await call('POST', '/api/missions', { title: 'Audit', assignedTo: agent.id, contextLinks: ['https://exemple.fr'] });
    assert.equal(created.status, 200);
    const edited = await call('PUT', `/api/missions/${created.data.id}`, { expectedResult: 'Liste priorisée' });
    assert.deepEqual([edited.status, edited.data.expectedResult, edited.data.contextLinks], [200, 'Liste priorisée', ['https://exemple.fr/']]);
    assert.equal((await call('PUT', '/api/missions/inconnue', { title: 'T' })).status, 404);
    assert.equal((await call('PUT', `/api/missions/${created.data.id}`, { contextLinks: ['ftp://x'] })).status, 400);
    assert.equal(aiCalls, 0);
  } finally { await new Promise((r) => server.close(r)); studio.close(); }
});

test('mission memory: dated typed notes that are corrected or archived, never erased', () => {
  const studio = createStudio(':memory:');
  const harper = studio.hireAgent({ name: 'Harper', role: 'Test', departmentId: studio.listDepartments()[0].id });
  const m = studio.createMission({ title: 'Audit' }), other = studio.createMission({ title: 'Autre' });
  const fact = studio.addMemory(m.id, { kind: 'fact', body: ' 12 fiches sans image ' });
  const said = studio.addMemory(m.id, { kind: 'open', body: 'Qui valide les visuels ?', sourceAgentId: harper.id });
  assert.deepEqual([fact.body, fact.sourceAgentId, fact.updatedAt, fact.archivedAt], ['12 fiches sans image', null, null, null]);
  assert.deepEqual(studio.listMemory(m.id).map((e) => e.id), [said.id, fact.id]); // la plus récente d'abord
  assert.equal(studio.updateMemory(m.id, fact.id, { body: '12 fiches sans image' }).updatedAt, null); // rien changé : pas « corrigée »
  const fixed = studio.updateMemory(m.id, fact.id, { body: '14 fiches sans image', kind: 'decision' });
  assert.deepEqual([fixed.body, fixed.kind], ['14 fiches sans image', 'decision']); assert.ok(fixed.updatedAt);
  const archived = studio.updateMemory(m.id, said.id, { archived: true, body: 'ignoré' });
  assert.ok(archived.archivedAt); assert.equal(archived.body, 'Qui valide les visuels ?');
  assert.equal(studio.updateMemory(m.id, said.id, { archived: true }).archivedAt, archived.archivedAt); // date d'archivage conservée
  assert.equal(studio.updateMemory(m.id, said.id, { archived: false }).archivedAt, null);
  assert.equal(studio.listMemory(m.id).length, 2);
  assert.deepEqual(studio.listMemory(other.id), []);
  for (const input of [{ kind: 'fact', body: ' ' }, { kind: 'rumeur', body: 'x' }, { kind: 'fact', body: 'x'.repeat(4001) }, { kind: 'fact', body: 'x', sourceAgentId: 'inconnu' }, { kind: 'fact', body: 5 }])
    assert.throws(() => studio.addMemory(m.id, input));
  assert.throws(() => studio.addMemory('inconnue', { kind: 'fact', body: 'x' }), /Mission introuvable/);
  assert.throws(() => studio.updateMemory(other.id, fact.id, { body: 'x' }), /Note introuvable/); // une note reste dans sa mission
  studio.close();
});

test('mission memory over HTTP, without any AI call', async () => {
  const studio = createStudio(':memory:');
  let aiCalls = 0;
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async () => { aiCalls++; return ''; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = (method, path, data) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: data && JSON.stringify(data) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  try {
    const mission = studio.createMission({ title: 'Audit' });
    const base = `/api/missions/${mission.id}/memory`;
    const added = await call('POST', base, { kind: 'fact', body: 'Note' });
    assert.equal(added.status, 200);
    assert.equal((await call('PUT', `${base}/${added.data.id}`, { body: 'Note corrigée' })).data.body, 'Note corrigée');
    assert.ok((await call('PUT', `${base}/${added.data.id}`, { archived: true })).data.archivedAt);
    assert.deepEqual((await call('GET', base)).data.map((e) => e.body), ['Note corrigée']);
    assert.equal((await call('GET', '/api/missions/inconnue/memory')).status, 404);
    assert.equal((await call('POST', base, { kind: 'fact', body: '' })).status, 400);
    assert.equal(aiCalls, 0);
  } finally { await new Promise((r) => server.close(r)); studio.close(); }
});
