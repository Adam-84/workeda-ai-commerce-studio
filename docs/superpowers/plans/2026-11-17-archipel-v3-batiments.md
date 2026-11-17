# Archipel v3, chantier A : bâtiments fermés et îles volantes (plan d'implémentation)

> **Pour les agents qui exécutent ce plan :** SOUS-SKILL REQUISE : utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**Objectif :** remplacer la carte actuelle (pièces ouvertes, agents à leur bureau) par des îles volantes en pixel art pur, chacune portant un bâtiment fermé propre à son métier, avec des signes d'activité, des télécabines et des mini-passants.

**Architecture :**
- Tout se dessine en pixels « natifs » (la taille de la maquette) dans des caches par île, puis s'affiche agrandi ×3 (`K = 3`) sans lissage.
- Les primitives pixel vont dans `iso.js` (déjà présent).
- Trois fichiers séparés, purs et testables :
  - `buildings.js` : les bâtiments ;
  - `skyworld.js` : le ciel et les télécabines ;
  - `miniGrid` dans `sprites.js` : les mini-passants.
- `world.js` assemble les îles ; `app.js` gère les caches, l'animation et les boutons HTML.

**Pile technique :** Node ≥ 24 (`node:sqlite`, `node:test`), JavaScript ES modules dans le navigateur, Canvas 2D, aucune dépendance npm.

**Spec :** `docs/superpowers/specs/2026-11-17-archipel-v3-batiments-design.md`. Référence visuelle : `docs/maquettes/v3-archipel.html` (mode « Îles volantes », palette « Lagon ») et `docs/maquettes/v3-personnages.html`.

## Contraintes globales

- Aucun anticrénelage : tout remplissage passe par `fillRect` avec des coordonnées et tailles entières. `globalAlpha` n'est permis que pour les halos (`glow`) et les nuages (`cloud`).
- Lumière en haut à gauche. Face droite = `hs(couleur, -0.22)`. Contours `#2a2033` (`OL`) seulement sur les bâtiments, les objets et les personnages.
- Une couleur préfixée par `!` est une source lumineuse : elle n'est jamais teintée par le moment de la journée (`lightable`).
- Échelle native : 1 étage = 8 px, île `R = 84`, place centrale `R = 110`, bord `CL = 6`, mini-passant 6×11 (8×13 avec contour). `K = 3`.
- `ZOOMS = [1/3, 2/3, 1, 4/3, 2]` : chaque `zoom × K` est un entier.
- Textes visibles en français. Tous les éléments cliquables sont des `<button>` avec un `aria-label`.
- Pas de nouvelle dépendance. Les tests se lancent avec `npm test` (`node --test`).

## Écarts assumés par rapport à la spec

1. La spec prévoyait un fichier `public/pixel.js`. Ces primitives vont dans **`public/iso.js`**, qui contient déjà `fillPoly`, `line`, `disc`, `mix` et `tinter`. Les tests prévus pour `pixel.test.js` gardent ce nom.
2. Les caches d'îles sont **reconstruits à chaque `refresh()`**, comme aujourd'hui. Ils sont donc à jour quand l'activité ou un statut bloqué change, sans détection fine.
3. Les tests de l'API des styles vont dans `test/island-api.test.js`, qui existe déjà, et non dans `server.test.js`.
4. L'emblème va toujours sur une plaque fixée près de la porte (règle unique pour les 9 types), au lieu d'être peint sur l'enseigne quand il y en a une.
5. Les portes font 10 à 11 px (au lieu d'« environ 12 ») pour ne pas recouvrir le premier étage de fenêtres.

---

## Avant la tâche 1 (prérequis)

`public/app.js` et `public/style.css` contiennent des modifications non commitées d'une session précédente (animations des menus). **Demander à l'utilisateur** l'autorisation de les commiter à part, avant toute tâche, avec ce message :

```bash
git add public/app.js public/style.css
git commit -m "feat: animations des menus et de l'interface"
```

Ne pas toucher à `docs/maquettes/v3-personnages-anime.html` (fichier non suivi, d'origine inconnue).

---

### Tâche 1 : primitives pixel et couleur dans `iso.js`

**Fichiers :**
- Modifier : `public/iso.js`
- Créer : `test/pixel.test.js`

**Interfaces :**
- Produit :
  - `rng(seed) → () => nombre dans [0, 1[` ;
  - `hs(couleur, k) → '#rrggbb'` ;
  - `lightable(C) → (c) => couleur` ;
  - `polyDither(ctx, pts, couleur)` ;
  - `ell(ctx, cx, cy, rx, ry, couleur)` ;
  - `glow(ctx, x, y, r, couleur, alpha = 0.6)` ;
  - `inDia(x, y, cx, cy, R) → booléen` ;
  - `pen(ctx, C = identité) → p`, où `p` vaut `{ ctx, C, rect(x, y, w, h, c), pix(x, y, c), poly(pts, c), dither(pts, c), line(x0, y0, x1, y1, c), ell(cx, cy, rx, ry, c), glow(x, y, r, c, a) }`. Chaque couleur passe par `lightable(C)`, sauf pour `glow`, qui reçoit une couleur brute.

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
// test/pixel.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillPoly, polyDither, diamondPts, hs, lightable, ell, rng, pen, inDia } from '../public/iso.js';

const fake = () => { const rects = []; let c; return { rects, set fillStyle(v) { c = v; }, get fillStyle() { return c; }, globalAlpha: 1, save() {}, restore() {}, fillRect(x, y, w, h) { rects.push({ x, y, w, h, c }); } }; };
const area = (rects) => rects.reduce((s, r) => s + r.w * r.h, 0);
const hue = (c) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255), M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m; if (!d) return 0; const h = M === r ? (g - b) / d + (g < b ? 6 : 0) : M === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
const lum = (c) => [1, 3, 5].reduce((s, i) => s + parseInt(c.slice(i, i + 2), 16), 0);
const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('un losange 2:1 de rayon 8 couvre exactement 64 pixels entiers', () => {
  const ctx = fake(); fillPoly(ctx, diamondPts(10, 10, 8), '#ff0000');
  assert.equal(area(ctx.rects), 64);
  assert.ok(ctx.rects.every((r) => [r.x, r.y, r.w, r.h].every(Number.isInteger)));
});

test('la trame couvre un pixel sur deux du même losange', () => {
  const ctx = fake(); polyDither(ctx, diamondPts(10, 10, 8), '#ff0000');
  assert.equal(area(ctx.rects), 32);
});

test('hs assombrit vers le bleu-violet, éclaircit vers le jaune, ne teinte pas les gris', () => {
  const g = '#5fb04a', dark = hs(g, -0.3), light = hs(g, 0.3);
  assert.ok(lum(dark) < lum(g) && lum(light) > lum(g));
  assert.ok(angle(hue(dark), 250) < angle(hue(g), 250));
  assert.ok(angle(hue(light), 55) < angle(hue(g), 55));
  const grey = hs('#808080', -0.3); assert.equal(grey.slice(1, 3), grey.slice(3, 5)); assert.equal(grey.slice(3, 5), grey.slice(5, 7));
  assert.equal(hs(g, -0.3), dark); // mémoïsé, stable
});

test('lightable : « ! » = lumière jamais teintée', () => {
  const C = lightable(() => '#000000');
  assert.equal(C('!#ffcf5c'), '#ffcf5c'); assert.equal(C('#123456'), '#000000');
});

test('ell, pen et rng', () => {
  const ctx = fake(); ell(ctx, 20, 20, 6, 3, '#00ff00');
  assert.ok(ctx.rects.every((r) => Number.isInteger(r.x) && r.x >= 14 && r.x + r.w <= 27 && r.y >= 17 && r.y <= 23));
  const c2 = fake(), p = pen(c2, (c) => '#111111'); p.rect(1.4, 2.6, 3, 1, '#abcdef'); p.rect(0, 0, 1, 1, '!#ffffff');
  assert.deepEqual(c2.rects.map((r) => [r.x, r.y, r.c]), [[1, 3, '#111111'], [0, 0, '#ffffff']]);
  const a = rng(7), b = rng(7); assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.ok(inDia(10, 10, 10, 10, 8) && !inDia(19, 10, 10, 10, 8));
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node --test test/pixel.test.js`
Attendu : ÉCHEC (`polyDither` / `hs` non exportés).

- [ ] **Étape 3 : implémenter dans `public/iso.js`**

Remplacer `fillPoly` par une version qui partage le balayage, puis ajouter les nouvelles fonctions à la fin du fichier :

```js
/** Lignes d'un polygone (balayage, règle pair-impair) : cb(x, y, largeur) avec des entiers. */
function scanRows(pts, cb) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y < y1; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc) !== (by <= yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.round(xs[k]), b = Math.round(xs[k + 1]); if (b > a) cb(a, y, b - a); }
  }
}
/** Polygone rempli au pixel près. */
export function fillPoly(ctx, pts, color) { ctx.fillStyle = color; scanRows(pts, (x, y, w) => ctx.fillRect(x, y, w, 1)); }
/** Même polygone, un pixel sur deux (trame en damier). */
export function polyDither(ctx, pts, color) { ctx.fillStyle = color; scanRows(pts, (x, y, w) => { for (let i = 0; i < w; i++) if (((x + i + y) & 1) === 0) ctx.fillRect(x + i, y, 1, 1); }); }

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const toHsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const M = Math.max(r, g, b), m = Math.min(r, g, b), l = (M + m) / 2; if (M === m) return [0, 0, l]; const d = M - m, s = l > 0.5 ? d / (2 - M - m) : d / (M + m); const h = M === r ? (g - b) / d + (g < b ? 6 : 0) : M === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l]; };
const fromHsl = (h, s, l) => { h = ((h % 360) + 360) % 360; const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2; const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; };
const hsMemo = new Map();
/** Ombre (k < 0) tirée vers le bleu-violet 250°, lumière (k > 0) vers le jaune 55° ; les gris gardent leur teinte. */
export function hs(c, k) {
  const key = c + k; if (hsMemo.has(key)) return hsMemo.get(key);
  let [h, s, l] = toHsl(rgb(c)); const grey = s <= 0.04;
  if (!grey) { const target = k < 0 ? 250 : 55; h += (((target - h + 540) % 360) - 180) * Math.min(1, Math.abs(k)) * 0.35; s = Math.max(0, Math.min(1, s + (k < 0 ? 0.05 : -0.03))); }
  l = Math.max(0, Math.min(1, l + k * 0.5));
  const v = hex(fromHsl(h, s, l)); hsMemo.set(key, v); return v;
}
/** Couleurs « !#rrggbb » = sources lumineuses, jamais teintées. */
export const lightable = (C) => (c) => (c[0] === '!' ? c.slice(1) : C(c));
export function ell(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color;
  for (let dy = -ry; dy <= ry; dy++) { const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2))); ctx.fillRect(Math.round(cx - hw), Math.round(cy + dy), hw * 2 + 1, 1); }
}
/** Halo tramé (couleur brute) : plein au centre, de plus en plus clairsemé. */
export function glow(ctx, x, y, r, color, alpha = 0.6) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const d = Math.hypot(dx, dy * 1.6) / r; if (d > 1) continue;
    const X = Math.round(x + dx), Y = Math.round(y + dy);
    if (d < 0.45 ? ((X + Y) & 1) === 0 : d < 0.8 ? (X & 1) === 0 && (Y & 1) === 0 : X % 3 === 0 && Y % 2 === 0) ctx.fillRect(X, Y, 1, 1);
  }
  ctx.restore();
}
export const inDia = (x, y, cx, cy, R) => Math.abs(x - cx) / R + Math.abs(y - cy) / (R / 2) <= 1;
/** Pinceau lié à un contexte et à une teinte : coordonnées arrondies, couleurs passées par lightable(C). */
export function pen(ctx, C = (c) => c) {
  const col = lightable(C);
  const p = {
    ctx, C,
    rect: (x, y, w, h, c) => { ctx.fillStyle = col(c); ctx.fillRect(Math.round(x), Math.round(y), w, h); },
    pix: (x, y, c) => p.rect(x, y, 1, 1, c),
    poly: (pts, c) => fillPoly(ctx, pts, col(c)),
    dither: (pts, c) => polyDither(ctx, pts, col(c)),
    line: (x0, y0, x1, y1, c) => line(ctx, x0, y0, x1, y1, col(c)),
    ell: (cx, cy, rx, ry, c) => ell(ctx, cx, cy, rx, ry, col(c)),
    glow: (x, y, r, c, a) => glow(ctx, x, y, r, c, a)
  };
  return p;
}
```

- [ ] **Étape 4 : lancer tous les tests**

Lancer : `npm test`
Attendu : `test/pixel.test.js` et `test/iso.test.js` passent. Les autres tests ne changent pas.

- [ ] **Étape 5 : commiter**

```bash
git add public/iso.js test/pixel.test.js
git commit -m "feat(iso): primitives pixel (trame, ellipse, halo, teinte décalée, pinceau)"
```

---

### Tâche 2 : choix du bâtiment dans les données et l'API

**Fichiers :**
- Modifier : `public/island-style.js`, `src/studio.js`
- Tester : `test/island-style.test.js`, `test/studio.test.js`, `test/island-api.test.js`

**Interfaces :**
- Produit :
  - `OPTIONS.building` (liste de 9 clés) et `LABELS_FR.building` ;
  - `STYLE_FIELDS` inclut `'building'` ;
  - `applyStyle(identity, style).building` vaut une clé valide, sinon `identity.building`, sinon `'bureaux'` ;
  - les objets renvoyés par l'API ont `building` (chaîne ou `null`).

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `test/island-style.test.js`, ajouter :

```js
test('building : 9 types valides, inconnu refusé, repli sur le défaut', () => {
  assert.deepEqual(OPTIONS.building, ['siege', 'entrepot', 'atelier', 'panneau', 'accueil', 'hangar', 'tour', 'labo', 'bureaux']);
  assert.equal(isValidIslandStyle({ building: 'tour' }), true);
  assert.equal(isValidIslandStyle({ building: 'chateau' }), false);
  assert.equal(applyStyle({ ...base, building: 'siege' }, { building: 'tour' }).building, 'tour');
  assert.equal(applyStyle({ ...base, building: 'siege' }, { building: 'chateau' }).building, 'siege');
  assert.equal(applyStyle(base, null).building, 'bureaux');
});
```

Toujours dans `test/island-style.test.js`, dans le test « every option has a French label », remplacer `for (const k of ['tree', 'emblem'])` par `for (const k of ['tree', 'emblem', 'building'])`.

Dans `test/studio.test.js`, ajouter (en tête : `import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { DatabaseSync } from 'node:sqlite';`) :

```js
test('une ancienne base sans colonne building est migrée sans perte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-')), file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE island_styles (department_id TEXT PRIMARY KEY REFERENCES departments(id), label TEXT, accent TEXT, floor TEXT, wall TEXT, emblem TEXT, tree TEXT, ground TEXT, lanterns INTEGER, updated_at TEXT NOT NULL);
      INSERT INTO departments VALUES ('d1', 'Direction', 'x', 1, '2026-01-01');
      INSERT INTO island_styles VALUES ('d1', 'Pilotage', 'teal', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01');`);
    old.close();
    const s = createStudio(file);
    const [row] = s.listIslandStyles();
    assert.deepEqual([row.label, row.accent, row.building], ['Pilotage', 'teal', null]);
    assert.equal(s.setIslandStyle('d1', { building: 'tour' }).building, 'tour');
    s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Dans `test/island-api.test.js`, ajouter :

```js
test('building est enregistré par l’API ; une valeur inconnue est refusée', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const ok = await call('PUT', `/api/departments/${dept.id}/style`, { building: 'tour' });
  assert.equal(ok.status, 200); assert.equal(ok.data.building, 'tour');
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { building: 'chateau' })).status, 400);
  assert.equal((await call('GET', '/api/island-styles')).data[0].building, 'tour');
}));
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node --test test/island-style.test.js test/studio.test.js test/island-api.test.js`
Attendu : ÉCHEC (`OPTIONS.building` est indéfini ; colonne `building` absente).

- [ ] **Étape 3 : implémenter `public/island-style.js`**

Dans `OPTIONS`, après `emblem`, ajouter :
```js
  building: Object.freeze(['siege', 'entrepot', 'atelier', 'panneau', 'accueil', 'hangar', 'tour', 'labo', 'bureaux'])
```
Remplacer `STYLE_FIELDS` par :
```js
export const STYLE_FIELDS = Object.freeze(['label', 'accent', 'floor', 'wall', 'emblem', 'tree', 'ground', 'lanterns', 'building']);
```
Dans `LABELS_FR`, ajouter :
```js
  building: { siege: 'Siège', entrepot: 'Entrepôt', atelier: 'Atelier loft', panneau: 'Immeuble à panneau', accueil: 'Accueil', hangar: 'Hangar technique', tour: 'Tour vitrée', labo: 'Labo à dôme', bureaux: 'Bureaux modernes' }
```
Dans `isValidIslandStyle`, remplacer `okList('tree') && okList('emblem')` par `okList('tree') && okList('emblem') && okList('building')`.
Dans `applyStyle`, ajouter dans l'objet renvoyé :
```js
    building: OPTIONS.building.includes(s.building) ? s.building : identity.building || 'bureaux',
```

- [ ] **Étape 4 : implémenter `src/studio.js`**

1. Dans le `CREATE TABLE IF NOT EXISTS island_styles`, ajouter `building TEXT,` avant `updated_at`.
2. Juste après le `db.exec(...)` de création des tables, ajouter la migration :
```js
  const styleCols = db.prepare('PRAGMA table_info(island_styles)').all().map((c) => c.name);
  if (!styleCols.includes('building')) {
    try { db.exec('ALTER TABLE island_styles ADD COLUMN building TEXT'); }
    catch (e) { throw new Error(`Migration de la table island_styles impossible : ${e.message}`); }
  }
```
3. `mapIslandStyle` : ajouter `building: r.building ?? null,` avant `updatedAt`.
4. `setIslandStyle` : ajouter la colonne dans l'INSERT et l'UPDATE :
```js
      db.prepare(`INSERT INTO island_styles (department_id, label, accent, floor, wall, emblem, tree, ground, lanterns, building, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(department_id) DO UPDATE SET label = excluded.label, accent = excluded.accent, floor = excluded.floor, wall = excluded.wall, emblem = excluded.emblem, tree = excluded.tree, ground = excluded.ground, lanterns = excluded.lanterns, building = excluded.building, updated_at = excluded.updated_at`)
        .run(departmentId, s.label, s.accent, s.floor, s.wall, s.emblem, s.tree, s.ground, s.lanterns === null ? null : Number(s.lanterns), s.building, now());
```

- [ ] **Étape 5 : lancer tous les tests**

Lancer : `npm test`
Attendu : tout passe.

- [ ] **Étape 6 : commiter**

```bash
git add public/island-style.js src/studio.js test/island-style.test.js test/studio.test.js test/island-api.test.js
git commit -m "feat(styles): choix du bâtiment par île, migration de la base existante"
```

---

### Tâche 3 : les 9 bâtiments (`buildings.js`)

**Fichiers :**
- Créer : `public/buildings.js`, `test/buildings.test.js`

**Interfaces :**
- Consomme (tâche 1) : `OL`, `hs`, `rng`, `pen` (le pinceau `p`).
- Produit :
  - `TYPES[type] = { a, b, h, roof, door: [k, w, h], draw(p, B, o) }` pour les 9 clés de `OPTIONS.building` ;
  - `B = { x, y, a, b, h }` : coin avant au sol, en pixels natifs ;
  - `o = { accent, seed, lit, glow, emblem, blinks: [], smoke: [] }`, avec `lit` dans [0, 1] (seuil d'allumage des fenêtres) et `glow` (soir/nuit : porte, enseignes et couronnes éclairées) ;
  - `door(p, B, T.door, o) → [x, y]` (point natif du gyrophare) ;
  - `YARDS[type](p, x, y, o) → [{ y, d() }]` ;
  - `extentOf(B, T) → { x0, x1, y0, y1 }` ;
  - `fr`, `box`, `mat`, `shadow`, `roofPt`, `bench`, `LIT`.

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
// test/buildings.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, YARDS, door, extentOf, LIT } from '../public/buildings.js';
import { OPTIONS } from '../public/island-style.js';
import { pen } from '../public/iso.js';

const rec = () => { const calls = []; let c; return { calls, ctx: { set fillStyle(v) { c = v; }, get fillStyle() { return c; }, globalAlpha: 1, save() {}, restore() {}, fillRect(x, y, w, h) { calls.push([x, y, w, h, c]); } } }; };
const opts = (over = {}) => ({ accent: '#ff6f5c', seed: 42, lit: 0, glow: false, emblem: null, blinks: [], smoke: [], ...over });
const place = (T) => ({ x: 200, y: 200, a: T.a, b: T.b, h: T.h });

test('chaque type de bâtiment existe, se dessine dans son emprise et a sa cour', () => {
  assert.deepEqual(Object.keys(TYPES).sort(), [...OPTIONS.building].sort());
  for (const [key, T] of Object.entries(TYPES)) {
    const { calls, ctx } = rec(), p = pen(ctx), B = place(T), o = opts({ glow: true, lit: 1, emblem: 'crown' });
    T.draw(p, B, o); door(p, B, T.door, o);
    const e = extentOf(B, T);
    assert.ok(calls.length > 200, key);
    for (const [x, y, w, h] of calls) assert.ok(x >= e.x0 && x + w <= e.x1 && y >= e.y0 && y + h <= e.y1, `${key} déborde : ${[x, y, w, h]}`);
    const items = YARDS[key](p, 100, 100, o); assert.ok(items.length >= 1, key); items.forEach((it) => it.d());
  }
});

test('même seed, même dessin', () => {
  for (const T of Object.values(TYPES)) {
    const a = rec(), b = rec(); T.draw(pen(a.ctx), place(T), opts()); T.draw(pen(b.ctx), place(T), opts());
    assert.deepEqual(a.calls, b.calls);
  }
});

test('plus d’activité allume plus de fenêtres, jamais moins', () => {
  for (const [key, T] of Object.entries(TYPES)) {
    const count = (lit) => { const r = rec(); T.draw(pen(r.ctx), place(T), opts({ lit })); return r.calls.filter((c) => LIT.includes(c[4])).length; };
    const n = [0, 0.2, 0.5, 0.9].map(count);
    assert.equal(n[0], 0, key);
    assert.ok(n[1] <= n[2] && n[2] <= n[3] && n[3] > 0, `${key} : ${n}`);
  }
});

test('la porte est sur la face droite et le gyrophare au-dessus', () => {
  const T = TYPES.siege, B = place(T), [ax, ay] = door(pen(rec().ctx), B, T.door, opts());
  assert.ok(ax > B.x && ay < B.y - T.door[2]);
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node --test test/buildings.test.js`
Attendu : ÉCHEC (module introuvable).

- [ ] **Étape 3 : implémenter `public/buildings.js`**

Ce code est le portage des fonctions de `docs/maquettes/v3-archipel.html`. Changements par rapport à la maquette : contexte passé en paramètre (`p`), `o.lit` au lieu de `rate × LL`, `o.glow` au lieu de `LL > .3`, portes de 10 à 11 px, nouveau type `bureaux`, plaque d'emblème.

```js
// public/buildings.js — les 9 bâtiments métier et leurs cours, en pixels natifs (pur, sans DOM).
// p = pinceau de iso.js ; B = { x, y, a, b, h } coin avant au sol ; o = { accent, seed, lit, glow, emblem, blinks, smoke }.
import { OL, hs, rng } from './iso.js';
import { drawEmblem } from './emblems.js';

export const LIT = Object.freeze(['#ffcf5c', '#ffe9a8', '#bfe4ff']);
const GLASS = '#7fb6d9', LEAF = '#3f9a45', LEAF_L = '#72c95c', GRASS_D = '#3d8a3c', STONE = '#e4d8bf';
const side = (B, s) => (s === 'L' ? B.a : B.b);
const lit = (o, v) => (v < o.lit ? (v < o.lit * 0.3 ? '!' + LIT[1] : '!' + LIT[0]) : null);

/** Rectangle posé sur une face : c0 colonnes depuis l'arête avant, r rangées au-dessus du sol. */
export function fr(p, B, s, c0, r, w, h, c) { for (let i = 0; i < w; i++) { const k = c0 + i; p.rect(s === 'L' ? B.x - 1 - k : B.x + k, B.y - Math.floor(k / 2) - r - h, 1, h, c); } }
export const topPts = (B, up = 0) => { const { x, y, a, b, h } = B, Y = y - h - up; return [[x, Y], [x - a, Y - a / 2], [x + b - a, Y - (a + b) / 2], [x + b, Y - b / 2]]; };
const topInset = (B, d) => { const { x, y, a, b, h } = B, Y = y - h; return [[x, Y - d], [x - a + 2 * d, Y - a / 2], [x + b - a, Y - (a + b) / 2 + d], [x + b - 2 * d, Y - b / 2]]; };
export const roofPt = (B, s, t) => [Math.round(B.x - B.a * s + B.b * t), Math.round(B.y - B.h - (B.a * s) / 2 - (B.b * t) / 2)];
export const mat = (c, top) => ({ left: c, right: hs(c, -0.22), top: top || hs(c, 0.14) });
export function box(p, B, m) {
  fr(p, B, 'L', 0, -1, B.a + 1, B.h + 2, OL); fr(p, B, 'R', 0, -1, B.b + 1, B.h + 2, OL); p.poly(topPts(B, 1), OL);
  p.poly(topPts(B), m.top); fr(p, B, 'L', 0, 0, B.a, B.h, m.left); fr(p, B, 'R', 0, 0, B.b, B.h, m.right);
  fr(p, B, 'L', 0, B.h - 1, B.a, 1, hs(m.left, 0.1)); fr(p, B, 'R', 0, 0, 1, B.h, hs(m.right, 0.12));
}
/** Ombre portée dans l'axe de la face gauche (lumière en haut à gauche). */
export function shadow(p, B, ground) { const sh = Math.min(22, Math.round(B.h * 0.3)), { x, y, a, b } = B; p.poly([[x - a, y - a / 2], [x + sh, y + sh / 2], [x + b + sh, y - b / 2 + sh / 2], [x + b - a, y - (a + b) / 2]], ground); }
export const extentOf = (B, T) => ({ x0: B.x - B.a - 4, x1: B.x + B.b + 4, y0: Math.floor(B.y - B.h - (B.a + B.b) / 2 - T.roof - 1), y1: B.y + 2 });
const parapet = (p, B, c) => p.poly(topInset(B, 2), c);

function punched(p, B, s, o, { start = 1, floors, fh = 8, ww = 3, wh = 4, gap = 3, off = 3, glass = GLASS, sill, salt = 0 }) {
  const W = side(B, s), r = rng(o.seed + salt + (s === 'L' ? 11 : 97)), gl = s === 'L' ? glass : hs(glass, -0.22);
  for (let f = start; f < floors; f++) for (let k = off; k + ww <= W - 2; k += ww + gap) {
    const row = f * fh + 2, on = lit(o, r());
    fr(p, B, s, k, row - 1, ww, 1, sill ? (s === 'L' ? sill : hs(sill, -0.22)) : hs(gl, -0.3));
    fr(p, B, s, k, row, ww, wh, on || gl);
    if (!on) fr(p, B, s, s === 'L' ? k + ww - 1 : k, row + wh - 1, 1, 1, hs(gl, 0.28));
  }
}
function ribbon(p, B, s, o, { start = 1, floors, fh = 8, bandH = 4, glass = GLASS, mull = '#5d6b7a', mstep = 5, base = 2, salt = 0 }) {
  const W = side(B, s), r = rng(o.seed + salt + (s === 'L' ? 3 : 7)), gl = s === 'L' ? glass : hs(glass, -0.22), mu = s === 'L' ? mull : hs(mull, -0.22);
  for (let f = start; f < floors; f++) {
    const row = f * fh + base;
    for (let k = 2; k < W - 2; k += mstep) {
      const w = Math.min(mstep - 1, W - 2 - k), on = lit(o, r());
      fr(p, B, s, k, row, w, bandH, on || gl);
      if (!on && w >= 2) fr(p, B, s, s === 'L' ? k + w - 2 : k, row + bandH - 1, 2, 1, hs(gl, 0.25));
      if (k + w < W - 2) fr(p, B, s, k + w, row, 1, bandH, mu);
    }
    fr(p, B, s, 2, row - 1, W - 4, 1, mu);
  }
}
function curtain(p, B, s, o, { fh = 8, top, glass, frame }) {
  const W = side(B, s), r = rng(o.seed + (s === 'L' ? 5 : 9)), gl = s === 'L' ? glass : hs(glass, -0.22);
  fr(p, B, s, 0, fh, W, top - fh, s === 'L' ? frame : hs(frame, -0.2));
  for (let f = 1; f * fh + fh <= top; f++) for (let ci = 0, k = 1; k + 3 <= W; ci++, k += 4) {
    const v = r(), on = v < o.lit ? (v < o.lit * 0.3 ? '!' + LIT[0] : '!' + LIT[2]) : null;
    fr(p, B, s, k, f * fh + 1, 3, fh - 2, on || ((ci + f * 2) % 9 < 2 ? hs(gl, 0.2) : gl));
  }
}
function sign(p, B, s, k, w, row, bg, seed, glow) { const r = rng(seed); fr(p, B, s, k - 1, row - 1, w + 2, 6, '#3a3540'); fr(p, B, s, k, row, w, 4, bg); for (let i = 1; i < w - 1; i++) if (i % 4 !== 0) fr(p, B, s, k + i, row + 1 + (r() < 0.5 ? 0 : 1), 1, 1, glow ? '!#fff6e0' : '#fff6e0'); }
function awning(p, B, s, k, w, row, c) { fr(p, B, s, k, row - 1, w, 1, hs(c, -0.4)); for (let i = 0; i < w; i++) fr(p, B, s, k + i, row, 1, 3, i % 2 ? '#fff6e0' : s === 'L' ? c : hs(c, -0.2)); }
const ac = (p, x, y) => { box(p, { x, y, a: 5, b: 4, h: 3 }, mat('#c9ced6')); p.pix(x, y - 5, '#7a8090'); };

/** Porte sur la face droite (+ plaque d'emblème) ; renvoie le point du gyrophare. */
export function door(p, B, [k, w, h], o) {
  fr(p, B, 'R', k - 1, 0, w + 2, h + 1, '#3a3540'); fr(p, B, 'R', k, 0, w, h, o.glow ? '!' + LIT[0] : '#5a3a2a'); fr(p, B, 'R', k + w - 1, Math.floor(h / 2), 1, 1, '#f2c14e');
  if (o.emblem) { // plaque à droite de la porte, ou à gauche si la porte est au bord (hangar)
    const x = k + w + 12 <= B.b ? B.x + k + w + 2 : B.x + k - 12, y = B.y - Math.floor(k / 2) - h - 14;
    p.rect(x - 1, y - 1, 11, 11, OL); p.rect(x, y, 9, 9, '#fff6e0'); drawEmblem(p.ctx, o.emblem, x, y, p.C(o.accent));
  }
  return [B.x + k + Math.floor(w / 2), B.y - Math.floor((k + w / 2) / 2) - h - 3];
}

export const TYPES = Object.freeze({
  siege: { a: 34, b: 34, h: 54, roof: 18, door: [15, 4, 11], draw(p, B, o) {
    const st = '#e8dcc2'; box(p, B, mat(st, '#d0c2a4')); parapet(p, B, '#bba98a');
    for (const s of ['L', 'R']) punched(p, B, s, o, { floors: 6, ww: 3, wh: 5, gap: 3, sill: '#fff6e4' });
    fr(p, B, 'R', 4, 0, B.b - 8, 10, hs(st, -0.45)); for (let k = 5; k < B.b - 5; k += 4) if (k < 13 || k > 19) fr(p, B, 'R', k, 0, 2, 10, '#fbf3e2');
    fr(p, B, 'R', 3, 10, B.b - 6, 2, hs(st, -0.08));
    for (let k = 4; k + 5 < B.a - 2; k += 8) fr(p, B, 'L', k, 2, 5, 6, o.glow ? '!' + LIT[0] : GLASS);
    fr(p, B, 'L', 0, B.h - 5, B.a, 3, o.accent); fr(p, B, 'R', 0, B.h - 5, B.b, 3, hs(o.accent, -0.22));
    const [sx, sy] = roofPt(B, 0.35, 0.6); box(p, { x: sx, y: sy, a: 7, b: 7, h: 4 }, { top: '#9fd6f0', left: '#d0c2a4', right: hs('#d0c2a4', -0.22) });
    const [fx, fy] = roofPt(B, 0.7, 0.3); p.line(fx, fy, fx, fy - 16, '#4a4450'); p.rect(fx + 1, fy - 16, 6, 4, o.accent); p.rect(fx + 3, fy - 15, 1, 3, hs(o.accent, -0.25)); p.rect(fx + 6, fy - 16, 1, 3, hs(o.accent, -0.25));
  } },
  entrepot: { a: 50, b: 36, h: 26, roof: 2, door: [16, 3, 11], draw(p, B, o) {
    const m = '#c3ccd6'; box(p, B, mat(m, '#9aa6b4'));
    for (let k = 1; k < B.a; k += 3) fr(p, B, 'L', k, 0, 1, B.h - 3, hs(m, -0.1)); for (let k = 1; k < B.b; k += 3) fr(p, B, 'R', k, 0, 1, B.h - 3, hs(m, -0.32));
    fr(p, B, 'L', 0, B.h - 3, B.a, 2, o.accent); fr(p, B, 'R', 0, B.h - 3, B.b, 2, hs(o.accent, -0.22));
    for (const k of [3, 22]) { fr(p, B, 'R', k - 1, 2, 13, 16, '#3d4350'); fr(p, B, 'R', k, 3, 11, 14, '#5b6372'); for (let v = 4; v < 17; v += 2) fr(p, B, 'R', k, v, 11, 1, '#717a8a'); }
    fr(p, B, 'R', 1, 0, B.b - 2, 3, '#aaa69c'); for (let k = 1; k < B.b - 1; k++) fr(p, B, 'R', k, 2, 1, 1, k % 2 ? '#f2c14e' : '#2a2033');
    const r = rng(o.seed + 1); for (let k = 5; k < 27; k += 6) { const on = lit(o, r()); fr(p, B, 'L', k, 13, 4, 4, on || GLASS); }
    sign(p, B, 'L', 31, 14, 13, o.accent, o.seed, o.glow);
    for (const s of [0.25, 0.5, 0.75]) { const a = roofPt(B, s, 0.12), b = roofPt(B, s, 0.88); p.line(a[0], a[1], b[0], b[1], '#cfe9f5'); p.line(a[0], a[1] + 1, b[0], b[1] + 1, '#8fb8cf'); }
  } },
  atelier: { a: 36, b: 34, h: 34, roof: 13, door: [22, 4, 11], draw(p, B, o) {
    const br = '#b65a41'; box(p, B, mat(br, '#8c7a6a'));
    for (let v = 2; v < B.h - 1; v += 3) { fr(p, B, 'L', 0, v, B.a, 1, hs(br, -0.12)); fr(p, B, 'R', 0, v, B.b, 1, hs(br, -0.34)); }
    const r = rng(o.seed);
    for (const f of [11, 19, 27]) for (const s of ['L', 'R']) for (let k = 3; k + 7 <= side(B, s) - 1; k += 10) {
      const on = lit(o, r()), gl = s === 'L' ? '#86bede' : hs('#86bede', -0.22), fc = s === 'L' ? '#3a3540' : '#2a2530';
      fr(p, B, s, k - 1, f - 1, 8, 7, fc); fr(p, B, s, k, f, 6, 5, on || gl); fr(p, B, s, k + 3, f, 1, 5, fc); fr(p, B, s, k, f + 2, 6, 1, fc);
      if (!on) fr(p, B, s, s === 'L' ? k + 5 : k, f + 4, 1, 1, hs(gl, 0.3));
    }
    fr(p, B, 'L', 4, 2, B.a - 10, 6, o.glow ? '!' + LIT[0] : '#86bede'); awning(p, B, 'L', 3, B.a - 8, 8, o.accent);
    for (let k = B.a - 13, f = 10; f < 34; f += 8) { fr(p, B, 'L', k, f, 9, 1, OL); fr(p, B, 'L', k, f + 3, 1, 3, OL); fr(p, B, 'L', k + 8, f + 3, 1, 3, OL); fr(p, B, 'L', k, f + 5, 9, 1, OL); }
    for (const s of [0.8, 0.5, 0.2]) {
      const a = roofPt(B, s, 0.1), b = roofPt(B, s, 0.9), a2 = roofPt(B, s + 0.16, 0.1), b2 = roofPt(B, s + 0.16, 0.9);
      p.poly([[a[0], a[1] - 6], [b[0], b[1] - 6], b2, a2], '#a08e7c'); p.poly([a, b, [b[0], b[1] - 6], [a[0], a[1] - 6]], '#9fd6f0');
      p.line(a[0], a[1] - 6, b[0], b[1] - 6, OL); p.line(a[0], a[1] - 3, b[0], b[1] - 3, '#5d7a8a');
    }
    const [cx, cy] = roofPt(B, 0.12, 0.78); box(p, { x: cx, y: cy, a: 4, b: 4, h: 12 }, mat(br, '#3a3030'));
  } },
  panneau: { a: 36, b: 36, h: 40, roof: 24, door: [15, 5, 11], draw(p, B, o) {
    const w = '#eceff2'; box(p, B, mat(w, '#c9ced6')); parapet(p, B, '#b6bcc6');
    ribbon(p, B, 'L', o, { floors: 5 }); ribbon(p, B, 'R', o, { floors: 5 });
    fr(p, B, 'L', 2, 1, B.a - 4, 7, o.glow ? '!' + LIT[0] : '#3d5568'); fr(p, B, 'R', 2, 1, B.b - 4, 7, o.glow ? '!#f0b850' : '#33495a');
    for (let k = 5; k < B.a - 2; k += 6) fr(p, B, 'L', k, 1, 1, 7, '#5d6b7a');
    ac(p, ...roofPt(B, 0.25, 0.75)); ac(p, ...roofPt(B, 0.45, 0.8));
    const t = roofPt(B, 0.5, 0.1), BB = { x: t[0] + 2, y: t[1] - 4, a: 26, b: 0, h: 17 };
    for (const k of [3, 22]) { const X = BB.x - 1 - k, Y = BB.y - Math.floor(k / 2); p.line(X, Y, X, Y + 5, '#3a3540'); }
    fr(p, BB, 'L', 0, -1, 27, 19, OL); fr(p, BB, 'L', 1, 0, 25, 17, o.accent);
    fr(p, BB, 'L', 15, 4, 8, 9, '#fff6e0'); fr(p, BB, 'L', 17, 6, 4, 5, hs(o.accent, -0.2)); fr(p, BB, 'L', 3, 10, 10, 2, '#fff6e0'); fr(p, BB, 'L', 3, 6, 8, 2, '#fff6e0'); fr(p, BB, 'L', 3, 3, 6, 1, OL);
    if (o.glow) for (let k = 1; k < 26; k += 3) fr(p, BB, 'L', k, 17, 1, 1, '!#fff2b0');
  } },
  accueil: { a: 38, b: 36, h: 27, roof: 14, door: [15, 5, 10], draw(p, B, o) {
    const m = '#dcefe6'; box(p, B, mat(m, '#b9d3c8')); parapet(p, B, '#a7c2b6');
    const r = rng(o.seed);
    for (const s of ['L', 'R']) {
      const W = side(B, s); fr(p, B, s, 2, 1, W - 4, 8, o.glow ? (s === 'L' ? '!#ffd98a' : '!#f0c070') : s === 'L' ? '#a6dcf0' : '#82b8cf');
      for (let k = 7; k < W - 2; k += 6) fr(p, B, s, k, 1, 1, 8, '#5d6b7a');
      for (let i = 0; i < 4; i++) { const k = 4 + Math.floor(r() * (W - 10)); fr(p, B, s, k, 1, 1, 3, '#3a3540'); fr(p, B, s, k, 4, 1, 1, '#c98a62'); }
    }
    fr(p, B, 'L', 0, 10, B.a, 2, o.accent); fr(p, B, 'R', 0, 10, B.b, 2, hs(o.accent, -0.22)); sign(p, B, 'L', 8, 18, 12, o.accent, o.seed + 3, o.glow);
    for (const s of ['L', 'R']) for (let k = 3; k + 5 <= side(B, s) - 2; k += 8) for (const f of [15, 21]) { const on = lit(o, r()); fr(p, B, s, k, f - 1, 5, 1, '#ffffff'); fr(p, B, s, k, f, 5, 4, on || (s === 'L' ? GLASS : '#6390ad')); }
    const [dx, dy] = roofPt(B, 0.35, 0.6); p.line(dx, dy, dx, dy - 4, '#3a3540'); p.poly([[dx - 5, dy - 9], [dx + 2, dy - 12], [dx + 5, dy - 5], [dx - 2, dy - 3]], '#e4e8ee'); p.line(dx - 5, dy - 9, dx - 2, dy - 3, '#aab3bf'); p.line(dx, dy - 7, dx + 4, dy - 11, '#3a3540');
    ac(p, ...roofPt(B, 0.7, 0.3));
    const [ax, ay] = roofPt(B, 0.2, 0.2); p.line(ax, ay, ax, ay - 10, '#4a4450'); o.blinks.push([ax, ay - 11]);
  } },
  hangar: { a: 46, b: 40, h: 24, roof: 22, door: [36, 3, 11], draw(p, B, o) {
    const m = '#cbbb9e'; box(p, B, mat(m, '#9e8f78'));
    for (let k = 1; k < B.a; k += 2) fr(p, B, 'L', k, 0, 1, B.h - 3, hs(m, -0.08)); for (let k = 1; k < B.b; k += 2) fr(p, B, 'R', k, 0, 1, B.h - 3, hs(m, -0.3));
    fr(p, B, 'L', 0, B.h - 3, B.a, 2, o.accent); fr(p, B, 'R', 0, B.h - 3, B.b, 2, hs(o.accent, -0.22));
    for (const [k, open] of [[3, false], [19, true]]) { fr(p, B, 'R', k - 1, 0, 15, 17, '#3d4350'); fr(p, B, 'R', k, 0, 13, 16, '#6a7080'); for (let v = 2; v < 16; v += 2) fr(p, B, 'R', k, v, 13, 1, '#7d8494'); if (open) { fr(p, B, 'R', k, 0, 13, 7, o.glow ? '!#e8b060' : '#2a2530'); fr(p, B, 'R', k + 3, 0, 3, 3, '#e8853d'); } }
    const r = rng(o.seed); for (let k = 4; k < B.a - 4; k += 7) { const on = lit(o, r()); fr(p, B, 'L', k, 15, 4, 3, on || GLASS); }
    const [cx, cy] = roofPt(B, 0.75, 0.3), CH = { x: cx, y: cy, a: 4, b: 4, h: 20 }; box(p, CH, mat('#b9b2a6', '#3a3030'));
    for (const v of [14, 10]) { fr(p, CH, 'L', 0, v, 4, 2, '#d9483a'); fr(p, CH, 'R', 0, v, 4, 2, '#a83a30'); }
    o.smoke.push([cx - 1, cy - 26]);
    for (const [s, t] of [[0.35, 0.55], [0.5, 0.3]]) { const [vx, vy] = roofPt(B, s, t); box(p, { x: vx, y: vy, a: 5, b: 5, h: 4 }, mat('#9aa0aa')); p.rect(vx - 2, vy - 7, 4, 1, '#5a6070'); }
  } },
  tour: { a: 26, b: 26, h: 100, roof: 22, door: [10, 5, 11], draw(p, B, o) {
    box(p, B, mat('#2c3e63', '#2f3550'));
    for (const s of ['L', 'R']) curtain(p, B, s, o, { top: B.h - 8, glass: '#5d9fe0', frame: '#2c3e63' });
    fr(p, B, 'L', 0, B.h - 7, B.a, 5, o.glow ? '!#5fd8ff' : '#3b9be0'); fr(p, B, 'R', 0, B.h - 7, B.b, 5, o.glow ? '!#3fb0e0' : '#2a78b8');
    fr(p, B, 'L', 2, 0, B.a - 4, 7, o.glow ? '!#ffe0a0' : '#a6dcf0'); fr(p, B, 'R', 2, 0, B.b - 4, 7, o.glow ? '!#e8c080' : '#82b8cf');
    parapet(p, B, '#262b40'); const [bx, by] = roofPt(B, 0.45, 0.45); box(p, { x: bx, y: by, a: 8, b: 8, h: 5 }, mat('#5a6280'));
    const [ax, ay] = roofPt(B, 0.55, 0.3); p.line(ax, ay, ax, ay - 20, '#8a90a0'); p.line(ax + 1, ay - 8, ax + 1, ay - 2, '#8a90a0'); o.blinks.push([ax, ay - 21]);
  } },
  labo: { a: 38, b: 36, h: 25, roof: 13, door: [15, 5, 11], draw(p, B, o) {
    const m = '#f1f3f5'; box(p, B, mat(m, '#d6dce2')); parapet(p, B, '#c4ccd4');
    for (const s of ['L', 'R']) ribbon(p, B, s, o, { start: 0, floors: 3, glass: '#a8e6ee', mull: '#8aa0a8', mstep: 6 });
    fr(p, B, 'L', 0, B.h - 3, B.a, 2, o.accent); fr(p, B, 'R', 0, B.h - 3, B.b, 2, hs(o.accent, -0.22));
    for (const t of [0.72, 0.86]) { const a = roofPt(B, 0.12, t), b = roofPt(B, 0.3, t), c = roofPt(B, 0.3, t + 0.1), d = roofPt(B, 0.12, t + 0.1); p.poly([a, d, c, b], '#2f4b7c'); p.line(a[0], a[1], b[0], b[1], '#6f8fc0'); }
    const [dx, dy] = roofPt(B, 0.55, 0.45), R = 10;
    for (let yy = -R; yy <= 3; yy++) { const t = yy <= 0 ? yy / R : yy / 4; if (Math.abs(t) > 1) continue; const hw = Math.round(R * Math.sqrt(1 - t * t)); for (let xx = -hw; xx <= hw; xx++) p.pix(dx + xx, dy + yy, xx < -R * 0.35 ? '#eef1f4' : xx > R * 0.3 ? '#a9b2bf' : '#cbd2db'); p.pix(dx - hw - 1, dy + yy, OL); p.pix(dx + hw + 1, dy + yy, OL); }
    p.rect(dx - 3, dy - R - 1, 7, 1, OL); p.rect(dx + 1, dy - R + 1, 2, R - 1, o.glow ? '!#9fe8ff' : OL);
  } },
  bureaux: { a: 36, b: 36, h: 34, roof: 6, door: [15, 5, 11], draw(p, B, o) {
    const w = '#e6e2da'; box(p, B, mat(w, '#cfcac0')); parapet(p, B, '#bdb7ab');
    ribbon(p, B, 'L', o, { floors: 4, salt: 1 }); ribbon(p, B, 'R', o, { floors: 4, salt: 1 });
    fr(p, B, 'L', 2, 1, B.a - 4, 7, o.glow ? '!' + LIT[0] : '#3d5568'); fr(p, B, 'R', 2, 1, B.b - 4, 7, o.glow ? '!#f0b850' : '#33495a');
    fr(p, B, 'R', 10, 12, 16, 2, o.accent);
    ac(p, ...roofPt(B, 0.3, 0.7)); ac(p, ...roofPt(B, 0.6, 0.4));
  } }
});

// ---------- cours ----------
export const bench = (p, x, y) => { p.rect(x - 3, y - 2, 6, 1, '#8a6240'); p.rect(x - 3, y - 3, 6, 1, '#a87a4a'); p.pix(x - 3, y - 1, '#3a3540'); p.pix(x + 2, y - 1, '#3a3540'); };
const crate = (p, x, y) => box(p, { x, y, a: 4, b: 4, h: 4 }, mat('#c99a5e', '#dcb27a'));
const car = (p, x, y, c) => { box(p, { x, y, a: 7, b: 4, h: 3 }, mat(c)); box(p, { x: x - 1, y: y - 3, a: 4, b: 3, h: 2 }, { top: hs(c, 0.14), left: '#9fd6f0', right: '#6fa6c8' }); };
const flowerbed = (p, x, y, seed) => { box(p, { x, y, a: 10, b: 5, h: 2 }, mat('#8a6a4a', GRASS_D)); const r = rng(seed); for (let i = 0; i < 9; i++) p.pix(x - 9 + Math.floor(r() * 12), y - 6 + Math.floor(r() * 4), ['#ff8fb0', '#fff6e0', '#f2c14e'][i % 3]); };
const barrel = (p, x, y, c) => { p.rect(x, y - 4, 3, 4, c); p.rect(x, y - 5, 3, 1, hs(c, 0.2)); p.rect(x + 2, y - 3, 1, 2, hs(c, -0.25)); };
const parasol = (p, x, y, c) => { p.rect(x, y - 7, 1, 7, '#5a4a40'); p.ell(x, y - 8, 5, 2, c); for (const d of [-3, 1]) p.pix(x + d, y - 8, '#fff6e0'); p.rect(x - 2, y - 2, 5, 1, '#c9b48f'); };
export const YARDS = Object.freeze({
  siege: (p, x, y, o) => [{ y, d: () => flowerbed(p, x, y, o.seed) }, { y: y + 9, d: () => flowerbed(p, x + 12, y + 9, o.seed + 1) }, { y: y + 2, d: () => { box(p, { x: x - 10, y: y + 2, a: 4, b: 4, h: 4 }, mat(STONE)); p.rect(x - 11, y - 9, 2, 5, '#8a6a3a'); p.pix(x - 11, y - 10, '#8a6a3a'); } }],
  entrepot: (p, x, y) => [{ y, d: () => { const V = { x, y, a: 10, b: 6, h: 6 }; box(p, V, mat('#f4f1ea')); fr(p, V, 'L', 0, 2, 10, 1, '#4f8fd9'); box(p, { x: x + 1, y: y - 6, a: 3, b: 6, h: 2 }, { top: '#e4e1da', left: '#9fd6f0', right: '#6fa6c8' }); } }, { y: y + 8, d: () => { crate(p, x + 14, y + 8); crate(p, x + 19, y + 10); crate(p, x + 16, y + 5); } }, { y: y + 12, d: () => { p.rect(x + 2, y + 10, 8, 1, '#a87a4a'); p.rect(x + 2, y + 11, 8, 1, '#8a6240'); } }],
  atelier: (p, x, y) => [{ y, d: () => { box(p, { x, y, a: 5, b: 5, h: 5 }, mat('#ff6f5c')); box(p, { x: x + 2, y: y - 5, a: 4, b: 4, h: 4 }, mat('#f2c14e')); box(p, { x: x - 1, y: y - 9, a: 3, b: 3, h: 3 }, mat('#4f8fd9')); } }, { y: y + 8, d: () => bench(p, x + 12, y + 8) }, { y: y + 10, d: () => { for (let i = 0; i < 4; i++) p.rect(x - 6 + i * 3, y + 7, 1, 3, '#3a3540'); p.rect(x - 6, y + 7, 10, 1, '#3a3540'); } }],
  panneau: (p, x, y, o) => [{ y, d: () => { const Q = { x, y, a: 6, b: 6, h: 9 }; box(p, Q, mat(o.accent)); fr(p, Q, 'L', 1, 2, 4, 5, '#fff6e0'); box(p, { x, y: y - 9, a: 7, b: 7, h: 1 }, mat('#3a3540')); } }, { y: y + 8, d: () => bench(p, x + 12, y + 8) }],
  accueil: (p, x, y, o) => [{ y, d: () => parasol(p, x, y, o.accent) }, { y: y + 7, d: () => parasol(p, x + 13, y + 7, o.accent) }, { y: y + 3, d: () => bench(p, x - 9, y + 3) }],
  hangar: (p, x, y, o) => [{ y, d: () => { const Cn = { x, y, a: 7, b: 18, h: 8 }; box(p, Cn, mat(o.accent)); for (let k = 1; k < 18; k += 2) fr(p, Cn, 'R', k, 0, 1, 8, hs(o.accent, -0.35)); } }, { y: y + 10, d: () => { barrel(p, x - 6, y + 10, '#4f8fd9'); barrel(p, x - 2, y + 11, '#4f8fd9'); barrel(p, x - 4, y + 13, '#d9483a'); } }, { y: y + 14, d: () => { p.pix(x + 8, y + 13, '#ff8a3d'); p.rect(x + 7, y + 14, 3, 1, '#ff8a3d'); } }],
  tour: (p, x, y) => [{ y: y - 2, d: () => { for (let i = 0; i < 3; i++) p.line(x - 6 + i * 8, y - 2 + i * 4, x + 2 + i * 8, y - 6 + i * 4, '#f4f1ea'); } }, { y, d: () => car(p, x + 2, y + 1, '#d9483a') }, { y: y + 4, d: () => car(p, x + 10, y + 5, '#f4f1ea') }],
  labo: (p, x, y) => [{ y, d: () => { const G = { x, y, a: 14, b: 12, h: 8 }; box(p, G, { top: '#dff5f8', left: '#bfeef6', right: '#94cdd8' }); for (let k = 2; k < 14; k += 3) fr(p, G, 'L', k, 0, 1, 8, '#ffffff'); for (let k = 2; k < 12; k += 3) fr(p, G, 'R', k, 0, 1, 8, '#e0f0f4'); } }, { y: y + 10, d: () => { for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) p.pix(x + 4 + i * 2 + row * 2, y + 6 - i + row * 3, i % 2 ? LEAF_L : LEAF); } }],
  bureaux: (p, x, y, o) => [{ y, d: () => flowerbed(p, x, y, o.seed) }, { y: y + 8, d: () => bench(p, x + 12, y + 8) }]
});
```

- [ ] **Étape 4 : lancer les tests**

Lancer : `node --test test/buildings.test.js`
Attendu : RÉUSSITE. Si un type déborde de `extentOf`, réduire le décor de toit en cause ou augmenter son `roof`. Ne jamais élargir la marge de 4 px.

- [ ] **Étape 5 : commiter**

```bash
git add public/buildings.js test/buildings.test.js
git commit -m "feat(buildings): 9 bâtiments métier en pixel art et leurs cours"
```

---

### Tâche 4 : ciel, nuages, télécabines (`skyworld.js`) et mini-passants (`miniGrid`)

**Fichiers :**
- Créer : `public/skyworld.js`, `test/skyworld.test.js`
- Modifier : `public/sprites.js`, `test/sprites.test.js`

**Interfaces :**
- Consomme : `pen` (le pinceau `p`), `mix`, `rng`, `hs`, `OL` (`iso.js`) ; `PALETTES` (`sky.js`).
- Produit :
  - `drawSky(p, phase, w, h)` ;
  - `cloud(p, phase, x, y, s, alpha = 1)` ;
  - `cableAt(route, u) → [x, y]` ;
  - `gondolaAt(route, t) → { x, y, moving }` ;
  - `drawCable(p, route)`, `drawCabin(p, x, y, color, glow)`, `drawGondola(p, route, t, glow)`, `drawBird(p, x, y, up)` ;
  - `SAG = 10`, `DWELL = 3`, `SPEED = 10` ;
  - une `route` vaut `{ id, color, from: [x, y], to: [x, y], offset }` en pixels natifs ;
  - `miniGrid(look, { dir: 'down' | 'up', frame: 0 | 1 | 2 }) → grille 13 × 8` (couleurs ou `null`), contour compris.

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
// test/skyworld.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawSky, cableAt, gondolaAt, DWELL, SPEED, SAG } from '../public/skyworld.js';
import { pen } from '../public/iso.js';

const rec = () => { const calls = []; let c; return { calls, ctx: { set fillStyle(v) { c = v; }, get fillStyle() { return c; }, globalAlpha: 1, save() {}, restore() {}, fillRect(x, y, w, h) { calls.push([x, y, w, h, c]); } } }; };

test('le ciel couvre toutes les rangées du canvas, à chaque moment', () => {
  for (const phase of ['morning', 'noon', 'evening', 'night']) {
    const { calls, ctx } = rec(); drawSky(pen(ctx), phase, 300, 200);
    const rows = new Set(); for (const [x, y, w, h] of calls) if (x === 0 && w === 300) for (let k = 0; k < h; k++) rows.add(y + k);
    assert.equal(rows.size, 200, phase);
    assert.ok(calls.every(([x, y, w, h]) => [x, y, w, h].every(Number.isInteger)), phase);
  }
});

test('la télécabine attend à la station, puis voyage sous le câble fléchi', () => {
  const route = { id: 'x', color: '#ff0000', from: [0, 0], to: [100, 0], offset: 0 };
  assert.deepEqual(gondolaAt(route, 0), { x: 0, y: 0, moving: false });
  const end = gondolaAt(route, DWELL + 100 / SPEED + 0.1); assert.equal(end.moving, false); assert.ok(Math.abs(end.x - 100) < 1e-9);
  const mid = gondolaAt(route, DWELL + 50 / SPEED); assert.equal(mid.moving, true); assert.ok(mid.y > SAG * 0.9);
  assert.deepEqual(cableAt(route, 0.5), [50, SAG]);
});
```

Dans `test/sprites.test.js`, ajouter (et ajouter `miniGrid` à l'import existant depuis `../public/sprites.js`) :

```js
test('mini-passant 6×11 : contour, déterministe, de dos sans visage, jambes qui bougent', () => {
  const look = { hairStyle: 'bun', hairColor: '#d79a4a', skin: '#f8d6b8', eyes: '#3a9a6a', outfit: 'labcoat', topColor: '#8ac23a', accessory: 'headset' };
  const g = miniGrid(look);
  assert.equal(g.length, 13); assert.ok(g.every((r) => r.length === 8));
  assert.ok(g.flat().includes('#2a2033'));
  assert.deepEqual(miniGrid(look), g);
  const skin = (grid) => grid.flat().filter((c) => c === look.skin).length;
  assert.ok(skin(miniGrid(look, { dir: 'up' })) < skin(g));
  assert.notDeepEqual(miniGrid(look, { frame: 1 }), miniGrid(look, { frame: 2 }));
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node --test test/skyworld.test.js test/sprites.test.js`
Attendu : ÉCHEC (module et export introuvables).

- [ ] **Étape 3 : implémenter `public/skyworld.js`**

```js
// public/skyworld.js — ciel, nuages, télécabines et mouettes, en pixels natifs (pur, sans DOM).
import { PALETTES } from './sky.js';
import { OL, hs, mix, rng } from './iso.js';

export const SAG = 10, DWELL = 3, SPEED = 10;

/** Dégradé en 14 bandes tramées, étoiles la nuit, nuages lointains figés. Couleurs brutes : le ciel est déjà propre au moment. */
export function drawSky(p, phase, w, h) {
  const P = PALETTES[phase], N = 14;
  for (let i = 0; i < N; i++) {
    const y0 = Math.floor((i * h) / N), y1 = Math.floor(((i + 1) * h) / N);
    p.rect(0, y0, w, y1 - y0, '!' + mix(P.skyTop, P.skyBottom, i / (N - 1)));
    if (i < N - 1) { const c = '!' + mix(P.skyTop, P.skyBottom, (i + 1) / (N - 1)); for (let x = 0; x < w; x += 2) { p.rect(x + ((y1 - 2) & 1), y1 - 2, 1, 1, c); p.rect(x + ((y1 - 1) & 1), y1 - 1, 1, 1, c); p.rect(x + 1 - ((y1 - 1) & 1), y1 - 1, 1, 1, c); } }
  }
  const r = rng(3);
  if (phase === 'night') for (let i = 0, n = Math.round((w * h) / 2700); i < n; i++) {
    const x = Math.floor(r() * w), y = Math.floor(r() * h); p.pix(x, y, i % 7 ? '!#c8ccf0' : '!#ffffff');
    if (i % 29 === 0) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) p.pix(x + dx, y + dy, '!#7a82c0');
  }
  for (let i = 0; i < 10; i++) cloud(p, phase, Math.floor(r() * w), Math.floor(r() * h), 10 + Math.floor(r() * 16), 0.45);
}
export function cloud(p, phase, x, y, s, alpha = 1) {
  const P = PALETTES[phase], c1 = '!' + P.cloud, c2 = '!' + P.cloudShade, ctx = p.ctx, q = (v) => Math.max(2, Math.round(v));
  ctx.save(); ctx.globalAlpha = alpha;
  p.ell(x, y + 2, Math.round(s), q(s * 0.28), c2);
  p.ell(x - Math.round(s * 0.35), y - 1, Math.round(s * 0.55), q(s * 0.3), c1); p.ell(x + Math.round(s * 0.3), y - 2, Math.round(s * 0.5), q(s * 0.32), c1); p.ell(x, y - Math.round(s * 0.3), Math.round(s * 0.45), q(s * 0.3), c1);
  ctx.restore();
}
export const cableAt = (route, u) => { const [ax, ay] = route.from, [bx, by] = route.to; return [ax + (bx - ax) * u, ay + (by - ay) * u + SAG * 4 * u * (1 - u)]; };
/** Va-et-vient adouci avec un arrêt de DWELL secondes à chaque station. */
export function gondolaAt(route, t) {
  const d = Math.hypot(route.to[0] - route.from[0], route.to[1] - route.from[1]), tr = d / SPEED, T = 2 * (tr + DWELL), u = (((t + route.offset) % T) + T) % T;
  let f, moving = false;
  if (u < DWELL) f = 0; else if (u < DWELL + tr) { f = (u - DWELL) / tr; moving = true; } else if (u < 2 * DWELL + tr) f = 1; else { f = 1 - (u - 2 * DWELL - tr) / tr; moving = true; }
  const [x, y] = cableAt(route, f * f * (3 - 2 * f)); return { x, y, moving };
}
export function drawCable(p, route) { const n = Math.ceil(Math.hypot(route.to[0] - route.from[0], route.to[1] - route.from[1])); for (let i = 0; i <= n; i++) { const [x, y] = cableAt(route, i / n); p.rect(x, y, 1, 1, '#3a3540'); } }
export function drawCabin(p, x, y, color, glow) {
  const X = Math.round(x), Y = Math.round(y);
  p.rect(X, Y, 1, 4, '#3a3540'); p.rect(X - 2, Y, 5, 1, '#3a3540');
  p.rect(X - 4, Y + 4, 9, 7, OL); p.rect(X - 3, Y + 5, 7, 5, color); p.rect(X - 3, Y + 5, 7, 1, hs(color, 0.2)); p.rect(X - 2, Y + 6, 5, 2, glow ? '!#ffe9a8' : '#cfeaf6'); p.rect(X - 3, Y + 9, 7, 1, hs(color, -0.3));
}
export const drawGondola = (p, route, t, glow) => { const g = gondolaAt(route, t); drawCabin(p, g.x, g.y, route.color, glow); };
export function drawBird(p, x, y, up) { p.pix(x, y, '#ffffff'); p.pix(x - 1, y - up, '#ffffff'); p.pix(x + 1, y - up, '#ffffff'); p.pix(x - 2, y - 1 + up, '#e4e8ee'); p.pix(x + 2, y - 1 + up, '#e4e8ee'); }
```

- [ ] **Étape 4 : implémenter `miniGrid` dans `public/sprites.js`**

À ajouter à la fin du fichier (réutilise `shade` et `DK`, déjà présents) :

```js
/** Mini-passant de la carte : 6×11 px + contour (grille 13 × 8). dir : down | up ; frame 0 = immobile, 1 et 2 = pas. */
export function miniGrid(look, { dir = 'down', frame = 0 } = {}) {
  const W = 8, H = 13, g = Array.from({ length: H }, () => Array(W).fill(null));
  const set = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) g[y][x] = c; };
  const R = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c); };
  const back = dir === 'up', sk = look.skin, hair = look.hairColor, hairD = shade(hair, -0.25);
  const top = look.outfit === 'labcoat' ? '#f2f4f6' : look.topColor, topD = shade(top, -0.22), acc = look.outfit === 'labcoat' ? look.topColor : shade(look.topColor, 0.35);
  const pan = '#2f3550', shoes = '#3a2a22', b = frame ? -1 : 0, upL = frame === 1 ? 1 : 0, upR = frame === 2 ? 1 : 0;
  R(2, 8, 2, 2 - upL, pan); R(4, 8, 2, 2 - upR, shade(pan, -0.2)); R(2, 10 - upL, 2, 1, shoes); R(4, 10 - upR, 2, 1, shoes);
  const sw = frame === 1 ? -1 : frame === 2 ? 1 : 0;
  R(2, 4 + b, 4, 4, top); R(5, 4 + b, 1, 4, topD);
  R(1, 4 + b + Math.max(0, sw), 1, 3, top); R(6, 4 + b + Math.max(0, -sw), 1, 3, topD); set(1, 7 + b + Math.max(0, sw), sk); set(6, 7 + b + Math.max(0, -sw), shade(sk, -0.15));
  if (look.outfit === 'labcoat') { R(2, 8, 4, 1, top); set(3, 4 + b, acc); }
  if (!back) {
    if (look.outfit === 'blazer') R(3, 4 + b, 2, 2, '#f4f4f0');
    if (look.outfit === 'apron') R(3, 5 + b, 2, 3, acc);
    if (look.outfit === 'hoodie') R(2, 4 + b, 4, 1, topD);
    if (look.outfit === 'jacket') R(4, 4 + b, 1, 4, DK);
    if (look.outfit === 'sweater') R(2, 6 + b, 4, 1, acc);
  }
  R(2, 1 + b, 4, 3, sk); set(5, 2 + b, shade(sk, -0.15)); set(5, 3 + b, shade(sk, -0.15));
  R(2, 1 + b, 4, 1, hair); set(2, 2 + b, hair);
  if (back) R(2, 1 + b, 4, 3, hair);
  const hs_ = look.hairStyle;
  if (hs_ === 'long' || hs_ === 'bob') { set(2, 3 + b, hair); set(5, 2 + b, hairD); set(5, 3 + b, hairD); if (hs_ === 'long') { set(2, 4 + b, hair); set(5, 4 + b, hairD); } }
  if (hs_ === 'spiky') { set(2, b, hair); set(4, b, hair); }
  if (hs_ === 'bun') R(3, b, 2, 1, hair);
  if (hs_ === 'ponytail') { set(6, 2 + b, hairD); set(6, 3 + b, hairD); }
  const a = look.accessory;
  if (a === 'headset') { R(2, b, 4, 1, '#3a3f55'); set(2, 2 + b, '#3a3f55'); set(5, 2 + b, '#3a3f55'); }
  if (a === 'cap') { R(2, b, 4, 2, look.topColor); if (!back) set(6, 1 + b, shade(look.topColor, -0.25)); }
  if (a === 'glasses' && !back) R(3, 2 + b, 3, 1, DK);
  if (a === 'scarf') R(2, 4 + b, 4, 1, acc);
  const out = g.map((r) => r.slice());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!g[y][x] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx])) out[y][x] = DK;
  return out;
}
```

Remarque : avec `frame` non nul, le haut du corps remonte d'un pixel (`b = -1`). La rangée 0 accueille alors le chignon, les pointes, le casque ou la casquette. Rien ne sort de la grille, car `set` ignore ce qui est hors limites.

- [ ] **Étape 5 : lancer tous les tests**

Lancer : `npm test`
Attendu : tout passe.

- [ ] **Étape 6 : commiter**

```bash
git add public/skyworld.js public/sprites.js test/skyworld.test.js test/sprites.test.js
git commit -m "feat(ciel): ciel en pixels, nuages, télécabines ; mini-passants 6×11"
```

---

### Tâche 5 : îles volantes (`world.js`)

**Fichiers :**
- Modifier : `public/world.js` (réécriture : disposition native, dessin des îles et de la place centrale)
- Tester : `test/world.test.js` (réécrit)

**Interfaces :**
- Consomme :
  - tâche 1 : `pen`, `hs`, `rng`, `inDia`, `diamondPts`, `shade`, `OL` ;
  - tâche 3 : `TYPES`, `YARDS`, `door`, `shadow`, `extentOf`, `bench` ;
  - tâche 2 : `applyStyle`, `OPTIONS`.
- Produit :
  - constantes : `K = 3`, `GRID = { DX: 170, DY: 85 }`, `ISLAND = { R: 84, HUB: 110, CL: 6, MARGIN: 60 }`, `LIGHT_FACTOR = { morning: 0, noon: 0, evening: 0.6, night: 1 }` ;
  - `computeWorld(departments, agents?, styles?) → { width, height, hub, islands }` (largeur et hauteur en unités monde, soit natif × K) ;
  - chaque île : `{ id, name, index, i, j, nx, ny, x, y, R, identity, label, type, edge, station }` ;
  - place centrale : `{ nx, ny, x, y, R, stations: { NE, SE, SW, NW } }` ;
  - `nativeBounds(isl | hub) → { x, y, w, h }` en pixels natifs entiers ;
  - `drawIsland(ctx, C, isl, { factor, activity }) → { blinks, smoke, alarm }` (points natifs) ;
  - `drawHub(ctx, C, hub, { factor, flags })` ;
  - `activityRate(agents) → nombre` ;
  - repères en unités monde : `pillSpot(isl) → [x, y]`, `buildingHit(isl) → { x, y, w, h }`, `plotSpot(isl) → [x, y]`, `hubSpot(hub) → [x, y]` ;
  - repères natifs : `walkPath(isl) → [[x, y], [x, y]]`, `hubWalks(hub) → [[a, b] × 6]` ;
  - `cableRoutes(world) → route[]` ;
  - on garde `styledIdentity`, `identityFor`, `IDENTITY` (avec `building`), `spriteCanvas`.
- Supprimés : `placeAgents`, `deskSpots`, `roomPoint`, `drawDesk`, `recruitSpot`, `signSpot`, `doorSpot`, `islandBounds`, `FURNITURE`, `ISLAND.GROW`.

- [ ] **Étape 1 : réécrire les tests (ils échouent)**

Remplacer tout `test/world.test.js` par :

```js
// test/world.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';
import { computeWorld, nativeBounds, drawIsland, drawHub, styledIdentity, cableRoutes, activityRate, pillSpot, buildingHit, plotSpot, walkPath, GRID, K, LAGON } from '../public/world.js';
import { tinter } from '../public/iso.js';
import { OPTIONS } from '../public/island-style.js';

const seeded = () => { const s = createStudio(':memory:'); return { s, d: s.listDepartments() }; };
const rec = () => { const calls = []; let c; return { calls, ctx: { set fillStyle(v) { c = v; }, get fillStyle() { return c; }, globalAlpha: 1, save() {}, restore() {}, fillRect(x, y, w, h) { calls.push([x, y, w, h, c]); } } }; };
const inside = (calls, b) => calls.every(([x, y, w, h]) => x >= b.x && y >= b.y && x + w <= b.x + b.w && y + h <= b.y + b.h);

test('huit départements sur l’anneau autour de la place, dans l’ordre ; monde = natif × K', () => {
  const { s, d } = seeded(); const w = computeWorld(d);
  assert.deepEqual(w.islands.map((i) => [i.name, i.i, i.j]), [['Direction', -1, -1], ['Catalogue', 0, -1], ['Création', 1, -1], ['Marketing', 1, 0], ['Service client', 1, 1], ['Opérations', 0, 1], ['Données', -1, 1], ['Laboratoire', -1, 0]]);
  const dir = w.islands[0];
  assert.deepEqual([dir.nx - w.hub.nx, dir.ny - w.hub.ny], [0, -2 * GRID.DY]);
  assert.deepEqual([dir.x, dir.y], [dir.nx * K, dir.ny * K]);
  s.close();
});

test('un neuvième département va sur l’anneau extérieur', () => {
  const { s } = seeded(); s.createDepartment({ name: 'Juridique' });
  const w = computeWorld(s.listDepartments());
  assert.equal(Math.max(Math.abs(w.islands[8].i), Math.abs(w.islands[8].j)), 2);
  assert.equal(w.islands[8].type, 'bureaux');
  s.close();
});

test('la taille d’une île ne dépend plus du nombre d’agents ; tout tient dans le monde', () => {
  const { s, d } = seeded(), dir = d[0];
  const many = (n) => Array.from({ length: n }, (_, k) => ({ id: `a${k}`, name: `A${k}`, role: 'r', department_id: dir.id, created_at: String(k) }));
  const sizes = [0, 9, 31].map((n) => { const w = computeWorld(d, many(n)), b = nativeBounds(w.islands[0]); assert.ok(b.x >= 0 && b.y >= 0 && (b.x + b.w) * K <= w.width && (b.y + b.h) * K <= w.height); return [b.w, b.h]; });
  assert.deepEqual(sizes[0], sizes[1]); assert.deepEqual(sizes[0], sizes[2]);
  s.close();
});

test('chaque île (9 types) et la place centrale se dessinent dans leur emprise', () => {
  const { s, d } = seeded(); const base = computeWorld(d);
  for (const building of OPTIONS.building) for (const isl of base.islands.slice(0, 2)) {
    const w = computeWorld(d, [], [{ departmentId: isl.id, building, emblem: 'crown' }]), x = w.islands.find((i) => i.id === isl.id);
    const { calls, ctx } = rec(); const dyn = drawIsland(ctx, tinter('night'), x, { factor: 1, activity: 1 });
    assert.ok(calls.length > 1000, building); assert.ok(inside(calls, nativeBounds(x)), `${building} / ${x.name}`);
    assert.ok(Array.isArray(dyn.blinks) && Array.isArray(dyn.smoke) && dyn.alarm.length === 2);
  }
  const { calls, ctx } = rec(); drawHub(ctx, tinter('noon'), base.hub, { factor: 0, flags: base.islands.map((i) => i.identity.accent) });
  assert.ok(calls.length > 1000 && inside(calls, nativeBounds(base.hub)));
  s.close();
});

test('bâtiment par défaut selon le métier, remplacé par le style', () => {
  const { s, d } = seeded(); const w = computeWorld(d);
  assert.deepEqual(w.islands.map((i) => i.type), ['siege', 'entrepot', 'atelier', 'panneau', 'accueil', 'hangar', 'tour', 'labo']);
  const lab = d.find((x) => x.name === 'Laboratoire');
  assert.equal(computeWorld(d, [], [{ departmentId: lab.id, building: 'tour' }]).islands.find((i) => i.id === lab.id).type, 'tour');
  s.close();
});

test('styles fusionnés par département ; identité intacte ailleurs ; Map acceptée ; null ignoré', () => {
  const { s, d } = seeded(); const lab = d.find((x) => x.name === 'Laboratoire');
  const plain = computeWorld(d), styled = computeWorld(d, [], [{ departmentId: lab.id, accent: 'gold', label: 'Recherche' }, { departmentId: 'inconnu', accent: 'gold' }, null]);
  const b = styled.islands.find((i) => i.id === lab.id);
  assert.equal(b.label, 'Recherche'); assert.equal(b.identity.accent, OPTIONS.accent.gold);
  assert.deepEqual(plain.islands.filter((i) => i.id !== lab.id).map((i) => i.identity), styled.islands.filter((i) => i.id !== lab.id).map((i) => i.identity));
  assert.deepEqual(styled.islands.map((i) => [i.x, i.y]), plain.islands.map((i) => [i.x, i.y]));
  assert.equal(computeWorld(d, [], new Map([[lab.id, { ground: 'snow' }]])).islands.find((i) => i.id === lab.id).identity.ground, 'snow');
  s.close();
});

test('terrain, arbres et lampadaires changent le dessin', () => {
  const { s, d } = seeded(); const base = computeWorld(d).islands[0];
  const colors = (st) => { const isl = { ...base, identity: styledIdentity(base.name, base.index, st) }, seen = new Set(), { ctx } = rec(); Object.defineProperty(ctx, 'fillStyle', { set(v) { seen.add(v); }, get() { return ''; } }); drawIsland(ctx, (c) => c, isl, { factor: 0 }); return seen; };
  assert.ok(colors({}).has(LAGON.grass));
  assert.ok(colors({ ground: 'snow' }).has(OPTIONS.ground.snow.top) && !colors({ ground: 'snow' }).has(LAGON.grass));
  assert.ok(colors({ tree: 'blossom' }).has(LAGON.blossom) && !colors({ tree: 'round' }).has(LAGON.blossom));
  assert.ok(colors({ lanterns: true }).has('#d8cfb4') && !colors({ lanterns: false }).has('#d8cfb4'));
  s.close();
});

test('activité, repères et câbles', () => {
  assert.equal(activityRate([]), 0.05);
  assert.equal(activityRate([{ status: 'working' }, { status: 'idle' }]), 0.5);
  assert.equal(activityRate([{ status: 'working', enabled: false }, { status: 'idle' }]), 0.1);
  const { s, d } = seeded(); const w = computeWorld(d), routes = cableRoutes(w);
  assert.equal(routes.length, 8);
  for (const [k, isl] of w.islands.entries()) {
    assert.deepEqual(routes[k].from, isl.station); assert.ok(Object.values(w.hub.stations).some((st) => st === routes[k].to));
    const hb = buildingHit(isl), [px, py] = pillSpot(isl), [qx, qy] = plotSpot(isl);
    assert.ok(py <= hb.y && px > hb.x && px < hb.x + hb.w);
    assert.ok(Math.hypot(qx / K - isl.nx, (qy / K - isl.ny) * 2) < isl.R);
    assert.equal(walkPath(isl).length, 2);
  }
  s.close();
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node --test test/world.test.js`
Attendu : ÉCHEC (exports manquants : `nativeBounds`, `K`…).

- [ ] **Étape 3 : réécrire `public/world.js`**

Remplacer tout le fichier par le code ci-dessous. Le contenu de `IDENTITY` (accents, sols, murs), `FALLBACK`, `RING1`, `RING2`, `identityFor`, `styledIdentity` et `spriteCanvas` reprend le fichier actuel, plus la clé `building`.

```js
// public/world.js — archipel d'îles volantes : disposition (pure) et dessin en pixels natifs (affichés ×K).
import { OL, shade, hs, rng, pen, inDia } from './iso.js';
import { applyStyle, OPTIONS } from './island-style.js';
import { TYPES, YARDS, door, shadow, extentOf, bench } from './buildings.js';

export const K = 3;
export const GRID = Object.freeze({ DX: 170, DY: 85 });
export const ISLAND = Object.freeze({ R: 84, HUB: 110, CL: 6, MARGIN: 60 });
export const LIGHT_FACTOR = Object.freeze({ morning: 0, noon: 0, evening: 0.6, night: 1 });
export const LAGON = Object.freeze({ grass: '#5fb04a', rock: '#9a6a48', rock2: '#76503a', leaf: '#3f9a45', leafL: '#72c95c', leafD: '#2a6b3c', trunk: '#8f6544', stone: '#e4d8bf', blossom: '#e58fb8', blossomL: '#f6c4da', blossomD: '#b9638e' });
export const IDENTITY = Object.freeze({
  Direction: { accent: '#f2c14e', floor: '#e9d3a8', wall: '#efe4cc', building: 'siege' },
  Catalogue: { accent: '#4f8fd9', floor: '#cfe0f2', wall: '#efe4cc', building: 'entrepot' },
  'Création': { accent: '#b46be0', floor: '#ecd3ef', wall: '#efe4cc', building: 'atelier' },
  Marketing: { accent: '#ff6f5c', floor: '#ffd8cc', wall: '#efe4cc', building: 'panneau' },
  'Service client': { accent: '#2fb39a', floor: '#cdeee2', wall: '#efe4cc', building: 'accueil' },
  'Opérations': { accent: '#e8853d', floor: '#e3d6c4', wall: '#e2d8c8', building: 'hangar' },
  'Données': { accent: '#3b9be0', floor: '#d4d9f2', wall: '#c8ccd8', building: 'tour' },
  Laboratoire: { accent: '#8ac23a', floor: '#e4f2cf', wall: '#f2f4f6', building: 'labo' }
});
const FALLBACK = ['#d9655a', '#6a82e0', '#c06ad0', '#4fb98f'];
export function identityFor(name, index) {
  if (IDENTITY[name]) return IDENTITY[name];
  const accent = FALLBACK[index % FALLBACK.length];
  return { accent, floor: shade(accent, 0.7), wall: '#efe4cc', building: 'bureaux' };
}
export const styledIdentity = (name, index, style) => applyStyle(identityFor(name, index), style);
const RING1 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const RING2 = (() => { const out = []; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if (Math.max(Math.abs(i), Math.abs(j)) === 2) out.push([i, j]); return out.sort((a, b) => Math.atan2(a[1] + a[0], a[0] - a[1]) - Math.atan2(b[1] + b[0], b[0] - b[1])); })();

/** Proportion de fenêtres pouvant s'allumer : 0,1 au repos → 0,9 si tous les agents activés sont « en cours ». */
export function activityRate(agents) { const on = agents.filter((a) => a.enabled !== false); return on.length ? 0.1 + (0.8 * on.filter((a) => a.status === 'working').length) / on.length : 0.05; }

// ---------- géométrie (pixels natifs) ----------
const EDGES = (cx, cy, R) => [
  { n: 'NE', m: [cx + R / 2, cy - R / 4], d: [1, -0.5] }, { n: 'SE', m: [cx + R / 2, cy + R / 4], d: [1, 0.5] },
  { n: 'SW', m: [cx - R / 2, cy + R / 4], d: [-1, 0.5] }, { n: 'NW', m: [cx - R / 2, cy - R / 4], d: [-1, -0.5] }];
const nearestEdge = (cx, cy, R, tx, ty) => EDGES(cx, cy, R).reduce((b, e) => (Math.hypot(e.m[0] - tx, e.m[1] - ty) < Math.hypot(b.m[0] - tx, b.m[1] - ty) - 0.01 ? e : b));
const edgeOf = (isl) => EDGES(isl.nx, isl.ny, isl.R).find((e) => e.n === isl.edge);
const pierAt = (E) => (s, w) => [E.m[0] + E.d[0] * s + E.d[0] * w, E.m[1] + E.d[1] * s - E.d[1] * w];
const stationTop = (E) => { const [x, y] = pierAt(E)(15, -2).map(Math.round); return [x, y - 15]; };
export function buildingOf(isl) {
  const T = TYPES[isl.type], cx = isl.nx, cy = isl.ny;
  const B = { x: Math.round(cx - (T.b - T.a) / 2), y: Math.round(cy - 14 + (T.a + T.b) / 4), a: T.a, b: T.b, h: T.h };
  const kk = T.door[0] + T.door[1] / 2, D = [B.x + Math.round(kk), B.y - Math.floor(kk / 2) + 1];
  return { T, B, door: D, out: [D[0] + 16, D[1] + 8] };
}
export function nativeBounds(x) {
  const R = x.R, cx = x.nx, cy = x.ny, bottom = cy + ISLAND.CL + R / 2 + Math.round(R * 0.5) + 4;
  let top = cy - R / 2 - 20;
  if (x.type) { const { B, T } = buildingOf(x); top = Math.min(cy - R / 2 - 24, extentOf(B, T).y0); }
  return { x: Math.floor(cx - R - 34), y: Math.floor(top), w: Math.ceil(2 * R + 68), h: Math.ceil(bottom - Math.floor(top)) };
}

export function computeWorld(departments, agents = [], styles = []) {
  const byDept = styles instanceof Map ? styles : new Map((styles || []).filter(Boolean).map((s) => [s.departmentId, s]));
  const slots = [...RING1, ...RING2];
  const islands = departments.map((d, k) => {
    const [i, j] = slots[k % slots.length], identity = styledIdentity(d.name, k, byDept.get(d.id));
    return { id: d.id, name: d.name, index: k, i, j, nx: (i - j) * GRID.DX, ny: (i + j) * GRID.DY, R: ISLAND.R, identity, label: identity.label || d.name, type: TYPES[identity.building] ? identity.building : 'bureaux' };
  });
  const hub = { nx: 0, ny: 0, R: ISLAND.HUB }, all = [hub, ...islands], bs = all.map(nativeBounds), M = ISLAND.MARGIN;
  const ox = M - Math.min(...bs.map((b) => b.x)), oy = M - Math.min(...bs.map((b) => b.y));
  const nw = Math.max(...bs.map((b) => b.x + b.w)) + ox + M, nh = Math.max(...bs.map((b) => b.y + b.h)) + oy + M;
  for (const x of all) { x.nx += ox; x.ny += oy; x.x = x.nx * K; x.y = x.ny * K; }
  for (const isl of islands) { const E = nearestEdge(isl.nx, isl.ny, isl.R, hub.nx, hub.ny); isl.edge = E.n; isl.station = stationTop(E); }
  hub.stations = Object.fromEntries(EDGES(hub.nx, hub.ny, hub.R).map((E) => [E.n, stationTop(E)]));
  return { width: nw * K, height: nh * K, hub, islands };
}

// ---------- repères ----------
const W = ([x, y]) => [x * K, y * K];
export function pillSpot(isl) { const { B, T } = buildingOf(isl); return W([B.x + (B.b - B.a) / 2, extentOf(B, T).y0 - 3]); }
export function buildingHit(isl) { const { B, T } = buildingOf(isl), e = extentOf(B, T); return { x: (B.x - B.a) * K, y: e.y0 * K, w: (B.a + B.b) * K, h: (B.y - e.y0) * K }; }
const plotPt = (isl) => { const E = edgeOf(isl); return [Math.round(E.m[0] - 8 * E.d[0]), Math.round(E.m[1] - 32 * E.d[1])]; };
export const plotSpot = (isl) => W(plotPt(isl));
export const hubSpot = (hub) => W([hub.nx, hub.ny - 20]);
export const walkPath = (isl) => { const { door: D, out } = buildingOf(isl); return [D, out]; };
export function hubWalks(hub) {
  const r = rng(55), S = (hub.R - 18) / 2, iso = (u, v) => [hub.nx + u - v, hub.ny + (u + v) / 2], pick = () => iso((r() * 2 - 1) * S * 0.8, (r() * 2 - 1) * S * 0.8), out = [];
  while (out.length < 6) { const a = pick(), b = pick(); if ([a, b].every(([x, y]) => Math.hypot(x - hub.nx, (y - hub.ny) * 2) >= 30)) out.push([a, b]); }
  return out;
}
export function cableRoutes(world) {
  const h = world.hub;
  return world.islands.map((isl) => ({ id: isl.id, color: isl.identity.accent, from: isl.station, to: h.stations[nearestEdge(h.nx, h.ny, h.R, isl.nx, isl.ny).n], offset: isl.index * 3.3 }));
}

// ---------- dessin ----------
function groundColors(id) { const g = id.ground && id.ground !== 'grass' && OPTIONS.ground[id.ground] ? OPTIONS.ground[id.ground].top : LAGON.grass; return { g, gl: hs(g, 0.12), gd: hs(g, -0.16) }; }
function disc(p, cx, cy, r, base, light, dark) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r + r * 0.6) continue;
    const v = (dx + dy * 1.3) / r; p.pix(cx + dx, cy + dy, v < -0.55 ? light : v > 0.45 ? dark : base);
    if ((dx + 1) ** 2 + (dy + 1) ** 2 > r * r + r * 0.6 && dx + dy > 0) p.pix(cx + dx + 1, cy + dy + 1, hs(dark, -0.2));
  }
}
function tree(p, x, y, kind, gc) {
  const L = LAGON;
  if (kind !== 'bush') p.ell(x + 4, y + 1, 5, 1, hs(gc.g, -0.32));
  if (kind === 'palm') {
    for (let i = 0; i < 12; i++) p.rect(x + Math.round(Math.sin(i / 4) * 2), y - i, 2, 1, i % 3 ? L.trunk : hs(L.trunk, -0.2));
    const tx = x + Math.round(Math.sin(11 / 4) * 2), ty = y - 12;
    for (const [dx, dy] of [[-8, 3], [8, 3], [-6, -1], [6, -2], [-1, -4], [3, 4], [-4, 5]]) { p.line(tx, ty, tx + dx, ty + dy, L.leaf); p.line(tx, ty + 1, tx + dx, ty + dy + 1, L.leafD); }
    p.line(tx - 1, ty, tx - 6, ty - 1, L.leafL); p.rect(tx, ty + 1, 2, 2, '#6a4a2a'); return;
  }
  if (kind === 'pine') {
    p.rect(x, y - 3, 2, 3, L.trunk);
    for (const [w, up] of [[7, 0], [6, 5], [4, 10], [2, 14]]) { p.poly([[x - w, y - 3 - up], [x + w + 2, y - 3 - up], [x + 1, y - 11 - up]], L.leafD); p.poly([[x - w + 1, y - 4 - up], [x + 1, y - 4 - up], [x + 1, y - 10 - up]], L.leaf); p.pix(x - w + 2, y - 5 - up, L.leafL); }
    return;
  }
  if (kind === 'bush') { disc(p, x, y - 2, 3, L.leaf, L.leafL, L.leafD); return; }
  const [base, light, dark] = kind === 'blossom' ? [L.blossom, L.blossomL, L.blossomD] : [L.leaf, L.leafL, L.leafD];
  p.rect(x, y - 6, 2, 6, L.trunk); p.pix(x + 1, y - 6, hs(L.trunk, -0.25)); disc(p, x + 1, y - 12, 6, base, light, dark);
}
function lamp(p, x, y, factor) { p.rect(x, y - 9, 1, 9, '#3a3540'); p.rect(x - 1, y - 11, 3, 2, '#3a3540'); p.pix(x, y - 10, factor > 0 ? '!#ffe9a8' : '#d8cfb4'); if (factor > 0.3) p.glow(x, y - 8, 8, '#ffd36b'); }
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
function underside(p, cx, cy, R, r) {
  const L = LAGON, y0 = cy + ISLAND.CL, depth = Math.round(R * 0.5), A = [cx - R, y0], Bm = [cx, y0 + R / 2], Rr = [cx + R, y0], tip = [cx + Math.round(R * 0.06), y0 + R / 2 + depth];
  p.poly([A, Bm, tip], L.rock); p.poly([Bm, Rr, tip], L.rock2);
  for (let k = 1; k < 5; k++) { const f = k / 5, a = lerp(A, tip, f), b = lerp(Bm, tip, f), c = lerp(Rr, tip, f); p.line(a[0], a[1], b[0], b[1], hs(L.rock, -0.08 - f * 0.12)); p.line(b[0], b[1], c[0], c[1], hs(L.rock2, -0.08 - f * 0.12)); }
  p.dither([lerp(A, tip, 0.55), lerp(Bm, tip, 0.55), tip], hs(L.rock, -0.32)); p.dither([lerp(Bm, tip, 0.55), lerp(Rr, tip, 0.55), tip], hs(L.rock2, -0.32));
  for (let i = 0; i < 26; i++) { const left = r() < 0.5, top = left ? lerp(A, Bm, r()) : lerp(Bm, Rr, r()), q = lerp(top, tip, r() * 0.75), c = left ? L.rock : L.rock2; p.pix(q[0], q[1], hs(c, 0.14)); p.pix(q[0] + 1, q[1], hs(c, -0.2)); }
  for (let i = 0; i < 18; i++) { const s = i % 2 ? lerp(A, Bm, r()) : lerp(Bm, Rr, r()), len = 3 + Math.floor(r() * 10), vine = r() < 0.45, dx = r() < 0.5 ? -1 : 1; p.line(s[0], s[1] + 1, s[0] + dx, s[1] + len, vine ? L.leafD : hs(L.trunk, -0.1)); if (vine) p.pix(s[0] + dx, s[1] + len, L.leafL); }
  for (let i = 0; i < 3; i++) { const sd = i % 2 ? 1 : -1, x = Math.round(cx + sd * (R * 0.55 + r() * 22)), y = Math.round(y0 + R / 2 + 6 + r() * depth * 0.6); p.rect(x - 2, y - 3, 4, 2, hs(LAGON.grass, 0.05)); p.rect(x - 2, y - 1, 2, 3, L.rock); p.rect(x, y - 1, 2, 3, L.rock2); }
}
function terrain(p, cx, cy, R, r, gc) {
  const L = LAGON, CL = ISLAND.CL;
  underside(p, cx, cy, R, r);
  p.poly([[cx - R, cy], [cx, cy + R / 2], [cx, cy + R / 2 + CL], [cx - R, cy + CL]], L.rock);
  p.poly([[cx, cy + R / 2], [cx + R, cy], [cx + R, cy + CL], [cx, cy + R / 2 + CL]], L.rock2);
  p.line(cx - R, cy + CL - 3, cx, cy + R / 2 + CL - 3, hs(L.rock, -0.12)); p.line(cx, cy + R / 2 + CL - 3, cx + R, cy + CL - 3, hs(L.rock2, -0.12));
  p.poly([[cx - R, cy], [cx, cy - R / 2], [cx + R, cy], [cx, cy + R / 2]], gc.g);
  for (let i = 0; i < R * R * 0.09; i++) { const x = cx + Math.round((r() * 2 - 1) * R), y = cy + Math.round(((r() * 2 - 1) * R) / 2); if (inDia(x, y, cx, cy, R - 2)) p.pix(x, y, r() < 0.5 ? gc.gl : gc.gd); }
  for (let i = 0; i < 16; i++) { const x = cx + Math.round((r() * 2 - 1) * R * 0.8), y = cy + Math.round((r() * 2 - 1) * R * 0.38); if (inDia(x, y, cx, cy, R - 6)) { p.pix(x, y, gc.gd); p.pix(x + 1, y - 1, gc.gd); p.pix(x + 2, y, gc.gd); } }
  for (let i = 0; i < 7; i++) { const x = cx + Math.round((r() * 2 - 1) * R * 0.75), y = cy + Math.round((r() * 2 - 1) * R * 0.35), c = ['#fff6e0', '#ffd34d', '#ff9ec0', '#c8a8ff'][i % 4]; if (inDia(x, y, cx, cy, R - 8)) for (let k = 0; k < 6; k++) { const fx = x + Math.round((r() * 2 - 1) * 4), fy = y + Math.round((r() * 2 - 1) * 2); p.pix(fx, fy + 1, gc.gd); p.pix(fx, fy, c); } }
  p.line(cx - R, cy, cx, cy + R / 2, hs(gc.g, 0.16)); p.line(cx, cy + R / 2, cx + R, cy, hs(gc.g, -0.1));
  for (let i = 0; i < 26; i++) { const u = r(), left = i % 2, x = left ? cx - R + u * R : cx + u * R, y = left ? cy + (u * R) / 2 : cy + R / 2 - (u * R) / 2; p.rect(x, y + 1, 1, 1 + (r() < 0.35 ? 1 : 0), gc.gd); }
}
function pathBand(p, pts) {
  for (const [c, w] of [[hs(LAGON.stone, -0.28), 3.4], [LAGON.stone, 2.4]]) {
    for (let i = 0; i + 1 < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay) || 1, nx = (-(by - ay) / L) * w, ny = ((bx - ax) / L) * w * 0.7; p.poly([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], c); }
    for (const [x, y] of pts) p.poly([[x - w - 1, y], [x, y - (w + 1) / 2], [x + w + 1, y], [x, y + (w + 1) / 2]], c);
  }
}
function station(p, E, factor, lamps) {
  const at = pierAt(E), pts = [at(-2, 3), at(18, 3), at(18, -3), at(-2, -3)];
  p.poly(pts.map(([x, y]) => [x, y + 2]), '#5e4430'); p.poly(pts, '#a87a4a');
  for (let s = 0; s <= 18; s += 2) { const a = at(s, 3), b = at(s, -3); p.line(a[0], a[1], b[0], b[1], '#8a6240'); }
  for (const w of [3, -3]) { const [x, y] = at(17, w); p.rect(x, y, 1, 4, '#4a3628'); }
  if (lamps) { const [lx, ly] = at(16, 3); lamp(p, Math.round(lx), Math.round(ly), factor); }
  const [sx, sy] = at(15, -2).map(Math.round); p.rect(sx, sy - 16, 1, 16, '#5a5460'); p.rect(sx - 2, sy - 16, 5, 1, '#5a5460');
}
const plotSign = (p, x, y, accent) => { p.rect(x, y - 9, 1, 9, '#6a4a30'); p.rect(x - 4, y - 14, 9, 6, OL); p.rect(x - 3, y - 13, 7, 4, accent); p.rect(x - 1, y - 12, 3, 1, '#fff6e0'); p.rect(x, y - 13, 1, 3, '#fff6e0'); };

/** Île complète (dessous, terrain, chemin, station, bâtiment, décor) ; renvoie les points animés. */
export function drawIsland(ctx, C, isl, { factor = 0, activity = 0.05 } = {}) {
  const p = pen(ctx, C), id = isl.identity, gc = groundColors(id), seed = 31 + isl.index * 17, r = rng(seed), cx = isl.nx, cy = isl.ny, R = isl.R, lamps = id.lanterns !== false;
  terrain(p, cx, cy, R, r, gc);
  const { T, B, door: D } = buildingOf(isl), E = edgeOf(isl), P1 = [D[0] + 10, D[1] + 5];
  const via = { SE: [], SW: [[cx, cy + 24]], NE: [[cx + 46, cy + 4]], NW: [[cx, cy + 24], [cx - 48, cy + 2]] }[E.n];
  pathBand(p, [D, P1, ...via, E.m]);
  station(p, E, factor, lamps);
  shadow(p, B, hs(gc.g, -0.32));
  const o = { accent: id.accent, seed, lit: activity * factor, glow: factor > 0.3, emblem: id.emblem, blinks: [], smoke: [] };
  let alarm = [D[0], D[1] - 15];
  const items = [{ y: B.y, d: () => { T.draw(p, B, o); alarm = door(p, B, T.door, o); } }];
  const [yx, yy] = E.n === 'SE' || E.n === 'NE' ? [cx - 40, cy + 8] : [cx + 34, cy + 12];
  items.push(...YARDS[isl.type](p, yx, yy, o));
  const main = OPTIONS.tree.includes(id.tree) ? id.tree : 'round';
  for (const [dx, dy] of [[-58, -2], [52, -8], [-30, -28], [26, -30], [-64, 8], [60, 8], [-14, 30], [8, -38], [-46, -12], [46, -16], [-52, 16]]) {
    const kind = r() < 0.7 ? main : 'bush', keep = r() < 0.8, x = cx + dx, y = cy + dy;
    if (keep && Math.hypot(x - yx, y - yy) > 14) items.push({ y, d: () => tree(p, x, y, kind, gc) });
  }
  if (lamps) items.push({ y: P1[1] - 4, d: () => lamp(p, P1[0] + 6, P1[1] - 4, factor) });
  items.push({ y: P1[1] + 6, d: () => bench(p, P1[0] - 6, P1[1] + 6) });
  const Kc = { L: [cx - R, cy], T: [cx, cy - R / 2], Rr: [cx + R, cy], Bm: [cx, cy + R / 2] }, inset = (q, f) => [cx + (q[0] - cx) * f, cy + (q[1] - cy) * f];
  const EP = { NW: ['L', 'T'], NE: ['T', 'Rr'], SE: ['Rr', 'Bm'], SW: ['Bm', 'L'] };
  for (const en of ['NW', 'NE']) if (en !== E.n) { const [a, b] = EP[en].map((k) => inset(Kc[k], 0.88)); for (let u = 0.12; u < 0.88; u += 0.06) { if (r() < 0.18) continue; const [x, y] = lerp(a, b, u).map(Math.round), s = r() < 0.3 ? 3 : 2; items.push({ y, d: () => disc(p, x, y - 2, s, LAGON.leaf, LAGON.leafL, LAGON.leafD) }); } }
  const [fa, fb] = EP[E.n === 'SW' ? 'SE' : 'SW'].map((k) => inset(Kc[k], 0.92));
  items.push({ y: lerp(fa, fb, 0.5)[1], d: () => { let prev; for (let u = 0.55; u < 0.92; u += 0.035) { const [x, y] = lerp(fa, fb, u).map(Math.round); p.rect(x, y - 4, 1, 4, '#7a5a40'); if (prev) { p.line(prev[0], prev[1] - 3, x, y - 3, '#a87a4a'); p.line(prev[0], prev[1] - 1, x, y - 1, '#8a6240'); } prev = [x, y]; } } });
  const [qx, qy] = plotPt(isl); items.push({ y: qy, d: () => plotSign(p, qx, qy, id.accent) });
  items.sort((a, b) => a.y - b.y).forEach((it) => it.d());
  return { blinks: o.blinks, smoke: o.smoke, alarm };
}

/** Place centrale : dallage, fontaine, cristal, jardinières, lampadaires, bancs, drapeaux, 4 stations. */
export function drawHub(ctx, C, hub, { factor = 0, flags = [] } = {}) {
  const p = pen(ctx, C), gc = groundColors({}), r = rng(5), cx = hub.nx, cy = hub.ny, R = hub.R, S = (R - 18) / 2, iso = (u, v) => [cx + u - v, cy + (u + v) / 2], st = LAGON.stone;
  terrain(p, cx, cy, R, r, gc);
  p.poly([[cx - R + 16, cy], [cx, cy - (R - 16) / 2], [cx + R - 16, cy], [cx, cy + (R - 16) / 2]], hs(st, -0.3));
  p.poly([[cx - R + 18, cy], [cx, cy - (R - 18) / 2], [cx + R - 18, cy], [cx, cy + (R - 18) / 2]], st);
  for (let u = -S + 8; u < S; u += 8) { const a = iso(u, -S), b = iso(u, S), c = iso(-S, u), d = iso(S, u); p.line(a[0], a[1], b[0], b[1], hs(st, -0.1)); p.line(c[0], c[1], d[0], d[1], hs(st, -0.1)); }
  for (const E of EDGES(cx, cy, R)) station(p, E, factor, true);
  const items = [{ y: cy + 4, d: () => {
    p.ell(cx, cy + 4, 22, 11, hs(st, -0.35)); p.ell(cx, cy + 3, 21, 10, hs(st, 0.08)); p.ell(cx, cy + 4, 17, 8, '#62d0d4'); p.ell(cx, cy + 5, 15, 6, '#36b3c2');
    p.rect(cx - 4, cy - 2, 8, 6, '#cfc6e0'); p.rect(cx - 4, cy - 2, 8, 1, '#e4dcf0');
    p.poly([[cx, cy - 44], [cx + 11, cy - 20], [cx, cy + 3], [cx - 11, cy - 20]], OL);
    p.poly([[cx, cy - 42], [cx, cy + 1], [cx - 9, cy - 20]], '#c58bff'); p.poly([[cx, cy - 42], [cx + 9, cy - 20], [cx, cy + 1]], '#8a5af0');
    p.line(cx - 4, cy - 26, cx - 1, cy - 36, '#f4e8ff'); p.pix(cx - 5, cy - 22, '#f4e8ff');
    if (factor > 0.3) p.glow(cx, cy - 20, 18, '#c58bff', 0.5);
  } }];
  for (const [u, v] of [[-S + 10, 0], [S - 10, 0], [0, -S + 10], [0, S - 10]]) { const [x, y] = iso(u, v); items.push({ y, d: () => { p.rect(x - 5, y - 1, 8, 3, '#9a8a78'); p.rect(x - 5, y - 1, 8, 1, '#6a4c3a'); tree(p, x - 2, y - 2, 'palm', gc); } }); }
  for (const [u, v] of [[-S + 3, -S + 3], [S - 3, -S + 3], [-S + 3, S - 3], [S - 3, S - 3]]) { const [x, y] = iso(u, v).map(Math.round); items.push({ y, d: () => lamp(p, x, y, factor) }); }
  for (const [u, v] of [[-S / 2, S - 4], [S - 4, -S / 2], [S / 2, S - 4]]) { const [x, y] = iso(u, v).map(Math.round); items.push({ y, d: () => bench(p, x, y) }); }
  flags.forEach((c, n) => { const [x, y] = (n < 4 ? iso(-S - 5, -S + 10 + n * 14) : iso(-S + 10 + (n - 4) * 14, -S - 5)).map(Math.round); items.push({ y, d: () => { p.line(x, y, x, y - 15, '#5a5460'); p.rect(x + 1, y - 15, 5, 3, c); p.pix(x + 5, y - 13, hs(c, -0.3)); } }); });
  items.sort((a, b) => a.y - b.y).forEach((it) => it.d());
}

/** Grille 64×64 → canvas (navigateur uniquement). */
export function spriteCanvas(grid, doc = globalThis.document) {
  const c = doc.createElement('canvas'); c.width = grid[0].length; c.height = grid.length;
  const g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const col = grid[y][x]; if (!col) continue;
    const i = (y * c.width + x) * 4; img.data[i] = parseInt(col.slice(1, 3), 16); img.data[i + 1] = parseInt(col.slice(3, 5), 16); img.data[i + 2] = parseInt(col.slice(5, 7), 16); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
}
```

Remarque : `spriteCanvas` lit maintenant la taille de la grille, ce qui sert aussi pour les grilles 8×13 des mini-passants. Les drapeaux sont limités à 8 (deux bords de 4). Au-delà, les drapeaux en trop se superposent, ce qui est acceptable avec 9 départements ou plus.

- [ ] **Étape 4 : lancer les tests**

Lancer : `node --test test/world.test.js`
Attendu : RÉUSSITE. Si un débordement est signalé, augmenter la marge de `nativeBounds` à l'endroit en cause (haut : `- 24` ; côtés : `R + 34`), jamais en retirant des pixels de test.

Lancer : `npm test`
Attendu : seuls les tests de `world.test.js` sont concernés et ils passent. `app.js` n'est pas importé par les tests.

- [ ] **Étape 5 : commiter**

```bash
git add public/world.js test/world.test.js
git commit -m "feat(world): îles volantes en pixels natifs, stations, bâtiments par métier"
```

---

### Tâche 6 : zooms entiers (`viewport.js`)

**Fichiers :**
- Modifier : `public/viewport.js:2`, `test/viewport.test.js`

**Interfaces :**
- Produit : `ZOOMS = [1/3, 2/3, 1, 4/3, 2]`. `nextZoom` et `zoomAt` ne changent pas de signature.

- [ ] **Étape 1 : adapter les tests (ils échouent)**

Dans `test/viewport.test.js`, remplacer la dernière ligne du deuxième test (`assert.equal(nextZoom(1, 1), 2); …`) par :

```js
  assert.equal(nextZoom(1, 1), 4 / 3); assert.equal(nextZoom(2, 1), 2); assert.equal(nextZoom(1 / 3, -1), 1 / 3);
```
et ajouter :
```js
test('chaque zoom × 3 donne un nombre entier de pixels écran par pixel natif', () => {
  assert.deepEqual(ZOOMS.map((z) => Math.round(z * 3 * 1e9) / 1e9), [1, 2, 3, 4, 6]);
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node --test test/viewport.test.js`
Attendu : ÉCHEC (ZOOMS vaut encore `[0.5, 1, 2]`).

- [ ] **Étape 3 : implémenter**

`public/viewport.js`, ligne 2 :
```js
export const ZOOMS = [1 / 3, 2 / 3, 1, 4 / 3, 2]; // × K = 3 : 1, 2, 3, 4, 6 pixels écran par pixel natif
```
Mettre à jour le commentaire de la ligne 1 : « zoom par paliers entiers (×K) ».

- [ ] **Étape 4 : lancer**

Lancer : `node --test test/viewport.test.js`
Attendu : RÉUSSITE.

- [ ] **Étape 5 : commiter**

```bash
git add public/viewport.js test/viewport.test.js
git commit -m "feat(viewport): paliers de zoom nets pour l'affichage ×3"
```

---

### Tâche 7 : rendu de la carte dans `app.js`

**Fichiers :**
- Modifier : `public/app.js` (imports, état, caches, `draw`, animation, recrutement)

**Interfaces :**
- Consomme (tâches 1, 4, 5) :
  - `pen`, `tinter` ;
  - `miniGrid` ;
  - `drawSky`, `cloud`, `drawCable`, `drawGondola`, `drawCabin`, `cableAt`, `drawBird` ;
  - `computeWorld`, `drawIsland`, `drawHub`, `nativeBounds`, `pillSpot`, `hubSpot`, `walkPath`, `hubWalks`, `cableRoutes`, `activityRate`, `LIGHT_FACTOR`, `K`, `spriteCanvas`.
- Produit (pour la tâche 8) : `state.world`, les caches à jour et `routes`. On supprime `state.placed`.

Pas de test automatique pour `app.js`, qui dépend du DOM. La vérification se fait dans le navigateur (étape 6).

- [ ] **Étape 1 : imports et état**

Remplacer les lignes d'import de `iso.js`, `sprites.js` et `world.js` par :
```js
import { tinter, mix, pen, rng } from './iso.js';
import { appearanceFor, expressionFor, spriteGrid, miniGrid, OPTIONS, hashStr } from './sprites.js';
import { computeWorld, drawIsland, drawHub, spriteCanvas, nativeBounds, pillSpot, plotSpot, buildingHit, hubSpot, walkPath, hubWalks, cableRoutes, activityRate, styledIdentity, LIGHT_FACTOR, K } from './world.js';
import { drawSky, cloud, drawCable, drawGondola, drawCabin, cableAt, drawBird } from './skyworld.js';
```
Dans `state`, retirer `placed: []`. Remplacer `const beamQueue = [], walkers = new Map();` par `const beamQueue = [], arrivals = new Map();`. Remplacer `let hubCache = null;` par `let hubCache = null, skyCache = null, routes = [];`. Supprimer la constante `ICONS`.

- [ ] **Étape 2 : caches natifs**

Remplacer `lighting`, `rebuildIslandCache` et `rebuildCaches` par :

```js
// ---------- calques en cache (pixels natifs, affichés ×K) ----------
const teamOf = (deptId) => state.agents.filter((a) => a.department_id === deptId);
function rebuildIslandCache(deptId) {
  const isl = islandOf(deptId); if (!isl) return;
  const b = nativeBounds(isl), c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
  const g = c.getContext('2d'); g.translate(-b.x, -b.y);
  const dyn = drawIsland(g, tinter(phase), isl, { factor: LIGHT_FACTOR[phase], activity: activityRate(teamOf(deptId)) });
  islandCache.set(deptId, { canvas: c, b, ny: isl.ny, dyn });
}
function rebuildCaches() {
  if (!state.world) return;
  islandCache.clear();
  for (const isl of state.world.islands) rebuildIslandCache(isl.id);
  const hub = state.world.hub, hb = nativeBounds(hub), hc = document.createElement('canvas'); hc.width = hb.w; hc.height = hb.h;
  const hg = hc.getContext('2d'); hg.translate(-hb.x, -hb.y);
  drawHub(hg, tinter(phase), hub, { factor: LIGHT_FACTOR[phase], flags: state.world.islands.map((i) => i.identity.accent) });
  hubCache = { canvas: hc, b: hb, ny: hub.ny };
  const sc = document.createElement('canvas'); sc.width = Math.ceil(state.world.width / K); sc.height = Math.ceil(state.world.height / K);
  drawSky(pen(sc.getContext('2d')), phase, sc.width, sc.height); skyCache = sc;
  routes = cableRoutes(state.world);
  draw(performance.now() / 1000);
}
```

- [ ] **Étape 3 : rendu et vie de la carte**

Remplacer `drawSky(t)` (l'ancien), `draw(t)`, `centerOf`, `drawAgents` par :

```js
// ---------- rendu ----------
const DRIFT = (() => { const r = rng(9); return Array.from({ length: 7 }, (_, k) => ({ o: r(), y: 0.05 + r() * 0.85, s: 12 + Math.round(r() * 18), v: 3 + r() * 4, front: k < 2 })); })();
const BIRDS = (() => { const r = rng(21); return Array.from({ length: 4 }, (_, k) => ({ o: k * 260 + r() * 80, y: 0.1 + r() * 0.7, v: 10 + r() * 6 })); })();
const miniCache = new Map();
function miniCanvas(look, dir, frame) { const key = `${JSON.stringify(look)}|${dir}|${frame}`; if (!miniCache.has(key)) miniCache.set(key, spriteCanvas(miniGrid(look, { dir, frame }))); return miniCache.get(key); }
const DECOR_LOOKS = Array.from({ length: 6 }, (_, k) => ({ hairStyle: OPTIONS.hairStyle[k % 6], hairColor: OPTIONS.hairColor[(k * 3) % 7], skin: OPTIONS.skin[k % 4], eyes: OPTIONS.eyes[0], outfit: OPTIONS.outfit[(k * 5) % 6], topColor: OPTIONS.topColor[(k * 3) % 8], accessory: 'none' }));
/** Va-et-vient entre a et b, pause de 2 s à chaque bout ; renvoie [x, y, direction, pas]. */
function walkAt([a, b], t, o, v = 6) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tr = d / v, T = 2 * tr + 4, u = (t + o) % T;
  let f, dir = 'down', moving = true;
  if (u < tr) f = u / tr; else if (u < tr + 2) { f = 1; moving = false; } else if (u < 2 * tr + 2) { f = 1 - (u - tr - 2) / tr; dir = 'up'; } else { f = 0; moving = false; dir = 'up'; }
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, dir, moving ? 1 + (Math.floor(t * 6 + o) % 2) : 0];
}
function drawMini(look, x, y, dir, frame) { ctx.drawImage(miniCanvas(look, dir, frame), Math.round(x) - 4, Math.round(y) - 11); }
function drawLife(p, isl, dyn, t) {
  const team = teamOf(isl.id).filter((a) => a.enabled !== false), path = walkPath(isl);
  team.slice(0, 4).forEach((a, k) => { const [x, y, dir, fr] = walkAt(path, t, k * 2.3 + isl.index); drawMini(lookOf(a), x, y, dir, fr); });
  const blink = Math.floor(t * 1.4) % 2 === 1, night = LIGHT_FACTOR[phase] > 0.3;
  for (const [x, y] of dyn.blinks) if (blink) { p.pix(x, y, '!#ff4a3d'); if (night) p.glow(x, y, 3, '#ff4a3d', 0.5); }
  for (const [x, y] of dyn.smoke) for (let k = 0; k < 4; k++) { const u = (t * 0.35 + k / 4) % 1, r = 1 + Math.round(u * 2); if (u < 0.9) p.ell(x + Math.round(u * 10 + Math.sin(u * 6 + k) * 2), y - Math.round(u * 18), r, Math.max(1, r - 1), '#e8e4dc'); }
  if (team.some((a) => a.status === 'blocked') && Math.floor(t * 2.5) % 2 === 0) { const [x, y] = dyn.alarm; p.rect(x - 1, y - 1, 2, 2, '!#ff3b30'); p.glow(x, y, 4, '#ff3b30', night ? 0.55 : 0.3); }
}
function drawHubLife(t) { hubWalks(state.world.hub).forEach((ab, k) => { const [x, y, dir, fr] = walkAt(ab, t, k * 1.7); drawMini(DECOR_LOOKS[k], x, y, dir, fr); }); }
/** Recrutement : la télécabine vient de la place (2 s), puis le mini-passant marche jusqu'à la porte (2,5 s). */
function drawArrivals(p, t) {
  for (const [id, a] of arrivals) {
    const k = t - a.start, r = routes.find((x) => x.id === a.isl.id), agent = state.agents.find((x) => x.id === id);
    if (!r || !agent || k > 4.5) { arrivals.delete(id); continue; }
    if (k < 2) { const [x, y] = cableAt(r, 1 - k / 2); drawCabin(p, x, y, r.color, LIGHT_FACTOR[phase] > 0.3); continue; }
    const [door] = walkPath(a.isl), from = [r.from[0], r.from[1] + 15], u = (k - 2) / 2.5;
    drawMini(lookOf(agent), from[0] + (door[0] - from[0]) * u, from[1] + (door[1] - from[1]) * u, 'down', 1 + (Math.floor(t * 6) % 2));
  }
}
function draw(t) {
  if (!state.world) return;
  if (canvas.width !== innerWidth || canvas.height !== innerHeight) { canvas.width = innerWidth; canvas.height = innerHeight; }
  const s = vp.zoom * K, still = reduce ? 0 : t, nw = state.world.width / K, nh = state.world.height / K, night = LIGHT_FACTOR[phase] > 0.3;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false; ctx.fillStyle = PALETTES[phase].skyBottom; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(s, 0, 0, s, -vp.x * vp.zoom, -vp.y * vp.zoom); ctx.imageSmoothingEnabled = false;
  const p = pen(ctx, tinter(phase)), driftX = (c) => Math.round(((c.o * nw + still * c.v) % (nw + 80)) - 40);
  if (skyCache) ctx.drawImage(skyCache, 0, 0);
  for (const c of DRIFT) if (!c.front) cloud(p, phase, driftX(c), Math.round(c.y * nh), c.s, 0.7);
  const layers = [...islandCache.entries()].map(([id, l]) => ({ l, isl: islandOf(id) }));
  if (hubCache) layers.push({ l: hubCache, hub: true });
  layers.sort((a, b) => a.l.ny - b.l.ny);
  for (const { l, isl, hub } of layers) { ctx.drawImage(l.canvas, l.b.x, l.b.y); if (isl) drawLife(p, isl, l.dyn, still); if (hub) drawHubLife(still); }
  for (const r of routes) { drawCable(p, r); drawGondola(p, r, still, night); }
  drawArrivals(p, t);
  for (const c of DRIFT) if (c.front) cloud(p, phase, driftX(c), Math.round(c.y * nh), c.s, 0.85);
  for (const b of BIRDS) drawBird(p, Math.round(((still * b.v + b.o) % (nw + 40)) - 20), Math.round(b.y * nh + Math.sin(still * 0.8 + b.o) * 5), Math.floor(still * 5 + b.o) % 2);
  ctx.setTransform(vp.zoom, 0, 0, vp.zoom, -vp.x * vp.zoom, -vp.y * vp.zoom);
  drawLinks(t); drawBeams(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
const centerOf = (key) => (key === 'hub' ? hubSpot(state.world.hub) : (() => { const i = islandOf(key); return i ? [i.x, pillSpot(i)[1] + 60] : null; })());
```

Garder `drawLinks` et `drawBeams` tels quels : ils utilisent `centerOf` en unités monde.

- [ ] **Étape 4 : animation, zoom, recrutement**

- Dans `frame(ts)`, remplacer `ts - last >= 40` par `ts - last >= 80` (≈ 12 images par seconde au repos).
- Dans `afterView`, remplacer le libellé par `` `${Math.round(vp.zoom * 100)} %` ``.
- Dans `refresh()` :
  - remplacer `state.world = computeWorld(departments, agents, state.styles); state.placed = placeAgents(state.world, agents);` par `state.world = computeWorld(departments, agents, state.styles);` ;
  - remplacer la boucle `for (const a of agents) { … walkers.set(…) … }` par :
```js
  for (const a of agents) { if (!firstLoad && !knownAgents.has(a.id) && !reduce) { const isl = islandOf(a.department_id); if (isl) arrivals.set(a.id, { isl, start: performance.now() / 1000 }); } knownAgents.add(a.id); }
```
- Dans `previewIsland`, la ligne `rebuildIslandCache(deptId); refreshPill(isl); if (reduce) draw(0);` reste inchangée.

- [ ] **Étape 5 : supprimer les restes**

Chercher et supprimer toute référence restante : `grep -n "placed\|walkers\|drawDesk\|doorSpot\|recruitSpot\|ICONS\|placeAgents\|islandBounds" public/app.js`. La tâche 8 traite `buildOverlay` et la recherche. Si ces fonctions cassent l'exécution en attendant, remplacer temporairement la boucle `for (const p of state.placed)` de `buildOverlay` par rien.

- [ ] **Étape 6 : vérifier dans le navigateur**

Lancer : `npm start`, puis ouvrir `http://localhost:4318` dans le panneau navigateur.
Attendu :
- aucune erreur dans la console ;
- ciel en dégradé, îles volantes avec leur dessous rocheux, un bâtiment par métier comme dans `docs/maquettes/v3-archipel.html` ;
- télécabines en mouvement, nuages qui dérivent ;
- pixels nets à tous les zooms (⅓ à 2).

Passer en « Nuit » depuis les réglages du ciel : fenêtres allumées, lampadaires avec halo.

- [ ] **Étape 7 : commiter**

```bash
git add public/app.js
git commit -m "feat(carte): rendu natif ×3, ciel, télécabines, passants et arrivée des recrues"
```

---

### Tâche 8 : boutons de la carte, recherche, éditeur et styles

**Fichiers :**
- Modifier : `public/app.js` (`buildOverlay`, `fillPill`/`refreshPill`, recherche, `islandEditor`), `public/style.css`

**Interfaces :**
- Consomme (tâche 5) : `pillSpot`, `buildingHit`, `plotSpot`, `hubSpot` (unités monde).
- Produit : des boutons `data-key="island:<id>"` (bulle), `building:<id>`, `plot:<id>`, `hub:hub`, et la fonction `markMatches()`.

- [ ] **Étape 1 : `buildOverlay`**

Remplacer la fonction entière par :

```js
function buildOverlay() {
  overlay.replaceChildren(); overlayNodes.length = 0;
  const addNode = (el, wx, wy, w, hh, ax = 0.5, ay = 0.5) => { overlay.append(el); overlayNodes.push({ el, wx, wy, w, hh, ax, ay }); };
  for (const isl of state.world.islands) {
    const d = deptOf(isl.id), team = teamOf(isl.id), hb = buildingHit(isl);
    // bâtiment : même action que la bulle, retiré du clavier et des lecteurs d'écran (la bulle suffit)
    addNode(h('button', { class: 'hit building', type: 'button', tabindex: '-1', 'aria-hidden': 'true', 'data-key': `building:${isl.id}`, onclick: () => show('island', isl.id) }), hb.x, hb.y, hb.w, hb.h, 0, 0);
    const [px, py] = pillSpot(isl), pill = h('button', { class: 'pill panel hit island', type: 'button', 'data-key': `island:${isl.id}`, onclick: () => show('island', isl.id) });
    fillPill(pill, isl, team); addNode(pill, px, py, 0, 0, 0, 0);
    const [rx, ry] = plotSpot(isl);
    addNode(h('button', { class: 'hit plot', type: 'button', 'data-key': `plot:${isl.id}`, title: `Recruter un agent — ${d.name}`, 'aria-label': `Recruter un agent — ${d.name}`, onclick: () => show('island', isl.id, { recruit: true }) }), rx, ry - 7 * K, 10 * K, 12 * K);
  }
  const [hx, hy] = hubSpot(state.world.hub);
  addNode(h('button', { class: 'hit island', type: 'button', 'data-key': 'hub:hub', 'aria-label': 'Place centrale : missions et connexions', onclick: () => show('hub', 'hub') }), hx, hy, 46 * K, 50 * K);
  markMatches(); positionOverlay(); updateMinimap(); state.world.islands.forEach(paintDot);
}
```

- [ ] **Étape 2 : mise en évidence des résultats de recherche**

Ajouter juste après `buildOverlay` :

```js
const matches = (a, q) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q);
/** Bulle d'île mise en évidence + nombre d'agents trouvés (les agents ne sont plus sur la carte). */
function markMatches() {
  const q = $('#search').value.trim().toLowerCase();
  for (const isl of state.world?.islands || []) {
    const el = overlay.querySelector(`[data-key="island:${isl.id}"]`); if (!el) continue;
    const n = q ? teamOf(isl.id).filter((a) => matches(a, q)).length : 0;
    el.classList.toggle('match', n > 0); el.querySelector('.found')?.remove();
    if (n) el.append(h('span', { class: 'found', 'aria-label': `${n} agent${n > 1 ? 's' : ''} trouvé${n > 1 ? 's' : ''}` }, String(n)));
  }
}
```
Dans `refreshPill`, ajouter `markMatches();` après `fillPill(...)`.
Dans le gestionnaire `$('#search').addEventListener('input', …)` :
- remplacer la boucle `for (const b of overlay.querySelectorAll('.hit.agent')) { … }` par `markMatches();` ;
- remplacer `const p = state.placed.find((x) => x.agent.id === a.id); if (p) centerOnWorld(p.x, p.y - 40);` par `const isl = islandOf(a.department_id); if (isl) centerOnWorld(isl.x, isl.y - 60);`.

- [ ] **Étape 3 : éditeur d'île**

Dans `islandEditor` :
- remplacer la création de `accent, floor, wall` par :
```js
  const building = choice('building', 'building', L.building, O.building), accent = choice('accent', 'accent', L.accent, Object.keys(O.accent));
```
- `const controls = [label, building, accent, ground, tree, lanterns, emblem];`
- `draft` conserve les couleurs d'intérieur déjà enregistrées (l'API remplace le style en entier) :
```js
  const draft = () => normalizeIslandStyle({ label: label.value, building: building.value, accent: accent.value, floor: saved.floor ?? null, wall: saved.wall ?? null, ground: ground.value, tree: tree.value, lanterns: lanterns.value === '' ? null : lanterns.value === '1', emblem: emblem.value });
```
- remplacer les deux `fieldset` et le champ emblème du formulaire par :
```js
  field('Bâtiment', building),
  h('fieldset', {}, h('legend', {}, 'Couleur'), field('Accent', accent)),
  h('fieldset', {}, h('legend', {}, 'Décor extérieur'), field('Terrain de l’île', ground), field('Arbres', tree), field('Lampadaires', lanterns)),
  field('Emblème', emblem),
```

- [ ] **Étape 4 : `public/style.css`**

- Ligne 35, remplacer `.hit.agent.match{…}.hit.plot:hover{…}` par :
```css
.hit.plot:hover,.hit.building:hover{background:rgba(255,255,255,.12)}.hit.building{border-radius:4px}
.pill.match{outline:3px solid var(--accent);outline-offset:2px}
.pill .found{position:absolute;top:-8px;right:-8px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--accent);color:#fff;font:700 11px var(--font);display:grid;place-items:center}
```
- Supprimer la ligne 39 (`.status-icon{…}`).

- [ ] **Étape 5 : vérifier dans le navigateur**

Lancer : `npm start`, ouvrir `http://localhost:4318`.
Vérifier :
1. Clic sur un bâtiment → la fenêtre de l'île s'ouvre.
2. Bulle au-dessus du toit, à toutes les hauteurs (tour vitrée comprise).
3. Panneau « + » → recrutement. Après confirmation : une télécabine arrive, puis le passant marche jusqu'à la porte.
4. Recherche d'un nom → la bulle de son île est encadrée et affiche le nombre d'agents trouvés. Un clic sur le résultat centre l'île.
5. Onglet Personnaliser : la liste « Bâtiment » change l'aperçu en direct ; Enregistrer, puis recharger : le bâtiment est conservé, et les couleurs sol/murs déjà en base ne sont pas effacées.
6. Navigation au clavier : Tab parcourt les bulles et les panneaux « + », pas les zones des bâtiments.

- [ ] **Étape 6 : commiter**

```bash
git add public/app.js public/style.css
git commit -m "feat(carte): bâtiments cliquables, recherche par île, choix du bâtiment dans l'éditeur"
```

---

### Tâche 9 : vérification finale

**Fichiers :** aucun nouveau. Corrections éventuelles dans les fichiers déjà touchés.

- [ ] **Étape 1 : tous les tests**

Lancer : `npm test`
Attendu : tous les tests passent, sans aucun échec.

- [ ] **Étape 2 : comparaison avec la maquette**

Ouvrir `docs/maquettes/v3-archipel.html` (Îles volantes, Lagon) et l'app côte à côte. Pour chacun des moments Matin, Midi, Soir et Nuit (réglages du ciel), et chacun des zooms 33 %, 67 %, 100 %, 133 % et 200 %, vérifier :
- pixels nets, sans flou ni trait parasite entre les îles ;
- les 8 bâtiments ont tous les détails obligatoires du tableau §7.1 de la spec ;
- la nuit : fenêtres allumées en plus grand nombre sur une île dont des agents sont « en cours ».

- [ ] **Étape 3 : cas particuliers**

- Passer un agent en statut « bloqué » (via la base ou l'API d'activité si elle est disponible) : gyrophare rouge au-dessus de la porte.
- Activer « réduire les animations » dans le système (ou l'émuler dans le navigateur) : image fixe, aucune télécabine en mouvement.
- Thème sombre du système : l'interface reste lisible.
- Créer un 9ᵉ département : il apparaît sur l'anneau extérieur avec des « Bureaux modernes ».

- [ ] **Étape 4 : commit de correction (seulement si des correctifs ont été faits)**

```bash
git add -A public test
git commit -m "fix(carte): ajustements après vérification visuelle"
```
