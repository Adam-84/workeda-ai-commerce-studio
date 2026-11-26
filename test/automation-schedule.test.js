import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSlots } from '../src/automation-schedule.js';
import { condition, validateDefinition } from '../src/automation-core.js';

test('Paris skips nonexistent spring hour and chooses first repeated autumn hour', () => {
  const schedule = { kind: 'daily', time: '02:30', zone: 'Europe/Paris' };
  assert.equal(nextSlots(schedule, '2027-03-27T02:00:00Z', 1)[0], '2027-03-29T00:30:00.000Z');
  assert.deepEqual(nextSlots(schedule, '2027-10-30T12:00:00Z', 2), ['2027-10-31T00:30:00.000Z', '2027-11-01T01:30:00.000Z']);
});
test('monthly skips absent days, weekly and interval use their specified calendar', () => {
  assert.equal(nextSlots({ kind: 'monthly', day: 31, time: '09:00' }, '2028-01-31T09:00:00Z', 1)[0], '2028-03-31T07:00:00.000Z');
  assert.equal(nextSlots({ kind: 'weekly', weekday: 1, time: '09:00' }, '2026-11-25T12:00:00Z', 1)[0], '2026-11-30T08:00:00.000Z');
  assert.equal(nextSlots({ kind: 'interval', minutes: 15, anchor: '2026-01-01T00:00:00Z' }, '2026-01-01T00:15:00Z', 1)[0], '2026-01-01T00:30:00.000Z');
  assert.deepEqual(nextSlots({ kind: 'once', at: '2026-01-01T00:00:00Z' }, '2026-02-01T00:00:00Z'), []);
});
test('conditions never convert unknown cost or incomparable currency to a real margin', () => {
  assert.equal(condition({ kind: 'margin', below: 30 }, { price: 10, cost: null, currency: 'EUR', costCurrency: 'EUR' }).available, false);
  assert.equal(condition({ kind: 'margin', below: 30 }, { price: 10, cost: 8, currency: 'EUR', costCurrency: 'USD' }).available, false);
  assert.equal(condition({ kind: 'margin', below: 30 }, { price: 10, cost: 8, currency: 'EUR', costCurrency: 'EUR' }).matched, true);
  assert.equal(condition({ kind: 'variation', percent: 10 }, { before: 0, after: 4 }).available, false);
  assert.equal(condition({ kind: 'variation', percent: 10 }, { before: 100, after: 115 }).matched, true);
});
test('definition trust boundary rejects executable expressions, unknown sources and unbounded intervals', () => {
  const base = { name: 'Audit', agentSlug: 'maxime', objective: 'Analyser', trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } }, sources: ['shopify_apps'] };
  assert.equal(validateDefinition(base).allowAi, false);
  for (const change of [{ sources: ['arbitrary-url'] }, { trigger: { kind: 'condition', condition: { kind: 'javascript', code: 'process.exit()' } } }, { trigger: { kind: 'time', schedule: { kind: 'interval', minutes: 0 } } }]) assert.throws(() => validateDefinition({ ...base, ...change }));
});
