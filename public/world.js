// public/world.js — archipel isométrique : disposition et placement (pur), puis dessin (Task 8).
import { OL, shade, fillPoly, diamondPts, prism, box, disc, line } from './iso.js';
import { drawPixelText, textWidth } from './pixelfont.js';
import { applyStyle, OPTIONS } from './island-style.js';
import { drawEmblem } from './emblems.js';

export const GRID = Object.freeze({ DX: 400, DY: 200 });
export const ISLAND = Object.freeze({ R: 240, H: 16, RR: 170, HW: 84, GROW: 60, DESKS: 9 });
export const IDENTITY = Object.freeze({
  Direction: { accent: '#f2c14e', floor: '#e9d3a8', wall: '#efe4cc' },
  Catalogue: { accent: '#4f8fd9', floor: '#cfe0f2', wall: '#efe4cc' },
  'Création': { accent: '#b46be0', floor: '#ecd3ef', wall: '#efe4cc' },
  Marketing: { accent: '#ff6f5c', floor: '#ffd8cc', wall: '#efe4cc' },
  'Service client': { accent: '#2fb39a', floor: '#cdeee2', wall: '#efe4cc' },
  'Opérations': { accent: '#e8853d', floor: '#e3d6c4', wall: '#e2d8c8' },
  'Données': { accent: '#3b9be0', floor: '#d4d9f2', wall: '#c8ccd8' },
  Laboratoire: { accent: '#8ac23a', floor: '#e4f2cf', wall: '#f2f4f6' }
});
const FALLBACK = ['#d9655a', '#6a82e0', '#c06ad0', '#4fb98f'];
export function identityFor(name, index) {
  if (IDENTITY[name]) return IDENTITY[name];
  const accent = FALLBACK[index % FALLBACK.length];
  return { accent, floor: shade(accent, 0.7), wall: '#efe4cc' };
}
export const styledIdentity = (name, index, style) => applyStyle(identityFor(name, index), style);
const RING1 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const RING2 = (() => { const out = []; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if (Math.max(Math.abs(i), Math.abs(j)) === 2) out.push([i, j]); return out.sort((a, b) => Math.atan2(a[1] + a[0], a[0] - a[1]) - Math.atan2(b[1] + b[0], b[0] - b[1])); })();

export function computeWorld(departments, agents = [], styles = []) {
  const byDept = styles instanceof Map ? styles : new Map((styles || []).filter(Boolean).map((s) => [s.departmentId, s]));
  const counts = new Map(); for (const a of agents) counts.set(a.department_id, (counts.get(a.department_id) || 0) + 1);
  const slots = [...RING1, ...RING2];
  const raw = departments.map((d, k) => {
    const [i, j] = slots[k % slots.length];
    const grow = Math.ceil(Math.max(0, (counts.get(d.id) || 0) - ISLAND.DESKS) / 3) * ISLAND.GROW;
    const identity = styledIdentity(d.name, k, byDept.get(d.id));
    return { id: d.id, name: d.name, index: k, i, j, gx: (i - j) * GRID.DX, gy: (i + j) * GRID.DY, R: ISLAND.R + grow, RR: ISLAND.RR + grow, identity, label: identity.label || d.name };
  });
  const bs = raw.map((r) => islandBounds({ ...r, x: r.gx, y: r.gy })), hubR = 220;
  const minX = Math.min(-hubR, ...raw.map((r) => r.gx - 520), ...bs.map((b) => b.x)), maxX = Math.max(hubR, ...raw.map((r) => r.gx + 520), ...bs.map((b) => b.x + b.w));
  const minY = Math.min(-hubR, ...raw.map((r) => r.gy - 360), ...bs.map((b) => b.y)), maxY = Math.max(hubR, ...raw.map((r) => r.gy + 420), ...bs.map((b) => b.y + b.h));
  return {
    width: maxX - minX, height: maxY - minY,
    hub: { x: -minX, y: -minY, R: 220 },
    islands: raw.map(({ gx, gy, ...r }) => ({ ...r, x: gx - minX, y: gy - minY }))
  };
}
const roomCenterY = (isl) => isl.y - 20;
export const roomPoint = (isl, a, b) => [isl.x + ((a - b) * isl.RR) / 2, roomCenterY(isl) + ((a + b) * isl.RR) / 4];
export function deskSpots(isl, n) {
  const rows = Math.max(3, Math.ceil(n / 3));
  const bs = rows === 3 ? [-0.25, 0.2, 0.65] : Array.from({ length: rows }, (_, k) => -0.3 + (1.05 * k) / (rows - 1));
  const out = [];
  for (const b of bs) for (const a of [-0.15, 0.25, 0.65]) out.push(roomPoint(isl, a, b));
  return out.slice(0, n);
}
export function placeAgents(world, agents) {
  const ordered = [...agents].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.name.localeCompare(b.name)));
  const out = [];
  for (const isl of world.islands) {
    const here = ordered.filter((a) => a.department_id === isl.id);
    deskSpots(isl, here.length).forEach(([x, y], k) => out.push({ agent: here[k], island: isl, x: Math.round(x), y: Math.round(y) }));
  }
  return out.sort((a, b) => a.y - b.y);
}
export const recruitSpot = (isl) => [isl.x + Math.round(isl.R * 0.46), isl.y + 52];
export const signSpot = (isl) => [isl.x, isl.y + 96];
export const pillSpot = (isl) => [isl.x, roomCenterY(isl) - isl.RR / 2 - ISLAND.HW - 14];
export const doorSpot = (isl) => [isl.x + isl.RR * 0.73, roomCenterY(isl) - isl.RR / 2 + isl.RR * 0.365];
export const islandBounds = (isl) => { const top = roomCenterY(isl) - isl.RR / 2 - ISLAND.HW - 70; return { x: Math.floor(isl.x - isl.R - 30), y: Math.floor(top), w: 2 * isl.R + 60, h: Math.ceil(isl.y + isl.R / 2 + ISLAND.H + isl.R * 0.5 + 40 - top) }; };

// ---------- dessin (canvas ; C = fonction de teinte de la phase) ----------
const glow = (ctx, c, x, y, w, h, a) => { ctx.globalAlpha = a; ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); ctx.globalAlpha = 1; };
const quadOn = (P, t1, t2, h1, h2) => { const [a, b] = P(t1), [c, d] = P(t2); return [[a, b - h1], [c, d - h1], [c, d - h2], [a, b - h2]]; };
function plant(ctx, C, x, y) { box(ctx, C, x, y, 6, 8, '#c97a4a'); disc(ctx, x, y - 16, 8, C('#4f9f4f'), OL); }
function shelf(ctx, C, x, y, h, cols) { box(ctx, C, x, y, 16, h, '#8a6240'); cols.forEach((c, k) => { ctx.fillStyle = C(c); ctx.fillRect(x - 14, y - h + 6 + k * 12, 12, 7); }); }

const FURNITURE = {
  Direction: [[-0.15, 0.25, (ctx, C, x, y) => fillPoly(ctx, diamondPts(x, y, 52), C('#b4473f'))], [-0.8, -0.2, (ctx, C, x, y) => shelf(ctx, C, x, y, 60, ['#d9655a', '#4f8fd9', '#e8b03d', '#8ac23a'])], [-0.75, 0.55, plant], [0.6, -0.75, (ctx, C, x, y) => { box(ctx, C, x, y, 8, 10, '#8a6240'); disc(ctx, x, y - 20, 8, C('#4f8fd9'), OL); }]],
  Catalogue: [[-0.8, -0.3, (ctx, C, x, y) => shelf(ctx, C, x, y, 62, ['#c99a5e', '#b8854e', '#c99a5e', '#b8854e'])], [-0.8, 0.3, (ctx, C, x, y) => shelf(ctx, C, x, y, 62, ['#b8854e', '#c99a5e', '#d9b07a', '#c99a5e'])], [0.65, -0.7, (ctx, C, x, y) => { box(ctx, C, x, y, 10, 10, '#c99a5e'); box(ctx, C, x, y - 10, 10, 10, '#d9b07a'); box(ctx, C, x + 18, y + 9, 10, 10, '#b8854e'); }], [0.75, 0.6, (ctx, C, x, y) => { ctx.fillStyle = '#5a5a6a'; ctx.fillRect(x - 22, y - 40, 44, 3); ctx.fillRect(x - 20, y - 40, 2, 40); ctx.fillRect(x + 18, y - 40, 2, 40); ['#ff6f5c', '#4f8fd9', '#f2c14e', '#2fb39a'].forEach((c, k) => { ctx.fillStyle = C(c); ctx.fillRect(x - 16 + k * 9, y - 37, 7, 20); }); }]],
  'Création': [[-0.7, -0.5, (ctx, C, x, y) => { ctx.fillStyle = '#7a5230'; ctx.fillRect(x - 1, y - 50, 2, 50); ctx.fillRect(x - 14, y - 4, 2, 4); ctx.fillRect(x + 12, y - 4, 2, 4); ctx.fillStyle = OL; ctx.fillRect(x - 16, y - 50, 32, 26); ctx.fillStyle = '#fff8ec'; ctx.fillRect(x - 14, y - 48, 28, 22); disc(ctx, x - 4, y - 38, 5, C('#ff6f5c')); ctx.fillStyle = C('#4f8fd9'); ctx.fillRect(x + 2, y - 36, 8, 6); }], [0.55, -0.7, (ctx, C, x, y) => box(ctx, C, x, y, 22, 16, '#e8ecf2', '#f4fbff')], [-0.75, 0.55, plant], [0.75, 0.55, plant]],
  Marketing: [[0.2, -0.95, (ctx, C, x, y) => { fillPoly(ctx, [[x - 42, y - 76], [x + 42, y - 96], [x + 42, y - 46], [x - 42, y - 26]], OL); fillPoly(ctx, [[x - 40, y - 74], [x + 40, y - 94], [x + 40, y - 48], [x - 40, y - 28]], '#ffffff'); ['#f2c14e', '#ff6f5c', '#8ac23a', '#4f8fd9'].forEach((c, k) => { ctx.fillStyle = C(c); ctx.fillRect(x - 30 + k * 16, y - 70 - k * 4, 10, 10); }); }], [-0.75, 0.2, (ctx, C, x, y) => { box(ctx, C, x, y, 26, 10, '#ff8a6c'); box(ctx, C, x - 16, y - 8, 10, 14, '#e86a50'); }], [-0.85, -0.6, (ctx, C, x, y) => { ctx.fillStyle = OL; ctx.fillRect(x - 22, y - 70, 44, 30); ctx.fillStyle = '#24324f'; ctx.fillRect(x - 20, y - 68, 40, 26); [10, 16, 12, 22].forEach((hh, k) => { ctx.fillStyle = C(['#3fd0ff', '#8ac23a', '#f2c14e', '#ff6f5c'][k]); ctx.fillRect(x - 14 + k * 8, y - 44 - hh, 5, hh); }); }]],
  'Service client': [[0.1, -0.75, (ctx, C, x, y) => box(ctx, C, x, y, 40, 16, '#2fb39a', '#e8faf4')], [-0.75, 0.35, (ctx, C, x, y) => { box(ctx, C, x, y, 14, 8, '#ffb15c'); box(ctx, C, x - 8, y - 6, 6, 12, '#e8953d'); }], [-0.75, -0.55, plant]],
  'Opérations': [[-0.6, -0.55, (ctx, C, x, y) => { box(ctx, C, x, y, 42, 10, '#5a6070', '#7a8090'); for (let k = 0; k < 4; k++) box(ctx, C, x - 24 + k * 16, y - 10 - k * 8, 6, 6, '#c99a5e'); }], [0.65, -0.7, (ctx, C, x, y) => { box(ctx, C, x, y, 18, 4, '#a87a4a'); box(ctx, C, x, y - 4, 14, 14, '#c99a5e'); box(ctx, C, x, y - 18, 10, 10, '#d9b07a'); }], [0.75, 0.55, (ctx, C, x, y) => { ctx.fillStyle = '#e8853d'; ctx.fillRect(x - 1, y - 40, 3, 40); ctx.fillStyle = '#3a3f4a'; ctx.fillRect(x - 10, y - 4, 22, 4); box(ctx, C, x + 2, y - 4, 8, 12, '#c99a5e'); }]],
  'Données': [[-0.85, -0.6, 'rack'], [-0.85, -0.1, 'rack'], [-0.85, 0.4, 'rack'], [0.55, -0.75, (ctx, C, x, y) => { box(ctx, C, x, y, 12, 4, '#9aa6b4'); ctx.fillStyle = '#9aa6b4'; ctx.fillRect(x - 1, y - 40, 2, 36); fillPoly(ctx, [[x - 17, y - 50], [x, y - 59], [x + 17, y - 50], [x, y - 41]], OL); fillPoly(ctx, [[x - 16, y - 50], [x, y - 58], [x + 16, y - 50], [x, y - 42]], '#dfe6ee'); }]],
  Laboratoire: [[0.1, -0.75, (ctx, C, x, y) => { box(ctx, C, x, y, 40, 18, '#eef2f6', '#ffffff'); ['#ff6f5c', '#3fd0ff', '#8ac23a'].forEach((c, k) => { ctx.fillStyle = OL; ctx.fillRect(x - 22 + k * 16, y - 34 - k * 4, 6, 12); ctx.fillStyle = C(c); ctx.fillRect(x - 21 + k * 16, y - 30 - k * 4, 4, 7); }); ctx.fillStyle = '#4a4a5a'; ctx.fillRect(x + 22, y - 40, 4, 14); ctx.fillRect(x + 18, y - 28, 12, 4); }], [-0.8, -0.5, (ctx, C, x, y) => { box(ctx, C, x, y, 20, 26, '#bfeef6', '#e0f8fc'); disc(ctx, x, y - 34, 7, C('#4f9f4f')); }], [-0.75, 0.5, plant]]
};
const rack = (ctx, C, x, y) => { box(ctx, C, x, y, 14, 64, '#2f3550', '#3a4260'); for (let k = 0; k < 6; k++) { ctx.fillStyle = k % 2 ? '#4cd68f' : '#5ab0ff'; ctx.fillRect(x - 12, y - 58 + k * 9, 2, 2); } }; // voyants fixes : décor

function drawTree(ctx, C, kind, x, y) {
  if (kind === 'pine') {
    ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 2, y - 12, 5, 12);
    [[26, 0], [20, 14], [14, 26]].forEach(([w, up]) => fillPoly(ctx, [[x - w / 2 - 1, y - 12 - up + 1], [x + w / 2 + 1, y - 12 - up + 1], [x, y - 34 - up]], OL));
    [[26, 0], [20, 14], [14, 26]].forEach(([w, up]) => fillPoly(ctx, [[x - w / 2, y - 12 - up], [x + w / 2, y - 12 - up], [x, y - 32 - up]], C('#2f7a4a')));
    return;
  }
  if (kind === 'palm') {
    const hx = x + 4, hy = y - 42, F = [[-4, 0, 8], [-12, 0, 8], [4, 0, 8], [-16, -4, 12], [-4, -4, 8], [4, -4, 12], [-10, -8, 10], [0, -8, 10], [-4, -12, 8]]; // couronne contiguë, posée sur le haut du tronc (y-38)
    ctx.fillStyle = OL; for (const [dx, dy, w] of F) ctx.fillRect(hx + dx - 1, hy + dy - 1, w + 2, 6);
    ctx.fillStyle = '#8f6544'; for (let k = 0; k < 6; k++) ctx.fillRect(x - 2 + Math.round(k * 0.6), y - 8 - k * 6, 5, 7);
    ctx.fillStyle = C('#3f9a45'); for (const [dx, dy, w] of F) ctx.fillRect(hx + dx, hy + dy, w, 4);
    return;
  }
  if (kind === 'blossom') {
    ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 3, y - 16, 6, 16);
    disc(ctx, x, y - 30, 17, C('#e58fb8'), OL); disc(ctx, x - 5, y - 35, 6, C('#f6c4da'));
    return;
  }
  ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 3, y - 16, 6, 16); disc(ctx, x, y - 30, 17, C('#4fa83c'), OL); disc(ctx, x - 5, y - 35, 6, C('#7fd36a'));
}
function lantern(ctx, x, y, lit) { ctx.fillStyle = '#4a3a3a'; ctx.fillRect(x, y - 34, 3, 34); ctx.fillStyle = OL; ctx.fillRect(x - 4, y - 42, 11, 9); ctx.fillStyle = lit ? '#ffe58a' : '#c9b48f'; ctx.fillRect(x - 2, y - 40, 7, 5); if (lit) glow(ctx, '#ffd866', x - 14, y - 52, 31, 28, 0.22); }

export function drawIsland(ctx, C, isl, { lit = false, neon = false } = {}) {
  const { x, y, R, RR, identity: id } = isl, H = ISLAND.H, HW = ISLAND.HW, cy = roomCenterY(isl);
  // roche et plateforme
  const y0 = y + H, depth = Math.round(R * 0.46);
  fillPoly(ctx, [[x - R, y0], [x, y0 + R / 2], [x, y0 + R / 2 + depth]], C('#8a654c'));
  fillPoly(ctx, [[x, y0 + R / 2], [x + R, y0], [x, y0 + R / 2 + depth]], C('#6a4c3a'));
  const g = OPTIONS.ground[id.ground] || OPTIONS.ground.grass;
  prism(ctx, x, y, R, H, C(g.top), C(g.left), C(g.right));
  if (neon) { const pts = diamondPts(x, y, R); for (let k = 0; k < 4; k++) line(ctx, ...pts[k], ...pts[(k + 1) % 4], id.accent, 2); }
  // pièce
  fillPoly(ctx, diamondPts(x, cy, RR + 3), OL); fillPoly(ctx, diamondPts(x, cy, RR), C(id.floor));
  for (let t = -0.8; t <= 0.81; t += 0.2) line(ctx, ...roomPoint(isl, t, -1), ...roomPoint(isl, t, 1), C(shade(id.floor, -0.1)));
  const Lw = (t) => [x - RR + t * RR, cy - (t * RR) / 2], Rw = (t) => [x + t * RR, cy - RR / 2 + (t * RR) / 2];
  fillPoly(ctx, quadOn(Lw, 0, 1, -2, HW + 2), OL); fillPoly(ctx, quadOn(Rw, 0, 1, -2, HW + 2), OL);
  fillPoly(ctx, quadOn(Lw, 0, 1, 0, HW), C(shade(id.wall, -0.04))); fillPoly(ctx, quadOn(Rw, 0, 1, 0, HW), C(shade(id.wall, -0.2)));
  fillPoly(ctx, quadOn(Lw, 0, 1, HW - 8, HW), C(id.accent)); fillPoly(ctx, quadOn(Rw, 0, 1, HW - 8, HW), C(shade(id.accent, -0.25)));
  fillPoly(ctx, quadOn(Lw, 0, 1, 0, 8), C(shade(id.wall, -0.35))); fillPoly(ctx, quadOn(Rw, 0, 1, 0, 8), C(shade(id.wall, -0.45)));
  for (const [P, t] of [[Lw, 0.18], [Lw, 0.58], [Rw, 0.12]]) {
    fillPoly(ctx, quadOn(P, t - 0.01, t + 0.23, 28, 66), OL);
    fillPoly(ctx, quadOn(P, t, t + 0.22, 30, 64), lit ? '#ffd866' : C('#9fd6f0'));
    if (lit) { ctx.globalAlpha = 0.22; fillPoly(ctx, quadOn(P, t - 0.03, t + 0.25, 24, 70), '#ffd866'); ctx.globalAlpha = 1; }
  }
  fillPoly(ctx, quadOn(Rw, 0.61, 0.85, 6, 68), OL); fillPoly(ctx, quadOn(Rw, 0.62, 0.84, 8, 66), C('#7a5230'));
  const [kx, ky] = Rw(0.79); ctx.fillStyle = '#ffd866'; ctx.fillRect(Math.round(kx), Math.round(ky - 38), 3, 3);
  // mobilier (ordre de profondeur)
  const items = (FURNITURE[isl.name] || [[-0.75, 0.55, plant]]).map(([a, b, f]) => { const [px, py] = roomPoint(isl, a, b); return { y: py, draw: () => (f === 'rack' ? rack : f)(ctx, C, Math.round(px), Math.round(py)) }; });
  items.sort((p, q) => p.y - q.y).forEach((it) => it.draw());
  // extérieur : arbres, lanterne, parcelle « + », panneau
  for (const [a, b] of [[1.25, 1.25], [-1.25, 1.1], [1.3, -1.25]]) drawTree(ctx, C, id.tree || 'round', Math.round(x + ((a - b) * R) / 2.6), Math.round(y + ((a + b) * R) / 5.2 + 10));
  if (id.lanterns !== false) lantern(ctx, x - 80, y + 70, lit);
  const [px, py] = recruitSpot(isl);
  fillPoly(ctx, diamondPts(px, py, 26), id.accent); fillPoly(ctx, diamondPts(px, py, 22), C('#9a7a60'));
  ctx.fillStyle = id.accent; ctx.fillRect(px - 5, py - 1, 11, 3); ctx.fillRect(px - 1, py - 5, 3, 11);
  const [sx, sy] = signSpot(isl), label = isl.label || isl.name, hasEmblem = !!id.emblem, w = textWidth(label) + 16 + (hasEmblem ? 12 : 0);
  ctx.fillStyle = neon ? '#0b1030' : '#6a4a2a'; ctx.fillRect(sx - w / 2 - 3, sy - 3, w + 6, 19);
  ctx.fillStyle = neon ? '#0b1030' : '#b98a5a'; ctx.fillRect(sx - w / 2, sy, w, 13);
  drawPixelText(ctx, label, Math.round(sx - textWidth(label) / 2) + (hasEmblem ? 6 : 0), sy + 3, neon ? id.accent : '#fff6e0');
  if (hasEmblem) drawEmblem(ctx, id.emblem, Math.round(sx - w / 2 + 5), sy + 2, neon ? id.accent : '#fff6e0');
}

export function drawHub(ctx, C, hub, { lit = false, neon = false } = {}) {
  const { x, y, R } = hub;
  fillPoly(ctx, [[x - R, y + 16], [x, y + R / 2 + 16], [x, y + R / 2 + 120]], C('#8a654c'));
  fillPoly(ctx, [[x, y + R / 2 + 16], [x + R, y + 16], [x, y + R / 2 + 120]], C('#6a4c3a'));
  prism(ctx, x, y, R, 16, C('#7fd36a'), C('#7a5a44'), C('#5f4636'));
  fillPoly(ctx, diamondPts(x, y, 164), OL); fillPoly(ctx, diamondPts(x, y, 160), C('#efe2cf'));
  fillPoly(ctx, diamondPts(x, y, 72), C('#e2d4ff'));
  const crystal = neon ? '#7ff0ff' : '#c58bff';
  box(ctx, C, x, y + 10, 34, 22, '#5a5f7a');
  fillPoly(ctx, [[x, y - 152], [x + 38, y - 82], [x, y - 24], [x - 38, y - 82]], OL);
  fillPoly(ctx, [[x, y - 150], [x + 36, y - 82], [x, y - 26], [x - 36, y - 82]], crystal);
  fillPoly(ctx, [[x, y - 150], [x + 36, y - 82], [x, y - 26]], neon ? '#3f6bff' : '#8a5af0');
  fillPoly(ctx, [[x - 12, y - 100], [x, y - 126], [x + 6, y - 90]], '#ffffff');
  for (const bx of [x - 120, x + 120]) { box(ctx, C, bx, y + 20, 18, 6, '#a87a4a'); lantern(ctx, bx, y + 14, lit); }
}

export function drawDesk(ctx, C, x, y, screenOn) {
  box(ctx, C, x - 2, y + 22, 26, 18, '#c9a06a');
  ctx.fillStyle = OL; ctx.fillRect(x - 24, y - 8, 22, 15);
  ctx.fillStyle = screenOn ? '#5fd3e6' : '#3a3f55'; ctx.fillRect(x - 22, y - 6, 18, 11);
}

/** Grille 64×64 → canvas (navigateur uniquement). */
export function spriteCanvas(grid, doc = globalThis.document) {
  const c = doc.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d'), img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const col = grid[y][x]; if (!col) continue;
    const i = (y * 64 + x) * 4; img.data[i] = parseInt(col.slice(1, 3), 16); img.data[i + 1] = parseInt(col.slice(3, 5), 16); img.data[i + 2] = parseInt(col.slice(5, 7), 16); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
}
