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
