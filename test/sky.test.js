import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseForHour, resolveSkyPhase, normalizeOverride, loadOverride, saveOverride, PALETTES, PHASES } from '../public/sky.js';

test('phase boundaries follow local hour', () => {
  const expected = { 0: 'night', 4: 'night', 5: 'morning', 9: 'morning', 10: 'noon', 16: 'noon', 17: 'evening', 20: 'evening', 21: 'night', 23: 'night' };
  for (const [hour, phase] of Object.entries(expected)) assert.equal(phaseForHour(Number(hour)), phase, `${hour}h`);
});

test('manual override wins, auto and junk fall back to the clock', () => {
  const noon = new Date(2026, 0, 1, 12, 0);
  assert.equal(resolveSkyPhase(noon), 'noon');
  assert.equal(resolveSkyPhase(noon, 'night'), 'night');
  assert.equal(resolveSkyPhase(noon, 'auto'), 'noon');
  assert.equal(normalizeOverride('storm'), 'auto');
});

test('only a manual choice is persisted; missing storage never throws', () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  assert.equal(loadOverride(storage), 'auto');
  saveOverride('evening', storage);
  assert.equal(loadOverride(storage), 'evening');
  saveOverride('auto', storage);
  assert.equal(map.size, 0);
  assert.equal(loadOverride({ getItem() { throw new Error('blocked'); } }), 'auto');
  assert.equal(saveOverride('night', { setItem() { throw new Error('blocked'); } }), 'night');
});

test('every phase has a palette; only evening and night light the buildings', () => {
  for (const p of PHASES) assert.ok(PALETTES[p].skyTop && PALETTES[p].skyBottom);
  assert.deepEqual(PHASES.filter((p) => PALETTES[p].lights), ['evening', 'night']);
  assert.equal(PALETTES.night.stars, true);
});
