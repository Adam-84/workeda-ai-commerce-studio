// test/world.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';
import { computeWorld, placeAgents, deskSpots, ISLAND, GRID, styledIdentity } from '../public/world.js';

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

import { drawIsland, drawHub, drawDesk, islandBounds } from '../public/world.js';
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

test('computeWorld : une île agrandie (31 agents) reste dans le monde', () => {
  const agents = Array.from({ length: 31 }, (_, k) => ({ id: `a${k}`, name: `A${k}`, role: 'r', department_id: 'd1', created_at: `2026-01-01T00:00:${String(k).padStart(2, '0')}` }));
  const w = computeWorld([{ id: 'd1', name: 'Direction' }], agents);
  const b = islandBounds(w.islands[0]);
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= w.width && b.y + b.h <= w.height, JSON.stringify({ b, w: w.width, h: w.height }));
});

const fillsOf = (isl, phase = 'noon', opts = {}) => { const out = []; let c; const ctx = { set fillStyle(v) { c = v; }, set globalAlpha(v) {}, fillRect() { out.push(c); } }; drawIsland(ctx, tinter(phase), isl, { lit: false, neon: false, ...opts }); return out; };
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
  assert.ok(!colorsDrawn(withStyle({ ground: 'sand', tree: 'pine' })).has('#7fd36a'));
  assert.ok(colorsDrawn(withStyle({ ground: 'sand', tree: 'pine' })).has('#e8c778'));
  const leaf = { round: '#4fa83c', pine: '#2f7a4a', palm: '#3f9a45', blossom: '#e58fb8' };
  for (const [tree, col] of Object.entries(leaf)) {
    const seen = colorsDrawn(withStyle({ tree })); assert.ok(seen.size > 20, tree); assert.ok(seen.has(col), tree);
    if (tree !== 'round') assert.ok(!seen.has(leaf.round), tree);
  }
  const noLantern = colorsDrawn(withStyle({ lanterns: false })), lantern = colorsDrawn(withStyle({ lanterns: true }));
  assert.ok(lantern.has('#c9b48f') && !noLantern.has('#c9b48f'));                       // lanterne éteinte de jour
  assert.ok(fillsOf(withStyle({ emblem: 'crown' })).length > fillsOf(base).length);     // l'emblème ajoute des pixels
  const acc = base.identity.accent, nAcc = (isl) => fillsOf(isl, 'noon', { neon: true }).filter((c) => c === acc).length;
  assert.ok(nAcc(withStyle({ emblem: 'crown' })) > nAcc(base));                         // en néon, l'emblème est à la couleur d'accent
  const night = colorsDrawn(withStyle({ ground: 'snow' }), 'night');
  assert.ok(!night.has('#eef4fa') && night.has(tinter('night')('#eef4fa')));             // la phase teinte bien le sol personnalisé, une seule fois
  s.close();
});

test('a null element in styles does not throw', () => {
  const { s, d } = seeded(); assert.equal(computeWorld(d, [], [null, undefined]).islands.length, 8); s.close();
});

test('custom island still draws inside its bounds', () => {
  const { s, d } = seeded(); const base = computeWorld(d).islands[3]; const b = islandBounds(base);
  const label = 'ATELIER DE CREATION NOIR'; assert.equal(label.length, 24);            // pire cas : libellé de 24 caractères
  const isl = { ...base, label, identity: styledIdentity(base.name, base.index, { tree: 'palm', emblem: 'truck', label }) };
  const rects = []; const ctx = { set fillStyle(v) {}, set globalAlpha(v) {}, fillRect: (x, y, w, h) => rects.push([x, y, w, h]) };
  drawIsland(ctx, tinter('evening'), isl, { lit: true, neon: false });
  assert.ok(rects.every(([x, y, w, h]) => x >= b.x - 2 && x + w <= b.x + b.w + 2 && y >= b.y - 2 && y + h <= b.y + b.h + 2));
  s.close();
});
