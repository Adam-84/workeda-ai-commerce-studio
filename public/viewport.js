// public/viewport.js — vue sur la carte : zoom entier ou demi, déplacement borné (pur).
export const ZOOMS = [0.5, 1, 2];
const MARGIN = 200;
export const createViewport = (worldW, worldH, viewW, viewH) => ({ worldW, worldH, viewW, viewH, zoom: 1, x: 0, y: 0 });
export const toScreen = (vp, wx, wy) => [(wx - vp.x) * vp.zoom, (wy - vp.y) * vp.zoom];
export const toWorld = (vp, sx, sy) => [sx / vp.zoom + vp.x, sy / vp.zoom + vp.y];
export const visibleRect = (vp) => ({ x: vp.x, y: vp.y, w: vp.viewW / vp.zoom, h: vp.viewH / vp.zoom });
export function clampView(vp) {
  const { w, h } = visibleRect(vp);
  const clamp = (v, size, world) => (world + 2 * MARGIN <= size ? (world - size) / 2 : Math.min(Math.max(v, -MARGIN), world - size + MARGIN));
  vp.x = Math.round(clamp(vp.x, w, vp.worldW) * vp.zoom) / vp.zoom;
  vp.y = Math.round(clamp(vp.y, h, vp.worldH) * vp.zoom) / vp.zoom;
  return vp;
}
export function centerOn(vp, wx, wy) { vp.x = wx - vp.viewW / vp.zoom / 2; vp.y = wy - vp.viewH / vp.zoom / 2; return clampView(vp); }
export function zoomAt(vp, zoom, sx, sy) {
  if (!ZOOMS.includes(zoom)) return vp;
  const [wx, wy] = toWorld(vp, sx, sy);
  vp.zoom = zoom; vp.x = wx - sx / zoom; vp.y = wy - sy / zoom;
  return clampView(vp);
}
export function panBy(vp, dsx, dsy) { vp.x -= dsx / vp.zoom; vp.y -= dsy / vp.zoom; return clampView(vp); }
export const nextZoom = (zoom, dir) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + dir))];
// vue intermédiaire entre a et b (e de 0 à 1) : zoom géométrique, le point de l'écran qui ne bouge pas entre a et b reste fixe
export function lerpView(a, b, e) {
  if (a.zoom === b.zoom) return { zoom: a.zoom, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
  const zoom = a.zoom * (b.zoom / a.zoom) ** e, d = 1 / a.zoom - 1 / b.zoom;
  const at = (p, q) => { const s = (q - p) / d; return p + s / a.zoom - s / zoom; };
  return { zoom, x: at(a.x, b.x), y: at(a.y, b.y) };
}
