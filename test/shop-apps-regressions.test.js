import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';
import { analyzeApps, measureStorefront, APP_CSV_TEMPLATE, MAX_APPS } from '../src/shop-apps.js';

const setup = (t) => {
  const studio = createStudio(':memory:', { env: {}, shopConnector: null });
  t.after(() => studio.close());
  return studio.integrations;
};

test('annual costs retain cents before rounding monthly equivalents', () => {
  const result = analyzeApps([1, 2].map((id) => ({ id, name: `App ${id}`, function: 'seo', status: 'declared', costAmount: 10, costCurrency: 'EUR', billingPeriod: 'yearly' })));
  assert.deepEqual(result.costs.totals, [{ currency: 'EUR', monthly: 1.67, yearly: 20, apps: 2 }]);
});

test('CSV confirmation refuses an inventory edited after preview', (t) => {
  const svc = setup(t);
  const app = svc.apps.add({ name: 'Avis', note: 'initial' });
  const preview = svc.previewAppsImport(`${APP_CSV_TEMPLATE}Avis;;avis;declared;;;;;;obsolete\r\n`);
  assert.equal(preview.ok, true);
  svc.apps.update(app.id, { note: 'correction manuelle' });
  assert.throws(() => svc.commitAppsImport({ previewId: preview.previewId, confirm: true }), (e) => e.status === 409);
  assert.equal(svc.apps.byId(app.id).note, 'correction manuelle');
});

test('promoting an indication observes the same inventory limit as manual entry', (t) => {
  const svc = setup(t);
  for (let i = 0; i < MAX_APPS; i++) svc.apps.add({ name: `App ${i}` });
  svc.apps.saveScan({ findings: [{ key: 'host:widget.example', label: 'widget.example' }] });
  assert.throws(() => svc.apps.promote({ key: 'host:widget.example', name: 'Extra' }), (e) => e.status === 409);
  assert.equal(svc.apps.count(), MAX_APPS);
});

test('public detection reads only the fixed storefront and keeps third-party hints unmeasured', async () => {
  const calls = [];
  const scan = await measureStorefront({ domain: 'store.example', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('<head><script src="https://third.example/widget.js"></script></head>');
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://store.example/');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.page.ok, true);
  assert.ok(scan.page.bytes > 0);
  assert.equal(scan.findings[0].bytes, null);
  assert.equal(scan.findings[0].ms, null);
  const result = analyzeApps([{ id: 'a', name: 'App', detectedKeys: ['host:third.example'] }], { measures: scan });
  assert.equal(result.impact[0].measured, false);
  assert.equal(result.impact[0].bytes, null);
});

test('nonfinite and unsafe amounts are rejected at the inventory boundary', (t) => {
  const svc = setup(t);
  for (const amount of ['9'.repeat(310), '90071992547409.91']) {
    assert.throws(() => svc.apps.add({ name: 'Trop grand', costAmount: amount, costCurrency: 'EUR', billingPeriod: 'monthly' }), (e) => e.status === 400);
    const csv = svc.previewAppsImport(`${APP_CSV_TEMPLATE}Trop grand;;seo;declared;;${amount};EUR;monthly;;\r\n`);
    assert.equal(csv.ok, false);
  }
  assert.equal(svc.apps.count(), 0);
});

test('a bounded agent inventory explicitly identifies omitted applications before any truncation', async (t) => {
  const { loadAgentFiles } = await import('../src/agent-files.js');
  const { fileURLToPath } = await import('node:url');
  const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
  const studio = createStudio(':memory:', { env: {}, shopConnector: null });
  t.after(() => studio.close()); studio.syncAgentFiles(profiles);
  const service = studio.integrations;
  for (let i = 0; i < 61; i++) service.apps.add({ name: `App ${String(i).padStart(2, '0')}`, note: 'x'.repeat(400), function: 'avis' });
  service.grant('shopify_apps', 'maxime');
  service.apps.saveScan({ findings: Array.from({ length: 25 }, (_, i) => { const host = '123456789.a.'.repeat(20) + `x${i}.com`; return { key: `host:${host}`, label: host, count: 1, renderBlocking: 0 }; }) });
  const output = service.promptFor({ agentSlug: 'maxime', integrations: ['shopify_apps'] });
  assert.match(output.text, /61 application\(s\) au total/);
  assert.match(output.text, /NON fournie\(s\).*analyse partielle/);
  assert.match(output.text, /FIN INVENTAIRE FOURNI/);
  assert.ok(output.text.length < 23000);
  const jsonBlock = output.text.match(/\n(\{.*\})\nFIN INVENTAIRE FOURNI/s);
  assert.ok(jsonBlock); assert.doesNotThrow(() => JSON.parse(jsonBlock[1]));
});
