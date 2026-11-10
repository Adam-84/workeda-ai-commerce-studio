import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';

test('seeds exactly eight configurable departments', () => {
  const studio = createStudio(':memory:');
  assert.equal(studio.listDepartments().length, 8);
  assert.equal(studio.listDepartments()[0].name, 'Direction');
  studio.close();
});

test('hiring an agent records a truthful manual status event', () => {
  const studio = createStudio(':memory:');
  const department = studio.listDepartments()[0];
  const agent = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId: department.id });
  assert.equal(agent.enabled, true);
  assert.equal(agent.status, 'idle');
  assert.equal(agent.statusSource, 'manual');
  assert.equal(studio.listEvents(agent.id)[0].kind, 'agent.hired');
  studio.close();
});

test('messages create an auditable inter-agent mission trail', () => {
  const studio = createStudio(':memory:');
  const departmentId = studio.listDepartments()[0].id;
  const sender = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId });
  const recipient = studio.hireAgent({ name: 'Lin', role: 'Recherche', departmentId });
  const mission = studio.createMission({ title: 'Vérifier le thème', requestedBy: sender.id, assignedTo: recipient.id });
  const message = studio.sendMessage({ fromAgentId: sender.id, toAgentId: recipient.id, missionId: mission.id, body: 'Analyse la copie du thème uniquement.' });
  assert.equal(message.missionId, mission.id);
  assert.equal(studio.listMessages(mission.id).length, 1);
  assert.equal(studio.listEvents(recipient.id)[0].kind, 'message.received');
  studio.close();
});

test('external activity refuses unverified connector data', () => {
  const studio = createStudio(':memory:');
  const agent = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId: studio.listDepartments()[0].id });
  assert.throws(() => studio.recordActivity({ agentId: agent.id, status: 'working', source: 'shopify', verified: false }));
  studio.close();
});
