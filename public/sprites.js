// public/sprites.js — personnages 64×64 originaux, générés par couches (pur, sans DOM).
import { shade } from './iso.js';

export const OPTIONS = Object.freeze({
  hairStyle: ['short', 'long', 'spiky', 'bun', 'ponytail', 'bob'],
  hairColor: ['#2b2230', '#6a3d22', '#d79a4a', '#efe0a8', '#c7cbd6', '#7a3a6a', '#3a5a9a'],
  skin: ['#f8d6b8', '#eebc94', '#cf9468', '#8f5a3a'],
  eyes: ['#3a7fd0', '#3a9a6a', '#8a5a2a', '#7a4ab0'],
  outfit: ['blazer', 'hoodie', 'sweater', 'jacket', 'labcoat', 'apron'],
  topColor: ['#f2c14e', '#4f8fd9', '#b46be0', '#ff6f5c', '#2fb39a', '#e8853d', '#3b9be0', '#8ac23a'],
  accessory: ['none', 'glasses', 'headset', 'cap', 'scarf']
});
export const APPEARANCE_FIELDS = Object.keys(OPTIONS);
export const isValidAppearance = (a) => !!a && APPEARANCE_FIELDS.every((k) => OPTIONS[k].includes(a[k]));
const pickFields = (a) => Object.fromEntries(APPEARANCE_FIELDS.map((k) => [k, a[k]]));

// Tenue par défaut selon le département : [tenue, couleur, accessoire imposé ou null]
const DEPT_STYLE = {
  Direction: ['blazer', '#f2c14e', null], Catalogue: ['hoodie', '#4f8fd9', null], 'Création': ['sweater', '#b46be0', null],
  Marketing: ['jacket', '#ff6f5c', null], 'Service client': ['sweater', '#2fb39a', 'headset'], 'Opérations': ['apron', '#e8853d', null],
  'Données': ['hoodie', '#3b9be0', null], Laboratoire: ['labcoat', '#8ac23a', null]
};
export const hashStr = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Apparence automatique stable, dérivée du nom et du rôle. */
export function autoAppearance(agent, deptName) {
  const h = hashStr(`${agent.name}|${agent.role}`);
  const p = (k, s) => OPTIONS[k][(h >>> s) % OPTIONS[k].length];
  const [outfit, topColor, accessory] = DEPT_STYLE[deptName] || [p('outfit', 15), p('topColor', 18), null];
  return { hairStyle: p('hairStyle', 0), hairColor: p('hairColor', 3), skin: p('skin', 6), eyes: p('eyes', 9), outfit, topColor, accessory: accessory || p('accessory', 12) };
}
/** Apparence enregistrée si valide, sinon automatique. */
export const appearanceFor = (agent, deptName, saved) => (isValidAppearance(saved) ? pickFields(saved) : autoAppearance(agent, deptName));

const EXPRESSIONS = { idle: 'calm', working: 'focused', waiting: 'questioning', blocked: 'worried' };
export const expressionFor = (status) => EXPRESSIONS[status] || 'calm';

const DK = '#2a2033';
/** Grille 64×64 (pieds en y = 61). dir : down | up | left | right ; frame 0 = immobile, 1 et 2 = pas. */
export function spriteGrid(look, { expr = 'calm', dir = 'down', frame = 0 } = {}) {
  if (dir === 'right') return spriteGrid(look, { expr, dir: 'left', frame }).map((row) => row.slice().reverse());
  const g = Array.from({ length: 64 }, () => Array(64).fill(null));
  const set = (x, y, c) => { if (x >= 0 && x < 64 && y >= 0 && y < 64) g[y][x] = c; };
  const R = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c); };
  const E = (cx, cy, rx, ry, c, cond) => {
    for (let j = Math.floor(cy - ry - 1); j <= cy + ry + 1; j++) for (let i = Math.floor(cx - rx - 1); i <= cx + rx + 1; i++) {
      const dx = (i + 0.5 - cx) / rx, dy = (j + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1 && (!cond || cond(i, j))) set(i, j, c);
    }
  };
  const side = dir === 'left', front = dir === 'down', back = dir === 'up';
  const typingPose = expr === 'focused' && front; // frappe au clavier : frame ne sert qu'au toggle
  const walk = typingPose ? 0 : frame % 3, b = walk ? -1 : 0;
  const sk = look.skin, skD = shade(sk, -0.15);
  const top = look.outfit === 'labcoat' ? '#f2f4f6' : look.topColor, topD = shade(top, -0.22);
  const acc = look.outfit === 'labcoat' ? look.topColor : shade(look.topColor, 0.35);
  const pan = '#2f3550', panD = shade(pan, -0.25), shoes = '#3a2a22';
  const hair = look.hairColor, hairD = shade(hair, -0.25), hairL = shade(hair, 0.3);
  const long = look.outfit === 'labcoat';
  // jambes (le pied levé raccourcit la jambe de 2 px)
  const upL = walk === 1 ? 2 : 0, upR = walk === 2 ? 2 : 0;
  if (side) { R(29, 46 - upL, 5, 13, pan); R(34, 46 - upR, 4, 13, panD); R(27, 58 - upL, 8, 4, shoes); R(33, 58 - upR, 6, 4, shade(shoes, -0.2)); }
  else { R(25, 46, 6, 13 - upL, pan); R(33, 46, 6, 13 - upR, pan); R(29, 46, 2, 13 - upL, panD); R(37, 46, 2, 13 - upR, panD); R(24, 58 - upL, 8, 4, shoes); R(32, 58 - upR, 8, 4, shoes); }
  // buste, bras, mains
  if (side) {
    R(25, 30 + b, 14, long ? 24 : 17, top); R(35, 31 + b, 4, long ? 23 : 16, topD);
    const swing = walk === 1 ? -2 : walk === 2 ? 2 : 0;
    R(29 + swing, 31 + b, 5, 14, topD); R(29 + swing, 45 + b, 5, 3, sk);
  } else {
    R(22, 30 + b, 20, long ? 24 : 17, top); R(38, 31 + b, 4, long ? 23 : 16, topD); set(22, 30 + b, null); set(41, 30 + b, null);
    const swing = walk === 1 ? -1 : walk === 2 ? 1 : 0;
    const typing = typingPose ? (frame % 2 ? -2 : 0) : 0; // frappe au clavier (statut working)
    const rightTyp = typingPose ? (typing ? 0 : -2) : 0; // mains alternées
    R(18, 31 + b + swing, 4, 14, top); R(42, 31 + b - swing, 4, 14, topD);
    R(18, 45 + b + swing + typing, 4, 3, sk); R(42, 45 + b - swing + rightTyp, 4, 3, skD);
  }
  if (front) {
    const o = look.outfit;
    if (o === 'blazer') { R(29, 30 + b, 6, 17, '#f4f4f0'); for (let k = 0; k < 7; k++) { set(28 + Math.floor(k / 2), 30 + b + k, topD); set(35 - Math.floor(k / 2), 30 + b + k, topD); } R(31, 31 + b, 2, 9, acc); }
    if (o === 'hoodie') { R(25, 29 + b, 14, 3, topD); R(26, 40 + b, 12, 4, topD); R(29, 32 + b, 1, 2, '#ffffff'); R(34, 32 + b, 1, 2, '#ffffff'); }
    if (o === 'sweater') { R(22, 36 + b, 20, 2, acc); R(22, 41 + b, 20, 2, acc); R(27, 30 + b, 10, 2, topD); }
    if (o === 'jacket') { R(31, 30 + b, 2, 17, DK); R(26, 29 + b, 12, 2, topD); R(23, 39 + b, 4, 1, topD); R(37, 39 + b, 4, 1, topD); R(29, 30 + b, 2, 3, acc); }
    if (o === 'labcoat') { R(29, 30 + b, 6, 8, acc); R(24, 44 + b, 5, 1, shade(top, -0.3)); R(35, 44 + b, 5, 1, shade(top, -0.3)); R(31, 38 + b, 1, 16, shade(top, -0.2)); }
    if (o === 'apron') { R(25, 35 + b, 14, 15, acc); R(26, 30 + b, 2, 5, acc); R(36, 30 + b, 2, 5, acc); R(29, 40 + b, 6, 4, shade(acc, -0.25)); }
  }
  if (back) R(25, 29 + b, 14, 2, topD);
  // cou, tête
  R(29, 27 + b, 6, 4, skD);
  if (side) { E(31, 17 + b, 10, 11, sk); R(20, 18 + b, 2, 2, sk); }
  else { E(32, 17 + b, 11, 11, sk); R(20, 16 + b, 2, 5, sk); R(44, 16 + b, 2, 5, skD); }
  // visage (statut réel → expression)
  if (front) {
    const eyes = () => { for (const x0 of [26, 35]) { R(x0, 17 + b, 3, 1, DK); R(x0, 18 + b, 3, 2, look.eyes); set(x0, 18 + b, '#ffffff'); } };
    if (expr === 'focused') { R(26, 18 + b, 3, 1, DK); R(35, 18 + b, 3, 1, DK); R(26, 19 + b, 3, 1, look.eyes); R(35, 19 + b, 3, 1, look.eyes); R(25, 15 + b, 4, 1, hairD); R(35, 15 + b, 4, 1, hairD); R(30, 24 + b, 4, 1, DK); }
    else if (expr === 'questioning') { eyes(); R(25, 14 + b, 4, 1, hairD); R(35, 15 + b, 4, 1, hairD); R(31, 24 + b, 2, 2, DK); }
    else if (expr === 'worried') { eyes(); for (const [x, y] of [[25, 15], [26, 15], [27, 14], [28, 14], [38, 15], [37, 15], [36, 14], [35, 14]]) set(x, y + b, hairD); for (const [x, y] of [[30, 25], [31, 24], [32, 24], [33, 25]]) set(x, y + b, DK); R(44, 12 + b, 1, 2, '#7fd0ff'); }
    else { eyes(); for (const [x, y] of [[30, 24], [31, 25], [32, 25], [33, 24]]) set(x, y + b, DK); }
    R(25, 22 + b, 2, 1, '#f3a0a0'); R(37, 22 + b, 2, 1, '#f3a0a0');
  }
  if (side) {
    R(24, 17 + b, 3, 1, DK); R(24, 18 + b, 3, 2, look.eyes); set(24, 18 + b, '#ffffff');
    if (expr === 'worried') R(23, 25 + b, 3, 1, DK); else if (expr === 'questioning') R(23, 24 + b, 2, 2, DK); else R(23, 24 + b, 3, 1, DK);
    R(25, 22 + b, 2, 1, '#f3a0a0');
  }
  // cheveux
  if (back) { E(32, 15 + b, 12, 12, hair); R(24, 6 + b, 10, 1, hairL); }
  else if (side) { E(32, 12 + b, 11, 9, hair, (i, j) => j <= 14 + b || i >= 33); R(22, 12 + b, 6, 3, hair); R(25, 6 + b, 8, 1, hairL); }
  else { E(32, 12 + b, 12, 9, hair, (i, j) => j <= 14 + b); for (let i = 21; i <= 42; i += 3) R(i, 14 + b, 2, 2, hair); R(24, 6 + b, 10, 1, hairL); R(23, 7 + b, 4, 1, hairL); }
  const hs = look.hairStyle;
  if (hs === 'long') { if (!side) R(19, 11 + b, 4, 22, hair); R(41, 11 + b, 4, 22, hairD); }
  if (hs === 'spiky') for (const [x, y] of [[23, 3], [28, 1], [33, 0], [38, 2], [42, 5]]) { R(x, y + b, 3, 3, hair); set(x + 1, y - 1 + b, hair); }
  if (hs === 'bun') E(32, 2 + b, 5, 3.5, hair);
  if (hs === 'ponytail') { E(back ? 32 : 46, back ? 28 + b : 14 + b, 3, 8, hairD); }
  if (hs === 'bob') { if (!side) R(20, 11 + b, 4, 13, hair); R(40, 11 + b, 4, 13, hairD); }
  // accessoires
  const a = look.accessory;
  if (a === 'glasses' && front) { for (const x0 of [25, 34]) { R(x0, 16 + b, 5, 1, DK); R(x0, 21 + b, 5, 1, DK); R(x0, 16 + b, 1, 6, DK); R(x0 + 4, 16 + b, 1, 6, DK); } R(30, 18 + b, 4, 1, DK); }
  if (a === 'glasses' && side) { R(23, 16 + b, 5, 1, DK); R(23, 21 + b, 5, 1, DK); R(28, 18 + b, 5, 1, DK); }
  if (a === 'headset') { R(21, 3 + b, 22, 2, '#3a3f55'); if (!side) R(19, 14 + b, 3, 8, '#3a3f55'); R(42, 14 + b, 3, 8, '#3a3f55'); if (front) R(40, 23 + b, 5, 1, '#3a3f55'); }
  if (a === 'cap') { E(32, 8 + b, 12, 6, look.topColor, (i, j) => j <= 10 + b); if (front) R(32, 10 + b, 15, 2, shade(look.topColor, -0.25)); if (side) R(16, 10 + b, 10, 2, shade(look.topColor, -0.25)); }
  if (a === 'scarf') { R(side ? 25 : 24, 28 + b, side ? 14 : 16, 4, acc); if (front) R(34, 32 + b, 4, 7, shade(acc, -0.2)); }
  // contour automatique
  const out = g.map((row) => row.slice());
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (!g[y][x] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx])) out[y][x] = DK;
  return out;
}
