import test from 'node:test';
import assert from 'node:assert/strict';
import { supports, textWidth, drawPixelText } from '../public/pixelfont.js';

test('covers every department name, the hub and the logo', () => {
  for (const n of ['Direction', 'Catalogue', 'Création', 'Marketing', 'Service client', 'Opérations', 'Données', 'Laboratoire', 'Coordination', 'WORKEDA']) assert.ok(supports(n), n);
  assert.equal(supports('€'), false);
});

test('width is 6 px per character minus the last gap', () => {
  assert.equal(textWidth('AB'), 11);
  assert.equal(textWidth('AB', 2), 22);
});

test('draws only whole pixels in the given colour', () => {
  const rects = []; const ctx = { set fillStyle(v) { this.c = v; }, fillRect: (x, y, w, h) => rects.push([x, y, w, h]) };
  drawPixelText(ctx, 'É', 10, 10, '#fff');
  assert.ok(rects.length > 10);
  assert.ok(rects.some(([, y]) => y < 10)); // accent au-dessus
});
