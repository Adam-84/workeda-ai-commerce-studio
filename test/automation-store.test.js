import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAutomationStore } from '../src/studio-automation.js';
const definition = { name: 'Audit apps', agentSlug: 'maxime', objective: 'Analyser les apps locales', sources: ['shopify_apps'], trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } };
function fixture() {
  const db = new DatabaseSync(':memory:'); let time = '2026-11-25T07:00:00.000Z';
  const store = createAutomationStore(db, { clock: () => time, identity: 'pc-a', validateAgent: () => true });
  return { db, store, at: (s) => { time = s; } };
}
test('new/imported definitions are inactive and need a separately confirmed executor', () => {
  const { db, store } = fixture(); try {
    const d = store.save(definition); assert.equal(d.enabled, false);
    assert.throws(() => store.activate(d.id, { confirm: true }), /ordinateur/i);
    store.designate({ confirm: true }); store.activate(d.id, { confirm: true });
    const exported = store.exportDefinitions(); assert.equal(exported[0].enabled, undefined);
    const other = createAutomationStore(new DatabaseSync(':memory:'), { identity: 'pc-b', validateAgent: () => true });
    assert.equal(other.importDefinitions(exported)[0].enabled, false); assert.equal(other.status().owner, false);
    assert.equal(store.save({ ...d, objective: 'Nouvelle demande' }).enabled, false);
    assert.equal(store.importDefinitions(store.exportDefinitions())[0].enabled, false);
  } finally { db.close(); }
});
test('occurrences survive restart, claim once, expire and stop blocks manual runs', () => {
  const { db, store, at } = fixture(); try {
    store.designate({ confirm: true }); const d = store.save(definition); store.activate(d.id, { confirm: true });
    at('2026-11-25T08:00:00.000Z'); store.scheduleDue(); store.scheduleDue();
    assert.equal(store.history().length, 1);
    const r = store.claim('worker-a'); assert.ok(r); assert.equal(store.claim('worker-b'), null);
    store.finish(r.id, 'done', 'Sans IA'); assert.equal(store.claim('worker-b'), null);
    store.pause(true); assert.throws(() => store.manual(d.id, { confirm: true }), /suspend/i);
    store.pause(false); const m = store.manual(d.id, { confirm: true }); at('2026-11-27T08:00:00.000Z');
    assert.equal(store.claim('worker-a'), null); assert.equal(store.run(m.id).state, 'expired');
  } finally { db.close(); }
});
test('first observations establish baseline and changed observations deduplicate events', () => {
  const { db, store } = fixture(); try {
    assert.equal(store.observe({ source: 'catalog', subject: 'shop', revision: 'a', event: 'catalog.changed', fetchedAt: '2026-11-25T07:00:00Z' }), null);
    const e = store.observe({ source: 'catalog', subject: 'shop', revision: 'b', event: 'catalog.changed', fetchedAt: '2026-11-25T07:01:00Z' }); assert.ok(e);
    assert.equal(store.observe({ source: 'catalog', subject: 'shop', revision: 'b', event: 'catalog.changed', fetchedAt: '2026-11-25T07:01:00Z' }), null);
    assert.equal(store.observe({ source: 'catalog', subject: 'shop', revision: 'c', event: 'catalog.changed', partial: true }), null);
  } finally { db.close(); }
});
test('long outage coalesces to the latest recent slot and clock rollback cannot replay it', () => {
  const { db, store, at } = fixture(); try {
    store.designate({ confirm: true }); const d = store.save(definition); store.activate(d.id, { confirm: true }); at('2026-11-29T12:00:00.000Z'); store.scheduleDue();
    assert.equal(store.history().filter((r) => r.state === 'queued').length, 1);
    assert.match(store.history()[0].occurrence_key, /2026-11-29T08:00/);
    at('2026-11-28T07:00:00.000Z'); store.scheduleDue(); assert.equal(store.history().length, 1);
  } finally { db.close(); }
});
test('local AI call reservations enforce the per-rule quota before a second dispatch', () => {
  const { db, store } = fixture(); try {
    store.designate({ confirm: true }); const d = store.save({ ...definition, allowAi: true, perDay: 1 }); store.activate(d.id, { confirm: true, ai: true });
    const first = store.manual(d.id, { confirm: true }); store.claim('w'); assert.equal(store.reserveAi(first.id), true); store.finish(first.id, 'done');
    const second = store.manual(d.id, { confirm: true }); store.claim('w'); assert.equal(store.reserveAi(second.id), false);
  } finally { db.close(); }
});
test('new zero price is a real 100 percent variation; an old zero never becomes infinite percent', () => {
  const { db, store, at } = fixture(); try {
    store.designate({ confirm: true }); const d = store.save({ ...definition, sources: ['shopify_admin'], trigger: { kind: 'condition', condition: { kind: 'variation', percent: 10 } } }); const active = store.activate(d.id, { confirm: true });
    store.evaluatePrice(active, 'v1', { value: 100, currency: 'EUR', fetchedAt: '2026-11-25T07:00:00.000Z' });
    at('2026-11-25T07:01:00.000Z'); store.evaluatePrice(active, 'v1', { value: 0, currency: 'EUR', fetchedAt: '2026-11-25T07:01:00.000Z' }); assert.equal(store.history().length, 1);
    at('2026-11-25T09:00:00.000Z'); store.evaluatePrice(active, 'v1', { value: 100, currency: 'EUR', fetchedAt: '2026-11-25T09:00:00.000Z' }); assert.equal(store.history().length, 1);
  } finally { db.close(); }
});
