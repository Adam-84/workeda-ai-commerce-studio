// Phase 8 — Shopify App Manager : inventaire déclaré, analyse, détection publique (indices), mesures réelles simulées, accès agent, API. Hors ligne.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { normalizeApp, validateAppsCsv, analyzeApps, extractResources, findingsOf, measureStorefront, APP_CSV_TEMPLATE, MEASURE_LIMITS } from '../src/shop-apps.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const DOMAIN = 'boutique-test.example';
const EXT = '0123abcd-4567-89ef-0123-456789abcdef';
const HTML = `<html><head>
<script src="https://cdn.shopify.com/s/files/1/0001/theme.js" async></script>
<script src="https://cdn.shopify.com/extensions/${EXT}/app/assets/embed.js?v=3&token=secret123"></script>
<script src="https://widgets.avis-exemple.test/loader.js?key=abc"></script>
<script src="//widgets.avis-exemple.test/second.js" defer></script>
<script src="http://pas-https.example/x.js"></script>
<script src="https://127.0.0.1/local.js"></script>
<script src="https://intranet.internal/x.js"></script>
<script src="/theme-local.js"></script>
<script>window.inline = 1;</script>
<link rel="stylesheet" href="https://fonts.tiers-exemple.test/css.css">
</head><body></body></html>`;
const at = '2026-11-22T12:00:00.000Z', t0 = Date.parse(at);

const base = (o = {}) => ({ id: o.id ?? 'x', name: 'A', function: 'avis', status: 'declared', costAmount: null, costCurrency: null, billingPeriod: 'unknown', detectedKeys: [], updatedAt: at, ...o });

test('fiche : coût seulement avec devise et périodicité ; « détectée » jamais acceptée à la main ; texte nettoyé', () => {
  assert.equal(normalizeApp({ name: 'Avis+', costAmount: '9,90', costCurrency: 'eur', billingPeriod: 'monthly' }).app.costAmount, 9.9);
  assert.equal(normalizeApp({ name: 'Avis+' }).app.costAmount, null, 'coût absent = inconnu');
  assert.equal(normalizeApp({ name: 'Avis+' }).app.billingPeriod, 'unknown');
  for (const bad of [{ name: 'A', costAmount: '5' }, { name: 'A', costAmount: '5', costCurrency: 'EUR' }, { name: 'A', costAmount: '5', costCurrency: 'ZZZ', billingPeriod: 'monthly' }, { name: 'A', costAmount: '-5', costCurrency: 'EUR', billingPeriod: 'monthly' },
    { name: 'A', function: 'inconnue' }, { name: '' }, { name: 'A', status: 'detected' }, { name: 'A', installedOn: '2026-13-40' }, { name: 'A', costAmount: '3', costCurrency: 'EUR', billingPeriod: 'free' }]) assert.equal(normalizeApp(bad).ok, false, JSON.stringify(bad));
  const n = normalizeApp({ name: 'Contact jean@example.invalid 0612345678', note: 'écrire à jean@example.invalid' }).app;
  assert.doesNotMatch(JSON.stringify(n), /jean@example/); assert.doesNotMatch(JSON.stringify(n), /0612345678/);
});

test('CSV : aperçu, erreurs par ligne, formules et doublons refusés, limites', () => {
  const ok = validateAppsCsv(`${APP_CSV_TEMPLATE}Avis+;Éditeur X;avis;declared;Pro;9.90;EUR;monthly;2026-01-15;ok\r\nMailer;;email_marketing;;;;;;;\r\n`);
  assert.equal(ok.ok, true); assert.equal(ok.rows.length, 2); assert.equal(ok.rows[1].costAmount, null);
  for (const [csv, re] of [[`${APP_CSV_TEMPLATE}=cmd|x;;avis;;;;;;;\r\n`, /formules/], [`${APP_CSV_TEMPLATE}A;;avis;;;5;;;;\r\n`, /devise/i], [`${APP_CSV_TEMPLATE}A;;avis;;;;;;;\r\nA;;avis;;;;;;;\r\n`, /double/], [`${APP_CSV_TEMPLATE}A;;avis;detected;;;;;;\r\n`, /Statut/], ['name;x\r\nA\r\n', /cellules/]]) {
    const r = validateAppsCsv(csv); assert.equal(r.ok, false); assert.match(JSON.stringify(r.errors), re);
  }
  assert.equal(validateAppsCsv('foo;bar\r\n1;2\r\n').ok, false); assert.equal(validateAppsCsv(undefined).ok, false);
  assert.equal(validateAppsCsv('name\r\n' + 'x'.repeat(600 * 1024)).ok, false);
});

test('analyse : doublons possibles, coûts connus seulement (jamais zéro inventé), totaux par devise, fiches périmées', () => {
  const apps = [base({ id: '1', name: 'Avis A', costAmount: 10, costCurrency: 'EUR', billingPeriod: 'monthly' }), base({ id: '2', name: 'Avis B', costAmount: 120, costCurrency: 'EUR', billingPeriod: 'yearly' }),
    base({ id: '3', name: 'Mail', function: 'email_marketing' }), base({ id: '4', name: 'Pop', function: 'popup', costAmount: 5, costCurrency: 'USD', billingPeriod: 'monthly', updatedAt: '2026-01-01T00:00:00Z' }),
    base({ id: '5', name: 'Gratuite', function: 'seo', billingPeriod: 'free' }), base({ id: '6', name: 'Licence', function: 'analytics', costAmount: 50, costCurrency: 'EUR', billingPeriod: 'one_time' }), base({ id: '7', name: 'Autre1', function: 'autre' }), base({ id: '8', name: 'Autre2', function: 'autre' })];
  const a = analyzeApps(apps, { now: t0 });
  assert.deepEqual(a.duplicates.map((d) => d.function), ['avis']); assert.match(a.duplicates[0].note, /POSSIBLE/);
  const eur = a.costs.totals.find((t) => t.currency === 'EUR'), usd = a.costs.totals.find((t) => t.currency === 'USD');
  assert.equal(eur.monthly, 20); assert.equal(eur.yearly, 240); assert.equal(usd.monthly, 5); assert.equal(a.costs.totals.length, 2, 'aucune conversion entre devises');
  assert.deepEqual(a.costs.unknownCost.map((x) => x.name).sort(), ['Autre1', 'Autre2', 'Mail']); assert.equal(a.costs.oneTime[0].name, 'Licence');
  assert.deepEqual(a.stale.map((x) => x.name), ['Pop']); assert.equal(a.byStatus.declared, 8); assert.equal(a.unconfirmed.length, 8);
  assert.equal(analyzeApps([base({ id: '9', name: 'Seule' })], { now: t0 }).costs.totals.length, 0, 'coût inconnu : aucun total');
});

test('détection : indices classés, requêtes nettoyées, hôtes non publics et http ignorés, jamais « preuve »', () => {
  const { resources, inlineScripts } = extractResources(HTML, DOMAIN);
  assert.equal(inlineScripts, 1);
  assert.ok(!resources.some((r) => /pas-https|127\.0\.0\.1|internal/.test(r.url)), 'http, IP et hôtes internes ignorés');
  assert.ok(resources.every((r) => !/[?#]/.test(r.url)), 'requêtes et jetons retirés');
  assert.doesNotMatch(JSON.stringify(resources), /secret123|key=abc/);
  const by = (p) => resources.filter((r) => r.party === p).length;
  assert.equal(by('boutique'), 1); assert.equal(by('plateforme_shopify'), 1); assert.equal(by('extension_shopify'), 1); assert.equal(by('tiers'), 3);
  const f = findingsOf(resources);
  assert.deepEqual(f.map((x) => x.key).sort(), [`ext:${EXT}`, 'host:fonts.tiers-exemple.test', 'host:widgets.avis-exemple.test']);
  assert.ok(f.every((x) => x.certainty === 'indice_non_prouve'));
  const w = f.find((x) => x.key === 'host:widgets.avis-exemple.test'); assert.equal(w.count, 2); assert.equal(w.renderBlocking, 1, 'seul le script sans async/defer bloque');
  assert.doesNotMatch(JSON.stringify(f), /\bpreuve certaine\b|installée/i);
});

function fakeFetch(map, log = []) {
  return async (url, init) => {
    log.push({ url, init }); const e = map[url];
    if (!e) return { status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    if (e instanceof Error) throw e;
    const buf = Buffer.from(e.body ?? 'x'.repeat(e.size ?? 100));
    return { status: e.status ?? 200, headers: new Map([['content-length', String(buf.length)], ['cache-control', 'max-age=60']]), arrayBuffer: async () => buf };
  };
}
test('mesure : octets, durées et blocages réels simulés ; échec isolé ; une seule requête GET sans redirection ni identifiants', async () => {
  const log = []; let tick = 0; const clock = () => (tick += 7);
  const map = { [`https://${DOMAIN}/`]: { body: HTML }, [`https://widgets.avis-exemple.test/loader.js`]: { size: 1000 }, 'https://widgets.avis-exemple.test/second.js': { size: 500 }, 'https://fonts.tiers-exemple.test/css.css': new Error('boom'), [`https://cdn.shopify.com/extensions/${EXT}/app/assets/embed.js`]: { size: 2048 } };
  const scan = await measureStorefront({ fetchImpl: fakeFetch(map, log), domain: DOMAIN, tick: clock, now: () => at });
  assert.equal(scan.page.ok, true); assert.equal(scan.totals.thirdPartyRequests, 4); assert.equal(scan.totals.failed, 1);
  assert.equal(scan.byKey['host:widgets.avis-exemple.test'].bytes, 1500); assert.equal(scan.byKey[`ext:${EXT}`].bytes, 2048); assert.equal(scan.byKey['host:fonts.tiers-exemple.test'].bytes, 0);
  assert.ok(scan.byKey['host:widgets.avis-exemple.test'].ms > 0); assert.match(scan.method, /sans rendu navigateur/);
  assert.ok(log.every((c) => c.init.method === 'GET' && c.init.redirect === 'manual' && c.init.credentials === 'omit' && !c.init.body && !c.init.headers.authorization && !c.init.headers.cookie));
  assert.ok(log.every((c) => new URL(c.url).protocol === 'https:'));
  assert.ok(log.every((c) => c.url === `https://${DOMAIN}/` || /widgets\.avis-exemple|fonts\.tiers|cdn\.shopify\.com\/extensions/.test(c.url)), 'seuls la page et les ressources tierces repérées sont lus');
  assert.ok(!log.some((c) => /theme\.js|theme-local|127\.0\.0\.1|pas-https|internal/.test(c.url)));
  const a = analyzeApps([base({ id: 'a', name: 'Avis', detectedKeys: ['host:widgets.avis-exemple.test', 'host:absent'] }), base({ id: 'b', name: 'Sans lien' })], { now: t0, measures: scan });
  assert.equal(a.impact.length, 1); assert.equal(a.impact[0].bytes, 1500); assert.equal(a.impact[0].measured, true);
  const none = analyzeApps([base({ id: 'a', name: 'Avis', detectedKeys: ['host:x'] })], { now: t0 }); assert.equal(none.impact[0].measured, false); assert.equal(none.impact[0].bytes, null, 'sans mesure : non mesuré, jamais zéro');
  const down = await measureStorefront({ fetchImpl: fakeFetch({}), domain: DOMAIN, now: () => at }); assert.equal(down.page.ok, false); assert.match(down.error, /indisponible/);
  await assert.rejects(() => measureStorefront({ fetchImpl: fakeFetch({}), domain: 'pas un domaine' }), /invalide/);
  assert.ok(MEASURE_LIMITS.maxResources <= 30);
});

// --- service + store ----------------------------------------------------------------------------------------------------------------
function setup(t, extra = {}) {
  let ms = t0; const s = createStudio(':memory:', { env: {}, shopConnector: null, clock: () => new Date(ms).toISOString(), nowMs: () => ms, ...extra });
  s.syncAgentFiles(profiles); t.after(() => s.close());
  return { s, svc: s.integrations, advance: (n) => { ms += n; } };
}

test('stockage : ajout, correction sans réimport, confirmation datée, suppression, import fusionné sans effacer, indice promu « détectée »', (t) => {
  const { s, svc, advance } = setup(t), apps = svc.apps;
  const a = apps.add({ name: 'Avis+', function: 'avis', costAmount: '9.9', costCurrency: 'EUR', billingPeriod: 'monthly' });
  assert.equal(a.status, 'declared'); assert.equal(a.confirmedAt, null);
  assert.throws(() => apps.add({ name: 'avis+' }), /existe déjà/);
  advance(1000);
  const c = apps.update(a.id, { status: 'confirmed', note: 'vue dans mon admin' }); assert.equal(c.status, 'confirmed'); assert.ok(c.confirmedAt); assert.equal(c.costAmount, 9.9, 'les autres champs sont conservés');
  const cleared = apps.update(a.id, { costAmount: null }); assert.equal(cleared.costAmount, null); assert.equal(cleared.costCurrency, null);
  assert.throws(() => apps.update(a.id, { status: 'detected' }), /Statut refusé/);
  assert.throws(() => apps.add({ name: 'X', status: 'detected' }), /Statut refusé/);
  const tok = 'shpat_' + 'a'.repeat(32); const masked = apps.add({ name: 'Clé', note: `token ${tok}` }); assert.ok(!masked.note.includes(tok), 'un secret saisi est masqué avant stockage'); assert.ok(!JSON.stringify(apps.list()).includes(tok)); apps.remove(masked.id);
  const keep = apps.add({ name: 'Garde-moi', function: 'seo' });
  const prev = svc.previewAppsImport(`${APP_CSV_TEMPLATE}Avis+;;avis;declared;;4.00;EUR;monthly;;\r\nNouvelle;;sms;;;;;;;\r\n`);
  assert.equal(prev.ok, true); assert.equal(apps.count(), 2, 'rien d’enregistré avant confirmation');
  assert.throws(() => svc.commitAppsImport({ previewId: prev.previewId }), /confirmation/i); assert.throws(() => svc.commitAppsImport({ previewId: 'faux', confirm: true }), /Aperçu/);
  assert.deepEqual(svc.commitAppsImport({ previewId: prev.previewId, confirm: true }), { added: 1, updated: 1 });
  assert.ok(apps.byId(keep.id), 'les fiches absentes du fichier ne sont jamais supprimées'); assert.equal(apps.byId(a.id).costAmount, 4);
  assert.throws(() => svc.commitAppsImport({ previewId: prev.previewId, confirm: true }), /Aperçu/, 'un aperçu ne sert qu’une fois');
  const scan = apps.saveScan({ at: new Date(t0).toISOString(), findings: [{ key: 'host:w.example.test', label: 'w.example.test', count: 1, renderBlocking: 0, bytes: 10, ms: 5 }], resources: [] });
  assert.ok(scan.id);
  const p = apps.promote({ key: 'host:w.example.test', name: 'Widget' }); assert.equal(p.status, 'detected'); assert.deepEqual(p.detectedKeys, ['host:w.example.test']); assert.match(p.note, /non confirmé/);
  assert.throws(() => apps.promote({ key: 'host:inconnu', name: 'Z' }), /Indice inconnu/);
  assert.equal(apps.link(keep.id, 'host:w.example.test').detectedKeys[0], 'host:w.example.test');
  assert.equal(apps.remove(a.id).removed, true); assert.throws(() => apps.remove(a.id), /inconnue/);
  s.integrations.purgeExpired();
});

test('rétention : relevés de détection purgés après 30 jours ; fiches conservées mais signalées à revérifier', (t) => {
  const { svc, advance } = setup(t), apps = svc.apps;
  apps.add({ name: 'Ancienne' }); apps.saveScan({ at: new Date(t0).toISOString(), findings: [], resources: [] });
  assert.ok(apps.latestScan()); advance(29 * 86_400_000); svc.purgeExpired(); assert.ok(apps.latestScan());
  advance(2 * 86_400_000); svc.purgeExpired(); assert.equal(apps.latestScan(), null);
  assert.equal(apps.count(), 1); assert.equal(svc.appsOverview().analysis.stale.length, 1);
});

test('accès agent : aucun par défaut, bloc fourni seulement après accord, statuts et coûts inconnus signalés, aucune donnée client', (t) => {
  const { svc } = setup(t);
  assert.deepEqual(svc.card('shopify_apps').grants, []);
  svc.apps.add({ name: 'Avis+', function: 'avis', costAmount: '10', costCurrency: 'EUR', billingPeriod: 'monthly', note: 'client marie@example.invalid' });
  svc.apps.add({ name: 'Mailer', function: 'email_marketing', status: 'confirmed' });
  const none = svc.promptFor({ agentSlug: 'maxime', integrations: ['shopify_apps'] });
  assert.equal(none.used.length, 0); assert.doesNotMatch(none.text, /Avis\+/); assert.match(none.text, /NON accordé/); assert.match(none.text, /Applications Shopify/);
  assert.throws(() => svc.grant('shopify_apps', 'inconnu-agent'), /Agent inconnu/);
  svc.grant('shopify_apps', 'maxime');
  const b = svc.promptFor({ agentSlug: 'maxime', integrations: ['shopify_apps'] });
  assert.deepEqual(b.used, ['shopify_apps']); assert.match(b.provided[0], /^archipel:\/\/integrations\/shopify_apps\/[0-9a-f-]{36}$/);
  assert.match(b.text, /Avis\+/); assert.match(b.text, /Déclarée/); assert.match(b.text, /Confirmée par le propriétaire/); assert.match(b.text, /"cout":"inconnu"/); assert.match(b.text, /jamais une preuve/); assert.match(b.text, /aucune installation/i);
  assert.doesNotMatch(b.text, /marie@example/);
  assert.equal(svc.promptFor({ agentSlug: 'lucas', integrations: ['shopify_apps'] }).used.length, 0, 'l’accès est individuel');
  svc.revoke('shopify_apps'); assert.equal(svc.promptFor({ agentSlug: 'maxime', integrations: ['shopify_apps'] }).used.length, 0);
  assert.equal(svc.apps.count(), 2, 'révoquer retire les accès sans effacer l’inventaire sauf demande explicite'); svc.revoke('shopify_apps', { purge: true }); assert.equal(svc.apps.count(), 0);
  svc.grant('shopify_apps', 'maxime'); const empty = svc.promptFor({ agentSlug: 'maxime', integrations: ['shopify_apps'] });
  assert.equal(empty.used.length, 0); assert.match(empty.text, /aucun inventaire|AUCUNE application/i);
});

test('détection : désactivée par défaut, activation + confirmation + réseau autorisé exigés à chaque lancement ; indice jamais preuve', async (t) => {
  const log = []; const map = { [`https://${DOMAIN}/`]: { body: HTML }, 'https://widgets.avis-exemple.test/loader.js': { size: 10 }, 'https://widgets.avis-exemple.test/second.js': { size: 10 }, 'https://fonts.tiers-exemple.test/css.css': { size: 10 }, [`https://cdn.shopify.com/extensions/${EXT}/app/assets/embed.js`]: { size: 10 } };
  const off = setup(t, { integrationsFetch: fakeFetch(map, log) });
  assert.equal(off.svc.appsOverview().settings.detectionEnabled, false);
  await assert.rejects(() => off.svc.runDetection({ confirm: true }), /désactivée/); assert.equal(log.length, 0);
  off.svc.setDetectionEnabled(true);
  await assert.rejects(() => off.svc.runDetection({}), /Confirmation explicite/); assert.equal(log.length, 0);
  await assert.rejects(() => off.svc.runDetection({ confirm: true }), /désactivée|real_network|ARCHIPEL_ALLOW_REAL_NETWORK/); assert.equal(log.length, 0, 'réseau réel non autorisé : aucune requête');
  const on = setup(t, { env: { ARCHIPEL_ALLOW_REAL_NETWORK: '1', WORKEDA_SHOP_DOMAIN: DOMAIN }, integrationsFetch: fakeFetch(map, log) });
  on.svc.setDetectionEnabled(true); await on.svc.runDetection({ confirm: true });
  assert.ok(log.length >= 5); const ov = on.svc.appsOverview();
  assert.equal(ov.scan.findings.length, 3); assert.ok(ov.scan.findings.every((f) => f.certainty === 'indice_non_prouve')); assert.equal(ov.apps.length, 0, 'une détection ne crée jamais de fiche d’elle-même');
  on.svc.revoke('shopify_apps'); assert.equal(on.svc.appsOverview().settings.detectionEnabled, false, 'révoquer désactive la détection');
  assert.throws(() => on.svc.setDetectionEnabled('oui'), /booléenne/);
});

test('API : inventaire, ajout, correction, suppression confirmée, import, détection refusée par défaut ; aucune écriture Shopify', async (t) => {
  let shopFetches = 0;
  const { s } = setup(t, { integrationsFetch: async () => { shopFetches++; throw new Error('réseau interdit'); } });
  const server = createApp({ studio: s, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); server.orchestrator?.stop?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, data) => { const r = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  const ov = await req('/api/shop-apps'); assert.equal(ov.status, 200); assert.deepEqual(ov.body.apps, []); assert.equal(ov.body.settings.detectionEnabled, false);
  assert.match((await req('/api/shop-apps/template')).body.csv, /billing_period/);
  const add = await req('/api/shop-apps', { name: 'Avis+', function: 'avis', costAmount: '9.9', costCurrency: 'EUR', billingPeriod: 'monthly' }); assert.equal(add.status, 200); const id = add.body.app.id;
  assert.equal((await req('/api/shop-apps', { name: 'Avis+' })).status, 409);
  assert.equal((await req('/api/shop-apps', { name: 'X', status: 'detected' })).status, 400);
  const upd = await req(`/api/shop-apps/${id}`, { status: 'confirmed' }); assert.equal(upd.body.app.status, 'confirmed'); assert.equal(upd.body.app.costAmount, 9.9);
  assert.equal((await req(`/api/shop-apps/${id}`, { function: 'zzz' })).status, 400);
  assert.equal((await req('/api/shop-apps/00000000-0000-4000-8000-000000000000', { note: 'x' })).status, 404);
  assert.equal((await req(`/api/shop-apps/${id}/delete`, {})).status, 400); assert.equal((await req(`/api/shop-apps/${id}/delete`, { confirm: true })).body.apps.length, 0);
  const p = await req('/api/shop-apps/import/preview', { text: `${APP_CSV_TEMPLATE}Mailer;;email_marketing;;;;;;;\r\n` }); assert.equal(p.body.ok, true);
  assert.equal((await req('/api/shop-apps/import/commit', { previewId: p.body.previewId })).status, 400);
  assert.equal((await req('/api/shop-apps/import/commit', { previewId: p.body.previewId, confirm: true })).body.added, 1);
  assert.equal((await req('/api/shop-apps/detection/run', { confirm: true })).status, 403, 'désactivée par défaut');
  await req('/api/shop-apps/detection/settings', { enabled: true });
  assert.equal((await req('/api/shop-apps/detection/run', { confirm: true })).status, 403, 'réseau réel non autorisé');
  assert.equal(shopFetches, 0);
  const cards = (await req('/api/integrations')).body.cards; assert.ok(cards.some((c) => c.id === 'shopify_apps' && c.grants.length === 0));
  const foreign = await fetch(`${base}/api/shop-apps`, { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Intrus' }) });
  assert.equal(foreign.status, 403, 'origine étrangère refusée'); assert.equal(s.integrations.apps.list().some((a) => a.name === 'Intrus'), false);
});

test('Comms : une tâche peut demander l’inventaire ; un agent délégué n’élargit jamais ; la recherche web exclut les données', async (t) => {
  const { s } = setup(t); const ids = Object.fromEntries(s.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const root = s.comm.createTask({ assigneeId: ids.maxime, instruction: 'Audit des applications', withIntegrations: ['shopify_apps'] }).task;
  assert.deepEqual(root.withIntegrations, ['shopify_apps']);
  const child = s.comm.createTask({ assigneeId: ids.lucas, instruction: 'Sous-tâche', parentTaskId: root.id, withIntegrations: ['shopify_apps', 'dsers'], }, { type: 'agent', agentId: ids.maxime, runId: s.comm.startRun({ agentId: ids.maxime, kind: 'reply', model: 'sonnet' }).id }).task;
  assert.deepEqual(child.withIntegrations, ['shopify_apps'], 'jamais plus large que la tâche parente');
  const orphan = s.comm.createTask({ assigneeId: ids.lucas, instruction: 'Autre', withIntegrations: ['inconnue'] }).task; assert.deepEqual(orphan.withIntegrations, []);
});

test('agent Maxime : 11e agent en lecture/recherche, les dix autres inchangés, aucun outil d’écriture ni connecteur d’écriture', () => {
  const m = profiles.find((p) => p.slug === 'maxime'); assert.ok(m); assert.equal(profiles.length, 11);
  assert.equal(m.department, 'Catalogue'); assert.equal(m.role, 'Responsable des applications Shopify et optimisation de la conversion');
  assert.deepEqual(m.skills, ['workeda-audit-apps-shopify', 'workeda-impact-performance-apps', 'workeda-alternatives-apps', 'workeda-cro-ecommerce']);
  assert.ok(!m.tools.some((x) => ['Bash', 'Edit', 'Write', 'NotebookEdit'].includes(x)), m.tools.join());
  for (const slug of ['alexander', 'olivia', 'sophia', 'noah', 'lucas', 'isabella', 'chloe', 'ryan', 'harper', 'benjamin']) assert.ok(profiles.some((p) => p.slug === slug), slug);
  const text = m.sections.neFaitJamais + m.sections.regles; for (const re of [/installe/i, /abonnement/i, /indice, jamais une preuve/, /données clients/i]) assert.match(text, re);
});

test('analyse statique : aucun processus, aucune requête d’écriture, aucune mutation Shopify, aucune installation dans la fonction', () => {
  for (const f of ['src/shop-apps.js', 'src/studio-apps.js']) {
    const code = readFileSync(f, 'utf8');
    assert.ok(!/child_process|execSync|spawn\(|eval\(|new Function|writeFileSync|appData|\.env\b/.test(code), `${f} : processus ou fichier`);
    assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(code), `${f} : requête d'écriture`);
    assert.ok(!/\bmutation\b|appInstall|appUninstall|appSubscription|webhookSubscription|app\/uninstall/i.test(code.replace(/\/\/.*$/gm, '')), `${f} : mutation Shopify`);
  }
  const ui = readFileSync('public/apps-ui.js', 'utf8'); assert.ok(!/innerHTML|eval\(|document\.write/.test(ui), 'interface : pas d’injection HTML');
  const routes = readFileSync('src/app.js', 'utf8'); assert.ok(!/shop-apps[^\n]*(install|uninstall|subscribe|billing)/i.test(routes), 'aucune route d’installation ou d’abonnement');
});

test('interface : le panneau des applications se construit, signale l’absence d’inventaire et n’active rien par défaut', async (t) => {
  const { integrationsCenter } = await import('../public/integrations-ui.js');
  function element(tagName, attrs = {}, ...children) {
    const el = { tagName: tagName.toUpperCase(), ...attrs, childNodes: [], parentNode: null, textContent: '', replaceChildren(...nodes) { this.childNodes = nodes; for (const n of nodes) if (typeof n === 'object') n.parentNode = this; }, contains(node) { return node === this || this.childNodes.some((n) => typeof n === 'object' && n.contains(node)); }, focus() { globalThis.document.activeElement = this; } };
    el.replaceChildren(...children.flat(Infinity).filter((n) => n != null && n !== false)); return el;
  }
  const text = (el) => (typeof el === 'string' ? el : (el.childNodes ?? []).map(text).join(' '));
  globalThis.document = { activeElement: null }; t.after(() => { delete globalThis.document; });
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const card = { id: 'shopify_apps', label: 'Applications Shopify', provenance: 'Inventaire déclaré par le propriétaire', state: 'not_configured', stateLabel: 'Aucun inventaire', local: true, readOnly: true, flags: {}, reasons: ['Archipel ne connaît pas les applications installées'], grants: [], settings: { detectionEnabled: false }, snapshots: [] };
  const overview = { apps: [], analysis: analyzeApps([], { now: t0 }), scan: null, labels: { statuses: { declared: 'Déclarée' }, functions: { autre: 'Autre', avis: 'Avis clients' }, billing: { unknown: 'Inconnu' } }, settings: { detectionEnabled: false, realNetworkAllowed: false, domain: DOMAIN } };
  const root = integrationsCenter({ setLeave() {}, ui: { h: element, announce() {}, send: async () => ({}), get: async (p) => (p === '/api/shop-apps' ? overview : { cards: [card], agents: [], realNetworkAllowed: false, storage: { available: true } }) } });
  await new Promise(setImmediate);
  const all = text(root);
  assert.match(all, /Aucune application déclarée/); assert.match(all, /ne connaît aucune application installée/); assert.match(all, /désactivée par défaut/); assert.match(all, /INDICE, jamais la preuve/);
  const find = (el, pred) => (pred(el) ? el : (el.childNodes ?? []).filter((n) => typeof n === 'object').map((n) => find(n, pred)).find(Boolean));
  const run = find(root, (e) => e.tagName === 'BUTTON' && e.childNodes.includes('Lancer la détection et la mesure')); assert.equal(run.disabled, true, 'bouton bloqué tant que la fonction n’est pas autorisée');
});
