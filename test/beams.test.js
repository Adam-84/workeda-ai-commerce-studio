import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBeams, LINK_WINDOW_MS } from '../public/beams.js';

const agents = [{ id: 'a', department_id: 'mk' }, { id: 'b', department_id: 'data' }, { id: 'c', department_id: 'mk' }];
const now = Date.parse('2026-11-10T12:00:00Z');
const iso = (msAgo) => new Date(now - msAgo).toISOString();

test('only real messages and missions produce beams, from the right islands', () => {
  const r = computeBeams({ agents, now, seen: new Set(), messages: [{ id: 'm1', from_agent_id: 'a', to_agent_id: 'b', created_at: iso(1000) }], missions: [{ id: 'x1', requested_by: null, assigned_to: 'b', created_at: iso(1000) }] });
  assert.deepEqual(r.fresh.map((f) => [f.kind, f.from, f.to]), [['message', 'mk', 'data'], ['mission', 'hub', 'data']]);
  assert.deepEqual(computeBeams({ agents, now, seen: new Set(), messages: [], missions: [] }).fresh, []);
});

test('first load replays nothing and already-seen exchanges are not replayed', () => {
  const messages = [{ id: 'm1', from_agent_id: 'a', to_agent_id: 'b', created_at: iso(1000) }];
  const first = computeBeams({ agents, now, seen: null, messages, missions: [] });
  assert.deepEqual(first.fresh, []);
  assert.deepEqual(computeBeams({ agents, now, seen: new Set(first.ids), messages, missions: [] }).fresh, []);
});

test('same-island exchange is a spark; links keep only the last 24 h', () => {
  const r = computeBeams({ agents, now, seen: new Set(), missions: [], messages: [
    { id: 'm1', from_agent_id: 'a', to_agent_id: 'c', created_at: iso(1000) },
    { id: 'm2', from_agent_id: 'a', to_agent_id: 'b', created_at: iso(LINK_WINDOW_MS + 1000) }] });
  assert.equal(r.fresh.find((f) => f.id === 'msg:m1').spark, true);
  assert.deepEqual(r.links, []);
});
