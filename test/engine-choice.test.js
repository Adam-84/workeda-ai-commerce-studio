// Lot 2 : choix du moteur par agent ou mission, moteur figé, aucun repli. Runners simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogReason, parseEngine, resolveEngine } from '../src/engines.js';

const claude = (model) => ({ provider: 'claude', model });

test('catalogue fermé : Codex désactivé, modèle ou fournisseur inconnu refusé', () => {
  assert.equal(catalogReason(claude('haiku')), '');
  assert.match(catalogReason({ provider: 'codex', model: 'x' }), /Codex.*Désactivé/);
  assert.match(catalogReason(claude('autre')), /Modèle inconnu/);
  assert.match(catalogReason({ provider: 'ailleurs', model: 'x' }), /Fournisseur inconnu/);
  assert.equal(parseEngine(null), null);
  assert.deepEqual(parseEngine({ provider: 'claude', model: 'opus', command: 'x' }), claude('opus'));
  for (const bad of [undefined, 'opus', {}, { provider: 'codex', model: 'x' }, claude('autre')]) assert.throws(() => parseEngine(bad), { status: 400 });
});

test('priorité : mission, puis agent, puis fiche', () => {
  const all = { mission: claude('haiku'), agent: claude('opus'), fiche: claude('sonnet') };
  assert.deepEqual(resolveEngine(all), { ...claude('haiku'), source: 'mission' });
  assert.deepEqual(resolveEngine({ ...all, mission: null }), { ...claude('opus'), source: 'agent' });
  assert.deepEqual(resolveEngine({ fiche: claude('sonnet') }), { ...claude('sonnet'), source: 'fiche' });
  assert.equal(resolveEngine({}), null);
});

import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}, file = ':memory:') {
  const studio = createStudio(file, options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, engines: studio.engines, ids };
}

test('magasin : mission, agent, fiche ; refus côté serveur', () => {
  const { studio, engines, ids } = setup();
  assert.deepEqual(engines.resolve(ids.lucas), { ...claude('sonnet'), source: 'fiche' });
  engines.setAgentChoice(ids.lucas, claude('opus'));
  assert.deepEqual(engines.resolve(ids.lucas), { ...claude('opus'), source: 'agent' });
  const m = studio.createMission({ title: 'Mission', assignedTo: ids.lucas });
  engines.setMissionChoice(m.id, claude('haiku'));
  assert.deepEqual(engines.resolve(ids.lucas, m.id), { ...claude('haiku'), source: 'mission' });
  engines.setMissionChoice(m.id, null);
  assert.equal(engines.resolve(ids.lucas, m.id).source, 'agent');
  assert.throws(() => engines.setAgentChoice(ids.lucas, { provider: 'codex', model: 'x' }), /Codex/);
  assert.throws(() => engines.setMissionChoice('absente', claude('opus')), { status: 404 });
  const hired = studio.hireAgent({ name: 'Sans fiche', role: 'Test', departmentId: studio.listDepartments()[0].id });
  assert.throws(() => engines.setAgentChoice(hired.id, claude('opus')), { status: 409 });
});
