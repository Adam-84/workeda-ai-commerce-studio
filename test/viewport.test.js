import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewport, toScreen, toWorld, centerOn, zoomAt, panBy, nextZoom, ZOOMS } from '../public/viewport.js';

test('screen ↔ world conversion is reversible at every zoom', () => {
  for (const z of ZOOMS) {
    const vp = createViewport(2400, 1600, 1440, 900); vp.zoom = z; centerOn(vp, 1200, 800);
    const [sx, sy] = toScreen(vp, 1000, 700); const [wx, wy] = toWorld(vp, sx, sy);
    assert.ok(Math.abs(wx - 1000) < 1e-9 && Math.abs(wy - 700) < 1e-9, `zoom ${z}`);
  }
});

test('zooming keeps the point under the cursor in place; only allowed zooms', () => {
  const vp = centerOn(createViewport(2400, 1600, 1440, 900), 1200, 800);
  const before = toWorld(vp, 300, 200); zoomAt(vp, 2, 300, 200); const after = toWorld(vp, 300, 200);
  assert.ok(Math.abs(before[0] - after[0]) < 1 && Math.abs(before[1] - after[1]) < 1);
  zoomAt(vp, 3, 0, 0); assert.equal(vp.zoom, 2);
  assert.equal(nextZoom(1, 1), 2); assert.equal(nextZoom(2, 1), 2); assert.equal(nextZoom(0.5, -1), 0.5);
});

test('panning is clamped near the world', () => {
  const vp = centerOn(createViewport(2400, 1600, 1440, 900), 1200, 800);
  panBy(vp, 1e6, 1e6);
  assert.ok(vp.x >= -200 && vp.y >= -200);
});
