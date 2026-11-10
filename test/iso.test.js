import test from 'node:test';
import assert from 'node:assert/strict';
import { fillPoly, diamondPts, prism, shade, mix, tinter, disc } from '../public/iso.js';

const fakeCtx = () => { const rects = []; return { rects, set fillStyle(v) { this.c = v; }, fillRect(x, y, w, h) { rects.push({ x, y, w, h, c: this.c }); } }; };

test('fillPoly fills a 2:1 diamond with whole-pixel rows inside its bounds', () => {
  const ctx = fakeCtx();
  fillPoly(ctx, diamondPts(50, 50, 20), '#ff0000');
  assert.ok(ctx.rects.length >= 18);
  for (const r of ctx.rects) {
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger));
    assert.ok(r.x >= 30 && r.x + r.w <= 70 && r.y >= 40 && r.y < 60 && r.h === 1);
  }
});

test('prism draws outline first then top face last', () => {
  const ctx = fakeCtx();
  prism(ctx, 50, 50, 10, 6, '#aaaaaa', '#888888', '#666666', '#000000');
  assert.equal(ctx.rects[0].c, '#000000');
  assert.equal(ctx.rects.at(-1).c, '#aaaaaa');
});

test('colour helpers', () => {
  assert.equal(shade('#808080', -0.5), '#404040');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(tinter('noon')('#123456'), '#123456');
  assert.notEqual(tinter('night')('#ffffff'), '#ffffff');
});

test('disc stays inside its radius', () => {
  const ctx = fakeCtx(); disc(ctx, 20, 20, 5, '#00ff00');
  for (const r of ctx.rects) assert.ok(r.x >= 15 && r.x + r.w <= 25 && r.y >= 15 && r.y < 25);
});
