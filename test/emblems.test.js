import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBLEMS, drawEmblem } from '../public/emblems.js';
import { OPTIONS } from '../public/island-style.js';

test('one 9×9 emblem per option, all distinct and recognisable density', () => {
  assert.deepEqual(Object.keys(EMBLEMS).sort(), [...OPTIONS.emblem].sort());
  const seen = new Set();
  for (const [name, rows] of Object.entries(EMBLEMS)) {
    assert.equal(rows.length, 9, name);
    assert.ok(rows.every((r) => /^[#.]{9}$/.test(r)), name);
    const lit = rows.join('').split('#').length - 1;
    assert.ok(lit >= 12 && lit <= 60, `${name}: ${lit}`);
    seen.add(rows.join('/'));
  }
  assert.equal(seen.size, 8);
});

test('drawEmblem paints whole pixels inside its 9×9 box at the given scale', () => {
  const rects = []; const ctx = { set fillStyle(v) {}, fillRect: (x, y, w, h) => rects.push([x, y, w, h]) };
  drawEmblem(ctx, 'crown', 10, 20, '#fff', 2);
  assert.ok(rects.length > 0);
  for (const [x, y, w, h] of rects) assert.ok(x >= 10 && x + w <= 28 && y >= 20 && y + h <= 38 && w === 2 && h === 2);
  const n = rects.length;
  for (const name of ['unknown', 'constructor', 'toString', '__proto__']) drawEmblem(ctx, name, 0, 0, '#fff'); // nom inconnu ou hérité : ne dessine rien, ne lève pas
  assert.equal(rects.length, n);
});
