// public/iso.js — primitives Pixel Art isométriques (pures, sans DOM).
export const OL = '#2a2033';
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const hex = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export const shade = (c, f) => hex(rgb(c).map((v) => (f > 0 ? v + (255 - v) * f : v * (1 + f))));
export const mix = (a, b, f) => { const A = rgb(a), B = rgb(b); return hex(A.map((v, i) => v + (B[i] - v) * f)); };

const LIGHT = { morning: ['#ffe0c0', 0.1], noon: null, evening: ['#ff7a5c', 0.16], night: ['#141a48', 0.45] };
/** Fonction de teinte selon la phase (mise en cache par couleur). */
export function tinter(phase, k = 1) {
  const l = LIGHT[phase]; if (!l) return (c) => c;
  const m = new Map();
  return (c) => { if (!m.has(c)) m.set(c, mix(c, l[0], l[1] * k)); return m.get(c); };
}

/** Polygone rempli au pixel près (balayage par lignes, règle pair-impair). */
export function fillPoly(ctx, pts, color) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  ctx.fillStyle = color;
  for (let y = y0; y < y1; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc) !== (by <= yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.round(xs[k]), b = Math.round(xs[k + 1]); if (b > a) ctx.fillRect(a, y, b - a, 1); }
  }
}
export const diamondPts = (x, y, r) => [[x, y - r / 2], [x + r, y], [x, y + r / 2], [x - r, y]];

/** Prisme : dessus centré sur (x, y), demi-largeur r, épaisseur h, contour ol (null = sans). */
export function prism(ctx, x, y, r, h, cT, cL, cR, ol = OL) {
  if (ol) fillPoly(ctx, [[x, y - r / 2 - 2], [x + r + 3, y], [x + r + 3, y + h + 1], [x, y + r / 2 + h + 2], [x - r - 3, y + h + 1], [x - r - 3, y]], ol);
  fillPoly(ctx, [[x - r, y], [x, y + r / 2], [x, y + r / 2 + h], [x - r, y + h]], cL);
  fillPoly(ctx, [[x, y + r / 2], [x + r, y], [x + r, y + h], [x, y + r / 2 + h]], cR);
  fillPoly(ctx, diamondPts(x, y, r), cT);
}
/** Bloc posé au sol (x, gy) ; C = fonction de teinte. */
export const box = (ctx, C, x, gy, r, h, wall, top) => prism(ctx, x, gy - h, r, h, C(top || shade(wall, 0.15)), C(shade(wall, -0.06)), C(shade(wall, -0.3)));

export function disc(ctx, cx, cy, r, color, ol) {
  if (ol) disc(ctx, cx, cy, r + 1.5, ol);
  ctx.fillStyle = color;
  for (let y = Math.floor(cy - r); y < Math.ceil(cy + r); y++) {
    const dy = y + 0.5 - cy, half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const a = Math.round(cx - half), b = Math.round(cx + half);
    if (b > a) ctx.fillRect(a, y, b - a, 1);
  }
}
export function line(ctx, x1, y1, x2, y2, color, w = 1) {
  ctx.fillStyle = color;
  const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let k = 0; k <= n; k++) ctx.fillRect(Math.round(x1 + ((x2 - x1) * k) / n), Math.round(y1 + ((y2 - y1) * k) / n), w, w);
}
