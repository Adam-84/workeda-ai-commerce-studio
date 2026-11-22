import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const marker = 'SKU-IMPORT-CONFIDENTIEL';
const csv = `id;sku;purchase_cost;shipping_cost;currency;cost_kind;email\n1234567890123;${marker};12.50;2;EUR;purchase_unit;client@example.invalid`;
function setup(t, extra = {}) {
  let at = Date.parse('2026-11-22T12:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'archipel-import-journal-'));
  const s = createStudio(':memory:', { env: {}, shopConnector: null, commJournalDir: dir, clock: () => new Date(at).toISOString(), nowMs: () => at, ...extra });
  s.syncAgentFiles(profiles); t.after(() => s.close());
  const ids = Object.fromEntries(s.listAgentFiles().map(f => [f.slug, f.agentId]));
  return { s, ids, dir, advance: n => { at += n; } };
}
function commit(s) { const p = s.integrations.previewImport(csv); assert.equal(p.ok, true); return s.integrations.commitImport({ previewId: p.previewId, confirm: true }); }

test('import : aperçu nettoyé seulement, confirmation atomique, absence de coût et expiration 30 jours', t => {
  const { s, advance } = setup(t), svc = s.integrations;
  const p = svc.previewImport(csv);
  assert.equal(p.ok, true); assert.doesNotMatch(JSON.stringify(p), /client@example/);
  assert.equal(svc.store.latest('manual_import', 'import'), null);
  assert.throws(() => svc.commitImport({ previewId: p.previewId }), /confirmation/);
  assert.equal(svc.commitImport({ previewId: p.previewId, confirm: true }).imported, 1);
  assert.equal(svc.card('dsers').stateLabel, 'Indisponible — abonnement Basic');
  assert.equal(svc.store.latest('manual_import', 'import').payload.rows[0].purchaseCost, 12.5);
  const invalid = svc.previewImport('sku;purchase_cost\nvalid;\nbad;abc');
  assert.equal(invalid.ok, false); assert.equal(invalid.previewId, null);
  assert.throws(() => svc.commitImport({ previewId: p.previewId, confirm: true }));
  assert.equal(svc.store.latest('manual_import', 'import').payload.rows.length, 1);
  const emptyCosts = svc.previewImport('sku\nunknown-cost');
  assert.equal(emptyCosts.rows[0].purchaseCost, null);
  advance(10 * 60_000); assert.throws(() => svc.commitImport({ previewId: emptyCosts.previewId, confirm: true }));
  advance(30 * 86_400_000); svc.purgeExpired();
  assert.equal(svc.store.latest('manual_import', 'import'), null);
});

test('import : rollback intégral si la persistance du lot échoue', t => {
  const { s } = setup(t), svc = s.integrations;
  const p = svc.previewImport(csv);
  const save = svc.store.saveSnapshot;
  svc.store.saveSnapshot = args => { save(args); throw new Error('échec simulé'); };
  assert.throws(() => svc.commitImport({ previewId: p.previewId, confirm: true }), /échec simulé/);
  assert.equal(svc.store.latest('manual_import', 'import'), null);
  svc.store.saveSnapshot = save;
  assert.equal(svc.commitImport({ previewId: p.previewId, confirm: true }).imported, 1);
});

test('nouvelles sources : accès individuels, tâches web exclues, mémoire et journal sans contenu', async t => {
  const { s, ids, dir } = setup(t); commit(s);
  const svc = s.integrations;
  assert.deepEqual(svc.card('manual_import').grants, []);
  assert.doesNotMatch(svc.promptFor({ agentSlug: 'lucas', integrations: ['manual_import'] }).text, new RegExp(marker));
  svc.grant('manual_import', 'lucas');
  const block = svc.promptFor({ agentSlug: 'lucas', integrations: ['manual_import'] });
  assert.match(block.text, new RegExp(marker)); assert.match(block.text, /Import manuel — origine déclarée DSers/);
  assert.equal(block.used[0], 'manual_import'); assert.match(block.provided[0], /^archipel:\/\/integrations\/manual_import\//);
  const calls = [];
  const orch = createOrchestrator({ studio: s, profiles: () => profiles, runner: async o => { calls.push(o); return JSON.stringify({ report: marker, sources: [{ url: block.provided[0], label: 'Import' }], memory: [{ title: marker, body: marker, nature: 'hypothesis', level: 'mission' }] }); } });
  const task = s.comm.createTask({ assigneeId: ids.lucas, instruction: 'Analyse des coûts ; donnée libre {"id":"0612345678"}', withIntegrations: ['manual_import'], requiresSources: true }).task;
  orch.pump(); await orch.idle();
  assert.match(calls[0].prompt, new RegExp(marker)); assert.match(calls[0].prompt, /1234567890123/); assert.doesNotMatch(calls[0].prompt, /0612345678/);
  assert.equal(s.comm.resultOf(task.id).sources[0].checked, true);
  assert.equal(s.memory.stats().total, 0);
  const journal = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(journal, new RegExp(marker)); assert.match(journal, /manual_import/);
  svc.grant('manual_import', 'noah');
  s.comm.createTask({ assigneeId: ids.noah, instruction: 'Chercher sans données locales', withIntegrations: ['manual_import'], allowWeb: true });
  orch.pump(); await orch.idle();
  assert.doesNotMatch(calls.at(-1).prompt, new RegExp(marker));
  svc.revokeGrant('manual_import', 'lucas');
  assert.equal(svc.promptFor({ agentSlug: 'lucas', integrations: ['manual_import'] }).used.length, 0);
});

test('Shopify Admin en cache : provenance indépendante et refus sans accès, aucun relevé implicite', t => {
  const { s } = setup(t); let reads = 0;
  s.shop.latestAdmin = () => ({ id: '11111111-1111-4111-8111-111111111111', fetchedAt: '2026-11-22T12:00:00Z', products: [{ id: 'gid://shopify/Product/1234567890123', variants: [{ sku: 'ADMIN-CONFIDENTIEL', price: 10 }] }], orders: [] });
  s.shop.refreshAdmin = () => { reads++; throw new Error('interdit'); };
  assert.equal(s.integrations.promptFor({ agentSlug: 'lucas', integrations: ['shopify_admin'] }).used.length, 0);
  s.integrations.grant('shopify_admin', 'lucas');
  const b = s.integrations.promptFor({ agentSlug: 'lucas', integrations: ['shopify_admin'] });
  assert.match(b.text, /ADMIN-CONFIDENTIEL/); assert.match(b.text, /gid:\/\/shopify\/Product\/1234567890123/); assert.match(b.provided[0], /shopify_admin/); assert.equal(reads, 0);
});

test('API locale : modèle, aperçu, confirmation et accord Admin sans aucune connexion', async t => {
  let fetches = 0;
  const { s } = setup(t, { integrationsFetch: async () => { fetches++; throw new Error('réseau interdit'); } });
  const app = createApp({ studio: s, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false, agentFiles: { profiles } });
  const server = app; await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); app.orchestrator?.stop?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, data) => { const r = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  assert.match((await req('/api/integrations/manual_import/template')).body.csv, /purchase_cost/);
  const preview = await req('/api/integrations/manual_import/preview', { text: csv }); assert.equal(preview.body.ok, true);
  assert.equal((await req('/api/integrations/manual_import/commit', { previewId: preview.body.previewId })).status, 400);
  assert.equal((await req('/api/integrations/manual_import/commit', { previewId: preview.body.previewId, confirm: true })).body.imported, 1);
  assert.equal((await req('/api/integrations/shopify_admin/configure', { enabled: true })).status, 400);
  assert.equal((await req('/api/integrations/shopify_admin/configure', { confirm: true, enabled: true, orders: false })).body.stateLabel, 'À configurer');
  const raw = Buffer.from(JSON.stringify({ text: 'sku\nSKU-écran' }));
  const split = raw.indexOf(Buffer.from('é')) + 1;
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/integrations/manual_import/preview', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve(JSON.parse(text)));
    }); req.on('error', reject); req.write(raw.subarray(0, split)); setImmediate(() => req.end(raw.subarray(split)));
  });
  assert.equal(chunked.ok, true); assert.equal(chunked.rows[0].sku, 'SKU-écran');
  const malformed = await fetch(base + '/api/integrations/manual_import/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'PRIVATE-INVALID-JSON' });
  assert.equal(malformed.status, 400); assert.doesNotMatch(await malformed.text(), /PRIVATE-INVALID/);
  const foreign = await fetch(base + '/api/integrations/manual_import/preview', { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ text: csv }) });
  assert.equal(foreign.status, 403); assert.equal(fetches, 0);
});
test('aperçu isolé : sa mutation ne change pas le lot confirmé et les SKU longs sont conservés', t => {
  const { s } = setup(t), svc = s.integrations;
  const sku = 'SKU-' + 'x'.repeat(995);
  const p = svc.previewImport(`id;sku\n1234567890123;${sku}`);
  assert.equal(p.ok, true);
  p.rows[0].customer = { name: 'Fixture Private Name' };
  p.rows[0].purchaseCost = 999;
  svc.commitImport({ previewId: p.previewId, confirm: true });
  const row = svc.store.latest('manual_import', 'import').payload.rows[0];
  assert.equal(row.customer, undefined); assert.equal(row.purchaseCost, null); assert.equal(row.sku, sku); assert.equal(row.id, '1234567890123');
  svc.grant('manual_import', 'lucas'); assert.match(svc.promptFor({ agentSlug: 'lucas', integrations: ['manual_import'] }).text, /1234567890123/);
});
