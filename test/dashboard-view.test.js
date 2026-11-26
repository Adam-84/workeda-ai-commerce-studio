// Tableau de bord et alertes : fonctions pures, aucune donnée inventée.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, readOperations } from '../public/dashboard-view.js';
import { snapshot, newAlerts, ALERT_KINDS } from '../public/alerts.js';

const card = (cards, id) => cards.find((c) => c.id === id);

test('without any source every card says unavailable instead of showing zero', () => {
  const cards = buildDashboard({});
  assert.deepEqual(cards.map((c) => c.id), ['server', 'agents', 'missions', 'approvals', 'automations', 'costs', 'quotas', 'integrations', 'workers', 'freshness', 'backup']);
  for (const c of cards) { assert.equal(c.tone, 'unknown', c.id); assert.doesNotMatch(c.value, /^0\b/, c.id); }
});

test('counts come from the data and approvals cover decisions only', () => {
  const cards = buildDashboard({
    agents: [{ enabled: true, status: 'working' }, { enabled: true, status: 'idle' }, { enabled: false, status: 'idle' }],
    missions: [{ state: 'draft' }, { state: 'done' }, { state: 'cancelled' }],
    notifications: [{ type: 'approval' }, { type: 'review' }, { type: 'message' }, { type: 'blocked' }],
    memoryPending: [{}],
    automations: { status: { paused: false }, rules: [{ enabled: true }, { enabled: false }] },
    integrations: { integrations: [{ id: 'a', state: 'tested' }, { id: 'b', state: 'not_configured' }] }
  });
  assert.equal(card(cards, 'agents').value, '2 disponibles');
  assert.match(card(cards, 'agents').detail, /1 au travail/);
  assert.equal(card(cards, 'missions').value, '1 ouverte');
  assert.equal(card(cards, 'approvals').value, '3 à valider');
  assert.equal(card(cards, 'automations').value, '1 active');
  assert.equal(card(cards, 'integrations').value, '1 sur 2 testée');
});

test('unreported costs stay unknown and quotas are never estimated', () => {
  const usage = (runs, costed, costUsd) => ({ usage: { today: { runs, runsWithCost: costed, costUsd }, limitPerDay: 60 } });
  const none = buildDashboard(usage(3, 0, null));
  assert.equal(card(none, 'costs').value, 'Inconnu');
  const partial = buildDashboard(usage(3, 1, 0.5));
  assert.match(card(partial, 'costs').value, /0,50/);
  assert.match(card(partial, 'costs').detail, /1 sur 3/);
  assert.equal(card(partial, 'quotas').value, 'Inconnu');
});

test('central mode reports workers, stop state and backup', () => {
  const ops = { mode: 'central', server: 'online', halted: true, workers: [{ online: true, blocked: false, revoked: false }, { online: false, revoked: false }, { online: true, blocked: true, revoked: false }, { online: false, revoked: true }], backup: { lastSuccessfulAt: null, error: true }, freshness: { catalog: null } };
  const cards = buildDashboard({ operations: ops });
  assert.equal(card(cards, 'server').tone, 'warn');
  assert.match(card(cards, 'server').value, /Arrêt général/);
  assert.equal(card(cards, 'workers').value, '1 disponible sur 3');
  assert.equal(card(cards, 'backup').tone, 'warn');
  assert.equal(card(buildDashboard({ operations: null, localHealth: { mode: 'local-only' } }), 'workers').value, 'Mode local');
});

test('alerts fire once for new items, respect preferences and never leak content', () => {
  const secret = 'Prix confidentiel du produit X : 42 €';
  const first = snapshot({ notifications: [{ type: 'approval', id: '1', detail: secret }] });
  const all = Object.fromEntries(ALERT_KINDS.map((k) => [k.id, true]));
  assert.deepEqual(newAlerts(null, first, all), [], 'aucune alerte au premier relevé');
  const next = snapshot({
    notifications: [{ type: 'approval', id: '1' }, { type: 'review', id: '2', detail: secret, title: secret }, { type: 'failed', id: '3' }, { type: 'blocked', id: '4', detail: 'Budget de la mission atteint' }],
    tasks: [{ id: '5', state: 'done', title: secret }],
    operations: { workers: [{ id: 'w', online: false, revoked: false }] }
  });
  const alerts = newAlerts(first, next, all);
  assert.deepEqual(alerts.map((a) => a.kind).sort(), ['approval', 'budget', 'done', 'failed']);
  assert.ok(!JSON.stringify(alerts).includes('confidentiel'));
  assert.deepEqual(newAlerts(next, next, all), []);
  assert.deepEqual(newAlerts(first, next, { ...all, approval: false, done: false, budget: false, failed: false }), []);
});

test('a worker that goes offline raises one alert', () => {
  const online = snapshot({ operations: { workers: [{ id: 'w', online: true, revoked: false }] } });
  const offline = snapshot({ operations: { workers: [{ id: 'w', online: false, revoked: false }] } });
  assert.deepEqual(newAlerts(online, offline, { worker: true }).map((a) => a.kind), ['worker']);
  assert.deepEqual(newAlerts(offline, offline, { worker: true }), []);
});

test('only a 404 means local mode; any other failure of the central server stays unavailable', async () => {
  const failing = (error) => async () => { throw error; };
  assert.equal(await readOperations(failing(Object.assign(new Error('Introuvable'), { status: 404 }))), null);
  assert.equal(await readOperations(failing(Object.assign(new Error('Erreur'), { status: 503 }))), false);
  assert.equal(await readOperations(failing(new TypeError('réseau'))), false);
  assert.deepEqual(await readOperations(async (path) => ({ path })), { path: '/api/operations' });
  const cards = buildDashboard({ operations: false, localHealth: { mode: 'local-only' } });
  for (const id of ['server', 'workers', 'backup']) { assert.equal(card(cards, id).value, 'Indisponible', id); assert.match(card(cards, id).detail, /pas répondu/, id); }
});

test('a missed operations reading neither raises nor hides a worker alert', () => {
  const online = snapshot({ operations: { workers: [{ id: 'w', online: true, revoked: false }] } });
  const unread = snapshot({ operations: false }, online);
  assert.deepEqual(newAlerts(online, unread, { worker: true }), []);
  const offline = snapshot({ operations: { workers: [{ id: 'w', online: false, revoked: false }] } }, unread);
  assert.deepEqual(newAlerts(unread, offline, { worker: true }).map((a) => a.kind), ['worker']);
});

test('a blocked task that merely mentions a budget is not a budget alert', () => {
  const next = snapshot({ notifications: [
    { type: 'blocked', id: '1', detail: 'Préparer le budget publicitaire — Agent indisponible (désactivé ou sans fiche).' },
    { type: 'blocked', id: '2', detail: 'Analyser les prix — Budget de la mission atteint (3.00 sur 3.00 $) : augmentez-le pour continuer.' }
  ] });
  assert.deepEqual(next.budget, ['2']); assert.deepEqual(next.failed, ['1']);
});
