import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePublicProduct, normalizeAdminProduct, catalogPrompt, createShopConnector } from '../src/shop-readonly.js';
import { createShopStore } from '../src/studio-shop.js';
import { matchCatalog, integrationPrompt } from '../src/integrations-core.js';
import { parseAgentOutput, untrusted, LIMITS } from '../src/comm-core.js';
import { buildContext } from '../src/memory-core.js';
import { createStudio } from '../src/studio.js';
import { createMcpClient } from '../src/mcp-client.js';
import { assertAllowed } from '../src/integrations-core.js';

const email = 'client@example.invalid', phone = '+33 6 00 00 00 00', track = 'RR000000000CN';
const dirty = `Lampe Jean Exemple, 12 rue Fictive, ${email} ${phone} ${track}`;
const safe = (v) => {
  const text = JSON.stringify(v);
  for (const s of [email, phone, track, 'client%40example.invalid', 'client&#64;example.invalid']) assert.ok(!text.includes(s), 'contact ou suivi conservé');
  return text;
};
const raw = { id: 1234567890123, title: dirty, handle: `lampe-${email}`, vendor: dirty, product_type: dirty, tags: [dirty], body_html: `<p>Aluminium 30 cm, 24 W. ${dirty}</p>` };
const snapshot = { mode: 'public', domain: 'example.invalid', ok: true, partial: false, errors: [], collections: [{ id: '1', title: dirty, handle: email, count: 1 }], products: [{ id: '1', title: dirty, handle: email, type: dirty, tags: [dirty], priceMin: 10, priceMax: 10, descChars: 50 }], sourceUrls: [] };

test('revue finale : secrets du catalogue absents des relevés et des prompts, même avant troncature', async () => {
  const credential = ['shpat', 'a'.repeat(32)].join('_');
  const input = structuredClone(snapshot);
  input.products[0].title = `Lampe ${credential}`;
  input.products[0].desc = `Aluminium 30 cm ${credential}`;
  const db = new DatabaseSync(':memory:');
  try {
    const store = createShopStore(db, { connector: { fetchCatalog: async () => input } });
    const result = await store.refresh();
    assert.ok(!JSON.stringify(result).includes(credential), 'secret dans API catalogue');
    assert.ok(!JSON.stringify(db.prepare('SELECT products FROM shop_snapshots').get()).includes(credential), 'secret dans SQL');
    assert.ok(!catalogPrompt(input).includes(credential), 'secret dans prompt historique');
    const product = normalizePublicProduct({ ...raw, title: `${'x'.repeat(150)} ${credential}` }, 'example.invalid');
    assert.ok(!product.title.includes(credential.slice(0, 10)), 'fragment de secret après troncature');
    assert.match(result.snapshot.products[0].desc, /Aluminium 30 cm/);
  } finally { db.close(); }
});

test('revue finale : les métadonnées de résultat ne publient aucun secret dans le journal Comms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-secret-journal-'));
  const studio = createStudio(':memory:', { commJournalDir: dir, device: 'pc-test' });
  const credential = ['shpat', 'b'.repeat(32)].join('_');
  try {
    studio.syncAgentFiles([{ slug: 'lucas', displayName: 'Lucas', role: 'Catalogue', department: 'Catalogue' }]);
    const agentId = studio.listAgentFiles()[0].agentId;
    const task = studio.comm.createTask({ assigneeId: agentId, instruction: 'Auditer les produits' }).task;
    const run = studio.comm.startRun({ agentId, kind: 'task', taskId: task.id });
    const result = studio.comm.recordResult(task.id, { agentId, runId: run.id, body: 'Rapport sans secret', summary: credential, sources: [{ label: credential }], observed: { nested: { detail: credential } }, verification: credential, verified: false, level: 'run' });
    assert.ok(!readFileSync(join(dir, 'pc-test.jsonl'), 'utf8').includes(credential), 'secret dans journal portable');
    assert.ok(!JSON.stringify(result).includes(credential), 'secret dans résultat API');
    assert.ok(!buildContext([{ item: { id: '1', level: 'company', nature: 'hypothesis', title: credential, body: credential, sources: [] }, stale: false }]).text.includes(credential), 'secret dans mémoire historique');
  } finally { studio.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('catalogue public et admin : contacts retirés avant troncature, texte commercial et noms conservés', async () => {
  for (const p of [normalizePublicProduct(raw, 'example.invalid'), normalizeAdminProduct({ ...raw, productType: dirty, descriptionHtml: raw.body_html, seo: { title: dirty } }, 'example.invalid')]) {
    safe(p); assert.match(p.desc, /Aluminium 30 cm, 24 W/); assert.match(p.title, /Jean Exemple, 12 rue Fictive/); assert.equal(p.id, String(raw.id));
  }
  for (const contact of ['client2026-11-22@example.invalid', '00000000-0000-0000-0000-000000000000@example.invalid', 'client&#64;example.invalid', 'client%40example.invalid', '1Z0000000000000000', 'yt000000000000000']) {
    assert.ok(!JSON.stringify(normalizePublicProduct({ ...raw, title: contact, body_html: contact }, 'example.invalid')).includes(contact), 'contact encodé ou contenant une date conservé');
  }
  const connector = createShopConnector({ domain: 'example.invalid', token: null, adminDomain: null, fetchImpl: async (url) => ({ status: 200, text: async () => JSON.stringify(url.includes('collections') ? { collections: [{ title: dirty, handle: email }] } : { products: [raw] }) }) });
  safe(await connector.fetchCatalog());
});

test('anciens relevés : catalogPrompt nettoie avant de couper les titres, y compris encodages', () => {
  const s = structuredClone(snapshot);
  s.products[0].title = `${'a'.repeat(74)} ${email}`;
  s.products[0].handle = 'client%40example.invalid';
  s.collections[0].title = 'client&#64;example.invalid';
  const text = safe(catalogPrompt(s));
  assert.ok(!text.includes('client@'), 'pas de fragment après troncature');
  assert.equal(s.products[0].handle, 'client%40example.invalid', 'entrée non modifiée');
});

test('cache Shopify : nouveaux relevés et anciennes lignes SQL sont filtrés en lecture', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createShopStore(db, { connector: { fetchCatalog: async () => structuredClone(snapshot) } });
    safe(await store.refresh());
    safe(db.prepare('SELECT products, collections FROM shop_snapshots').get());
    db.prepare('UPDATE shop_snapshots SET products = ?').run(JSON.stringify(snapshot.products));
    safe(store.latest());
  } finally { db.close(); }
});

test('rapprochement : sorties filtrées sans faux lien sur deux handles neutralisés', () => {
  const dsers = [{ id: 'd1', shopifyId: '1', handle: email, title: dirty, supplierName: dirty, mapped: true }];
  const match = matchCatalog(snapshot.products, dsers);
  safe(match); assert.equal(match.counts.matched, 1);
  assert.equal(matchCatalog([{ id: '1234567890123', handle: 'lampe' }], [{ id: 'd2', shopifyId: '1234567890123' }]).matched[0].shopId, '1234567890123');
  assert.equal(matchCatalog([{ id: '2', handle: '[e-mail retiré]' }], [{ id: 'd3', handle: '[e-mail retiré]' }]).counts.matched, 0);
  safe(integrationPrompt({ dsers: { fetchedAt: '2026-11-22T12:00:00Z', sources: [], match, shipping: [] }, notes: [dirty] }));
  const old = structuredClone(match); old.matched[0].title = dirty; old.matched[0].handle = email;
  safe(integrationPrompt({ dsers: { fetchedAt: '2026-11-22T12:00:00Z', sources: [], match: old } }));
});

test('journaux comm/mémoire et événements : contacts masqués, JSON rejouable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-privacy-'));
  const options = { commJournalDir: join(dir, 'comm'), memoryJournalDir: join(dir, 'memory'), device: 'pc-a' };
  const a = createStudio(':memory:', options), b = createStudio(':memory:', { ...options, device: 'pc-b' });
  try {
    const profiles = [{ slug: 'lucas', displayName: 'Lucas', role: 'Catalogue', department: 'Catalogue' }];
    a.syncAgentFiles(profiles); b.syncAgentFiles(profiles);
    const aid = a.listAgentFiles()[0].agentId;
    const task = a.comm.createTask({ assigneeId: aid, title: dirty, instruction: dirty, withCatalog: true }).task;
    const run = a.comm.startRun({ agentId: aid, kind: 'task', taskId: task.id });
    a.comm.recordResult(task.id, { agentId: aid, runId: run.id, body: dirty, summary: dirty, sources: [{ url: `https://example.invalid/${encodeURIComponent(email)}`, label: dirty }], observed: { note: dirty }, verification: dirty, verified: true, level: 'run' });
    a.comm.postMessage(task.threadId, { body: dirty, taskId: task.id }, { type: 'user' });
    a.memory.create({ level: 'company', kind: 'knowledge', nature: 'fact', title: dirty, body: dirty, tags: [email], sources: [{ label: dirty, url: `https://example.invalid/${encodeURIComponent(email)}` }] });
    safe(readFileSync(join(dir, 'comm', 'pc-a.jsonl'), 'utf8'));
    safe(readFileSync(join(dir, 'memory', 'pc-a.jsonl'), 'utf8'));
    safe(a.listEvents(aid));
    assert.equal(b.comm.importJournal().invalid, 0);
    assert.equal(b.memory.importJournal().invalid, 0);
    safe(b.comm.resultOf(task.id));
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('permissions : variantes de noms et objets coercibles refusés avant tout transport', async () => {
  let calls = 0;
  const client = createMcpClient({ integration: 'dsers', url: 'https://ai.dsers.com/mcp', fetchImpl: async () => { calls++; throw new Error('transport interdit'); } });
  for (const name of ['update_managed_store_product', 'list_stores ', 'LIST_STORES', 'list_stores\n', 'list_stores/../update_managed_store_product', 'list_stores%00', '__proto__', null, { toString: () => 'list_stores' }, { toString: () => { throw new Error('nom confidentiel'); } }]) {
    await assert.rejects(() => client.callTool(name, {}), { kind: 'forbidden' });
  }
  for (const name of ['register', 'getquota ', 'GETQUOTA', '/getquota', 'getquota?register', 'getquota\n', null, { toString: () => 'getquota' }]) assert.throws(() => assertAllowed('track17', name), { kind: 'forbidden' });
  assert.equal(calls, 0);
});


test('mémoire historique : nettoyage avant troncature du contexte, formats commerciaux conservés', () => {
  const ctx = buildContext([{ item: { id: '1', level: 'company', nature: 'fact', confidence: 'high', title: `${'x'.repeat(94)} ${email}`, body: `Aluminium 30 cm, 24 W, 2026-11-22. ${dirty}`, sources: [] }, stale: false }]);
  safe(ctx.text); assert.ok(!ctx.text.includes('client@')); assert.match(ctx.text, /Aluminium 30 cm, 24 W, 2026-11-22/);
});


test('rapports agent et blocs non fiables : aucune coordonnée partielle après troncature', () => {
  const parsed = parseAgentOutput(JSON.stringify({ report: `${'x'.repeat(LIMITS.result - 168)} ${email} ${'x'.repeat(500)}`, summary: `${'x'.repeat(392)} ${email}`, sources: [ `${'x'.repeat(193)} ${email}` ] }));
  assert.ok(!JSON.stringify(parsed).includes('client@'));
  assert.ok(!untrusted('catalogue', `${'x'.repeat(94)} ${email}`, 105).includes('client@'));
});
