# Carte isométrique « cycle du jour » — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer la carte actuelle par un archipel isométrique à l'échelle 1:1 (bâtiments meublés par métier, personnages 64×64 personnalisables, faisceaux limités aux vrais échanges, interface qui suit l'heure).

**Architecture:** Modules purs testables en Node (`iso.js`, `sprites.js`, `pixelfont.js`, `beams.js`, `viewport.js`, `world.js` pour la partie calcul) et une couche navigateur (`world.js` dessin + `app.js`) qui dessine sur un canvas plein écran avec des calques en cache par île. Le backend gagne une table `agent_appearance` et trois routes ; le reste est inchangé.

**Tech Stack:** Node ≥ 24, `node:sqlite`, `node:test`, HTML/CSS/JS natifs, Canvas 2D. Aucune dépendance.

**Spec:** `docs/superpowers/specs/2026-11-10-carte-iso-cycle-du-jour-design.md`

## Global Constraints

- Aucune dépendance npm, aucune ressource externe (police, image, CDN).
- Rien n'est affiché qui ne vienne pas de SQLite ; animations et expressions dépendent uniquement du statut enregistré.
- Contenu venant de la base inséré en nœuds texte (jamais `innerHTML`).
- `POST /api/activity` n'accepte que la source `manual` (inchangé).
- Phases : Matin 05:00–09:59, Midi 10:00–16:59, Soir 17:00–20:59, Nuit 21:00–04:59 (`public/sky.js`, inchangé).
- Personnages 64×64 ; 1 pixel du dessin = 1 pixel d'écran à 100 % ; zooms 50 %, 100 %, 200 %.
- Le dossier n'est pas un dépôt Git : chaque étape « Checkpoint » = `npm test` vert. Si l'utilisateur fait `git init`, remplacer par un commit.
- Tests : `npm test` (`node --test`), fichiers dans `test/`.

## Fichiers

| Fichier | Action | Rôle |
| --- | --- | --- |
| `public/iso.js` | créer | primitives pixel : polygone, prisme, bloc, disque, ligne, couleurs, teinte de phase |
| `public/sprites.js` | créer | options d'apparence, apparence auto, grille 64×64 par direction / frame / expression |
| `public/pixelfont.js` | créer | police pixel 5×7 avec accents |
| `public/beams.js` | créer | échanges réels → faisceaux et liaisons 24 h |
| `public/viewport.js` | créer | zoom, déplacement, conversions écran ↔ monde |
| `public/world.js` | créer | disposition, bureaux, placement des agents, dessin des îles / place / bureaux |
| `public/app.js` | réécrire | boucle de rendu, calques, interface, fenêtres, éditeur d'apparence |
| `public/index.html`, `public/style.css` | réécrire | structure et thème par phase |
| `public/scene.js`, `test/scene.test.js` | supprimer | remplacés |
| `src/studio.js`, `src/app.js` | modifier | table et routes d'apparence |
| `test/iso.test.js`, `test/sprites.test.js`, `test/pixelfont.test.js`, `test/beams.test.js`, `test/viewport.test.js`, `test/world.test.js`, `test/appearance.test.js` | créer | tests |
| `README.md`, `public/assets/characters/README.md` | modifier | documentation |

---

### Task 1: Primitives pixel (`public/iso.js`)

**Files:**
- Create: `public/iso.js`
- Test: `test/iso.test.js`

**Interfaces:**
- Produces: `OL`, `shade(c, f)`, `mix(a, b, f)`, `tinter(phase, k = 1)`, `fillPoly(ctx, pts, color)`, `diamondPts(x, y, r)`, `prism(ctx, x, y, r, h, cT, cL, cR, ol = OL)`, `box(ctx, C, x, gy, r, h, wall, top)`, `disc(ctx, cx, cy, r, color, ol)`, `line(ctx, x1, y1, x2, y2, color, w = 1)`.

- [ ] **Step 1: Write the failing test**

```js
// test/iso.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/iso.test.js`
Expected: FAIL (`Cannot find module '../public/iso.js'`).

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/iso.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 2: Personnages 64×64 (`public/sprites.js`)

**Files:**
- Create: `public/sprites.js`
- Test: `test/sprites.test.js`

**Interfaces:**
- Consumes: `shade` (Task 1).
- Produces: `OPTIONS`, `APPEARANCE_FIELDS`, `isValidAppearance(a)`, `hashStr(s)`, `autoAppearance(agent, deptName)`, `appearanceFor(agent, deptName, saved)`, `expressionFor(status)`, `spriteGrid(look, { expr, dir, frame })` → tableau 64×64 de couleurs `'#rrggbb'` ou `null`.
- Une apparence (`look`) : `{ hairStyle, hairColor, skin, eyes, outfit, topColor, accessory }`.

- [ ] **Step 1: Write the failing test**

```js
// test/sprites.test.js
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

test('every option list is non-empty', () => { for (const k of Object.keys(OPTIONS)) assert.ok(OPTIONS[k].length > 0); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sprites.test.js`
Expected: FAIL (module introuvable).

- [ ] **Step 3: Write minimal implementation**

```js
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
  const walk = frame % 3, b = walk ? -1 : 0;
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
    const typing = front && expr === 'focused' ? (frame % 2 ? -2 : 0) : 0; // frappe au clavier (statut working)
    R(18, 31 + b + swing, 4, 14, top); R(42, 31 + b - swing, 4, 14, topD);
    R(18, 45 + b + swing + typing, 4, 3, sk); R(42, 45 + b - swing - (typing ? 0 : 0), 4, 3, skD);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sprites.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 3: Apparence en base et routes (`src/studio.js`, `src/app.js`)

**Files:**
- Modify: `src/studio.js` (schéma `db.exec`, objet retourné)
- Modify: `src/app.js:23-45` (routes paramétrées, corps pour PUT)
- Test: `test/appearance.test.js`

**Interfaces:**
- Consumes: `isValidAppearance`, `APPEARANCE_FIELDS` (Task 2).
- Produces: `studio.listAppearances()` → `[{ agentId, hairStyle, hairColor, skin, eyes, outfit, topColor, accessory, updatedAt }]` ; `studio.setAppearance(agentId, look)` ; `studio.clearAppearance(agentId)` ; routes `GET /api/appearances`, `PUT /api/agents/:id/appearance`, `DELETE /api/agents/:id/appearance`.

- [ ] **Step 1: Write the failing test**

```js
// test/appearance.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { autoAppearance } from '../public/sprites.js';

async function withApp(fn) {
  const studio = createStudio(':memory:');
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  try { await fn({ studio, call }); } finally { server.close(); studio.close(); }
}

test('appearance can be saved, listed, journaled and reset', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const agent = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId: dept.id });
  const look = { ...autoAppearance(agent, dept.name), hairStyle: 'bun' };
  const saved = await call('PUT', `/api/agents/${agent.id}/appearance`, look);
  assert.equal(saved.status, 200); assert.equal(saved.data.hairStyle, 'bun');
  assert.equal((await call('GET', '/api/appearances')).data[0].agentId, agent.id);
  assert.equal(studio.listEvents(agent.id)[0].kind, 'agent.appearance.updated');
  assert.equal((await call('DELETE', `/api/agents/${agent.id}/appearance`)).status, 200);
  assert.deepEqual((await call('GET', '/api/appearances')).data, []);
}));

test('invalid values are refused (400) and unknown agents are 404', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const agent = studio.hireAgent({ name: 'Ada', role: 'Pilotage', departmentId: dept.id });
  const bad = { ...autoAppearance(agent, dept.name), topColor: '#000000' };
  assert.equal((await call('PUT', `/api/agents/${agent.id}/appearance`, bad)).status, 400);
  assert.equal((await call('PUT', '/api/agents/inconnu/appearance', autoAppearance(agent, dept.name))).status, 404);
  assert.equal((await call('DELETE', '/api/agents/inconnu/appearance')).status, 404);
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/appearance.test.js`
Expected: FAIL (404 sur `PUT`, puisque la route n'existe pas).

- [ ] **Step 3: Implement**

Dans `src/studio.js`, en tête :

```js
import { isValidAppearance } from '../public/sprites.js';
```

Ajouter au `db.exec` (après `approvals`) :

```sql
    CREATE TABLE IF NOT EXISTS agent_appearance (agent_id TEXT PRIMARY KEY REFERENCES agents(id), hair_style TEXT NOT NULL, hair_color TEXT NOT NULL, skin TEXT NOT NULL, eyes TEXT NOT NULL, outfit TEXT NOT NULL, top_color TEXT NOT NULL, accessory TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Ajouter avant `return {` :

```js
  const mapAppearance = (r) => ({ agentId: r.agent_id, hairStyle: r.hair_style, hairColor: r.hair_color, skin: r.skin, eyes: r.eyes, outfit: r.outfit, topColor: r.top_color, accessory: r.accessory, updatedAt: r.updated_at });
  const requireAgent = (id) => { if (!one('SELECT id FROM agents WHERE id = ?', id)) throw Object.assign(new Error('Agent introuvable.'), { status: 404 }); };
```

Ajouter dans l'objet retourné (avant `close`) :

```js
    listAppearances: () => db.prepare('SELECT * FROM agent_appearance').all().map(mapAppearance),
    setAppearance(agentId, look) {
      requireAgent(agentId);
      if (!isValidAppearance(look)) throw Object.assign(new Error('Apparence invalide.'), { status: 400 });
      db.prepare(`INSERT INTO agent_appearance (agent_id, hair_style, hair_color, skin, eyes, outfit, top_color, accessory, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET hair_style = excluded.hair_style, hair_color = excluded.hair_color, skin = excluded.skin, eyes = excluded.eyes, outfit = excluded.outfit, top_color = excluded.top_color, accessory = excluded.accessory, updated_at = excluded.updated_at`)
        .run(agentId, look.hairStyle, look.hairColor, look.skin, look.eyes, look.outfit, look.topColor, look.accessory, now());
      emit(agentId, 'agent.appearance.updated', 'Apparence modifiée.', 'manual', true);
      return one('SELECT * FROM agent_appearance WHERE agent_id = ?', agentId, mapAppearance);
    },
    clearAppearance(agentId) {
      requireAgent(agentId);
      db.prepare('DELETE FROM agent_appearance WHERE agent_id = ?').run(agentId);
      emit(agentId, 'agent.appearance.reset', 'Apparence automatique rétablie.', 'manual', true);
      return { agentId, reset: true };
    },
```

Dans `src/app.js`, ajouter la route de lecture dans `routes` :

```js
    'GET /api/appearances': () => studio.listAppearances(),
```

Ajouter après l'objet `routes` :

```js
  const paramRoutes = [
    ['PUT', /^\/api\/agents\/([^/]+)\/appearance$/, (m, data) => studio.setAppearance(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/agents\/([^/]+)\/appearance$/, (m) => studio.clearAppearance(decodeURIComponent(m[1]))]
  ];
```

Remplacer la ligne 45 par :

```js
      const hasBody = req.method === 'POST' || req.method === 'PUT';
      if (routes[key]) return send(res, 200, await routes[key](hasBody ? await body(req) : undefined, url.searchParams));
      for (const [method, re, fn] of paramRoutes) { const m = req.method === method && url.pathname.match(re); if (m) return send(res, 200, await fn(m, hasBody ? await body(req) : undefined)); }
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (nouveaux tests + existants).

- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 4: Police pixel (`public/pixelfont.js`)

**Files:**
- Create: `public/pixelfont.js`
- Test: `test/pixelfont.test.js`

**Interfaces:**
- Produces: `GLYPHS` (car → 7 lignes de 5 caractères `#`/`.`), `supports(text)`, `textWidth(text, scale = 1)`, `drawPixelText(ctx, text, x, y, color, scale = 1)` (x, y = coin haut gauche ; accents dessinés 2 px au-dessus, cédille 2 px en dessous).

- [ ] **Step 1: Write the failing test**

```js
// test/pixelfont.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pixelfont.test.js`
Expected: FAIL (module introuvable).

- [ ] **Step 3: Write minimal implementation**

```js
// public/pixelfont.js — police pixel 5×7 originale (majuscules, chiffres, accents français).
const G = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'], J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'], X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], 1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], 3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], 5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'], 7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], 9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'], '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'], "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....']
};
const MARKS = { acute: ['...#.', '..#..'], grave: ['.#...', '..#..'], circ: ['..#..', '.#.#.'], diaer: ['.#.#.', '.....'], cedil: ['..#..', '.##..'] };
const ACCENTED = { 'É': ['E', 'acute'], 'È': ['E', 'grave'], 'Ê': ['E', 'circ'], 'À': ['A', 'grave'], 'Ô': ['O', 'circ'], 'Û': ['U', 'circ'], 'Ï': ['I', 'diaer'], 'Ç': ['C', 'cedil'] };
export const GLYPHS = G;
const up = (t) => t.toLocaleUpperCase('fr');
export const supports = (text) => [...up(text)].every((c) => G[c] || ACCENTED[c]);
export const textWidth = (text, scale = 1) => Math.max(0, [...text].length * 6 - 1) * scale;
const paint = (ctx, rows, x, y, s) => rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') ctx.fillRect(x + i * s, y + j * s, s, s); }));
export function drawPixelText(ctx, text, x, y, color, scale = 1) {
  ctx.fillStyle = color;
  [...up(text)].forEach((c, k) => {
    const cx = x + k * 6 * scale, acc = ACCENTED[c], base = acc ? acc[0] : c;
    if (!G[base]) return;
    paint(ctx, G[base], cx, y, scale);
    if (acc) paint(ctx, MARKS[acc[1]], cx, acc[1] === 'cedil' ? y + 7 * scale : y - 2 * scale, scale);
  });
}
```

- [ ] **Step 4: Run test** — `node --test test/pixelfont.test.js` → PASS (3 tests).
- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 5: Faisceaux à partir des vrais échanges (`public/beams.js`)

**Files:**
- Create: `public/beams.js`
- Test: `test/beams.test.js`

**Interfaces:**
- Produces: `LINK_WINDOW_MS`, `exchanges({ messages, missions, agents })` → `[{ id, kind, from, to, at }]` (`from`/`to` = id de département ou `'hub'`), `computeBeams({ messages, missions, agents, seen, now })` → `{ fresh: [{ id, kind, from, to, spark }], links: [{ from, to }], ids: string[] }`. `seen = null` signifie « premier chargement » : aucun faisceau rejoué.

- [ ] **Step 1: Write the failing test**

```js
// test/beams.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBeams, LINK_WINDOW_MS } from '../public/beams.js';

const agents = [{ id: 'a', department_id: 'mk' }, { id: 'b', department_id: 'data' }, { id: 'c', department_id: 'mk' }];
const now = Date.parse('2026-11-10T12:00:00Z');
const iso = (msAgo) => new Date(now - msAgo).toISOString();

test('only real messages and missions produce beams, from the right islands', () => {
  const r = computeBeams({ agents, now, seen: new Set(), messages: [{ id: 'm1', from_agent_id: 'a', to_agent_id: 'b', created_at: iso(1000) }], missions: [{ id: 'x1', requested_by: null, assigned_to: 'b', created_at: iso(1000) }] });
  assert.deepEqual(r.fresh.map((f) => [f.kind, f.from, f.to]), [['message', 'mk', 'data'], ['mission', 'hub', 'data']]);
  assert.deepEqual(computeBeams({ agents, now, seen: new Set(), messages: [], missions: [] }).fresh, []);
});

test('first load replays nothing and already-seen exchanges are not replayed', () => {
  const messages = [{ id: 'm1', from_agent_id: 'a', to_agent_id: 'b', created_at: iso(1000) }];
  const first = computeBeams({ agents, now, seen: null, messages, missions: [] });
  assert.deepEqual(first.fresh, []);
  assert.deepEqual(computeBeams({ agents, now, seen: new Set(first.ids), messages, missions: [] }).fresh, []);
});

test('same-island exchange is a spark; links keep only the last 24 h', () => {
  const r = computeBeams({ agents, now, seen: new Set(), missions: [], messages: [
    { id: 'm1', from_agent_id: 'a', to_agent_id: 'c', created_at: iso(1000) },
    { id: 'm2', from_agent_id: 'a', to_agent_id: 'b', created_at: iso(LINK_WINDOW_MS + 1000) }] });
  assert.equal(r.fresh.find((f) => f.id === 'msg:m1').spark, true);
  assert.deepEqual(r.links, []);
});
```

- [ ] **Step 2: Run test** — `node --test test/beams.test.js` → FAIL (module introuvable).

- [ ] **Step 3: Write minimal implementation**

```js
// public/beams.js — faisceaux calculés uniquement à partir des messages et missions réels (pur).
export const LINK_WINDOW_MS = 24 * 3600 * 1000;
export function exchanges({ messages = [], missions = [], agents = [] }) {
  const dept = new Map(agents.map((a) => [a.id, a.department_id]));
  const out = [];
  for (const m of messages) {
    const from = dept.get(m.from_agent_id ?? m.fromAgentId), to = dept.get(m.to_agent_id ?? m.toAgentId);
    if (from && to) out.push({ id: `msg:${m.id}`, kind: 'message', from, to, at: Date.parse(m.created_at) });
  }
  for (const m of missions) {
    const to = m.assigned_to && dept.get(m.assigned_to); if (!to) continue;
    const from = (m.requested_by && dept.get(m.requested_by)) || 'hub';
    out.push({ id: `mission:${m.id}`, kind: 'mission', from, to, at: Date.parse(m.created_at) });
  }
  return out;
}
export function computeBeams({ messages, missions, agents, seen, now = Date.now() }) {
  const all = exchanges({ messages, missions, agents });
  const fresh = seen ? all.filter((e) => !seen.has(e.id)).map(({ id, kind, from, to }) => ({ id, kind, from, to, spark: from === to })) : [];
  const recent = all.filter((e) => e.from !== e.to && now - e.at <= LINK_WINDOW_MS);
  const links = [...new Map(recent.map((e) => [[e.from, e.to].sort().join('>'), { from: e.from, to: e.to }])).values()];
  return { fresh, links, ids: all.map((e) => e.id) };
}
```

- [ ] **Step 4: Run test** — PASS (3 tests).
- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 6: Zoom et déplacement (`public/viewport.js`)

**Files:**
- Create: `public/viewport.js`
- Test: `test/viewport.test.js`

**Interfaces:**
- Produces: `ZOOMS = [0.5, 1, 2]`, `createViewport(worldW, worldH, viewW, viewH)` → `{ worldW, worldH, viewW, viewH, zoom, x, y }` (x, y = coin haut gauche en coordonnées monde), `toScreen(vp, wx, wy)`, `toWorld(vp, sx, sy)`, `clampView(vp)`, `centerOn(vp, wx, wy)`, `zoomAt(vp, zoom, sx, sy)`, `panBy(vp, dsx, dsy)`, `nextZoom(zoom, dir)`, `visibleRect(vp)`.

- [ ] **Step 1: Write the failing test**

```js
// test/viewport.test.js
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
```

- [ ] **Step 2: Run test** — FAIL (module introuvable).

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test** — PASS (3 tests).
- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 7: Disposition du monde et placement (`public/world.js`, partie pure)

**Files:**
- Create: `public/world.js`
- Test: `test/world.test.js`

**Interfaces:**
- Produces: `GRID`, `ISLAND`, `IDENTITY`, `identityFor(name, index)`, `computeWorld(departments, agents = [])` → `{ width, height, hub: { x, y, R }, islands: [{ id, name, index, i, j, x, y, R, RR, identity }] }`, `roomPoint(island, a, b)` → `[x, y]` (a, b ∈ [-1, 1] dans la pièce), `deskSpots(island, n)` → `[[x, y], …]`, `placeAgents(world, agents)` → `[{ agent, island, x, y }]` trié par y, `recruitSpot(island)`, `signSpot(island)`, `pillSpot(island)`, `doorSpot(island)`, `islandBounds(island)` → `{ x, y, w, h }`.

- [ ] **Step 1: Write the failing test**

```js
// test/world.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';
import { computeWorld, placeAgents, deskSpots, ISLAND, GRID } from '../public/world.js';

const seeded = () => { const s = createStudio(':memory:'); return { s, d: s.listDepartments() }; };

test('eight departments sit on the 3×3 ring around the hub, in order', () => {
  const { s, d } = seeded(); const w = computeWorld(d);
  assert.deepEqual(w.islands.map((i) => [i.name, i.i, i.j]), [['Direction', -1, -1], ['Catalogue', 0, -1], ['Création', 1, -1], ['Marketing', 1, 0], ['Service client', 1, 1], ['Opérations', 0, 1], ['Données', -1, 1], ['Laboratoire', -1, 0]]);
  const dir = w.islands[0];
  assert.deepEqual([dir.x - w.hub.x, dir.y - w.hub.y], [0, -2 * GRID.DY]);
  assert.equal(new Set(w.islands.map((i) => i.identity.accent)).size, 8);
  s.close();
});

test('a ninth department goes to the outer ring', () => {
  const { s, d } = seeded(); s.createDepartment({ name: 'Juridique' });
  const w = computeWorld(s.listDepartments());
  assert.equal(Math.max(Math.abs(w.islands[8].i), Math.abs(w.islands[8].j)), 2);
  s.close();
});

test('one desk per real agent, on the right island; no desk without agent', () => {
  const { s, d } = seeded();
  const mk = d.find((x) => x.name === 'Marketing');
  s.hireAgent({ name: 'Lin', role: 'Campagnes', departmentId: mk.id });
  const w = computeWorld(d, s.listAgents());
  const placed = placeAgents(w, s.listAgents());
  assert.equal(placed.length, 1); assert.equal(placed[0].island.name, 'Marketing');
  assert.deepEqual(placeAgents(w, []), []);
  s.close();
});

test('rooms grow beyond nine agents', () => {
  const { s, d } = seeded(); const lab = d.find((x) => x.name === 'Laboratoire');
  const agents = Array.from({ length: 10 }, (_, k) => ({ id: `a${k}`, name: `A${k}`, role: 'x', department_id: lab.id, created_at: String(k) }));
  const w = computeWorld(d, agents); const isl = w.islands.find((i) => i.name === 'Laboratoire');
  assert.equal(isl.RR, ISLAND.RR + ISLAND.GROW);
  assert.equal(new Set(deskSpots(isl, 10).map((p) => p.join(','))).size, 10);
  s.close();
});
```

- [ ] **Step 2: Run test** — FAIL (module introuvable).

- [ ] **Step 3: Write the pure part of `public/world.js`**

```js
// public/world.js — archipel isométrique : disposition et placement (pur), puis dessin (Task 8).
import { OL, shade, fillPoly, diamondPts, prism, box, disc, line } from './iso.js';
import { drawPixelText, textWidth } from './pixelfont.js';

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
const RING1 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const RING2 = (() => { const out = []; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if (Math.max(Math.abs(i), Math.abs(j)) === 2) out.push([i, j]); return out.sort((a, b) => Math.atan2(a[1] + a[0], a[0] - a[1]) - Math.atan2(b[1] + b[0], b[0] - b[1])); })();

export function computeWorld(departments, agents = []) {
  const counts = new Map(); for (const a of agents) counts.set(a.department_id, (counts.get(a.department_id) || 0) + 1);
  const slots = [...RING1, ...RING2];
  const raw = departments.map((d, k) => {
    const [i, j] = slots[k % slots.length];
    const grow = Math.ceil(Math.max(0, (counts.get(d.id) || 0) - ISLAND.DESKS) / 3) * ISLAND.GROW;
    return { id: d.id, name: d.name, index: k, i, j, gx: (i - j) * GRID.DX, gy: (i + j) * GRID.DY, R: ISLAND.R + grow, RR: ISLAND.RR + grow, identity: identityFor(d.name, k) };
  });
  const xs = [0, ...raw.map((r) => r.gx)], ys = [0, ...raw.map((r) => r.gy)];
  const minX = Math.min(...xs) - 520, minY = Math.min(...ys) - 360, maxX = Math.max(...xs) + 520, maxY = Math.max(...ys) + 420;
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
```

- [ ] **Step 4: Run test** — `node --test test/world.test.js` → PASS (4 tests).
- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 8: Dessin des îles, de la place et des bureaux (`public/world.js`, partie dessin)

**Files:**
- Modify: `public/world.js` (ajouter à la fin)
- Test: `test/world.test.js` (ajouter un test de dessin sur faux contexte)

**Interfaces:**
- Consumes: Tasks 1, 4, 7.
- Produces: `drawIsland(ctx, C, isl, { lit, neon })` (dessine en coordonnées monde : roche, plateforme, pièce, mobilier, arbres, lanterne, parcelle, panneau), `drawHub(ctx, C, hub, { lit, neon })`, `drawDesk(ctx, C, x, y, screenOn)` (bureau devant un agent placé en (x, y)), `spriteCanvas(grid, doc)` (DOM : grille → canvas 64×64).

- [ ] **Step 1: Write the failing test** (ajouter à `test/world.test.js`)

```js
import { drawIsland, drawHub, drawDesk } from '../public/world.js';
import { tinter } from '../public/iso.js';

test('every department island and the hub draw without error inside their bounds', async () => {
  const { s, d } = seeded(); const w = computeWorld(d);
  const { islandBounds } = await import('../public/world.js');
  for (const isl of w.islands) {
    const b = islandBounds(isl), rects = [];
    const ctx = { set fillStyle(v) {}, set globalAlpha(v) {}, fillRect: (x, y, ww, hh) => rects.push([x, y, ww, hh]) };
    drawIsland(ctx, tinter('night'), isl, { lit: true, neon: true });
    assert.ok(rects.length > 100, isl.name);
    assert.ok(rects.every(([x, y]) => x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2), isl.name);
  }
  const ctx = { set fillStyle(v) {}, set globalAlpha(v) {}, fillRect() {} };
  drawHub(ctx, tinter('noon'), w.hub, { lit: false, neon: false }); drawDesk(ctx, tinter('noon'), 100, 100, true);
  s.close();
});
```

- [ ] **Step 2: Run test** — FAIL (`drawIsland` non exporté).

- [ ] **Step 3: Implement** (ajouter à la fin de `public/world.js`)

```js
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

function tree(ctx, C, x, y) { ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 3, y - 16, 6, 16); disc(ctx, x, y - 30, 17, C('#4fa83c'), OL); disc(ctx, x - 5, y - 35, 6, C('#7fd36a')); }
function lantern(ctx, x, y, lit) { ctx.fillStyle = '#4a3a3a'; ctx.fillRect(x, y - 34, 3, 34); ctx.fillStyle = OL; ctx.fillRect(x - 4, y - 42, 11, 9); ctx.fillStyle = lit ? '#ffe58a' : '#c9b48f'; ctx.fillRect(x - 2, y - 40, 7, 5); if (lit) glow(ctx, '#ffd866', x - 14, y - 52, 31, 28, 0.22); }

export function drawIsland(ctx, C, isl, { lit = false, neon = false } = {}) {
  const { x, y, R, RR, identity: id } = isl, H = ISLAND.H, HW = ISLAND.HW, cy = roomCenterY(isl);
  // roche et plateforme
  const y0 = y + H, depth = Math.round(R * 0.46);
  fillPoly(ctx, [[x - R, y0], [x, y0 + R / 2], [x, y0 + R / 2 + depth]], C('#8a654c'));
  fillPoly(ctx, [[x, y0 + R / 2], [x + R, y0], [x, y0 + R / 2 + depth]], C('#6a4c3a'));
  prism(ctx, x, y, R, H, C('#7fd36a'), C('#7a5a44'), C('#5f4636'));
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
  for (const [a, b] of [[1.25, 1.25], [-1.25, 1.1], [1.3, -1.25]]) tree(ctx, C, Math.round(x + ((a - b) * R) / 2.6), Math.round(y + ((a + b) * R) / 5.2 + 10));
  lantern(ctx, x - 80, y + 70, lit);
  const [px, py] = recruitSpot(isl);
  fillPoly(ctx, diamondPts(px, py, 26), id.accent); fillPoly(ctx, diamondPts(px, py, 22), C('#9a7a60'));
  ctx.fillStyle = id.accent; ctx.fillRect(px - 5, py - 1, 11, 3); ctx.fillRect(px - 1, py - 5, 3, 11);
  const [sx, sy] = signSpot(isl), label = isl.name, w = textWidth(label) + 16;
  ctx.fillStyle = neon ? '#0b1030' : '#6a4a2a'; ctx.fillRect(sx - w / 2 - 3, sy - 3, w + 6, 19);
  ctx.fillStyle = neon ? '#0b1030' : '#b98a5a'; ctx.fillRect(sx - w / 2, sy, w, 13);
  drawPixelText(ctx, label, Math.round(sx - textWidth(label) / 2), sy + 3, neon ? id.accent : '#fff6e0');
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
```

- [ ] **Step 4: Run test** — `node --test test/world.test.js` → PASS (5 tests). Si un rectangle sort des bornes, augmenter la marge de `islandBounds` (pas le test).
- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 9: Structure HTML et thème par phase (`public/index.html`, `public/style.css`)

**Files:**
- Rewrite: `public/index.html`, `public/style.css`

**Interfaces:**
- Produces (ids utilisés par `app.js`) : `#map` (canvas), `#overlay`, `#topbar`, `#search`, `#search-results`, `#missions-count`, `#phase-pill`, `#connections`, `#settings-btn`, `#settings`, `#sky`, `#zoom-in`, `#zoom-out`, `#zoom-label`, `#missionbar` (form : `select[name=assignedTo]`, `input[name=title]`), `#minimap`, `#minimap-grid`, `#minimap-view`, `#minimap-toggle`, `#pop`, `#live`. Classes : `.panel`, `.hit`, `.hit.island`, `.hit.plot`, `.hit.agent`, `.hit.agent.match`, `.pill`, `.status-icon`, `.tabs`, `.tab[aria-selected]`.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="fr" data-phase="noon">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Workeda AI Commerce Studio</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main id="stage">
    <canvas id="map" tabindex="0" role="img" aria-label="Archipel isométrique : une île par département autour d'une place centrale. Glisser pour déplacer, molette pour zoomer."></canvas>
    <div id="overlay"></div>
    <header id="topbar" class="panel">
      <canvas id="logo" width="44" height="7" aria-label="Workeda" role="img"></canvas>
      <span class="sub">AI Commerce Studio</span>
      <div class="search-wrap"><input id="search" type="search" placeholder="Rechercher un agent…" aria-label="Rechercher un agent par nom ou rôle" autocomplete="off"><ul id="search-results" class="panel" hidden></ul></div>
      <span id="missions-count" class="chip">0 mission ouverte</span>
      <button id="phase-pill" class="chip accent" type="button" aria-haspopup="true">Midi</button>
      <span id="connections" class="chip soft">Vérification locale…</span>
      <button id="settings-btn" class="icon" type="button" aria-label="Réglages" aria-haspopup="true">⚙</button>
    </header>
    <section id="settings" class="panel" hidden aria-label="Réglages">
      <label>Ciel <select id="sky"><option value="auto">Automatique</option><option value="morning">Matin</option><option value="noon">Midi</option><option value="evening">Soir</option><option value="night">Nuit</option></select></label>
      <div class="zoom">Zoom <button id="zoom-out" type="button" aria-label="Dézoomer">−</button><span id="zoom-label">100 %</span><button id="zoom-in" type="button" aria-label="Zoomer">+</button></div>
      <ul class="legend"><li><span class="dot idle"></span>En attente (aucune icône)</li><li><span class="dot working"></span>Au travail</li><li><span class="dot waiting"></span>Attend une réponse</li><li><span class="dot blocked"></span>Bloqué</li></ul>
      <p class="note">« Détecté » signifie seulement que le programme est présent sur cet ordinateur. Aucune écriture Shopify sans approbation explicite.</p>
    </section>
    <form id="missionbar" class="panel" aria-label="Donner une mission">
      <select name="assignedTo" aria-label="Agent assigné"><option value="">Sans agent</option></select>
      <input name="title" required maxlength="120" placeholder="Donner une mission…" aria-label="Titre de la mission">
      <button type="submit" class="primary">Créer la mission</button>
    </form>
    <aside id="minimap" class="panel" aria-label="Plan de l'archipel">
      <div class="mm-head"><span>Plan de l'archipel</span><button id="minimap-toggle" type="button" aria-label="Replier le plan">▾</button></div>
      <div id="minimap-grid"><div id="minimap-view"></div></div>
    </aside>
    <section id="pop" class="panel" hidden tabindex="-1" role="dialog" aria-label="Détails"></section>
    <div id="live" class="sr" aria-live="polite"></div>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
:root{--font:system-ui,"Segoe UI",sans-serif;--radius:16px;--t:1.5s}
html[data-phase=morning]{--sky:linear-gradient(180deg,#ffd7b5,#cfe6f5 55%,#fff1e2);--panel:rgba(255,249,242,.86);--panel-solid:#fff9f2;--border:rgba(255,255,255,.95);--text:#3a2f2a;--soft:#7a6456;--accent:#e86a3c;--on-accent:#fff;--shadow:0 8px 24px rgba(160,100,60,.16)}
html[data-phase=noon]{--sky:linear-gradient(180deg,#4aa8f0,#a9dcff 55%,#eaf7ff);--panel:rgba(255,255,255,.86);--panel-solid:#ffffff;--border:rgba(255,255,255,.95);--text:#1f2433;--soft:#4f566a;--accent:#6c5ce7;--on-accent:#fff;--shadow:0 8px 24px rgba(40,50,90,.16)}
html[data-phase=evening]{--sky:linear-gradient(180deg,#3f2f80,#b0508e 50%,#ff9a5c);--panel:rgba(62,36,64,.82);--panel-solid:#3e2440;--border:rgba(255,190,140,.45);--text:#fff3e8;--soft:#f0d0b8;--accent:#ffb15c;--on-accent:#3a1f12;--shadow:0 8px 28px rgba(40,10,30,.35)}
html[data-phase=night]{--sky:linear-gradient(180deg,#05071a,#120f3a 55%,#2a1450);--panel:rgba(10,14,40,.84);--panel-solid:#0a0e28;--border:rgba(63,208,255,.5);--text:#e8f4ff;--soft:#a8bad8;--accent:#3fd0ff;--on-accent:#05071a;--shadow:0 0 26px rgba(63,208,255,.22)}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font:14px/1.4 var(--font);color:var(--text)}
body{background:var(--sky);transition:background var(--t)}
#stage{position:fixed;inset:0}#map{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;cursor:grab;outline:none}#map.dragging{cursor:grabbing}
#overlay{position:absolute;inset:0;pointer-events:none}#overlay>*{pointer-events:auto}
.panel{background:var(--panel-solid);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);color:var(--text);transition:background var(--t),color var(--t),border-color var(--t)}
@supports (backdrop-filter:blur(1px)){.panel{background:var(--panel);backdrop-filter:blur(14px)}}
button,input,select,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:10px;padding:6px 10px}
button{cursor:pointer}button.primary{background:var(--accent);color:var(--on-accent);border-color:transparent;font-weight:700}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
#topbar{position:absolute;left:16px;right:16px;top:12px;height:56px;display:flex;align-items:center;gap:12px;padding:0 14px}
#logo{width:88px;height:14px;image-rendering:pixelated}.sub{color:var(--soft);font-size:13px}
.search-wrap{margin-left:auto;position:relative}#search{width:260px}
#search-results{position:absolute;top:44px;left:0;width:300px;list-style:none;margin:0;padding:6px;max-height:300px;overflow:auto}
#search-results button{width:100%;text-align:left;border:0}
.chip{padding:6px 12px;border-radius:999px;border:1px solid var(--border);font-weight:600;font-size:13px;white-space:nowrap}.chip.accent{background:var(--accent);color:var(--on-accent);border-color:transparent}.chip.soft{color:var(--soft)}
.icon{width:36px;height:36px;padding:0}
#settings{position:absolute;right:16px;top:76px;width:300px;padding:14px;display:grid;gap:10px;z-index:6}
.legend{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:13px}.dot{display:inline-block;width:10px;height:10px;border-radius:5px;margin-right:6px}
.dot.idle{background:#9fb3d1}.dot.working{background:#2f8f5a}.dot.waiting{background:#c9a23a}.dot.blocked{background:#e8853d}
.note{font-size:12px;color:var(--soft);margin:0}
#missionbar{position:absolute;left:50%;transform:translateX(-50%);bottom:16px;width:min(680px,calc(100vw - 32px));display:flex;gap:8px;padding:10px}
#missionbar input{flex:1;min-width:0}
#minimap{position:absolute;right:16px;bottom:16px;width:220px;padding:10px 12px}.mm-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.4px}
.mm-head button{border:0;padding:0 4px}#minimap-grid{position:relative;height:150px;margin-top:8px}#minimap.collapsed #minimap-grid{display:none}
.mm-dot{position:absolute;width:22px;height:22px;border-radius:8px;border:2px solid var(--border);transform:translate(-50%,-50%);padding:0}
#minimap-view{position:absolute;border:2px solid var(--accent);border-radius:6px;pointer-events:none}
.hit{position:absolute;padding:0;margin:0;border:0;background:transparent;cursor:pointer;border-radius:8px}
.hit.agent.match{outline:3px solid var(--accent);outline-offset:2px}.hit.plot:hover{background:rgba(255,255,255,.2)}
.pill{position:absolute;transform:translate(-50%,-100%);display:flex;gap:8px;align-items:center;padding:6px 10px;width:230px;text-align:left}
.pill .sw{width:20px;height:20px;border-radius:7px;flex:none}.pill b{display:block;font-size:14px}.pill small{color:var(--soft);font-size:11px;white-space:nowrap}
.pill .ini{display:flex;margin-left:auto}.pill .ini span{width:20px;height:20px;margin-left:-6px;border-radius:10px;border:2px solid #fff;background:#ffd58a;color:#2a2a3a;font:700 10px var(--font);display:grid;place-items:center}
.status-icon{position:absolute;width:30px;height:30px;transform:translate(-50%,-100%);pointer-events:none}
#pop{position:absolute;z-index:5;width:340px;max-height:calc(100vh - 160px);overflow:auto;padding:16px}
#pop[hidden],#settings[hidden],#search-results[hidden]{display:none}
#pop h2{margin:0 28px 4px 0;font-size:18px}#pop h3{margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--soft)}
#pop p,#pop li{margin:0;font-size:13px}#pop ul{margin:0;padding:0;list-style:none;display:grid;gap:4px}
#pop .x{position:absolute;right:10px;top:10px;border:0}#pop form{display:grid;gap:8px;margin-top:8px}#pop label{display:grid;gap:3px;font-size:12px;color:var(--soft)}
#pop::before{content:"";position:absolute;width:14px;height:14px;background:inherit;border-left:1px solid var(--border);border-bottom:1px solid var(--border);top:28px;left:-8px;transform:rotate(45deg)}
#pop.right::before{left:auto;right:-8px;transform:rotate(-135deg)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.tab{border-radius:999px;font-size:12px;font-weight:600}.tab[aria-selected=true]{background:var(--accent);color:var(--on-accent);border-color:transparent}
.status{display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:10px;background:rgba(127,127,127,.12);font-weight:600}
.err{color:#e0483a}.confirm{display:grid;gap:6px;padding:10px;border:1px solid var(--border);border-radius:12px}
.preview{width:128px;height:128px;image-rendering:pixelated;display:block;margin:4px auto 8px;border-radius:12px;background:rgba(127,127,127,.12)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media(max-width:700px){#topbar{left:8px;right:8px;gap:8px}.sub,#connections,#missions-count{display:none}#search{width:140px}
  #pop{left:0!important;right:0;top:auto!important;bottom:0;width:auto;max-height:70vh;border-radius:16px 16px 0 0}#pop::before{display:none}
  #minimap{width:150px}#minimap-grid{height:100px}#missionbar{bottom:8px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
```

- [ ] **Step 3: Checkpoint** — `npm test` vert (aucun test ne dépend de ces fichiers ; le test statique existant `GET /` vérifie toujours le 200).

---

### Task 10: Rendu, vue et superposition (`public/app.js`, partie 1)

**Files:**
- Rewrite: `public/app.js`
- Delete: `public/scene.js`, `test/scene.test.js`

**Interfaces:**
- Consumes: Tasks 1–9, `public/sky.js` (`PALETTES`, `PHASE_LABELS`, `resolveSkyPhase`, `loadOverride`, `saveOverride`).
- Produces (fonctions internes utilisées par Task 11) : `loadUserSprites()`, `state` (`{ departments, agents, missions, messages, appearances, health, world, placed }`), `refresh()`, `buildOverlay()`, `show(kind, id, opts)`, `close()`, `centerOnWorld(x, y)`, `lookOf(agent)`, `spriteFor(agent, opts)`, `beamQueue`, `walkers`.

- [ ] **Step 1: Write the first part of `public/app.js`** (rendu, vue, superposition, données). La partie 2 (Task 11) ajoute les fenêtres et formulaires à la fin du même fichier.

```js
// public/app.js — carte isométrique : rendu, interface, fenêtres (navigateur).
import { PALETTES, PHASE_LABELS, resolveSkyPhase, loadOverride, saveOverride } from './sky.js';
import { tinter, mix } from './iso.js';
import { appearanceFor, expressionFor, spriteGrid, OPTIONS, hashStr } from './sprites.js';
import { drawPixelText } from './pixelfont.js';
import { computeBeams } from './beams.js';
import { createViewport, toScreen, toWorld, centerOn, zoomAt, panBy, nextZoom, visibleRect } from './viewport.js';
import { computeWorld, placeAgents, drawIsland, drawHub, drawDesk, spriteCanvas, islandBounds, recruitSpot, pillSpot, doorSpot } from './world.js';

const $ = (s) => document.querySelector(s);
const get = (p) => fetch(p).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
const send = (method, p, data) => fetch(p, { method, headers: { 'content-type': 'application/json' }, body: data && JSON.stringify(data) }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
const h = (tag, props = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter((k) => k != null && k !== false)); return el; };
const announce = (t) => { $('#live').textContent = t; };
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATUS_LABELS = { idle: 'En attente', working: 'Au travail', waiting: 'En attente d’une réponse', blocked: 'Bloqué' };
const ICONS = {
  working: '<svg viewBox="-8 -8 16 16" width="30" height="30"><circle r="7.5" fill="#fff" stroke="#2f8f5a"/><path d="M0-4.6l1 .9 1.4-.3.5 1.3 1.3.5-.3 1.4.9 1-.9 1 .3 1.4-1.3.5-.5 1.3-1.4-.3-1 .9-1-.9-1.4.3-.5-1.3-1.3-.5.3-1.4-.9-1 .9-1-.3-1.4 1.3-.5.5-1.3 1.4.3z" fill="#2f8f5a"/><circle r="1.5" fill="#fff"/></svg>',
  waiting: '<svg viewBox="-8 -8 16 16" width="30" height="30"><circle r="7.5" fill="#fff" stroke="#c9a23a"/><path d="M-3.2-4.2h6.4M-3.2 4.2h6.4M-2.6-4.2c0 2.6 2.6 2.8 2.6 4.2s-2.6 1.6-2.6 4.2M2.6-4.2c0 2.6-2.6 2.8-2.6 4.2s2.6 1.6 2.6 4.2" fill="none" stroke="#6b4e10" stroke-width="1.1" stroke-linecap="round"/></svg>',
  blocked: '<svg viewBox="-8 -8 16 16" width="30" height="30"><circle r="7.5" fill="#fff" stroke="#e8853d"/><path d="M0-4.5L4.6 3.6H-4.6Z" fill="#e8853d"/><path d="M0-1.4v2.4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/><circle cy="2.4" r=".6" fill="#fff"/></svg>'
}; // icônes : SVG statiques écrits ici, aucune donnée de la base

export const state = { departments: [], agents: [], missions: [], messages: [], appearances: new Map(), health: null, world: null, placed: [] };
let override = loadOverride(), phase = resolveSkyPhase(new Date(), override), firstLoad = true;
const seenExchanges = new Set(), knownAgents = new Set();
const beamQueue = [], walkers = new Map();
const canvas = $('#map'), ctx = canvas.getContext('2d'), overlay = $('#overlay');
let vp = createViewport(2400, 1600, innerWidth, innerHeight);
const islandCache = new Map(); let hubCache = null;
const deptOf = (id) => state.departments.find((d) => d.id === id);
const islandOf = (deptId) => state.world?.islands.find((i) => i.id === deptId);

// ---------- phase et ciel ----------
function applyPhase() {
  document.documentElement.dataset.phase = phase;
  $('#sky').value = override;
  const now = new Date(), hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  const glyph = { morning: '◐', noon: '☀', evening: '◒', night: '☾' }[phase];
  $('#phase-pill').textContent = `${glyph} ${PHASE_LABELS[phase]} · ${hh}:${mm} · ${override === 'auto' ? 'auto' : 'manuel'}`;
  rebuildCaches();
}
$('#sky').addEventListener('change', (e) => { override = saveOverride(e.target.value); phase = resolveSkyPhase(new Date(), override); applyPhase(); announce(`Ciel : ${PHASE_LABELS[override]}`); });
setInterval(() => { phase = resolveSkyPhase(new Date(), override); applyPhase(); }, 30000);

// ---------- personnages ----------
const spriteCache = new Map();
export const lookOf = (agent) => appearanceFor(agent, deptOf(agent.department_id)?.name, state.appearances.get(agent.id));
let userSprites = null; // feuilles fournies par l'utilisateur (licence obligatoire), sinon personnages générés
export function spriteFor(agent, { dir = 'down', frame = 0, look, walking = false } = {}) {
  if (userSprites && !look) {
    const v = userSprites[hashStr(`${agent.name}|${agent.role}`) % userSprites.length];
    const sheet = v[walking ? `walk-${dir}` : agent.status] || (!walking && v.idle);
    if (sheet) { const key = `user|${sheet.img.src}|${frame % sheet.frames}`; if (!spriteCache.has(key)) { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').drawImage(sheet.img, (frame % sheet.frames) * 64, 0, 64, 64, 0, 0, 64, 64); spriteCache.set(key, c); } return spriteCache.get(key); }
  }
  const L = look || lookOf(agent), expr = expressionFor(agent.status);
  const key = `${JSON.stringify(L)}|${expr}|${dir}|${frame}`;
  if (!spriteCache.has(key)) spriteCache.set(key, spriteCanvas(spriteGrid(L, { expr, dir, frame })));
  return spriteCache.get(key);
}
async function loadUserSprites() {
  try {
    const r = await fetch('/assets/characters/manifest.json'); if (!r.ok) return; // absent : personnages générés
    const m = await r.json();
    if (!m.license?.trim() || !Array.isArray(m.variants) || !m.variants.length || m.frameWidth !== 64 || m.frameHeight !== 64) { console.warn('Sprites ignorés : manifest sans licence, sans variantes ou pas en 64×64.'); return; }
    const load = (src) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error(`image introuvable : ${src}`)); i.src = `/assets/characters/${encodeURI(src)}`; });
    userSprites = await Promise.all(m.variants.map(async (v) => Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, sh]) => [k, { img: await load(sh.src), frames: Math.max(1, sh.frames | 0) }])))));
    spriteCache.clear();
  } catch (e) { console.warn('Sprites ignorés :', e.message); }
}

// ---------- calques en cache ----------
function rebuildCaches() {
  if (!state.world) return;
  const P = { lit: phase === 'evening' || phase === 'night', neon: phase === 'night' }, C = tinter(phase);
  islandCache.clear();
  for (const isl of state.world.islands) {
    const b = islandBounds(isl), c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
    const g = c.getContext('2d'); g.translate(-b.x, -b.y); drawIsland(g, C, isl, P);
    islandCache.set(isl.id, { canvas: c, b, y: isl.y });
  }
  const hub = state.world.hub, hc = document.createElement('canvas'); hc.width = 520; hc.height = 420;
  const hg = hc.getContext('2d'); hg.translate(-(hub.x - 260), -(hub.y - 260)); drawHub(hg, C, hub, P);
  hubCache = { canvas: hc, x: hub.x - 260, y: hub.y - 260 };
  draw(performance.now() / 1000);
}

// ---------- rendu ----------
function drawSky(t) {
  const P = PALETTES[phase], H = canvas.height, W = canvas.width;
  for (let i = 0; i < 16; i++) { ctx.fillStyle = mix(P.skyTop, P.skyBottom, i / 15); ctx.fillRect(0, Math.floor((i * H) / 16), W, Math.ceil(H / 16) + 1); }
  if (P.stars) { ctx.fillStyle = '#d8dcff'; for (let i = 0; i < 140; i++) ctx.fillRect((i * 397) % W, (i * 211) % H, i % 9 ? 2 : 3, i % 9 ? 2 : 3); }
  ctx.fillStyle = P.cloud;
  for (let k = 0; k < 6; k++) { const w = 140 + (k % 3) * 40, x = ((k * 431 + (reduce ? 0 : t * (6 + k))) % (W + 300)) - 150, y = 120 + ((k * 173) % (H - 200)); ctx.globalAlpha = 0.8; ctx.fillRect(x, y, w, 22); ctx.fillRect(x + 28, y - 20, w - 70, 20); ctx.globalAlpha = 1; }
}
function draw(t) {
  if (!state.world) return;
  if (canvas.width !== innerWidth || canvas.height !== innerHeight) { canvas.width = innerWidth; canvas.height = innerHeight; }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
  drawSky(t);
  ctx.setTransform(vp.zoom, 0, 0, vp.zoom, -vp.x * vp.zoom, -vp.y * vp.zoom); ctx.imageSmoothingEnabled = false;
  const C = tinter(phase, 0.5), hub = state.world.hub;
  const layers = [...islandCache.values()].map((l) => ({ y: l.y, f: () => ctx.drawImage(l.canvas, l.b.x, l.b.y) }));
  if (hubCache) layers.push({ y: hub.y, f: () => ctx.drawImage(hubCache.canvas, hubCache.x, hubCache.y) });
  layers.sort((a, b) => a.y - b.y).forEach((l) => l.f());
  drawLinks(t); drawAgents(C, t); drawBeams(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  positionOverlay();
}
const centerOf = (key) => (key === 'hub' ? [state.world.hub.x, state.world.hub.y - 80] : (() => { const i = islandOf(key); return i ? [i.x, i.y - 140] : null; })());
function drawLinks() {
  ctx.fillStyle = phase === 'night' ? '#7ff0ff' : '#ffffff'; ctx.globalAlpha = 0.55;
  for (const l of state.links || []) { const a = centerOf(l.from), b = centerOf(l.to); if (!a || !b) continue; const n = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let d = 0; d < n; d += 10) ctx.fillRect(Math.round(a[0] + ((b[0] - a[0]) * d) / n), Math.round(a[1] + ((b[1] - a[1]) * d) / n - Math.sin((Math.PI * d) / n) * 60), 3, 3); }
  ctx.globalAlpha = 1;
}
function drawAgents(C, t) {
  for (const p of state.placed) {
    const w = walkers.get(p.agent.id);
    ctx.globalAlpha = p.agent.enabled === false ? 0.45 : 1;
    if (w) { const k = Math.min(1, (t - w.start) / w.duration), x = w.from[0] + (p.x - w.from[0]) * k, y = w.from[1] + (p.y - w.from[1]) * k; const dir = Math.abs(p.x - w.from[0]) > Math.abs(p.y - w.from[1]) ? (p.x < w.from[0] ? 'left' : 'right') : (p.y < w.from[1] ? 'up' : 'down'); ctx.drawImage(spriteFor(p.agent, { dir, frame: 1 + (Math.floor(t * 8) % 2), walking: true }), Math.round(x - 32), Math.round(y - 61)); drawDesk(ctx, C, p.x, p.y, false); if (k >= 1) walkers.delete(p.agent.id); continue; }
    const breath = reduce || p.agent.status === 'blocked' ? 0 : Math.floor(t * 0.7 + (p.x % 7)) % 2;
    const frame = p.agent.status === 'working' && !reduce ? Math.floor(t * 4) % 2 : 0;
    ctx.drawImage(spriteFor(p.agent, { frame }), p.x - 32, p.y - 61 + breath);
    drawDesk(ctx, C, p.x, p.y, p.agent.status === 'working');
  }
  ctx.globalAlpha = 1;
}
function drawBeams(t) {
  const crystal = centerOf('hub');
  for (let k = beamQueue.length - 1; k >= 0; k--) {
    const b = beamQueue[k], age = t - (b.start ??= t), dur = 2.6;
    if (age > dur) { beamQueue.splice(k, 1); continue; }
    const a = centerOf(b.from), z = centerOf(b.to); if (!a || !z) { beamQueue.splice(k, 1); continue; }
    const color = phase === 'night' ? '#bff8ff' : '#a070ff';
    if (b.spark) { ctx.fillStyle = color; for (let i = 0; i < 6; i++) ctx.fillRect(a[0] + Math.cos(i + age * 6) * 20 * age, a[1] + Math.sin(i + age * 6) * 10 * age, 3, 3); continue; }
    const half = age < dur / 2, f = half ? age / (dur / 2) : (age - dur / 2) / (dur / 2), p = half ? [a, crystal] : [crystal, z];
    const x = p[0][0] + (p[1][0] - p[0][0]) * f, y = p[0][1] + (p[1][1] - p[0][1]) * f - Math.sin(Math.PI * f) * 80;
    ctx.globalAlpha = 0.3; ctx.fillStyle = color; ctx.fillRect(x - 9, y - 9, 18, 18); ctx.globalAlpha = 1; ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 3, y - 3, 6, 6);
    if (Math.abs(age - dur / 2) < 0.3) { ctx.globalAlpha = 0.35; ctx.fillStyle = color; ctx.fillRect(crystal[0] - 10, crystal[1] - 600, 20, 600); ctx.globalAlpha = 1; } // éclair vertical au passage du cristal
  }
}
let last = 0;
function frame(ts) { if (ts - last >= 40) { last = ts; draw(ts / 1000); } requestAnimationFrame(frame); }

// ---------- superposition HTML (boutons, pastilles, icônes) ----------
const overlayNodes = [];
function buildOverlay() {
  overlay.replaceChildren(); overlayNodes.length = 0;
  const addNode = (el, wx, wy, w, hh, ax = 0.5, ay = 0.5) => { overlay.append(el); overlayNodes.push({ el, wx, wy, w, hh, ax, ay }); };
  for (const isl of state.world.islands) {
    const d = deptOf(isl.id), team = state.agents.filter((a) => a.department_id === isl.id);
    const [px, py] = pillSpot(isl);
    const pill = h('button', { class: 'pill panel hit island', type: 'button', 'data-key': `island:${isl.id}`, 'aria-label': `Département ${d.name}, ${team.length} agent${team.length > 1 ? 's' : ''}`, onclick: () => show('island', isl.id) },
      h('span', { class: 'sw', style: `background:${isl.identity.accent}` }),
      h('span', {}, h('b', {}, d.name), h('small', {}, `${team.length} agents · ${team.filter((a) => a.status === 'working').length} en cours`)),
      h('span', { class: 'ini' }, team.slice(0, 3).map((a) => h('span', {}, a.name.slice(0, 1).toUpperCase()))));
    addNode(pill, px, py, 0, 0, 0, 0);
    const [rx, ry] = recruitSpot(isl);
    addNode(h('button', { class: 'hit plot', type: 'button', 'data-key': `plot:${isl.id}`, title: `Recruter un agent — ${d.name}`, 'aria-label': `Recruter un agent — ${d.name}`, onclick: () => show('island', isl.id, { recruit: true }) }), rx, ry, 34, 24);
  }
  const hub = state.world.hub;
  addNode(h('button', { class: 'hit island', type: 'button', 'data-key': 'hub:hub', 'aria-label': 'Place centrale : missions et connexions', onclick: () => show('hub', 'hub') }), hub.x, hub.y - 60, 140, 180);
  const q = $('#search').value.trim().toLowerCase();
  for (const p of state.placed) {
    const a = p.agent, match = q && (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q));
    addNode(h('button', { class: `hit agent${match ? ' match' : ''}`, type: 'button', 'data-key': `agent:${a.id}`, title: a.name, 'aria-label': `${a.name}, ${a.role}, statut ${STATUS_LABELS[a.status] || a.status}`, onclick: () => show('agent', a.id) }), p.x, p.y - 30, 40, 64);
    if (ICONS[a.status]) { const icon = h('div', { class: 'status-icon', 'aria-hidden': 'true' }); icon.innerHTML = ICONS[a.status]; addNode(icon, p.x, p.y - 66, 0, 0, 0, 0); }
  }
  positionOverlay(); updateMinimap();
}
function positionOverlay() {
  for (const n of overlayNodes) {
    const [sx, sy] = toScreen(vp, n.wx, n.wy);
    n.el.style.left = `${Math.round(sx - n.w * vp.zoom * n.ax)}px`; n.el.style.top = `${Math.round(sy - n.hh * vp.zoom * n.ay)}px`;
    if (n.w) { n.el.style.width = `${n.w * vp.zoom}px`; n.el.style.height = `${n.hh * vp.zoom}px`; }
  }
  if (!$('#pop').hidden) positionPop();
}

// ---------- déplacement et zoom ----------
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (!drag) return; panBy(vp, e.clientX - drag.x, e.clientY - drag.y); drag = { x: e.clientX, y: e.clientY }; afterView(); });
canvas.addEventListener('pointerup', () => { drag = null; canvas.classList.remove('dragging'); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(vp, nextZoom(vp.zoom, e.deltaY < 0 ? 1 : -1), e.clientX, e.clientY); afterView(); }, { passive: false });
canvas.addEventListener('keydown', (e) => { const s = 60, m = { ArrowLeft: [s, 0], ArrowRight: [-s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }[e.key]; if (m) { e.preventDefault(); panBy(vp, ...m); afterView(); } });
$('#zoom-in').addEventListener('click', () => { zoomAt(vp, nextZoom(vp.zoom, 1), innerWidth / 2, innerHeight / 2); afterView(); });
$('#zoom-out').addEventListener('click', () => { zoomAt(vp, nextZoom(vp.zoom, -1), innerWidth / 2, innerHeight / 2); afterView(); });
function afterView() { $('#zoom-label').textContent = `${vp.zoom * 100} %`; positionOverlay(); updateMinimap(); if (reduce) draw(0); }
export function centerOnWorld(x, y) { centerOn(vp, x, y); afterView(); }
addEventListener('resize', () => { Object.assign(vp, { viewW: innerWidth, viewH: innerHeight }); centerOn(vp, ...toWorld(vp, innerWidth / 2, innerHeight / 2)); afterView(); });

// ---------- mini-plan ----------
function updateMinimap() {
  if (!state.world) return;
  const grid = $('#minimap-grid'), W = grid.clientWidth || 196, H = grid.clientHeight || 150, sx = W / state.world.width, sy = H / state.world.height;
  if (grid.children.length !== state.world.islands.length + 2) {
    grid.replaceChildren($('#minimap-view') || h('div', { id: 'minimap-view' }));
    for (const isl of state.world.islands) grid.append(h('button', { class: 'mm-dot', type: 'button', style: `left:${isl.x * sx}px;top:${isl.y * sy}px;background:${isl.identity.accent}`, 'aria-label': `Aller à ${isl.name}`, onclick: () => { centerOnWorld(isl.x, isl.y - 60); show('island', isl.id); } }));
    grid.append(h('button', { class: 'mm-dot', type: 'button', style: `left:${state.world.hub.x * sx}px;top:${state.world.hub.y * sy}px;background:linear-gradient(135deg,#e0c8ff,#8a5af0)`, 'aria-label': 'Aller à la place centrale', onclick: () => centerOnWorld(state.world.hub.x, state.world.hub.y) }));
  }
  const r = visibleRect(vp), v = $('#minimap-view');
  Object.assign(v.style, { left: `${r.x * sx}px`, top: `${r.y * sy}px`, width: `${r.w * sx}px`, height: `${r.h * sy}px` });
}
$('#minimap-toggle').addEventListener('click', () => { const m = $('#minimap'); m.classList.toggle('collapsed'); $('#minimap-toggle').textContent = m.classList.contains('collapsed') ? '▸' : '▾'; });

// ---------- données ----------
export async function refresh() {
  const [departments, agents, missions, messages, appearances] = await Promise.all([get('/api/departments'), get('/api/agents'), get('/api/missions'), get('/api/messages'), get('/api/appearances')]);
  Object.assign(state, { departments, agents, missions, messages, appearances: new Map(appearances.map((a) => [a.agentId, a])) });
  const prevW = state.world?.width;
  state.world = computeWorld(departments, agents); state.placed = placeAgents(state.world, agents);
  if (prevW !== state.world.width) { Object.assign(vp, { worldW: state.world.width, worldH: state.world.height }); if (firstLoad) centerOn(vp, state.world.hub.x, state.world.hub.y); }
  const beams = computeBeams({ messages, missions, agents, seen: firstLoad ? null : seenExchanges });
  beams.ids.forEach((id) => seenExchanges.add(id)); state.links = beams.links;
  if (!reduce) beamQueue.push(...beams.fresh);
  for (const a of agents) { if (!firstLoad && !knownAgents.has(a.id) && !reduce) { const isl = islandOf(a.department_id); if (isl) walkers.set(a.id, { from: doorSpot(isl), start: performance.now() / 1000, duration: 2 }); } knownAgents.add(a.id); }
  firstLoad = false;
  $('#missions-count').textContent = `${missions.filter((m) => !['done', 'cancelled'].includes(m.state)).length} missions ouvertes`;
  const sel = $('#missionbar select'); sel.replaceChildren(h('option', { value: '' }, 'Sans agent'), agents.map((a) => h('option', { value: a.id }, a.name)));
  rebuildCaches(); buildOverlay();
}
get('/api/health').then((v) => { state.health = v; const d = (x) => (x ? 'détecté' : 'non détecté'); $('#connections').textContent = `Claude ${d(v.connectors.claudeCode)} · Codex ${d(v.connectors.codexCli)} · Shopify CLI ${d(v.connectors.shopifyCli)}`; }).catch(() => { $('#connections').textContent = 'Serveur local injoignable'; });
loadUserSprites();
{ const logo = $('#logo').getContext('2d'); drawPixelText(logo, 'WORKEDA', 1, 0, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c5ce7'); }
```

- [ ] **Step 2: Supprimer les anciens fichiers**

Run: `rm public/scene.js test/scene.test.js`

- [ ] **Step 3: Checkpoint** — `npm test` vert (les tests de `scene.js` sont remplacés par `world.test.js`). L'application n'est pas encore utilisable : `show`, `close` et `positionPop` arrivent à la Task 11.

---

### Task 11: Fenêtres, éditeur d'apparence, recherche, barre de mission (`public/app.js`, partie 2)

**Files:**
- Modify: `public/app.js` (ajouter à la fin)

**Interfaces:**
- Consumes: Task 10 (`state`, `refresh`, `lookOf`, `spriteFor`, `centerOnWorld`, `h`, `send`, `get`, `announce`, `ICONS`, `STATUS_LABELS`).
- Produces : `show(kind, id, opts)`, `close()`, `positionPop()`.

- [ ] **Step 1: Append to `public/app.js`**

```js
// ---------- fenêtres contextuelles ----------
const pop = $('#pop'); let current = null;
const anchorEl = () => current && overlay.querySelector(`[data-key="${current.key}"]`);
function positionPop() {
  if (matchMedia('(max-width: 700px)').matches) { pop.style.left = pop.style.top = ''; return; }
  const a = anchorEl(); if (!a) return;
  const r = a.getBoundingClientRect(), w = pop.offsetWidth, hh = pop.offsetHeight;
  let left = r.right + 14, right = false; if (left + w > innerWidth - 8) { left = r.left - w - 14; right = true; }
  pop.classList.toggle('right', right);
  pop.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`; pop.style.top = `${Math.max(76, Math.min(r.top, innerHeight - hh - 90))}px`;
}
export function close(restore = true) { if (pop.hidden) return; const key = current?.key; pop.hidden = true; current = null; announce('Fenêtre fermée'); if (restore && key) overlay.querySelector(`[data-key="${key}"]`)?.focus(); }
export function show(kind, id, opts = {}) {
  const key = opts.recruit ? `plot:${id}` : `${kind}:${id}`; current = { kind, id, key };
  const view = { island: islandView, agent: agentView, hub: hubView }[kind](id, opts);
  pop.replaceChildren(h('button', { class: 'x', type: 'button', 'aria-label': 'Fermer', onclick: () => close() }, '×'), view);
  pop.hidden = false; positionPop(); pop.focus(); announce(`${pop.querySelector('h2')?.textContent ?? ''} ouvert`);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); $('#settings').hidden = true; $('#search-results').hidden = true; } });
document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.hit')) close(false); if (!$('#settings').hidden && !e.target.closest('#settings, #settings-btn, #phase-pill')) $('#settings').hidden = true; });

const field = (label, control) => h('label', {}, label, control);
function form(fields, submitLabel, onSubmit) {
  const err = h('p', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; const btn = f.querySelector('button[type=submit]'); btn.disabled = true; try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (x) { err.textContent = x.message; btn.disabled = false; } } }, fields, h('button', { type: 'submit', class: 'primary' }, submitLabel), err);
  return f;
}
const missionLine = (m) => h('li', {}, `${m.title} — ${m.state}, validation ${m.requiresApproval ? 'requise' : 'non requise'}`);
const deptSelect = (sel) => h('select', { name: 'departmentId', required: true }, state.departments.map((d) => h('option', { value: d.id, selected: d.id === sel }, d.name)));

function recruitFlow(slot, id, values = {}) {
  slot.replaceChildren(form([
    field('Nom', h('input', { name: 'name', required: true, maxlength: 60, value: values.name ?? '' })),
    field('Rôle', h('input', { name: 'role', required: true, maxlength: 80, value: values.role ?? '' })),
    field('Département', deptSelect(values.departmentId ?? id))
  ], 'Continuer', async (data) => {
    const err = h('p', { class: 'err', role: 'alert' });
    const ok = h('button', { type: 'button', class: 'primary', onclick: async () => { ok.disabled = true; try { await send('POST', '/api/agents', data); await refresh(); show('island', data.departmentId); announce(`${data.name} recruté`); } catch (x) { err.textContent = x.message; ok.disabled = false; } } }, 'Confirmer le recrutement');
    slot.replaceChildren(h('div', { class: 'confirm' }, h('p', {}, `Recruter ${data.name} (${data.role}) dans ${deptOf(data.departmentId)?.name ?? '?'}.`), h('p', {}, 'Enregistré dans la base locale, statut En attente (source : manual). Il entrera par la porte.'), h('div', {}, ok, ' ', h('button', { type: 'button', onclick: () => recruitFlow(slot, id, data) }, 'Modifier')), err));
    ok.focus();
  }));
  slot.querySelector('input').focus();
}

function islandView(id, opts) {
  const d = deptOf(id), team = state.agents.filter((a) => a.department_id === id), ids = new Set(team.map((a) => a.id));
  const list = state.missions.filter((m) => ids.has(m.assigned_to) || ids.has(m.requested_by));
  const slot = h('div'), recruit = h('button', { type: 'button', class: 'primary', onclick: () => { recruit.hidden = true; recruitFlow(slot, id); } }, 'Recruter un agent');
  if (opts.recruit) queueMicrotask(() => recruit.click());
  return h('div', {}, h('h2', {}, d.name), h('p', {}, d.description || ''),
    h('h3', {}, `Agents (${team.length})`),
    team.length ? h('ul', {}, team.map((a) => h('li', {}, h('button', { type: 'button', onclick: () => show('agent', a.id) }, `${a.name} — ${a.role}`)))) : h('p', {}, 'Aucun agent recruté.'),
    h('div', { style: 'margin-top:8px' }, recruit, slot),
    h('h3', {}, 'Missions'), list.length ? h('ul', {}, list.map(missionLine)) : h('p', {}, 'Aucune mission.'));
}

function agentView(id) {
  const a = state.agents.find((x) => x.id === id), d = deptOf(a.department_id);
  const body = h('div');
  const tabs = ['Profil', 'Apparence', 'Journal', 'Messages'].map((t, k) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(k === 0), onclick: (e) => { tabs.forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget))); body.replaceChildren(TABS[t](a)); } }, t));
  body.append(TABS.Profil(a));
  return h('div', {}, h('h2', {}, a.name), h('p', {}, `${a.role} · ${d?.name ?? ''}${a.enabled ? '' : ' · désactivé'}`), h('div', { class: 'tabs', role: 'tablist' }, tabs), body);
}
const TABS = {
  Profil: (a) => h('div', {},
    h('div', { class: 'status' }, `${STATUS_LABELS[a.status] || a.status} · source : ${a.statusSource}`),
    a.statusSource === 'manual' && h('p', { style: 'margin-top:6px' }, 'Statut déclaré manuellement : aucun connecteur n’a vérifié d’activité.'),
    h('h3', {}, 'Missions'), (() => { const m = state.missions.filter((x) => x.assigned_to === a.id || x.requested_by === a.id); return m.length ? h('ul', {}, m.map(missionLine)) : h('p', {}, 'Aucune mission.'); })()),
  Apparence: (a) => {
    const look = { ...lookOf(a) }, preview = h('canvas', { class: 'preview', width: 64, height: 64, 'aria-label': `Aperçu de ${a.name}`, role: 'img' });
    const paint = () => { const g = preview.getContext('2d'); g.clearRect(0, 0, 64, 64); g.drawImage(spriteFor(a, { look }), 0, 0); };
    const labels = { hairStyle: 'Coiffure', hairColor: 'Cheveux', skin: 'Peau', eyes: 'Yeux', outfit: 'Tenue', topColor: 'Couleur de tenue', accessory: 'Accessoire' };
    const names = { short: 'courte', long: 'longue', spiky: 'en pics', bun: 'chignon', ponytail: 'queue de cheval', bob: 'carré', blazer: 'blazer', hoodie: 'sweat', sweater: 'pull', jacket: 'veste', labcoat: 'blouse', apron: 'tablier', none: 'aucun', glasses: 'lunettes', headset: 'casque', cap: 'casquette', scarf: 'écharpe' };
    const selects = Object.keys(labels).map((k) => field(labels[k], h('select', { name: k, onchange: (e) => { look[k] = e.target.value; paint(); } }, OPTIONS[k].map((v, i) => h('option', { value: v, selected: v === look[k] }, names[v] || `Teinte ${i + 1}`)))));
    queueMicrotask(paint);
    const err = h('p', { class: 'err', role: 'alert' });
    return h('div', {}, preview, h('form', { onsubmit: async (e) => { e.preventDefault(); try { await send('PUT', `/api/agents/${encodeURIComponent(a.id)}/appearance`, look); await refresh(); show('agent', a.id); announce('Apparence enregistrée'); } catch (x) { err.textContent = x.message; } } }, selects, h('button', { type: 'submit', class: 'primary' }, 'Enregistrer'),
      h('button', { type: 'button', onclick: async () => { try { await send('DELETE', `/api/agents/${encodeURIComponent(a.id)}/appearance`); await refresh(); show('agent', a.id); announce('Apparence automatique rétablie'); } catch (x) { err.textContent = x.message; } } }, 'Revenir à l’automatique'), err));
  },
  Journal: (a) => { const ul = h('ul', {}, h('li', {}, 'Chargement…')); get(`/api/events?agentId=${encodeURIComponent(a.id)}`).then((ev) => ul.replaceChildren(...ev.slice(0, 8).map((e) => h('li', {}, `${new Date(e.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · ${e.kind} · ${e.detail} (source : ${e.source})`)))).catch((x) => ul.replaceChildren(h('li', { class: 'err' }, x.message))); return ul; },
  Messages: (a) => {
    const talk = state.messages.filter((m) => m.from_agent_id === a.id || m.to_agent_id === a.id).slice(0, 8), others = state.agents.filter((o) => o.id !== a.id), name = (id) => state.agents.find((x) => x.id === id)?.name ?? '?';
    return h('div', {}, talk.length ? h('ul', {}, talk.map((m) => h('li', {}, `${name(m.from_agent_id)} → ${name(m.to_agent_id)} : ${m.body}`))) : h('p', {}, 'Aucun message.'),
      others.length ? form([field('De', h('select', { name: 'fromAgentId' }, others.map((o) => h('option', { value: o.id }, o.name)))), field('Message', h('textarea', { name: 'body', required: true, maxlength: 500 }))], 'Envoyer', async (data) => { await send('POST', '/api/messages', { ...data, toAgentId: a.id }); await refresh(); show('agent', a.id); announce('Message enregistré'); }) : h('p', {}, 'Recrutez un second agent pour échanger des messages.'),
      h('p', { class: 'note' }, 'Un message est seulement enregistré dans la base locale : aucun modèle ne le reçoit.'));
  }
};
function hubView() {
  const d = (x) => (x ? 'détecté' : 'non détecté'), c = state.health?.connectors;
  return h('div', {}, h('h2', {}, 'Place centrale'), h('p', {}, `${state.departments.length} départements · ${state.agents.length} agents · ${state.missions.length} missions`),
    h('h3', {}, 'Missions'), state.missions.length ? h('ul', {}, state.missions.slice(0, 10).map(missionLine)) : h('p', {}, 'Aucune mission.'),
    h('h3', {}, 'Connexions'), c ? h('ul', {}, [['Shopify CLI', c.shopifyCli], ['Claude Code', c.claudeCode], ['Codex CLI', c.codexCli], ['clink', c.clink]].map(([n, v]) => h('li', {}, `${n} : ${d(v)}`))) : h('p', {}, 'Indisponible.'),
    h('p', { class: 'note' }, '« Détecté » signifie seulement que le programme est présent. Aucune écriture Shopify sans approbation explicite.'));
}

// ---------- barre du haut : recherche, réglages ----------
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase(), res = $('#search-results');
  buildOverlay();
  if (!q) { res.hidden = true; return; }
  const found = state.agents.filter((a) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)).slice(0, 8);
  res.replaceChildren(...(found.length ? found.map((a) => h('li', {}, h('button', { type: 'button', onclick: () => { const p = state.placed.find((x) => x.agent.id === a.id); if (p) centerOnWorld(p.x, p.y - 40); res.hidden = true; show('agent', a.id); } }, `${a.name} — ${a.role} · ${deptOf(a.department_id)?.name ?? ''}`))) : [h('li', {}, 'Aucun agent trouvé.')]));
  res.hidden = false;
});
const toggleSettings = () => { const s = $('#settings'); s.hidden = !s.hidden; if (!s.hidden) $('#sky').focus(); };
$('#settings-btn').addEventListener('click', toggleSettings); $('#phase-pill').addEventListener('click', toggleSettings);

// ---------- barre de mission ----------
$('#missionbar').addEventListener('submit', async (e) => {
  e.preventDefault(); const data = Object.fromEntries(new FormData(e.target));
  if (!data.assignedTo) delete data.assignedTo;
  try { await send('POST', '/api/missions', data); e.target.reset(); await refresh(); announce('Mission créée (validation requise)'); } catch (x) { announce(x.message); }
});

// ---------- démarrage ----------
applyPhase();
refresh().catch((e) => { $('#connections').textContent = e.message; });
addEventListener('focus', () => { if (pop.hidden) refresh().catch(() => {}); });
if (!reduce) requestAnimationFrame(frame);
```

- [ ] **Step 2: Checkpoint** — `npm test` vert.

- [ ] **Step 3: Vérification manuelle**

```bash
WORKEDA_DB="$TEMP/iso.db" PORT=4401 node src/server.js
```

Vérifier dans le navigateur (`http://localhost:4401`) : la carte s'affiche centrée sur la place ; glisser et la molette fonctionnent ; recruter via une parcelle « + » (formulaire → confirmation) fait entrer l'agent par la porte ; l'onglet Apparence modifie et enregistre l'aperçu ; créer une mission via la barre du bas lance un faisceau ; le sélecteur de ciel change toute l'interface ; en 375×812 les fenêtres s'ouvrent en bas.

---

### Task 12: Documentation et vérification finale

**Files:**
- Modify: `README.md` (sections « Naviguer sur la carte », « Personnages », « Cycle du ciel »)
- Modify: `public/assets/characters/README.md` (frames 64×64, états + directions)

- [ ] **Step 1: Mettre à jour `README.md`**

Remplacer les sections « Naviguer sur la carte » et « Personnages » par :

```markdown
## Naviguer sur la carte

Archipel isométrique à l'échelle 1:1 (personnages 64×64) : la place centrale et son cristal, entourés d'une île par département. Chaque île porte un bâtiment en coupe (murs, fenêtres, porte) meublé selon le métier.

- **Glisser** pour déplacer la carte, **molette** ou boutons +/− (Réglages) pour zoomer (50 %, 100 %, 200 %). Flèches du clavier quand la carte a le focus.
- **Mini-plan** (bas droite) : un clic recentre la carte sur une île.
- **Pastille au-dessus d'un bâtiment** : agents, missions, recrutement.
- **Parcelle « + »** : recruter un agent (nom, rôle, département prérempli, puis confirmation). Il entre par la porte et rejoint son bureau.
- **Personnage** : onglets Profil (statut et source), Apparence, Journal, Messages.
- **Barre du bas** : donner une mission à un agent (crée une vraie mission, validation requise).
- **Recherche** (barre du haut) : filtre les agents par nom ou rôle.

Les faisceaux lumineux ne représentent que de vrais messages ou missions ; les échanges des dernières 24 h restent visibles en pointillés.

## Personnages

Personnages 64×64 originaux, générés par couches (coiffure, couleurs, peau, tenue, accessoire). Apparence automatique stable, modifiable dans l'onglet Apparence (enregistrée dans la table `agent_appearance`). L'expression et l'attitude suivent uniquement le statut enregistré :

| Statut | Expression | Icône |
| --- | --- | --- |
| `idle` | calme | aucune |
| `working` | concentré, tape au clavier | engrenage |
| `waiting` | interrogatif | sablier |
| `blocked` | soucieux | panneau orange |
```

Dans « Cycle du ciel », ajouter : « Toute l'interface (barres, fenêtres, pastilles) change de couleurs avec la phase. La pastille de la barre du haut indique la phase, l'heure et le mode (auto ou manuel) ; un clic ouvre les réglages. »

- [ ] **Step 2: Mettre à jour `public/assets/characters/README.md`** : frames de 64×64, `anchorX: 32`, `anchorY: 61`, états `idle`, `working`, `waiting`, `blocked` et directions `walk-down`, `walk-up`, `walk-left`, `walk-right` (3 frames).

- [ ] **Step 3: Vérification complète**

Run: `npm test` → tous les tests passent.
Run: `PORT=4402 npm start` sur la base réelle, puis `curl` en lecture seule de `/api/health`, `/api/agents`, `/api/appearances`, `/` → 200.
Vérifier dans le navigateur les 4 phases, le zoom, le mobile ; faire relire le code par Codex (PAL, rôle codereviewer).

- [ ] **Step 4: Checkpoint final** — `npm test` vert, résumé des fichiers modifiés et des limites restantes.

---

## Self-review

- **Couverture de la spec** : §3.1 → Tasks 6, 10 ; §3.2 → Task 7 ; §3.3–3.5 → Task 8 ; §3.6 → Task 10 (calques en cache, 25 i/s, mouvement réduit) ; §4.1–4.3 → Tasks 2, 10, 11 ; §4.4 → Task 10 (`walkers`) ; §4.5 → Task 10 (`loadUserSprites`, `spriteFor`) et Task 12 (doc) ; §5 → Tasks 5, 10 ; §6.1 → Tasks 9, 10 ; §6.2 → Tasks 9–11 ; §6.3 → Task 9 ; §6.4 → Tasks 4, 9, 10 ; §7 → Task 3 ; §9 → tests des Tasks 1–8.
- **Noms vérifiés** : `spriteGrid`, `appearanceFor`, `expressionFor`, `computeWorld`, `placeAgents`, `deskSpots`, `doorSpot`, `islandBounds`, `computeBeams`, `centerOn`, `zoomAt`, `nextZoom`, `visibleRect` sont identiques entre leur définition et leurs usages.
