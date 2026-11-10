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
