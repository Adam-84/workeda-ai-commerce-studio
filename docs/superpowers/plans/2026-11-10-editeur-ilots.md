# Éditeur de personnalisation des îles — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre de personnaliser chaque île de département (couleurs, nom affiché, emblème, décor extérieur) depuis un onglet « Personnaliser » de la fenêtre d'île, avec aperçu en direct sur la carte et enregistrement en SQLite.

**Architecture:** Un module pur `public/island-style.js` (options, validation, fusion avec l'identité par défaut) partagé par le client et le serveur, comme `sprites.js`. Une table `island_styles` et trois routes. `world.js` fusionne les styles dans l'identité des îles et dessine sol, arbres, lanternes, libellé et emblème. `app.js` charge les styles, redessine une seule île pour l'aperçu et expose l'éditeur dans une fenêtre à onglets accessibles.

**Tech Stack:** Node ≥ 24, `node:sqlite`, `node:test`, HTML/CSS/JS natifs, Canvas 2D. Aucune dépendance.

**Spec:** conception validée dans la conversation (voir « Décisions » ci-dessous) ; s'appuie sur `docs/superpowers/specs/2026-11-10-carte-iso-cycle-du-jour-design.md` pour l'existant.

## Décisions (rulings, issues de la consultation de Codex)

- **Jetons, pas de couleurs hexadécimales en base.** La base stocke des noms (`gold`, `ice`, `grass`…) ; `island-style.js` les traduit en couleurs. Une valeur vide (`NULL`) = valeur par défaut de l'île.
- **`PUT` = remplacement complet** : un champ absent vaut « par défaut ». `DELETE` sur un département inconnu = 404.
- **Libellé affiché sur le canvas.** La règle « le contenu de la base n'est inséré qu'en nœuds texte » vise l'injection HTML. Le panneau est dessiné par `drawPixelText`, qui ne sait dessiner que ses propres glyphes et n'interprète rien : le libellé personnalisé y est donc autorisé, mais seulement s'il ne contient que des caractères supportés. Dans le DOM (pastille, fenêtre, `aria-label`) il reste inséré en nœuds texte, et les `aria-label` gardent le vrai nom du département.
- **Teinte de phase appliquée une seule fois** : le sol fournit des couleurs de base, chacune passe une fois dans `C(...)`.
- **Mobilier inchangé**, fixe selon le métier (`FURNITURE[isl.name]`).
- **Pas de Git** : « checkpoint » = `npm test` vert.

## Global Constraints

- Aucune dépendance npm, aucune ressource externe.
- Rien n'est affiché ou animé qui ne vienne pas de SQLite ; sans style enregistré, l'île est identique à aujourd'hui.
- Contenu de la base inséré en nœuds texte dans le DOM (jamais `innerHTML`) ; seules les icônes SVG statiques existantes sont autorisées.
- `POST /api/activity` n'accepte que la source `manual` (inchangé). Tables existantes non modifiées.
- Nom affiché : 1 à 24 caractères après `trim`, uniquement des caractères pour lesquels `pixelfont.supports(label)` est vrai, sans saut de ligne.
- Tests dans `test/`, lancés par `npm test`. Ne jamais utiliser `data/workeda.db` dans les tests.

## Fichiers

| Fichier | Action | Rôle |
| --- | --- | --- |
| `public/island-style.js` | créer | options (jetons → couleurs), libellés français, `normalizeIslandStyle`, `isValidIslandStyle`, `applyStyle` |
| `public/emblems.js` | créer | 8 pictos 9×9, `drawEmblem` |
| `src/studio.js`, `src/app.js` | modifier | table `island_styles`, routes |
| `public/world.js` | modifier | fusion des styles, rendu sol / arbres / lanternes / libellé / emblème |
| `public/app.js`, `public/style.css` | modifier | chargement, cache par île, onglets, éditeur, aperçu |
| `README.md` | modifier | documentation |
| `test/island-style.test.js`, `test/emblems.test.js`, `test/island-api.test.js`, `test/world.test.js` | créer / étendre | tests |

---

### Task 1: Contrat de style et emblèmes (`public/island-style.js`, `public/emblems.js`)

**Files:**
- Create: `public/island-style.js`, `public/emblems.js`
- Test: `test/island-style.test.js`, `test/emblems.test.js`

**Interfaces:**
- Consumes: `supports(text)` de `public/pixelfont.js`.
- Produces: `OPTIONS`, `LABEL_MAX`, `STYLE_FIELDS`, `LABELS_FR`, `normalizeIslandStyle(input)` → objet à 8 clés (`null` = défaut ; `lanterns` : `null | true | false`) ou `null` si l'entrée n'est pas un objet, `isValidIslandStyle(input)` → booléen, `applyStyle(identity, style)` → nouvelle identité. De `emblems.js` : `EMBLEMS` (nom → 9 chaînes de 9 caractères `#`/`.`), `drawEmblem(ctx, name, x, y, color, scale = 1)` (x, y = coin haut gauche).

- [ ] **Step 1: Write the failing tests**

```js
// test/island-style.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, LABEL_MAX, STYLE_FIELDS, LABELS_FR, normalizeIslandStyle, isValidIslandStyle, applyStyle } from '../public/island-style.js';

const base = { accent: '#f2c14e', floor: '#e9d3a8', wall: '#efe4cc' };

test('empty and null fields mean "inherit"; unknown keys and bad values are refused', () => {
  assert.equal(isValidIslandStyle({}), true);
  assert.deepEqual(normalizeIslandStyle({ accent: '', label: '  ' }), Object.fromEntries(STYLE_FIELDS.map((k) => [k, null])));
  assert.equal(isValidIslandStyle({ accent: 'gold', floor: 'ice', wall: 'cream', ground: 'snow', tree: 'palm', emblem: 'crown', lanterns: false, label: 'Atelier' }), true);
  assert.equal(isValidIslandStyle({ accent: '#ff0000' }), false);
  assert.equal(isValidIslandStyle({ accent: 'constructor' }), false);
  assert.equal(isValidIslandStyle({ ground: 'lava' }), false);
  assert.equal(isValidIslandStyle({ emblem: 'skull' }), false);
  assert.equal(isValidIslandStyle({ lanterns: 'maybe' }), false);
  assert.equal(isValidIslandStyle({ colour: 'gold' }), false);
  assert.equal(isValidIslandStyle(null), false);
  assert.equal(isValidIslandStyle([]), false);
});

test('label: 1–24 supported characters after trim, no line break', () => {
  assert.equal(isValidIslandStyle({ label: 'Création & Co' }), false);      // « & » non supporté par la police pixel
  assert.equal(isValidIslandStyle({ label: 'Création' }), true);
  assert.equal(isValidIslandStyle({ label: 'A'.repeat(LABEL_MAX) }), true);
  assert.equal(isValidIslandStyle({ label: 'A'.repeat(LABEL_MAX + 1) }), false);
  assert.equal(isValidIslandStyle({ label: 'Haut\nBas' }), false);
  assert.equal(normalizeIslandStyle({ label: '  Atelier  ' }).label, 'Atelier');
});

test('applyStyle merges tokens over the default identity without mutating it', () => {
  const frozen = Object.freeze({ ...base });
  const out = applyStyle(frozen, { accent: 'teal', ground: 'sand', tree: 'pine', lanterns: false, emblem: 'truck', label: 'Flux' });
  assert.equal(out.accent, OPTIONS.accent.teal);
  assert.equal(out.floor, base.floor);
  assert.deepEqual([out.ground, out.tree, out.lanterns, out.emblem, out.label], ['sand', 'pine', false, 'truck', 'Flux']);
  assert.deepEqual(frozen, base);
  const plain = applyStyle(frozen, null);
  assert.deepEqual([plain.ground, plain.tree, plain.lanterns, plain.emblem, plain.label], ['grass', 'round', true, null, null]);
  assert.equal(applyStyle(frozen, { accent: 'constructor' }).accent, base.accent); // valeur invalide ignorée
});

test('every option has a French label', () => {
  for (const k of ['accent', 'floor', 'wall', 'ground']) for (const t of Object.keys(OPTIONS[k])) assert.ok(LABELS_FR[k][t], `${k}.${t}`);
  for (const k of ['tree', 'emblem']) for (const t of OPTIONS[k]) assert.ok(LABELS_FR[k][t], `${k}.${t}`);
});
```

```js
// test/emblems.test.js
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
  drawEmblem(ctx, 'unknown', 0, 0, '#fff'); // nom inconnu : ne dessine rien, ne lève pas
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/island-style.test.js test/emblems.test.js`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Implement `public/island-style.js`**

```js
// public/island-style.js — personnalisation des îles : options, validation, fusion (pur, sans DOM).
import { supports } from './pixelfont.js';

export const LABEL_MAX = 24;
export const OPTIONS = Object.freeze({
  accent: Object.freeze({ gold: '#f2c14e', blue: '#4f8fd9', violet: '#b46be0', red: '#ff6f5c', teal: '#2fb39a', orange: '#e8853d', sky: '#3b9be0', lime: '#8ac23a' }),
  floor: Object.freeze({ sand: '#e9d3a8', ice: '#cfe0f2', lilac: '#ecd3ef', rose: '#ffd8cc', mint: '#cdeee2', stone: '#e3d6c4', mist: '#d4d9f2', moss: '#e4f2cf' }),
  wall: Object.freeze({ cream: '#efe4cc', sand: '#e2d8c8', slate: '#c8ccd8', white: '#f2f4f6', rose: '#f0d9d4', mint: '#dcebe3' }),
  ground: Object.freeze({
    grass: Object.freeze({ top: '#7fd36a', left: '#7a5a44', right: '#5f4636' }),
    sand: Object.freeze({ top: '#e8c778', left: '#a8794a', right: '#8a6038' }),
    snow: Object.freeze({ top: '#eef4fa', left: '#8a96aa', right: '#6a768c' }),
    stone: Object.freeze({ top: '#c9c2b0', left: '#8a8478', right: '#6a665c' })
  }),
  tree: Object.freeze(['round', 'pine', 'palm', 'blossom']),
  emblem: Object.freeze(['crown', 'package', 'brush', 'megaphone', 'headset', 'truck', 'chart', 'flask'])
});
export const STYLE_FIELDS = Object.freeze(['label', 'accent', 'floor', 'wall', 'emblem', 'tree', 'ground', 'lanterns']);
export const LABELS_FR = Object.freeze({
  accent: { gold: 'Or', blue: 'Bleu', violet: 'Violet', red: 'Corail', teal: 'Turquoise', orange: 'Orange', sky: 'Azur', lime: 'Citron vert' },
  floor: { sand: 'Sable', ice: 'Glace', lilac: 'Lilas', rose: 'Rose', mint: 'Menthe', stone: 'Pierre', mist: 'Brume', moss: 'Mousse' },
  wall: { cream: 'Crème', sand: 'Sable', slate: 'Ardoise', white: 'Blanc', rose: 'Rose', mint: 'Menthe' },
  ground: { grass: 'Herbe', sand: 'Sable', snow: 'Neige', stone: 'Pavés' },
  tree: { round: 'Arbres ronds', pine: 'Sapins', palm: 'Palmiers', blossom: 'Cerisiers' },
  emblem: { crown: 'Couronne', package: 'Colis', brush: 'Pinceau', megaphone: 'Mégaphone', headset: 'Casque', truck: 'Camion', chart: 'Graphique', flask: 'Fiole' }
});

const blank = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

/** Objet à 8 clés (null = « par défaut ») ou null si l'entrée n'est pas un objet. Ne valide pas les valeurs. */
export function normalizeIslandStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const k of STYLE_FIELDS) {
    let v = input[k];
    if (typeof v === 'string' && k === 'label') v = v.trim();
    if (blank(v)) { out[k] = null; continue; }
    if (k === 'lanterns') out[k] = v === true || v === 1 || v === '1' ? true : v === false || v === 0 || v === '0' ? false : undefined;
    else out[k] = v;
  }
  return out;
}

export function isValidIslandStyle(input) {
  const s = normalizeIslandStyle(input);
  if (!s) return false;
  if (Object.keys(input).some((k) => !STYLE_FIELDS.includes(k))) return false;
  const okLabel = s.label === null || (typeof s.label === 'string' && [...s.label].length <= LABEL_MAX && !/[\r\n\t]/.test(s.label) && supports(s.label));
  const okMap = (k) => s[k] === null || has(OPTIONS[k], s[k]);
  const okList = (k) => s[k] === null || OPTIONS[k].includes(s[k]);
  return okLabel && okMap('accent') && okMap('floor') && okMap('wall') && okMap('ground') && okList('tree') && okList('emblem') && (s.lanterns === null || typeof s.lanterns === 'boolean');
}

/** Fusionne un style (jetons) dans une identité par défaut ; valeurs invalides ignorées ; ne mute rien. */
export function applyStyle(identity, style) {
  const s = normalizeIslandStyle(style) || {};
  const pick = (map, key, fallback) => (has(map, key) ? map[key] : fallback);
  return {
    ...identity,
    accent: pick(OPTIONS.accent, s.accent, identity.accent),
    floor: pick(OPTIONS.floor, s.floor, identity.floor),
    wall: pick(OPTIONS.wall, s.wall, identity.wall),
    ground: has(OPTIONS.ground, s.ground) ? s.ground : identity.ground || 'grass',
    tree: OPTIONS.tree.includes(s.tree) ? s.tree : identity.tree || 'round',
    lanterns: typeof s.lanterns === 'boolean' ? s.lanterns : identity.lanterns ?? true,
    emblem: OPTIONS.emblem.includes(s.emblem) ? s.emblem : identity.emblem || null,
    label: typeof s.label === 'string' && s.label && [...s.label].length <= LABEL_MAX && supports(s.label) ? s.label : identity.label || null
  };
}
```

- [ ] **Step 4: Implement `public/emblems.js`**

Dessine les 8 pictos **toi-même**, en grille 9×9 (`#` allumé, `.` éteint), lisibles à cette taille : `crown` (couronne à 3 pointes), `package` (boîte avec ruban), `brush` (pinceau en diagonale), `megaphone` (cône + ondes), `headset` (arceau + deux écouteurs), `truck` (cabine + benne + roues), `chart` (3 barres croissantes), `flask` (fiole à col étroit avec liquide). Chacun entre 12 et 60 pixels allumés, tous distincts.

```js
// public/emblems.js — pictos pixel 9×9 (originaux) pour les panneaux et pastilles d'île.
export const EMBLEMS = Object.freeze({
  crown: [/* 9 chaînes de 9 caractères '#' / '.' */],
  package: [/* … */], brush: [/* … */], megaphone: [/* … */],
  headset: [/* … */], truck: [/* … */], chart: [/* … */], flask: [/* … */]
}); // ← remplacer les tableaux ci-dessus par les 8 dessins finis ; le test refuse toute grille incomplète

export function drawEmblem(ctx, name, x, y, color, scale = 1) {
  const rows = EMBLEMS[name];
  if (!rows) return;
  ctx.fillStyle = color;
  rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') ctx.fillRect(x + i * scale, y + j * scale, scale, scale); }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/island-style.test.js test/emblems.test.js`
Expected: PASS (4 + 2 tests).

- [ ] **Step 6: Checkpoint** — `npm test` vert.

---

### Task 2: Persistance et routes (`src/studio.js`, `src/app.js`)

**Files:**
- Modify: `src/studio.js` (import, schéma `db.exec`, helpers, objet retourné), `src/app.js` (routes)
- Test: `test/island-api.test.js`

**Interfaces:**
- Consumes: `isValidIslandStyle`, `normalizeIslandStyle` (Task 1).
- Produces: `studio.listIslandStyles()` → `[{ departmentId, label, accent, floor, wall, emblem, tree, ground, lanterns, updatedAt }]` (`lanterns` : `null | true | false`) ; `studio.setIslandStyle(departmentId, input)` ; `studio.clearIslandStyle(departmentId)` ; routes `GET /api/island-styles`, `PUT /api/departments/:id/style`, `DELETE /api/departments/:id/style`.

- [ ] **Step 1: Write the failing test**

```js
// test/island-api.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';

async function withApp(fn) {
  const studio = createStudio(':memory:');
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  try { await fn({ studio, call }); } finally { server.close(); studio.close(); }
}

test('a style is saved as a full replacement, listed, journaled and reset', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  assert.deepEqual((await call('GET', '/api/island-styles')).data, []);
  const put = await call('PUT', `/api/departments/${dept.id}/style`, { accent: 'teal', ground: 'snow', lanterns: false, label: 'Pilotage' });
  assert.equal(put.status, 200);
  assert.deepEqual([put.data.accent, put.data.ground, put.data.lanterns, put.data.label, put.data.floor], ['teal', 'snow', false, 'Pilotage', null]);
  const second = await call('PUT', `/api/departments/${dept.id}/style`, { tree: 'palm' });   // remplacement complet : le reste revient à « défaut »
  assert.deepEqual([second.data.tree, second.data.accent, second.data.label], ['palm', null, null]);
  const list = (await call('GET', '/api/island-styles')).data;
  assert.equal(list.length, 1); assert.equal(list[0].departmentId, dept.id);
  assert.ok(studio.listAllEvents?.() ?? true);
  assert.equal((await call('DELETE', `/api/departments/${dept.id}/style`)).status, 200);
  assert.deepEqual((await call('GET', '/api/island-styles')).data, []);
}));

test('invalid values are refused (400), unknown departments are 404, existing data untouched', () => withApp(async ({ studio, call }) => {
  const dept = studio.listDepartments()[0];
  const before = JSON.stringify(studio.listDepartments());
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { accent: '#ff0000' })).status, 400);
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { label: 'Création & Co' })).status, 400);
  assert.equal((await call('PUT', `/api/departments/${dept.id}/style`, { couleur: 'gold' })).status, 400);
  assert.equal((await call('PUT', '/api/departments/inconnu/style', { accent: 'gold' })).status, 404);
  assert.equal((await call('DELETE', '/api/departments/inconnu/style')).status, 404);
  assert.deepEqual((await call('GET', '/api/island-styles')).data, []);
  assert.equal(JSON.stringify(studio.listDepartments()), before);
}));
```

(La ligne `assert.ok(studio.listAllEvents?.() ?? true)` est un marqueur : remplace-la par un contrôle réel du journal — l'événement `island.style.updated` doit exister dans la table `events` avec `agent_id` nul ; lis-le par `studio`-interne si besoin en exposant dans le test une requête sur la base via une petite méthode de lecture déjà existante, ou en ajoutant `listIslandEvents()` à `studio.js` qui renvoie `SELECT kind, detail, source FROM events WHERE agent_id IS NULL ORDER BY rowid DESC`. Choisis la seconde option et teste `kind`, `source === 'manual'` et que `detail` contient le nom du département.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/island-api.test.js`
Expected: FAIL (404 sur les routes).

- [ ] **Step 3: Implement**

`src/studio.js` — en tête :

```js
import { isValidIslandStyle, normalizeIslandStyle } from '../public/island-style.js';
```

Dans le `db.exec`, après `agent_appearance` :

```sql
    CREATE TABLE IF NOT EXISTS island_styles (department_id TEXT PRIMARY KEY REFERENCES departments(id), label TEXT, accent TEXT, floor TEXT, wall TEXT, emblem TEXT, tree TEXT, ground TEXT, lanterns INTEGER, updated_at TEXT NOT NULL);
```

Avant `return {` :

```js
  const mapIslandStyle = (r) => ({ departmentId: r.department_id, label: r.label, accent: r.accent, floor: r.floor, wall: r.wall, emblem: r.emblem, tree: r.tree, ground: r.ground, lanterns: r.lanterns === null ? null : Boolean(r.lanterns), updatedAt: r.updated_at });
  const requireDepartment = (id) => { const d = one('SELECT id, name FROM departments WHERE id = ?', id); if (!d) throw Object.assign(new Error('Département introuvable.'), { status: 404 }); return d; };
```

Dans l'objet retourné (avant `close`) :

```js
    listIslandStyles: () => db.prepare('SELECT * FROM island_styles').all().map(mapIslandStyle),
    listIslandEvents: () => db.prepare("SELECT kind, detail, source FROM events WHERE agent_id IS NULL AND kind LIKE 'island.style.%' ORDER BY rowid DESC").all(),
    setIslandStyle(departmentId, input) {
      const dept = requireDepartment(departmentId);
      if (!isValidIslandStyle(input)) throw Object.assign(new Error('Style d’île invalide.'), { status: 400 });
      const s = normalizeIslandStyle(input);
      db.prepare(`INSERT INTO island_styles (department_id, label, accent, floor, wall, emblem, tree, ground, lanterns, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(department_id) DO UPDATE SET label = excluded.label, accent = excluded.accent, floor = excluded.floor, wall = excluded.wall, emblem = excluded.emblem, tree = excluded.tree, ground = excluded.ground, lanterns = excluded.lanterns, updated_at = excluded.updated_at`)
        .run(departmentId, s.label, s.accent, s.floor, s.wall, s.emblem, s.tree, s.ground, s.lanterns === null ? null : Number(s.lanterns), now());
      emit(null, 'island.style.updated', `Style de l’île ${dept.name} modifié.`, 'manual', true);
      return one('SELECT * FROM island_styles WHERE department_id = ?', departmentId, mapIslandStyle);
    },
    clearIslandStyle(departmentId) {
      const dept = requireDepartment(departmentId);
      db.prepare('DELETE FROM island_styles WHERE department_id = ?').run(departmentId);
      emit(null, 'island.style.reset', `Identité d’origine de l’île ${dept.name} rétablie.`, 'manual', true);
      return { departmentId, reset: true };
    },
```

`src/app.js` — ajouter dans `routes` :

```js
    'GET /api/island-styles': () => studio.listIslandStyles(),
```

et dans `paramRoutes` :

```js
    ['PUT', /^\/api\/departments\/([^/]+)\/style$/, (m, data) => studio.setIslandStyle(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/departments\/([^/]+)\/style$/, (m) => studio.clearIslandStyle(decodeURIComponent(m[1]))]
```

(`hasBody` couvre déjà `PUT`.)

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (nouveaux tests + existants, dont `POST /api/activity` inchangé).

- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 3: Fusion des styles et rendu (`public/world.js`)

**Files:**
- Modify: `public/world.js` (imports, `identityFor` voisinage, `computeWorld`, `drawIsland`)
- Test: `test/world.test.js` (ajouts)

**Interfaces:**
- Consumes: `applyStyle`, `OPTIONS` (Task 1), `drawEmblem` (Task 1), `drawPixelText`, `textWidth`.
- Produces: `styledIdentity(name, index, style)` → identité fusionnée ; `computeWorld(departments, agents = [], styles = [])` où `styles` est un tableau d'objets `{ departmentId, … }` **ou** une `Map` departmentId → style ; chaque île porte `identity` (avec `ground`, `tree`, `lanterns`, `emblem`, `label`) et `label` (libellé affiché = `identity.label || name`). `name` reste le vrai nom (mobilier, accessibilité). `drawIsland` lit `identity.ground/tree/lanterns/emblem` et `isl.label`.

- [ ] **Step 1: Write the failing tests** (ajouter à `test/world.test.js`)

```js
import { styledIdentity } from '../public/world.js';
import { tinter } from '../public/iso.js';

const colorsDrawn = (isl, phase = 'noon') => { const seen = new Set(); const ctx = { set fillStyle(v) { seen.add(v); }, set globalAlpha(v) {}, fillRect() {} }; drawIsland(ctx, tinter(phase), isl, { lit: false, neon: false }); return seen; };

test('styles are merged by department id; unstyled islands keep their identity', () => {
  const { s, d } = seeded();
  const lab = d.find((x) => x.name === 'Laboratoire');
  const plain = computeWorld(d);
  const styled = computeWorld(d, [], [{ departmentId: lab.id, accent: 'gold', label: 'Recherche', ground: 'sand', lanterns: false, emblem: 'flask' }]);
  const a = plain.islands.find((i) => i.id === lab.id), b = styled.islands.find((i) => i.id === lab.id);
  assert.notEqual(a.identity.accent, b.identity.accent);
  assert.equal(b.label, 'Recherche'); assert.equal(b.name, 'Laboratoire');
  assert.equal(a.label, 'Laboratoire');
  assert.deepEqual(plain.islands.filter((i) => i.id !== lab.id).map((i) => i.identity), styled.islands.filter((i) => i.id !== lab.id).map((i) => i.identity));
  assert.deepEqual(styled.islands.map((i) => [i.x, i.y]), plain.islands.map((i) => [i.x, i.y]));  // le style ne déplace rien
  const m = computeWorld(d, [], new Map([[lab.id, { ground: 'snow' }]]));                         // Map acceptée aussi
  assert.equal(m.islands.find((i) => i.id === lab.id).identity.ground, 'snow');
  s.close();
});

test('an unknown department id in styles is ignored; an added department gets default style', () => {
  const { s, d } = seeded(); s.createDepartment({ name: 'Juridique' });
  const w = computeWorld(s.listDepartments(), [], [{ departmentId: 'inconnu', accent: 'gold' }]);
  assert.equal(w.islands.length, 9); assert.equal(w.islands[8].label, 'Juridique');
  s.close();
});

test('ground, tree, lanterns and emblem change what is drawn; tint is applied once per colour', () => {
  const { s, d } = seeded(); const base = computeWorld(d).islands[0];
  const withStyle = (st) => ({ ...base, identity: styledIdentity(base.name, base.index, st) });
  assert.ok(colorsDrawn(base).has('#7fd36a'));                                         // sol herbe par défaut
  assert.ok(!colorsDrawn(withStyle({ ground: 'sand' })).has('#7fd36a'));
  assert.ok(colorsDrawn(withStyle({ ground: 'sand' })).has('#e8c778'));
  for (const tree of ['round', 'pine', 'palm', 'blossom']) assert.ok(colorsDrawn(withStyle({ tree })).size > 20, tree);
  const noLantern = colorsDrawn(withStyle({ lanterns: false })), lantern = colorsDrawn(withStyle({ lanterns: true }));
  assert.ok(lantern.has('#c9b48f') && !noLantern.has('#c9b48f'));                       // lanterne éteinte de jour
  assert.ok(colorsDrawn(withStyle({ emblem: 'crown' }), 'noon').size >= colorsDrawn(base).size);
  const night = colorsDrawn(withStyle({ ground: 'snow' }), 'night');
  assert.ok(!night.has('#eef4fa'));                                                     // la phase teinte bien le sol personnalisé
  s.close();
});

test('custom island still draws inside its bounds', () => {
  const { s, d } = seeded(); const base = computeWorld(d).islands[3]; const b = islandBounds(base);
  const isl = { ...base, label: 'ATELIER DE CRÉATION', identity: styledIdentity(base.name, base.index, { tree: 'palm', emblem: 'truck', label: 'ATELIER DE CRÉATION' }) };
  const rects = []; const ctx = { set fillStyle(v) {}, set globalAlpha(v) {}, fillRect: (x, y, w, h) => rects.push([x, y, w, h]) };
  drawIsland(ctx, tinter('evening'), isl, { lit: true, neon: false });
  assert.ok(rects.every(([x, y, w, h]) => x >= b.x - 2 && x + w <= b.x + b.w + 2 && y >= b.y - 2 && y + h <= b.y + b.h + 2));
  s.close();
});
```

(Si `islandBounds` n'est pas encore importé dans ce fichier de test, l'importer ; réutilise l'aide `seeded()` existante.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/world.test.js`
Expected: FAIL (`styledIdentity` absent, etc.).

- [ ] **Step 3: Implement in `public/world.js`**

1. Imports : `import { applyStyle, OPTIONS } from './island-style.js'; import { drawEmblem } from './emblems.js';`
2. Après `identityFor`, ajouter :

```js
export const styledIdentity = (name, index, style) => applyStyle(identityFor(name, index), style);
```

3. `computeWorld(departments, agents = [], styles = [])` : construire `const byDept = styles instanceof Map ? styles : new Map((styles || []).map((s) => [s.departmentId, s]));` ; dans la création de chaque île, remplacer `identity: identityFor(d.name, k)` par `identity, label: identity.label || d.name` avec `const identity = styledIdentity(d.name, k, byDept.get(d.id));` calculée avant le `return` de l'objet île. (Le reste, dont les bornes du monde, est inchangé : le style ne modifie pas la géométrie.)
4. Dans `drawIsland` :
   - Sol : `const g = OPTIONS.ground[id.ground] || OPTIONS.ground.grass;` et `prism(ctx, x, y, R, H, C(g.top), C(g.left), C(g.right));` à la place des trois couleurs codées en dur de la ligne 94 (la roche des lignes 92-93 ne change pas).
   - Arbres : remplacer l'appel `tree(...)` par `drawTree(ctx, C, id.tree || 'round', …)` avec la nouvelle fonction ci-dessous.
   - Lanterne : `if (id.lanterns !== false) lantern(ctx, x - 80, y + 70, lit);`.
   - Panneau : `const label = isl.label || isl.name, hasEmblem = !!id.emblem, w = textWidth(label) + 16 + (hasEmblem ? 12 : 0);` ; dessiner le fond avec cette largeur ; texte décalé de 6 px à droite quand il y a un emblème, et `drawEmblem(ctx, id.emblem, Math.round(sx - w / 2 + 5), sy + 2, neon ? id.accent : '#fff6e0');`.
5. Ajouter `drawTree` (la variante `round` reprend exactement le dessin actuel de `tree`) :

```js
function drawTree(ctx, C, kind, x, y) {
  if (kind === 'pine') {
    ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 2, y - 12, 5, 12);
    [[26, 0], [20, 14], [14, 26]].forEach(([w, up]) => fillPoly(ctx, [[x - w / 2 - 1, y - 12 - up + 1], [x + w / 2 + 1, y - 12 - up + 1], [x, y - 34 - up]], OL) );
    [[26, 0], [20, 14], [14, 26]].forEach(([w, up]) => fillPoly(ctx, [[x - w / 2, y - 12 - up], [x + w / 2, y - 12 - up], [x, y - 32 - up]], C('#2f7a4a')));
    return;
  }
  if (kind === 'palm') {
    ctx.fillStyle = '#8f6544'; for (let k = 0; k < 6; k++) ctx.fillRect(x - 2 + Math.round(k * 0.6), y - 8 - k * 6, 5, 7);
    const hx = x + 4, hy = y - 44;
    ctx.fillStyle = C('#3f9a45'); for (const [dx, dy, w] of [[-16, 2, 14], [-10, -6, 12], [4, -6, 12], [8, 2, 14], [-4, -10, 8]]) ctx.fillRect(hx + dx, hy + dy, w, 4);
    return;
  }
  if (kind === 'blossom') {
    ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 3, y - 16, 6, 16);
    disc(ctx, x, y - 30, 17, C('#e58fb8'), OL); disc(ctx, x - 5, y - 35, 6, C('#f6c4da'));
    return;
  }
  ctx.fillStyle = '#6f5547'; ctx.fillRect(x - 3, y - 16, 6, 16); disc(ctx, x, y - 30, 17, C('#4fa83c'), OL); disc(ctx, x - 5, y - 35, 6, C('#7fd36a'));
}
```

Supprimer l'ancienne fonction `tree` si plus aucun appel ne l'utilise (le hub n'en a pas ; vérifier par `grep`).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (tests de monde existants inclus : un île sans style dessine toujours la couleur d'herbe `#7fd36a`).

- [ ] **Step 5: Checkpoint** — `npm test` vert.

---

### Task 4: Chargement, aperçu et éditeur (`public/app.js`, `public/style.css`)

**Files:**
- Modify: `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: `computeWorld(departments, agents, styles)`, `styledIdentity`, `drawEmblem`, `islandBounds` (Task 3) ; `OPTIONS`, `LABELS_FR`, `LABEL_MAX`, `normalizeIslandStyle`, `isValidIslandStyle` (Task 1) ; routes `GET /api/island-styles`, `PUT` / `DELETE /api/departments/:id/style` (Task 2).
- Produces: `state.styles` (`Map` departmentId → style enregistré), `rebuildIslandCache(deptId)`, `previewIsland(deptId, draft)`, `restoreIsland(deptId)`, helper d'onglets `tabset(...)`, fenêtre d'île à onglets Agents / Missions / Personnaliser.

Cette tâche n'a pas de test unitaire de navigateur : vérifie avec `node --check public/app.js`, `npm test`, puis le contrôleur fait la vérification dans le navigateur.

- [ ] **Step 1: Chargement des styles**

- Importer `styledIdentity` et `drawEmblem` depuis `./world.js` / `./emblems.js`, et `OPTIONS, LABELS_FR, LABEL_MAX, normalizeIslandStyle, isValidIslandStyle` depuis `./island-style.js`.
- `state` gagne `styles: new Map()`.
- `refresh()` ajoute `get('/api/island-styles')` au `Promise.all`, remplit `state.styles = new Map(list.map((s) => [s.departmentId, s]))`, et appelle `computeWorld(departments, agents, state.styles)`.

- [ ] **Step 2: Cache par île et aperçu en direct (sans toucher aux autres îles)**

- Extraire de `rebuildCaches()` la partie « dessiner une île dans son canvas » en `rebuildIslandCache(deptId)` (même code : `islandBounds`, canvas, `drawIsland`, `islandCache.set`). `rebuildCaches()` l'appelle pour chaque île puis redessine le hub.
- Ajouter :

```js
export function previewIsland(deptId, draft) {
  const isl = islandOf(deptId); if (!isl) return;
  isl.identity = styledIdentity(isl.name, isl.index, draft);
  isl.label = isl.identity.label || isl.name;
  rebuildIslandCache(deptId); refreshPill(isl); if (reduce) draw(0);
}
export const restoreIsland = (deptId) => previewIsland(deptId, state.styles.get(deptId) || null);
```

- Pastille : extraire la construction du contenu en `fillPill(pillEl, isl, team)` qui remplit `.sw` (couleur d'accent), le nom **affiché** `isl.label` (nœud texte), le petit emblème (un `<canvas class="emblem" width="9" height="9">` dessiné par `drawEmblem`, couleur `isl.identity.accent`) et les initiales. `buildOverlay` l'utilise ; `refreshPill(isl)` retrouve le bouton `[data-key="island:<id>"]` et rappelle `fillPill`. **N'appelle jamais `buildOverlay()` pendant l'aperçu** (il remplacerait les nœuds et ferait perdre le focus). L'`aria-label` de la pastille garde le vrai nom du département. Mettre à jour aussi la couleur du point du mini-plan (ajouter `data-id` aux points et ajuster `style.background`).

- [ ] **Step 3: Fenêtre à onglets accessibles**

- Ajouter un helper réutilisable :

```js
let tabSeq = 0;
function tabset(defs, initial = 0, onChange = () => {}) {
  // defs : [{ label, render: () => Node }]
  const uid = ++tabSeq, panel = h('div', { role: 'tabpanel', id: `tp-${uid}`, tabindex: '0' });
  const btns = defs.map((d, k) => h('button', { class: 'tab', type: 'button', role: 'tab', id: `tb-${uid}-${k}`, 'aria-controls': `tp-${uid}`, 'aria-selected': 'false', tabindex: '-1', onclick: () => select(k, true) }, d.label));
  const list = h('div', { class: 'tabs', role: 'tablist', onkeydown: (e) => { const i = btns.indexOf(document.activeElement); const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: btns.length - 1 }[e.key]; if (n !== undefined && i >= 0) { e.preventDefault(); select((n + btns.length) % btns.length, true); } } }, btns);
  function select(k, focus) { btns.forEach((b, j) => { b.setAttribute('aria-selected', String(j === k)); b.tabIndex = j === k ? 0 : -1; }); panel.setAttribute('aria-labelledby', `tb-${uid}-${k}`); panel.replaceChildren(defs[k].render()); if (focus) btns[k].focus(); onChange(k); }
  select(initial, false);
  return { el: h('div', {}, list, panel), select };
}
```

- `islandView(id, opts)` utilise `tabset` : onglet **Agents** (le contenu actuel : liste d'agents, « Recruter un agent » avec confirmation — `opts.recruit` ouvre cet onglet et clique le bouton), onglet **Missions** (la liste actuelle), onglet **Personnaliser** (Step 4). `opts.tab === 'custom'` ouvre Personnaliser.
- Réutiliser `tabset` aussi pour `agentView` à la place des onglets actuels (résout le défaut mineur noté : rôles `tab`/`tabpanel`, flèches ; après un enregistrement, rouvrir l'onglet où l'on était).
- `close()` et `show()` appellent d'abord un crochet `closeHook` (variable de module, `null` par défaut) puis le remettent à `null` : l'éditeur y enregistre `() => restoreIsland(deptId)`. Ainsi fermer (Échap, croix, clic hors fenêtre) ou passer à une autre fenêtre annule l'aperçu non enregistré.

- [ ] **Step 4: L'onglet Personnaliser**

À l'activation : `centerOnWorld(isl.x, isl.y - 60)` et `closeHook = () => restoreIsland(id)`. Construire un formulaire (vrais `label`/`select`/`input`, `fieldset`+`legend` par famille) préremplie avec le style enregistré (`state.styles.get(id)`), sinon « Par défaut » partout :

- `Nom affiché` : `<input maxlength="24" placeholder="<vrai nom>">` + aide « Laisser vide pour garder le nom du département. Lettres, chiffres, espace, point, tiret et apostrophe. » ;
- fieldset **Couleurs** : trois `<select>` accent / sol de la pièce / murs, option « Par défaut » puis les jetons avec `LABELS_FR` ;
- fieldset **Décor extérieur** : `select` sol de la plateforme, `select` arbres, `select` lanternes (Par défaut / Oui / Non) ;
- **Emblème** : `select` (Aucun puis les 8) ;
- boutons : **Enregistrer** (primaire), **Annuler**, **Revenir à l'identité d'origine**.

Comportement :
1. À chaque `change`/`input`, lire le formulaire en `draft` (`lanterns` : `''→null`, `'1'→true`, `'0'→false`), appeler `previewIsland(id, draft)` et annoncer « Aperçu mis à jour » dans `#live` (dédoublonné : n'annoncer que si le texte change, au plus une fois par seconde).
2. Avant d'enregistrer, `isValidIslandStyle(draft)` ; sinon afficher un message visible `role="alert"` (« Le nom ne peut contenir que… » si le libellé est en cause).
3. **Enregistrer** : `PUT /api/departments/<id>/style` avec le brouillon ; en cas d'erreur serveur afficher son message dans l'alerte et garder l'aperçu ; en cas de succès `closeHook = null`, `await refresh()`, `show('island', id, { tab: 'custom' })` et annoncer « Île enregistrée ».
4. **Annuler** : `restoreIsland(id)`, `closeHook = null`, rouvrir l'onglet Agents.
5. **Revenir à l'identité d'origine** : si un style est enregistré `DELETE`, puis `refresh()` ; sinon remettre le formulaire sur « Par défaut » ; dans les deux cas annoncer le résultat.

Aucune valeur de la base n'est insérée par `innerHTML` : libellés, valeurs et messages passent par `h()`/`textContent`.

- [ ] **Step 5: CSS**

Ajouter dans `public/style.css` : `.emblem{width:18px;height:18px;image-rendering:pixelated;flex:none}` (canvas 9×9 affiché ×2), `fieldset{border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin:8px 0}`, `legend{font-size:12px;color:var(--soft);padding:0 4px}`, `[role=tabpanel]:focus-visible` (outline existant), et vérifier que les `select` / `fieldset` restent lisibles dans les 4 phases (texte `var(--text)`, fond `var(--panel-solid)` déjà défini pour `option`). Mobile : le formulaire défile dans la feuille basse (`#pop` a déjà `overflow:auto`).

- [ ] **Step 6: Verify**

Run: `node --check public/app.js` puis `npm test` → tous verts. Démarrer le serveur sur une base temporaire (`WORKEDA_DB=… PORT=…`) et vérifier que `/app.js`, `/island-style.js`, `/emblems.js`, `/api/island-styles` répondent 200. Le contrôleur fait la vérification dans le navigateur.

- [ ] **Step 7: Checkpoint** — `npm test` vert.

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Ajouter une section « Personnaliser une île » : ouverture (fenêtre d'île → onglet Personnaliser), les réglages (couleurs, nom affiché, emblème, décor extérieur), l'aperçu en direct, Annuler / Enregistrer / Revenir à l'identité d'origine, le fait que le mobilier reste lié au métier et que le vrai nom du département n'est jamais modifié. Documenter la table `island_styles` (ajout sans toucher aux tables existantes), les routes `GET /api/island-styles`, `PUT /api/departments/:id/style` (remplacement complet, `NULL` = défaut, 400 si valeur inconnue, 404 si département inconnu) et `DELETE`, ainsi que les caractères autorisés dans le nom affiché.
- [ ] **Step 2:** `npm test` vert ; démarrer le serveur sur la vraie base en **lecture seule** (`GET` uniquement) pour vérifier `/`, `/api/island-styles`, `/api/departments` → 200 (la table se crée au démarrage via `CREATE TABLE IF NOT EXISTS`, sans toucher aux données).
- [ ] **Step 3: Checkpoint** — `npm test` vert.

---

## Self-review

- **Couverture** : réglages couleurs / nom / emblème / décor → Tasks 1 et 3 ; mobilier fixe → inchangé (`FURNITURE[isl.name]`) ; onglet dans la fenêtre → Task 4 ; aperçu en direct sur la carte avec annulation → Task 4 (`previewIsland`, `restoreIsland`, `closeHook`) ; stockage et validation → Tasks 1 et 2 ; sécurité du libellé → décision + Task 1 (`supports`) + Task 4 (nœuds texte).
- **Types** : `normalizeIslandStyle` / `isValidIslandStyle` / `applyStyle` (Task 1) ↔ usages dans Tasks 2, 3, 4 ; `styledIdentity` / `computeWorld(…, styles)` (Task 3) ↔ `app.js` (Task 4) ; forme de ligne API `{ departmentId, …, updatedAt }` ↔ `new Map(list.map((s) => [s.departmentId, s]))`.
- **Point à surveiller** : Task 1, `emblems.js` demande à l'implémenteur de dessiner les 8 pictos ; le test impose 9×9, 12 à 60 pixels, tous distincts. Un contrôle visuel des emblèmes est fait par le contrôleur dans le navigateur.
