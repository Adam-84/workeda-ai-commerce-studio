// Noyau des intégrations : liste blanche (défaut = refus), anti-données personnelles, masquage, logistique, correspondance exacte, prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DSERS_ALLOWED_TOOLS, DSERS_WRITE_TOOLS, DSERS_UNUSED_READ_TOOLS, DSERS_READ_SCOPES, DSERS_PUBLISHED_SCOPES, TRACK17_ALLOWED_ENDPOINTS, TRACK17_FORBIDDEN_ENDPOINTS,
  classifyDsersTool, classifyTrack17Endpoint, assertAllowed, ForbiddenToolError, classifyExposedTools, maskTracking, scrubText, containsPii, sanitizeDeep,
  projectStoreProduct, projectSupplierProduct, projectShippingQuote, projectPackage, normalizeStatus, analyzeLogistics, matchCatalog, integrationPrompt, INTEGRATION_PROMPT_CHARS
} from '../src/integrations-core.js';

const fixture = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), 'utf8'));

test('portées OAuth : uniquement des lectures, toutes publiées par DSers (fixture officielle)', () => {
  const published = fixture('dsers-protected-resource.json').scopes_supported;
  assert.deepEqual([...published].sort(), [...DSERS_PUBLISHED_SCOPES].sort(), 'la liste publiée n’a pas changé');
  for (const s of DSERS_READ_SCOPES) { assert.ok(published.includes(s), `${s} publiée`); assert.match(s, /:read$/, `${s} est une lecture`); }
  for (const s of ['billing:read', 'staff:read', 'settings:read', 'theme:read', 'user:read', 'notification:read', 'product:mapping']) assert.ok(!DSERS_READ_SCOPES.includes(s), `${s} non demandée`);
});

test('DSers : 60 outils classés, aucun recouvrement, l’écriture n’est JAMAIS autorisée', () => {
  const all = [...DSERS_ALLOWED_TOOLS, ...DSERS_WRITE_TOOLS, ...DSERS_UNUSED_READ_TOOLS];
  assert.equal(all.length, 60); assert.equal(new Set(all).size, 60, 'aucun doublon entre les listes');
  assert.equal(DSERS_WRITE_TOOLS.length, 26); assert.equal(DSERS_ALLOWED_TOOLS.length + DSERS_UNUSED_READ_TOOLS.length, 34);
  for (const t of DSERS_WRITE_TOOLS) { assert.equal(classifyDsersTool(t).allowed, false, t); assert.throws(() => assertAllowed('dsers', t), ForbiddenToolError); }
  for (const t of DSERS_UNUSED_READ_TOOLS) assert.equal(classifyDsersTool(t).allowed, false, `${t} : lecture non utilisée = refusée`);
  for (const t of DSERS_ALLOWED_TOOLS) { assert.equal(classifyDsersTool(t).allowed, true, t); assert.doesNotMatch(t, /^(start|create|update|delete|publish|import|apply|place|cancel|sync|send)_/, `${t} n’a pas l’allure d’une écriture`); }
});

test('défaut = REFUS : outil inconnu, nouveau, mal formé ou déguisé', () => {
  for (const name of ['place_orders_to_suppliers_v2', 'delete_everything', 'refund_customer', 'get_secret_stuff', 'LIST_STORES', 'list-stores', ' list_stores', 'list_stores ', 'list_stores;drop', '', null, undefined, 42, {}, 'a'.repeat(200)]) {
    const v = classifyDsersTool(name);
    assert.equal(v.allowed, false, JSON.stringify(name)); assert.throws(() => assertAllowed('dsers', name), /refusé/);
  }
  assert.match(classifyDsersTool('create_new_thing').reason, /allure écriture/);
  assert.throws(() => assertAllowed('inconnu', 'list_stores'), /refusé/);
  const exposed = classifyExposedTools(['list_stores', 'update_pricing_rule', 'get_account_profile', 'brand_new_tool', 'create_future_write']);
  assert.deepEqual(exposed.allowed, ['list_stores']); assert.deepEqual(exposed.write, ['update_pricing_rule']); assert.deepEqual(exposed.readUnused, ['get_account_profile']); assert.deepEqual(exposed.unknown, ['brand_new_tool', 'create_future_write']);
  assert.ok(exposed.missing.includes('list_packages'), 'outils attendus mais absents signalés');
});

test('17TRACK : seules 3 lectures ; register (payant) et le reste refusés', () => {
  assert.deepEqual(TRACK17_ALLOWED_ENDPOINTS, ['getquota', 'gettracklist', 'gettrackinfo']);
  for (const e of TRACK17_FORBIDDEN_ENDPOINTS) assert.equal(classifyTrack17Endpoint(e).allowed, false, e);
  assert.match(classifyTrack17Endpoint('register').reason, /payant/);
  for (const e of ['REGISTER', 'getquota/', 'push', '', null, 'gettrackinfo?x=1']) assert.equal(classifyTrack17Endpoint(e).allowed, false, JSON.stringify(e));
});

test('masquage des numéros de suivi', () => {
  assert.equal(maskTracking('RR123456789CN'), 'RR*********CN');
  assert.equal(maskTracking('1234567'), '*******'); assert.equal(maskTracking(''), ''); assert.equal(maskTracking(null), '');
  assert.ok(!maskTracking('LP00123456789012').includes('0012345678'));
});

test('texte libre : e-mails, téléphones et numéros de suivi retirés, dates préservées', () => {
  const dirty = 'Colis remis à Jean Dupont, tél +33 6 12 34 56 78 / 06.12.34.56.78, jean.dupont@exemple.fr, suivi RR123456789CN et 9400100000000000000000, le 2026-11-21 10:00:00';
  const clean = scrubText(dirty, 400);
  for (const leak of ['jean.dupont@', '12 34 56 78', '12.34.56.78', 'RR123456789CN', '9400100000000000000000']) assert.ok(!clean.includes(leak), leak);
  assert.match(clean, /2026-11-21 10:00:00/, 'une date n’est pas un téléphone');
  assert.equal(containsPii(clean), false); assert.equal(containsPii('écrire à a@b.fr'), true); assert.equal(containsPii('+33 6 12 34 56 78'), true); assert.equal(containsPii('prix 29.90 EUR, 3 jours'), false);
  assert.equal(scrubText('x'.repeat(500), 50).length, 50);
});

test('projection de colis : liste blanche, aucune identité, suivi masqué', () => {
  const raw = { order_name: '#1042', tracking_number: 'RR123456789CN', carrier: 'Yanwen', status: 'In transit', destination_country: 'fr', shipped_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-18T08:00:00Z',
    customer: { first_name: 'Jean', last_name: 'Dupont', email: 'jean@exemple.fr', phone: '+33612345678' }, shipping_address: { name: 'Jean Dupont', address1: '12 rue des Lilas', city: 'Lyon', zip: '69003', phone: '0612345678' },
    events: [{ time: '2026-11-02T09:00:00Z', description: 'Remis à Jean Dupont, 12 rue des Lilas, tél 06 12 34 56 78' }, { time: '2026-11-18T08:00:00Z', description: 'Arrivé au hub RR123456789CN' }] };
  const p = projectPackage(raw);
  assert.deepEqual([p.orderRef, p.carrier, p.status, p.destCountry, p.tracking], ['#1042', 'Yanwen', 'InTransit', 'FR', 'RR*********CN']);
  const dump = JSON.stringify(p);
  for (const leak of ['Jean', 'Dupont', 'jean@', '12 rue', 'Lyon', '69003', '0612345678', '+33612345678', 'RR123456789CN', 'Lilas']) assert.ok(!dump.includes(leak), `${leak} absent`);
  assert.deepEqual(p.events.map((e) => e.status), ['Unknown', 'InTransit'], 'événements réduits à une date et un statut normalisé : aucun texte libre');
  const hostile = projectPackage({ order_name: 'Commande de Jean Dupont 12 rue des Lilas', carrier: 'Poste <script>', status: 'Livré à M. Dupont (signé)', tracking_number: 'X' });
  assert.match(hostile.orderRef, /^cmd-[0-9a-f]{6}$/); assert.equal(hostile.carrier, 'Autre'); assert.equal(hostile.statusRaw, '');
  assert.ok(!/Dupont|Lilas|script/.test(JSON.stringify(hostile)), 'identité dans un champ projeté : remplacée par un identifiant opaque / « Autre »');
  const reflected = projectPackage({ order_name: 'Jean-Dupont', carrier: '12 rue des Lilas', tracking_number: 'X' });
  assert.ok(reflected.orderRef.startsWith('cmd-') && reflected.carrier === 'Autre' && !JSON.stringify(reflected).match(/Jean|Dupont|Lilas/), 'scénario de la revue Codex : nom en référence, adresse en transporteur');
  assert.equal(containsPii(p), false);
  assert.ok(p.trackingKey && p.trackingKey.length === 10 && !p.trackingKey.includes('RR12'), 'identifiant stable non réversible');
  assert.equal(Object.keys(p).sort().join(), ['carrier', 'deliveredAt', 'destCountry', 'events', 'lastEventAt', 'orderRef', 'shippedAt', 'status', 'statusRaw', 'tracking', 'trackingKey'].join(), 'aucun champ hors liste blanche');
});

test('projection : champs inconnus ignorés, jamais copiés ; sanitizeDeep refuse une fuite résiduelle', () => {
  const p = projectStoreProduct({ id: 7, title: 'Support écran', handle: 'support-ecran', price: '29,90', supplier: { name: 'Fournisseur SA', price: 11.2 }, buyer_email: 'x@y.fr', note_interne: 'appeler 0612345678' });
  assert.deepEqual([p.id, p.title, p.price, p.supplierName, p.supplierCost], ['7', 'Support écran', 29.9, 'Fournisseur SA', 11.2]);
  assert.ok(!JSON.stringify(p).includes('x@y.fr') && !JSON.stringify(p).includes('0612345678'));
  assert.deepEqual(sanitizeDeep({ a: 'ok x@y.fr', b: [{ c: 'tél 06 12 34 56 78' }] }), { a: 'ok [e-mail retiré]', b: [{ c: 'tél [téléphone retiré]' }] });
  assert.equal(projectStoreProduct({ store_url: 'https://workeda.com/products/Bras-Articule?variant=1' }).handle, 'bras-articule');
  assert.equal(projectStoreProduct({ shopify_product_id: 'gid://shopify/Product/123' }).shopifyId, '123');
  assert.equal(projectSupplierProduct({ id: 1, variants: [{ price: 5 }, { price: 9.5 }] }).priceMax, 9.5);
  assert.equal(projectShippingQuote({ method: 'Standard', country: 'fr', cost: '4,5', days_min: 8, days_max: 15 }).country, 'FR');
});

test('statuts normalisés vers le vocabulaire 17TRACK', () => {
  const cases = { 'Delivered': 'Delivered', 'in_transit': 'InTransit', 'Out for delivery': 'OutForDelivery', 'Delivery failed': 'DeliveryFailure', 'returned to sender': 'Exception', 'customs hold': 'Exception', 'label created': 'InfoReceived', 'ready for pickup': 'AvailableForPickup', 'not found': 'NotFound', 'expired': 'Expired', '': 'Unknown', 'bizarre': 'Unknown', 'Exception': 'Exception' };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeStatus(raw), want, raw);
});

const NOW = Date.parse('2026-11-21T12:00:00Z');
const pkg = (over) => ({ orderRef: '#1', carrier: 'Yanwen', tracking: 'RR*********CN', status: 'InTransit', destCountry: 'FR', shippedAt: '2026-11-10T00:00:00Z', deliveredAt: null, lastEventAt: '2026-11-20T00:00:00Z', ...over });

test('analyse logistique : retards, anomalies, silences, délais, manques', () => {
  const L = analyzeLogistics([
    pkg({ orderRef: '#1', status: 'Delivered', shippedAt: '2026-11-01T00:00:00Z', deliveredAt: '2026-11-13T00:00:00Z' }),
    pkg({ orderRef: '#2', status: 'Delivered', shippedAt: '2026-11-01T00:00:00Z', deliveredAt: '2026-11-21T00:00:00Z', carrier: 'YunExpress', destCountry: 'DE' }),
    pkg({ orderRef: '#3', status: 'InTransit', shippedAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-11-19T00:00:00Z' }),          // en route depuis 37 j
    pkg({ orderRef: '#4', status: 'Exception', lastEventAt: '2026-11-20T00:00:00Z' }),
    pkg({ orderRef: '#5', status: 'InTransit', lastEventAt: '2026-11-05T00:00:00Z' }),                                              // 16 j sans nouvelle
    pkg({ orderRef: '#6', status: 'Unknown', carrier: '', shippedAt: null, destCountry: '' })
  ], { now: NOW });
  assert.equal(L.total, 6); assert.equal(L.byStatus.Delivered, 2); assert.equal(L.deliveredCount, 2);
  assert.equal(L.avgDeliveryDays, 16); assert.equal(L.medianDeliveryDays, 20);
  assert.equal(L.delayed, 1); assert.equal(L.exceptions, 1); assert.ok(L.stale >= 1);
  assert.ok(L.anomalies.every((a) => a.tracking === 'RR*********CN' || a.tracking === ''), 'numéros masqués dans les anomalies');
  assert.equal(L.anomalies[0].orderRef, '#3', 'le plus long en tête');
  assert.deepEqual(L.missing, { shippedAt: 1, carrier: 1, status: 1, country: 1 });
  assert.equal(L.byCountry.find((c) => c.key === 'DE').avgDays, 20);
  assert.equal(analyzeLogistics([], { now: NOW }).avgDeliveryDays, null);
});

test('correspondance Shopify ↔ DSers : identifiant exact, puis adresse exacte, JAMAIS approximative', () => {
  const shop = [{ id: 1, handle: 'bras-articule', title: 'Bras articulé', priceMin: 39.9 }, { id: 2, handle: 'lampe-led', title: 'Lampe LED', priceMin: 24.9 }, { id: 3, handle: 'tapis-xxl', title: 'Tapis XXL', priceMin: 19.9 }, { id: 4, handle: 'support', title: 'Support', priceMin: 15 }];
  const dsers = [
    { id: 'd1', shopifyId: '1', handle: '', title: 'Bras', supplierName: 'F1', supplierCost: 12, supplierCurrency: 'EUR', mapped: true },
    { id: 'd2', shopifyId: '', handle: 'lampe-led', title: 'Lampe', supplierName: 'F2', supplierCost: null, mapped: false },
    { id: 'd3', shopifyId: '3', handle: 'tapis-xxl', title: 'Tapis A', supplierName: 'F3', supplierCost: 5 }, { id: 'd4', shopifyId: '3', handle: '', title: 'Tapis B', supplierName: 'F4', supplierCost: 6 },
    { id: 'd5', shopifyId: '', handle: '', title: 'Support de bureau ergonomique (titre voisin)', supplierName: 'F5', supplierCost: 3 }
  ];
  const m = matchCatalog(shop, dsers);
  assert.deepEqual(m.matched.map((x) => [x.shopId, x.dsersId, x.basis]), [['1', 'd1', 'id'], ['2', 'd2', 'handle']]);
  assert.deepEqual(m.ambiguous.map((x) => x.shopId), ['3']); assert.deepEqual(m.unmatchedShop.map((x) => x.shopId), ['4'], 'un titre voisin ne suffit pas');
  assert.deepEqual(m.unmatchedDsers.map((x) => x.dsersId), ['d5']);
  assert.deepEqual(m.missing, { noSupplierCost: 1, noSupplier: 0, noShopPrice: 0, notMapped: 1 });
  assert.deepEqual(m.counts, { shop: 4, dsers: 5, matched: 2 });
});

test('bloc donné aux agents : cadré non fiable, daté, PII absentes, manques et troncature annoncés', () => {
  const matched = Array.from({ length: 400 }, (_, i) => ({ shopId: String(i), handle: `produit-${i}-un-long-identifiant`, title: `Produit numéro ${i} avec un titre assez long`, shopPrice: 20, supplierName: 'Fournisseur', supplierCost: 8, supplierCurrency: 'EUR', basis: 'id', mapped: true }));
  const L = analyzeLogistics([pkg({ status: 'Exception' })], { now: NOW });
  const { text, provided } = integrationPrompt({ dsers: { fetchedAt: '2026-11-21T10:00:00.000Z', sources: ['archipel://integrations/dsers/abc'], match: { matched, unmatchedShop: [], unmatchedDsers: [], ambiguous: [], missing: { noSupplierCost: 0, noSupplier: 0, noShopPrice: 0, notMapped: 0 }, counts: { shop: 400, dsers: 400, matched: 400 } }, shipping: [], logistics: L } });
  assert.match(text, /^<donnees-non-fiables origine="données fournisseurs et logistiques">/); assert.match(text, /LECTURE SEULE/); assert.match(text, /2026-11-21T10:00/);
  assert.match(text, /ATTENTION : \d+ produit\(s\) lié\(s\) NON listé\(s\) faute de place/); assert.match(text, /Frais d'expédition fournisseur : non relevés/);
  assert.match(text, /RR\*+CN/); assert.doesNotMatch(text, /RR123456789CN/);
  assert.ok(text.length < INTEGRATION_PROMPT_CHARS + 300); assert.ok(text.trimEnd().endsWith('</donnees-non-fiables>'));
  assert.deepEqual(provided, ['archipel://integrations/dsers/abc']);
  const none = integrationPrompt({});
  assert.match(none.text, /DSers : aucun relevé disponible/); assert.match(none.text, /Logistique : aucun colis relevé/); assert.deepEqual(none.provided, []);
});

test('containsPii : un identifiant de relevé (uuid) n’est jamais pris pour un téléphone (aucun faux positif sur 5000 tirages)', async () => {
  const { randomUUID } = await import('node:crypto');
  for (let i = 0; i < 5000; i += 1) assert.equal(containsPii(`archipel://integrations/dsers/${randomUUID()}`), false);
  assert.equal(containsPii('Appeler le 06 12 34 56 78'), true); assert.equal(containsPii('contact jean@exemple.fr'), true);
});
