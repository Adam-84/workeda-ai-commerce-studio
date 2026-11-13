import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';

const profile = (slug, department) => ({ slug, displayName: slug[0].toUpperCase() + slug.slice(1), role: `Rôle de ${slug}`, department });
const TEAM = [['alexander', 'Direction'], ['olivia', 'Direction'], ['sophia', 'Laboratoire'], ['noah', 'Laboratoire'], ['lucas', 'Catalogue'], ['isabella', 'Catalogue'], ['chloe', 'Création'], ['ryan', 'Création'], ['harper', 'Opérations'], ['benjamin', 'Données']].map(([s, d]) => profile(s, d));
const deptId = (studio, name) => studio.listDepartments().find((d) => d.name === name).id;

test('creates the ten agents in their departments with a manual hire event', () => {
  const studio = createStudio(':memory:');
  const r = studio.syncAgentFiles(TEAM);
  assert.equal(r.created.length, 10);
  assert.deepEqual(r.linked, []);
  assert.deepEqual(r.warnings, []);
  const agents = studio.listAgents();
  assert.equal(agents.length, 10);
  const ryan = agents.find((a) => a.name === 'Ryan');
  assert.equal(ryan.department_name, 'Création');
  assert.equal(ryan.role, 'Rôle de ryan');
  assert.equal(ryan.status, 'idle');
  assert.equal(ryan.statusSource, 'manual');
  const event = studio.listEvents(ryan.id)[0];
  assert.equal(event.kind, 'agent.hired');
  assert.equal(event.detail, 'recruté depuis .claude/agents/ryan.md');
  assert.equal(event.source, 'manual');
  assert.equal(studio.listAgentFiles().length, 10);
  studio.close();
});

test('a second pass creates no duplicate', () => {
  const studio = createStudio(':memory:');
  studio.syncAgentFiles(TEAM);
  const r = studio.syncAgentFiles(TEAM);
  assert.deepEqual(r, { created: [], linked: [], warnings: [] });
  assert.equal(studio.listAgents().length, 10);
  studio.close();
});

test('links an agent hired by hand, ignoring case, without changing it', () => {
  const studio = createStudio(':memory:');
  const hand = studio.hireAgent({ name: 'SOPHIA', role: 'Mon rôle', departmentId: deptId(studio, 'Marketing') });
  const r = studio.syncAgentFiles([profile('sophia', 'Laboratoire')]);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.linked, ['sophia']);
  const agents = studio.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'SOPHIA');
  assert.equal(agents[0].role, 'Mon rôle');
  assert.equal(agents[0].department_name, 'Marketing');
  assert.deepEqual(studio.listAgentFiles(), [{ agentId: hand.id, slug: 'sophia' }]);
  studio.close();
});

test('skips a profile whose department does not exist', () => {
  const studio = createStudio(':memory:');
  const r = studio.syncAgentFiles([profile('zoe', 'Inconnu')]);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.warnings, [{ file: 'zoe.md', reason: 'département inconnu : Inconnu' }]);
  assert.equal(studio.listAgents().length, 0);
  studio.close();
});

test('keeps the name, role and department changed in the app', () => {
  const studio = createStudio(':memory:');
  studio.syncAgentFiles([profile('noah', 'Laboratoire')]);
  const noah = studio.listAgents()[0];
  studio.updateAgent(noah.id, { name: 'Noé', role: 'Veille', departmentId: deptId(studio, 'Marketing') });
  assert.deepEqual(studio.syncAgentFiles([profile('noah', 'Laboratoire')]), { created: [], linked: [], warnings: [] });
  const [after] = studio.listAgents();
  assert.equal(after.name, 'Noé');
  assert.equal(after.role, 'Veille');
  assert.equal(after.department_name, 'Marketing');
  studio.close();
});

test('the name match ignores agents already linked to another file', () => {
  const studio = createStudio(':memory:');
  studio.syncAgentFiles([profile('noah', 'Laboratoire')]);
  studio.updateAgent(studio.listAgents()[0].id, { name: 'Lucas' });
  const r = studio.syncAgentFiles([profile('lucas', 'Catalogue')]);
  assert.deepEqual(r.created, ['lucas']);
  assert.equal(studio.listAgents().length, 2);
  studio.close();
});
