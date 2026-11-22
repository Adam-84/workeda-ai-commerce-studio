// Integration Center (interface) : libellés, actions et suggestions — jamais d'accès par défaut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateInfo, quotaLine, quotaRatio, lastLine, grantCandidates, actionsFor, revokeText } from '../public/integrations-view.js';

const card = (o = {}) => ({ id: 'dsers', label: 'DSers', realNetworkAllowed: true, storage: { available: true }, flags: { configured: true, authenticated: false, tested: false }, quota: { used: 10, cap: 100, remaining: 90, resetsAt: '2026-11-22T00:00:00.000Z' }, grants: [], ...o });

test('quatre états réels distingués, état inconnu affiché tel quel', () => {
  assert.deepEqual(['not_configured', 'configured', 'authenticated', 'tested', 'unavailable'].map((s) => stateInfo(s).label), ['Non configuré', 'Configuré', 'Authentifié', 'Testé', 'Indisponible']);
  assert.equal(stateInfo('xyz').label, 'xyz');
});
test('quota et dernière opération : texte honnête, « jamais » sans date', () => {
  assert.match(quotaLine({ used: 10, cap: 100, remaining: 90, resetsAt: '2026-11-22T00:00:00.000Z' }), /10 sur 100 \(reste 90\)/);
  assert.equal(quotaRatio({ used: 150, cap: 100 }), 1); assert.equal(quotaRatio(null), 0);
  assert.equal(lastLine('Dernier test', { at: null }), 'Dernier test : jamais.');
  assert.match(lastLine('Dernier test', { at: '2026-11-21T10:00:00Z', ok: false, error: 'Plan Basic' }), /échec \(Plan Basic\)/);
});
test('actions : connexion impossible hors ligne ; test/actualisation seulement une fois authentifié ; jamais d’action d’écriture', () => {
  const off = actionsFor(card({ realNetworkAllowed: false })); assert.ok(off.find((a) => a.id === 'blocked').disabled); assert.ok(off.find((a) => a.id === 'connect').disabled);
  const on = actionsFor(card()); assert.equal(on.find((a) => a.id === 'connect').disabled, false); assert.ok(!on.some((a) => ['test', 'sync'].includes(a.id)));
  const auth = actionsFor(card({ flags: { configured: true, authenticated: true, tested: true } })); assert.deepEqual(auth.map((a) => a.id), ['test', 'sync', 'revoke']);
  assert.ok(actionsFor(card({ quota: { used: 100, cap: 100, remaining: 0 }, flags: { configured: true, authenticated: true } })).find((a) => a.id === 'sync').disabled, 'plafond atteint : actualisation désactivée');
  for (const a of [...off, ...on, ...auth]) assert.ok(!/(command|paiement|publi|supprim|écri)/i.test(a.id), a.id);
});
test('suggestions : proposées mais jamais accordées ; un agent déjà autorisé n’est plus proposé', () => {
  const agents = [{ slug: 'noah', name: 'Noah' }, { slug: 'lucas', name: 'Lucas' }, { slug: 'isabella', name: 'Isabella' }];
  const c = grantCandidates(card(), agents); assert.deepEqual(c.map((a) => a.slug), ['isabella', 'lucas', 'noah']); assert.ok(c[0].suggested && !c[2].suggested);
  assert.deepEqual(grantCandidates(card({ grants: [{ agent: 'lucas' }] }), agents).map((a) => a.slug), ['isabella', 'noah']);
  assert.match(revokeText(card()), /DSers n’a pas de point de révocation/); assert.match(revokeText(card({ id: 'track17' })), /clé/);
});

test('Basic : aucune action OAuth, test ou relevé même avec un ancien état authentifié', () => {
  for (const authenticated of [false, true]) {
    const actions = actionsFor(card({ settings: { plan: 'basic' }, flags: { configured: true, authenticated } }));
    assert.ok(!actions.some((a) => ['connect', 'test', 'sync'].includes(a.id)));
    assert.equal(actions.find((a) => a.id === 'basic').label, 'Indisponible — abonnement Basic');
    assert.equal(actions.find((a) => a.id === 'basic').disabled, true);
  }
});
