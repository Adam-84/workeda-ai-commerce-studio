// Lot 3 : quota observé. Événements simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaOfEvent, signalReason } from '../src/engines.js';
import { observeTools } from '../src/comm-core.js';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const later = '2026-11-27T14:00:00.000Z', past = '2026-11-27T08:00:00.000Z';
const event = (info, extra = {}) => ({ type: 'rate_limit_event', rate_limit_info: info, ...extra });
const opus = { provider: 'claude', model: 'opus' }, sonnet = { provider: 'claude', model: 'sonnet' };
const signal = (extra = {}) => ({ status: 'allowed', window: 'five_hour', utilization: null, resetsAt: later, overage: false, ...extra });

test('événement : champs bornés, absents laissés inconnus, inconnu ignoré', () => {
  assert.deepEqual(quotaOfEvent(event({ status: 'rejected', resetsAt: Date.parse(later) / 1000, rateLimitType: 'seven_day_opus' })), { status: 'rejected', window: 'seven_day_opus', utilization: null, resetsAt: later, overage: false, source: 'local' });
  assert.equal(quotaOfEvent(event({ status: 'allowed' })).resetsAt, null);
  assert.equal(quotaOfEvent(event({ status: 'allowed', rateLimitType: 'nouvelle' })).window, 'unknown');
  assert.equal(quotaOfEvent(event({ status: 'autre' })), null);
  assert.equal(quotaOfEvent({ type: 'result' }), null);
  assert.equal(quotaOfEvent(event({ status: 'allowed' }, { archipel_source: 'worker-1' })).source, 'worker-1');
  const seen = observeTools();
  seen.feed(event({ status: 'allowed', rateLimitType: 'five_hour' })); seen.feed(event({ status: 'rejected', rateLimitType: 'five_hour' }));
  assert.deepEqual(seen.state.quota.map((q) => q.status), ['rejected']);
});

test('jugement : refus daté, fenêtre par modèle, relevé périmé, confirmations', () => {
  assert.match(signalReason(signal({ status: 'rejected' }), sonnet, NOW), /reprise après/);
  assert.equal(signalReason(signal({ status: 'rejected', window: 'seven_day_opus' }), sonnet, NOW), '');
  assert.match(signalReason(signal({ status: 'rejected', window: 'seven_day_opus' }), opus, NOW), /Limite/);
  assert.equal(signalReason(signal({ status: 'rejected', resetsAt: past }), sonnet, NOW), '');
  const open = signal({ status: 'rejected', resetsAt: null });
  assert.match(signalReason(open, sonnet, NOW), /confirmez/);
  assert.equal(signalReason({ ...open, confirmedUntil: later }, sonnet, NOW), '');
  assert.match(signalReason({ ...signal({ status: 'rejected' }), confirmedUntil: later }, sonnet, NOW), /reprise après/);
  assert.match(signalReason(signal({ overage: true }), sonnet, NOW), /Dépense supplémentaire/);
  assert.equal(signalReason({ ...signal({ overage: true }), confirmedUntil: later }, sonnet, NOW), '');
  assert.equal(signalReason(signal(), sonnet, NOW), '');
});
