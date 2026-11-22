import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createShopConnector, READ_QUERIES, ADMIN_VERSION, SHOP_RETENTION_MS } from '../src/shop-readonly.js';
import { createShopStore } from '../src/studio-shop.js';
import { REAL_NETWORK_ENV } from '../src/mcp-client.js';

const start = Date.parse('2026-11-22T12:00:00Z');
const token = ['fixture', 'admin', 'value'].join('-');
const reply = (data, version = ADMIN_VERSION) => ({ status: 200, headers: { get: (k) => k === 'x-shopify-api-version' ? version : null }, text: async () => JSON.stringify({ data }) });
function setup({ scopes = ['read_products', 'read_inventory'], version = ADMIN_VERSION, productPages = false, gate = true, handler } = {}) {
  let now = start; const calls = [];
  const fake = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, ...body });
    if (handler) return handler(body, calls.length);
    if (body.query === READ_QUERIES.scopes) return reply({ currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } }, version);
    if (body.query === READ_QUERIES.orders) return reply({ orders: { nodes: [{ id: 'gid://shopify/Order/1', createdAt: new Date(start - 1000).toISOString(), updatedAt: new Date(start).toISOString(), displayFulfillmentStatus: 'FULFILLED', customer: { email: 'private@example.test' }, fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ company: 'DHL', number: 'RR123456789CN', url: 'https://private.example.test/' }] }] }, { id: 'gid://shopify/Order/2', createdAt: '2020-01-01T00:00:00Z' }], pageInfo: { hasNextPage: false } } });
    return reply({ products: { nodes: [{ id: 'gid://shopify/Product/1', title: 'Produit', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', sku: 'article', price: '12.50', inventoryItem: { id: 'gid://shopify/InventoryItem/1', inventoryLevels: { nodes: [{ id: 'gid://shopify/InventoryLevel/1', location: { id: 'gid://shopify/Location/1', name: 'private@example.test' }, quantities: [{ name: 'available', quantity: 4 }] }] } } }] }, customer: 'private@example.test' }], pageInfo: { hasNextPage: productPages, endCursor: productPages ? 'next' : null } } });
  };
  const connector = createShopConnector({ domain: 'workeda.example', adminDomain: 'fixture.myshopify.com', token, fetchImpl: async () => { throw new Error('réseau public non attendu'); }, env: gate ? { [REAL_NETWORK_ENV]: '1' } : {}, adminFetchImpl: fake, now: () => now });
  const db = new DatabaseSync(':memory:');
  const shop = createShopStore(db, { connector, clock: () => new Date(now).toISOString() });
  const close = () => { shop.close(); db.close(); };
  return { connector, shop, db, calls, close, advance: (ms) => { now += ms; } };
}

test('Shopify Admin : jeton seul, accord absent et verrou réseau refusent sans fetch', async () => {
  const x = setup();
  try {
    assert.equal(x.shop.adminStatus().stateLabel, 'À configurer');
    const r = await x.connector.fetchAdmin(); assert.equal(r.ok, false); assert.equal(x.calls.length, 0);
    await assert.rejects(x.shop.refreshAdmin(), /À configurer/);
    assert.throws(() => x.shop.configureAdmin({ enabled: true }), /Confirmation/);
  } finally { x.close(); }
  const y = setup({ gate: false });
  try { y.shop.configureAdmin({ confirm: true, enabled: true }); await assert.rejects(y.shop.refreshAdmin(), /À configurer/); assert.equal(y.calls.length, 0); } finally { y.close(); }
});

test('Shopify Admin : scopes exacts, version effective et erreurs GraphQL HTTP 200 sont vérifiés', async () => {
  for (const options of [{ scopes: ['read_products'] }, { version: '2025-01' }, { handler: () => ({ status: 200, headers: { get: () => ADMIN_VERSION }, text: async () => JSON.stringify({ errors: [{ message: token }] }) }) }]) {
    const x = setup(options);
    try { x.shop.configureAdmin({ confirm: true, enabled: true }); const r = await x.shop.testAdmin(); assert.equal(r.ok, false); assert.equal(x.shop.adminStatus().authenticated, false); assert.equal(x.shop.latestAdmin(), null); assert.equal(x.calls.length, 1); assert.doesNotMatch(JSON.stringify(r), new RegExp(token)); } finally { x.close(); }
  }
});

test('Shopify Admin : projection fermée, stocks et commandes séparément autorisées ≤60 jours', async () => {
  const x = setup({ scopes: ['read_products', 'read_inventory', 'read_orders', 'read_customers'] });
  try {
    x.shop.configureAdmin({ confirm: true, enabled: true });
    assert.equal(x.shop.adminStatus().stateLabel, 'Configuré — non vérifié');
    await x.shop.testAdmin(); assert.equal(x.shop.adminStatus().stateLabel, 'Authentifié');
    assert.equal(x.calls.some((c) => c.query === READ_QUERIES.orders), false);
    assert.equal(x.shop.latest(), null, 'le catalogue public ne reçoit jamais le cache Admin');
    const p = x.shop.latestAdmin().products[0]; assert.equal(p.variants[0].inventory[0].available, 4); assert.equal(p.variants[0].price, 12.5);
    x.shop.configureAdmin({ confirm: true, enabled: true, orders: true }); assert.equal(x.shop.latestAdmin(), null);
    await x.shop.testAdmin();
    const snap = x.shop.latestAdmin(); assert.equal(snap.orders.length, 1); assert.equal(snap.source, 'shopify_admin');
    assert.equal(snap.orders[0].fulfillments[0].trackingInfo[0].number, 'RR*********CN');
    assert.doesNotMatch(JSON.stringify(snap), /private|RR123456789CN|customer|read_customers/i);
    assert.equal(Object.hasOwn(snap.orders[0].fulfillments[0].trackingInfo[0], 'url'), false);
    assert.match(x.calls.find((c) => c.query === READ_QUERIES.orders).variables.filter, /^created_at:>=2026-09-23/);
    assert.deepEqual(x.shop.adminStatus().requiredScopes, ['read_products', 'read_inventory', 'read_orders']);
  } finally { x.close(); }
});

test('Shopify Admin : pagination bornée annoncée, purge des caches à 7 jours et refus après retrait', async () => {
  const x = setup({ productPages: true });
  try {
    x.shop.configureAdmin({ confirm: true, enabled: true }); const r = await x.shop.testAdmin();
    assert.equal(x.calls.length, 5); assert.equal(r.snapshot.partial, true); assert.match(r.errors.join(), /pagination/);
    const insert = x.db.prepare('INSERT INTO shop_snapshots (id, fetched_at, mode, domain, ok, partial, errors, collections, products, source_urls, hash) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)');
    for (const mode of ['public', 'admin']) insert.run(mode, new Date(start).toISOString(), mode, 'workeda.example', '[]', '[]', '[]', '[]', mode);
    assert.equal(x.shop.latest().mode, 'public', 'les anciens relevés Admin restent exclus du catalogue public');
    const calls = x.calls.length; await x.shop.ensureFresh(); assert.equal(x.calls.length, calls, 'une tâche catalogue ne lance aucun relevé Admin');
    x.advance(SHOP_RETENTION_MS + 1); assert.equal(x.shop.latestAdmin(), null); assert.equal(x.shop.latest(), null);
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM shop_snapshots').get().n, 0);
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM shop_admin_snapshots').get().n, 0);
    x.shop.configureAdmin({ confirm: true, enabled: false }); await assert.rejects(x.shop.refreshAdmin(), /À configurer/);
  } finally { x.close(); }
});

test('Shopify Admin : retrait pendant un relevé interdit la suite et toute persistance', async () => {
  let release; const pending = new Promise((r) => { release = r; });
  const x = setup({ handler: async () => { await pending; return reply({ currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }] } }); } });
  try {
    x.shop.configureAdmin({ confirm: true, enabled: true }); const reading = x.shop.testAdmin();
    x.shop.configureAdmin({ confirm: true, enabled: false }); release();
    const r = await reading; assert.equal(r.ok, false); assert.equal(x.calls.length, 1); assert.equal(x.shop.latestAdmin(), null); assert.equal(x.shop.adminStatus().authenticated, false);
  } finally { x.close(); }
});
