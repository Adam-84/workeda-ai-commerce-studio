import test from 'node:test';
import assert from 'node:assert/strict';
import { autoAppearance, appearanceFor, isValidAppearance, spriteGrid, expressionFor, OPTIONS } from '../public/sprites.js';

const ada = { name: 'Ada', role: 'Pilotage' };

test('automatic appearance is stable and valid, with a department outfit', () => {
  const a = autoAppearance(ada, 'Laboratoire');
  assert.deepEqual(a, autoAppearance({ ...ada }, 'Laboratoire'));
  assert.ok(isValidAppearance(a));
  assert.equal(a.outfit, 'labcoat');
});

test('a saved valid appearance wins, an invalid one is ignored', () => {
  const saved = { ...autoAppearance(ada, 'Direction'), hairStyle: 'bun' };
  assert.equal(appearanceFor(ada, 'Direction', saved).hairStyle, 'bun');
  assert.deepEqual(appearanceFor(ada, 'Direction', { hairStyle: 'mohawk' }), autoAppearance(ada, 'Direction'));
  assert.equal(isValidAppearance({ ...saved, topColor: '#000000' }), false);
});

test('sprite grid is 64×64 for every direction and frame', () => {
  const look = autoAppearance(ada, 'Marketing');
  for (const dir of ['down', 'up', 'left', 'right']) for (const frame of [0, 1, 2]) {
    const g = spriteGrid(look, { dir, frame });
    assert.equal(g.length, 64); assert.ok(g.every((row) => row.length === 64));
    assert.ok(g.flat().some(Boolean));
  }
});

test('right is the mirror of left', () => {
  const look = autoAppearance(ada, 'Données');
  const l = spriteGrid(look, { dir: 'left' }), r = spriteGrid(look, { dir: 'right' });
  assert.deepEqual(r, l.map((row) => row.slice().reverse()));
});

test('expressions follow the real status and change the face', () => {
  assert.deepEqual(['idle', 'working', 'waiting', 'blocked', 'weird'].map(expressionFor), ['calm', 'focused', 'questioning', 'worried', 'calm']);
  const look = autoAppearance(ada, 'Direction');
  assert.notDeepEqual(spriteGrid(look, { expr: 'calm' }), spriteGrid(look, { expr: 'worried' }));
});

test('focused typing toggles hands only, legs stay still', () => {
  const look = autoAppearance(ada, 'Données');
  const f0 = spriteGrid(look, { expr: 'focused', dir: 'down', frame: 0 });
  const f1 = spriteGrid(look, { expr: 'focused', dir: 'down', frame: 1 });
  assert.notDeepEqual(f0, f1);
  // jambes = colonnes 24–39 (les mains occupent 18–21 et 42–45 et bougent)
  const legs = (g) => g.slice(46, 62).map((row) => row.slice(24, 40));
  assert.deepEqual(legs(f0), legs(f1));
});

test('every option list is non-empty', () => { for (const k of Object.keys(OPTIONS)) assert.ok(OPTIONS[k].length > 0); });
