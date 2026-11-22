import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_TEMPLATE, CSV_HEADERS, CSV_LIMITS, validateManualCsv } from '../src/manual-import.js';

const csv = (header, ...rows) => [header, ...rows].join('\r\n');

test('modèle Archipel : coûts absents explicites et aucune supposition de devise', () => {
  const result = validateManualCsv(CSV_TEMPLATE);
  assert.equal(result.ok, true); assert.equal(result.rows.length, 0);
  const r = validateManualCsv(csv('id;sku;purchase_cost;shipping_cost;currency;cost_kind', 'p1;SKU-1;;;;'));
  assert.equal(r.ok, true); assert.equal(r.rows[0].purchaseCost, null); assert.equal(r.rows[0].shippingCost, null);
  assert.equal(r.rows[0].missingCosts.purchaseCost, 'absent'); assert.equal(r.rows[0].calculationReady, false);
  assert.equal(r.rows[0].currency, null); assert.equal(r.rows[0].source, 'manual_import');
});

test('CSV réel : BOM, virgules, guillemets doublés, retours intégrés et séparateur point-virgule', () => {
  const r = validateManualCsv('\ufeffid,sku,currency,cost_kind,purchase_cost,shipping_cost\r\np1,"SKU,""édition""\r\nbleue",EUR,purchase_unit,12.50,0\r\n');
  assert.equal(r.ok, true); assert.equal(r.rows[0].sku, 'SKU,"édition"\r\nbleue');
  assert.equal(r.rows[0].purchaseCost, 12.5); assert.equal(r.rows[0].calculationReady, true);
  const commaDecimal = validateManualCsv(csv('id;currency;cost_kind;purchase_cost', 'p1;EUR;purchase_unit;12,50'));
  assert.equal(commaDecimal.ok, true); assert.equal(commaDecimal.rows[0].purchaseCost, 12.5);
});

test('aperçu : liste blanche, coordonnées encodées et secrets nettoyés, suivis masqués', () => {
  const fake = ['sh', 'pat_', 'z'.repeat(32)].join('');
  const r = validateManualCsv(csv('id;sku;order_id;tracking_number;carrier;status;customer;shippingAddress',
    `p1;test%40example.invalid ${fake};Nom Privé;RR123456789CN;DHL;InTransit;Nom Privé;12 rue privée`));
  assert.equal(r.ok, true);
  const row = r.rows[0], dump = JSON.stringify(r);
  for (const leak of ['test%40', 'test@example', fake, 'Nom Privé', 'rue privée', 'RR123456789CN', 'customer', 'shippingAddress']) assert.ok(!dump.includes(leak), leak);
  assert.equal(row.tracking, 'RR*********CN'); assert.match(row.trackingKey, /^[0-9a-f]{10}$/);
  assert.match(row.orderRef, /^cmd-/); assert.equal(row.carrier, 'DHL'); assert.equal(row.status, 'InTransit');
});

test('valeurs contrôlées : erreurs par ligne sans contenu brut et aucun succès partiel', () => {
  const r = validateManualCsv(csv('id;quantity;purchase_cost;currency;cost_kind;date',
    'p1;2;1;EUR;purchase_unit;2026-11-22',
    'p2;1e2;NaN;XXX;invented;2026-02-31',
    'p3;-1;10;;purchase_unit;'));
  assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.line === 3)); assert.ok(r.errors.some(e => e.line === 4));
  assert.ok(r.errors.every(e => Number.isInteger(e.line) && typeof e.message === 'string'));
  assert.equal(r.rows.length, 1, 'aperçu des seules lignes valides ; appelant refuse import si ok=false');
  assert.ok(!JSON.stringify(r.errors).includes('NaN'));
});

test('formules rejetées dans les champs retenus mais colonnes clients supprimées', () => {
  for (const formula of ['=1+1', '+SUM(A1)', '-SUM(A1)', '@SUM(A1)', '\t=1+1']) {
    const r = validateManualCsv(csv('id;sku', `p1;${formula}`));
    assert.equal(r.ok, false); assert.match(r.errors[0].message, /formule/i);
  }
  assert.equal(validateManualCsv(csv('id;customer', 'p1;=1+1')).ok, true);
});

test('formats non reconnus et CSV mal formé refusés proprement', () => {
  assert.equal(validateManualCsv(CSV_TEMPLATE, { format: 'dsers' }).ok, false);
  for (const input of ['', 'alien\nx', 'id,id\np1,p2', 'id;sku\np1;"inachevé', 'id;sku\np1;"x"suite', 'id;sku\np1;x;extra']) {
    const r = validateManualCsv(input); assert.equal(r.ok, false, input); assert.deepEqual(r.rows, []);
  }
  assert.equal(validateManualCsv(csv('id;alien', 'p1;anything')).ok, true);
  assert.ok(CSV_HEADERS.includes('tracking_number'));
});

test('bornes : octets UTF-8, lignes, colonnes et cellules', () => {
  assert.equal(validateManualCsv('id\n' + 'é'.repeat(CSV_LIMITS.maxBytes / 2)).ok, false);
  assert.equal(validateManualCsv('id\n' + Array.from({ length: CSV_LIMITS.maxRows + 1 }, (_, i) => `p${i}`).join('\n')).ok, false);
  assert.equal(validateManualCsv(Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `h${i}`).join(';')).ok, false);
  assert.equal(validateManualCsv('id\n' + 'x'.repeat(CSV_LIMITS.maxCellChars + 1)).ok, false);
  assert.equal(validateManualCsv('id\n' + 'x'.repeat(CSV_LIMITS.maxCellChars)).ok, true);
});


test('identifiants produits Shopify numériques conservés, texte libre toujours nettoyé', () => {
  const r = validateManualCsv(csv('id;sku', '1234567890123;article', 'gid://shopify/Product/1234567890123;article', 'contact@example.invalid;article'));
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].id, '1234567890123');
  assert.equal(r.rows[1].id, 'gid://shopify/Product/1234567890123');
  assert.doesNotMatch(r.rows[2].id, /contact@example/);
});
