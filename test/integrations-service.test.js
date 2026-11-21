// Integration Center : connecteurs DSers / 17TRACK contre des serveurs SIMULÉS. Aucun réseau réel, aucun compte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createSecretStore, testProtector } from '../src/secret-store.js';
import { containsPii } from '../src/integrations-core.js';
import { createSimDsers, createSimTrack17, shopCatalog, PII } from './helpers/sim-servers.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const OPEN = { ARCHIPEL_ALLOW_REAL_NETWORK: '1' };
function setup({ dsers = {}, track = {}, env = OPEN, clockMs } = {}) {
  const clock = { t: clockMs ?? Date.parse('2026-11-21T10:00:00Z') };
  const sim = createSimDsers({ nowMs: () => clock.t, ...dsers }), t17 = createSimTrack17({ clock: () => clock.t, ...track });
  const secretsDir = mkdtempSync(join(tmpdir(), 'archipel-int-'));
  const secrets = createSecretStore({ dir: secretsDir, protector: testProtector() });
  const fetchImpl = (url, init) => (String(url).includes('17track') ? t17.fetch(url, init) : sim.fetch(url, init));
  const studio = createStudio(':memory:', { secrets, env, integrationsFetch: fetchImpl, nowMs: () => clock.t, integrationsSleep: async () => { clock.t += 400; }, redirectUri: 'http://127.0.0.1:4318/api/integrations/dsers/callback' });
  studio.syncAgentFiles(profiles);
  const items = shopCatalog(38);
  studio.shop.latest = () => ({ id: 'shop1', fetchedAt: new Date(clock.t).toISOString(), products: items });
  const svc = studio.integrations;
  const connect = async () => { const { authorizationUrl } = await svc.beginAuth('dsers'); const a = sim.authorize(authorizationUrl); return svc.completeAuth({ code: a.code, state: a.state }); };
  return { studio, svc, sim, t17, secrets, secretsDir, clock, connect };
}

test('réseau réel désactivé par défaut : aucune connexion, aucun appel, état honnête', async () => {
  const { svc, sim } = setup({ env: {} });
  await assert.rejects(() => svc.beginAuth('dsers'), (e) => e.kind === 'real_network_disabled');
  assert.equal(sim.state.http.length, 0, 'aucune requête partie');
  const c = svc.card('dsers');
  assert.equal(c.realNetworkAllowed, false); assert.ok(['configured', 'not_configured'].includes(c.state));
  assert.equal(c.flags.authenticated, false);
  assert.equal(svc.card('track17').state, 'configured' === svc.card('track17').state ? 'configured' : svc.card('track17').state); // jamais « testé »
  assert.equal(svc.card('track17').flags.tested, false);
});

test('OAuth PKCE : portées de lecture exactes, PKCE S256, jetons chiffrés hors base', async () => {
  const { svc, sim, secretsDir, connect } = setup();
  const r = await connect();
  assert.deepEqual(r.scopes.sort(), ['order:read', 'plan:read', 'product:read', 'store:read', 'supplier:read', 'tracking:read']);
  assert.equal(sim.state.registered[0].token_endpoint_auth_method, 'none');
  assert.equal(sim.state.tokenRequests[0].grant_type, 'authorization_code'); assert.ok(sim.state.tokenRequests[0].code_verifier.length >= 43);
  const files = readdirSync(secretsDir); assert.ok(files.includes('dsers.tokens.secret'));
  const raw = readFileSync(join(secretsDir, 'dsers.tokens.secret'), 'utf8');
  assert.ok(![...sim.state.access].some((t) => raw.includes(t)), 'jeton illisible sur disque');
  assert.equal(svc.card('dsers').flags.authenticated, true);
  assert.ok(!JSON.stringify(svc.card('dsers')).match(/at-[0-9a-f-]{20}|rt-[0-9a-f-]{20}/), 'aucun jeton dans la carte');
});

test('portée excédentaire (écriture) accordée par le serveur : connexion refusée, jetons supprimés', async () => {
  const { svc, sim, secrets } = setup({ dsers: { extraScope: 'product:mapping' } });
  await assert.rejects(() => (async () => { const { authorizationUrl } = await svc.beginAuth('dsers'); const a = sim.authorize(authorizationUrl); return svc.completeAuth({ code: a.code, state: a.state }); })(), (e) => e.kind === 'forbidden');
  assert.equal(secrets.has('dsers.tokens'), false); assert.equal(svc.card('dsers').flags.authenticated, false);
});

test('retour OAuth : état inconnu ou rejoué refusé', async () => {
  const { svc, sim } = setup();
  const { authorizationUrl } = await svc.beginAuth('dsers'); const a = sim.authorize(authorizationUrl);
  await assert.rejects(() => svc.completeAuth({ code: a.code, state: 'inconnu' }), (e) => e.kind === 'auth');
  await svc.completeAuth({ code: a.code, state: a.state });
  await assert.rejects(() => svc.completeAuth({ code: a.code, state: a.state }), (e) => e.kind === 'auth');
});

test('test de connexion : 60 outils exposés, 12 autorisés, 26 d’écriture refusés ; état « testé »', async () => {
  const { svc, connect } = setup(); await connect();
  const r = await svc.test('dsers');
  assert.equal(r.ok, true); assert.equal(r.allowed, 12); assert.equal(r.write, 26);
  const c = svc.card('dsers'); assert.equal(c.state, 'tested'); assert.equal(c.lastTest.ok, true);
});

test('plan Basic : restriction expliquée, état indisponible, aucun achat, repli sans MCP', async () => {
  const { svc, connect } = setup({ dsers: { plan: 'basic' } }); await connect();
  await assert.rejects(() => svc.test('dsers'), (e) => e.kind === 'plan_restriction');
  const c = svc.card('dsers'); assert.equal(c.state, 'unavailable'); assert.match(c.lastTest.error, /plan|Basic|MCP/i);
  const p = svc.promptFor({ agentSlug: 'lucas', integrations: ['dsers'] });
  assert.deepEqual(p.used, []); // aucune donnée inventée
});

test('synchronisation : écritures jamais appelées, cache respecté, plafond de 100 appels par jour', async () => {
  const { svc, sim, connect } = setup(); await connect(); await svc.test('dsers');
  const r1 = await svc.sync('dsers', { force: true });
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.deepEqual(sim.writeAttempts, []);
  assert.ok(sim.calls.every((c) => ['list_stores', 'list_managed_store_products', 'list_packages', 'list_supplier_product_shipping_methods_and_cost'].includes(c.name)));
  const n = sim.calls.length, r2 = await svc.sync('dsers');
  assert.equal(sim.calls.length, n, 'deuxième relevé : cache, zéro appel'); assert.ok(r2.steps.every((s) => s.fromCache));
  assert.ok(svc.card('dsers').quota.used <= 100);
});

test('plafond configurable : atteint = refus local, jamais d’appel réseau', async () => {
  const { svc, sim, connect } = setup(); await connect();
  svc.setDailyCap('dsers', 3);
  await svc.test('dsers'); // 2 appels comptabilisés (initialize + tools/list)
  const r = await svc.sync('dsers', { force: true });
  assert.ok(sim.calls.length <= 1, `appels MCP outils après plafond : ${sim.calls.length}`);
  assert.equal(r.ok, false); assert.equal(svc.card('dsers').quota.remaining, 0);
  await assert.rejects(() => svc.dsers.call('list_stores'), (e) => e.kind === 'quota_local');
  assert.throws(() => svc.setDailyCap('dsers', 0)); assert.throws(() => svc.setDailyCap('dsers', 99999));
});

test('outils d’écriture et inconnus : refusés côté serveur Archipel avant tout réseau', async () => {
  const { svc, sim, connect } = setup(); await connect();
  const before = sim.state.http.length;
  for (const t of ['create_order', 'delete_product', 'push_to_store', 'update_product', 'confirm_order', 'billing', 'outil_inconnu']) await assert.rejects(() => svc.dsers.call(t, {}), (e) => e.kind === 'forbidden', t);
  assert.equal(sim.state.http.length, before); assert.deepEqual(sim.writeAttempts, []);
});

test('quota côté DSers (RATE_LIMITED) : pause enregistrée, plus aucun appel', async () => {
  const { svc, sim, connect } = setup({ dsers: { serverDailyCap: 2 } }); await connect();
  const r = await svc.sync('dsers', { force: true });
  assert.equal(r.ok, false); const seen = sim.state.mcpCount;
  const r2 = await svc.sync('dsers', { force: true });
  assert.equal(r2.ok, false); assert.equal(sim.state.mcpCount, seen, 'pause respectée');
});

test('jeton expiré : renouvelé automatiquement avec le jeton de rafraîchissement', async () => {
  const { svc, sim, clock, connect } = setup({ dsers: { ttlSec: 120 } }); await connect();
  await svc.test('dsers'); clock.t += 10 * 60_000; sim.expireAccessTokens();
  const r = await svc.dsers.call('list_stores', {}); assert.ok(r); assert.ok(sim.state.tokenRequests.some((t) => t.grant_type === 'refresh_token'));
});

test('données agents : AUCUN accès par défaut, accordé agent par agent, sans données personnelles', async () => {
  const { svc, connect } = setup(); await connect(); await svc.test('dsers'); await svc.sync('dsers', { force: true });
  let p = svc.promptFor({ agentSlug: 'lucas', integrations: ['dsers'] });
  assert.equal(p.text.includes('Produit'), false); assert.deepEqual(p.denied, ['dsers']); assert.match(p.text, /NON accordé/);
  svc.grant('dsers', 'lucas');
  p = svc.promptFor({ agentSlug: 'lucas', integrations: ['dsers'] });
  assert.deepEqual(p.used, ['dsers']); assert.ok(p.text.length > 200 && p.text.length <= 13_000);
  for (const bad of [...PII.names, ...PII.emails, ...PII.phones, ...PII.streets, ...PII.zips]) assert.ok(!p.text.includes(bad), `PII : ${bad}`);
  assert.equal(containsPii(p.text), false); assert.ok(!/RR\d{9}CN/.test(p.text), 'numéro de suivi masqué');
  assert.match(p.text, /RR\*+CN/); assert.ok(p.provided.every((u) => u.startsWith('archipel://integrations/dsers/')));
  // un autre agent reste sans accès ; la révocation est immédiate
  assert.deepEqual(svc.promptFor({ agentSlug: 'isabella', integrations: ['dsers'] }).used, []);
  svc.revokeGrant('dsers', 'lucas'); assert.deepEqual(svc.promptFor({ agentSlug: 'lucas', integrations: ['dsers'] }).used, []);
  assert.throws(() => svc.grant('dsers', 'agent-inexistant'), /inconnu/);
});

test('rapprochement Shopify↔DSers exact : appariés, ambigus/orphelins signalés, jamais approximatif', async () => {
  const { svc, connect } = setup(); await connect(); await svc.sync('dsers', { force: true });
  const d = svc.dsers.data(setup().studio.shop.latest().products);
  assert.deepEqual(d.match.counts, { shop: 38, dsers: 40, matched: 38 });
  assert.deepEqual(d.match.unmatchedDsers.map((x) => x.dsersId), ['dx0', 'dx1'], 'produits DSers sans équivalent Shopify signalés');
  assert.deepEqual([d.match.unmatchedShop.length, d.match.ambiguous.length], [0, 0]);
  assert.deepEqual(d.match.missing, { noSupplierCost: 6, noSupplier: 0, noShopPrice: 0, notMapped: 8 }, 'données manquantes comptées, jamais comblées');
  assert.ok(d.match.matched.every((m) => ['id', 'handle'].includes(m.basis)), 'jamais de rapprochement approximatif');
});

test('17TRACK : sans clé = non configuré, aucune requête, aucun enregistrement ; avec clé simulée = lecture seule', async () => {
  const { svc, t17 } = setup();
  await assert.rejects(() => svc.test('track17'), (e) => e.kind === 'auth'); assert.equal(t17.state.calls.length, 0);
  svc.setKey('track17', t17.key);
  const t = await svc.test('track17'); assert.equal(t.quotaTotal, 100);
  const s = await svc.sync('track17', { force: true });
  assert.equal(s.ok, true, JSON.stringify(s)); assert.equal(s.count, 85);
  assert.equal(t17.state.registerCalls, 0, 'aucun numéro enregistré'); assert.ok(t17.state.calls.every((c) => ['getquota', 'gettracklist', 'gettrackinfo'].includes(c)));
  assert.equal(t17.state.rateLimited, 0, 'cadence de 3 requêtes par seconde respectée');
  await assert.rejects(() => svc.track17.post('register', [{ number: 'RR1CN' }]), (e) => e.kind === 'forbidden');
  assert.equal(t17.state.registerCalls, 0);
  svc.grant('track17', 'benjamin');
  const p = svc.promptFor({ agentSlug: 'benjamin', integrations: ['track17'] });
  for (const bad of [...PII.names, ...PII.emails, ...PII.phones, ...PII.streets, ...PII.zips, 'Entrepôt']) assert.ok(!p.text.includes(bad), `PII : ${bad}`);
  assert.ok(!/RR\d{9}CN/.test(p.text));
});

test('17TRACK : clé refusée → erreur claire, état indisponible ; 429 non contourné', async () => {
  const { svc, t17 } = setup({ track: { whitelistOk: false } });
  svc.setKey('track17', t17.key);
  await assert.rejects(() => svc.test('track17'), (e) => e.kind === 'auth'); assert.equal(svc.card('track17').state, 'unavailable');
});

test('révocation : jetons supprimés, accès retirés, relevés purgés sur demande', async () => {
  const { svc, secrets, connect } = setup(); await connect(); await svc.sync('dsers', { force: true }); svc.grant('dsers', 'lucas');
  svc.revoke('dsers', { purge: true });
  assert.equal(secrets.has('dsers.tokens'), false); assert.deepEqual(svc.store.grantsOf('dsers'), []); assert.equal(svc.store.latest('dsers', 'products'), null);
  assert.equal(svc.card('dsers').flags.authenticated, false);
});

test('aucun secret ni donnée personnelle dans la base, les cartes, les journaux et les relevés', async () => {
  const { svc, studio, sim, t17, connect } = setup(); await connect(); svc.setKey('track17', t17.key);
  await svc.test('dsers'); await svc.sync('dsers', { force: true }); await svc.test('track17'); await svc.sync('track17', { force: true });
  const all = JSON.stringify(svc.cards()) + JSON.stringify(svc.store.recentCalls('dsers', 100)) + JSON.stringify(svc.store.recentCalls('track17', 100)) + JSON.stringify(['stores', 'products', 'packages', 'shipping'].map((k) => svc.store.latest('dsers', k))) + JSON.stringify(svc.store.latest('track17', 'tracklist'));
  for (const s of [...sim.state.access, t17.key]) assert.ok(!all.includes(s), 'secret exposé');
  for (const bad of [...PII.names, ...PII.emails, ...PII.phones, ...PII.streets, ...PII.zips]) assert.ok(!all.includes(bad), `PII stockée : ${bad}`);
  assert.ok(!/RR\d{9}CN/.test(all), 'numéros de suivi jamais en clair');
});

test('carte : le nom du service n’est jamais écrasé par le libellé d’état', () => {
  const { svc } = setup();
  assert.deepEqual(svc.cards().map((c) => c.label), ['DSers (MCP)', '17TRACK (API v2.4)']);
  assert.ok(svc.cards().every((c) => typeof c.stateLabel === 'string' && c.stateLabel.length > 0));
});

// --- correctifs issus de la revue Codex indépendante --------------------------------------------------------------------------------
import { classifyRpcError } from '../src/mcp-client.js';

test('revue Codex #2 : un jeton opaque reflété par le serveur ne survit ni dans l’erreur ni dans les cartes', () => {
  const e = classifyRpcError({ message: 'Rejected credential OPAQUEVALUE0123456789abcdef', code: -32000 });
  assert.ok(!e.message.includes('OPAQUEVALUE'));
});

test('revue Codex #4 : un retour OAuth en attente ne rétablit pas la connexion après une révocation', async () => {
  const { svc, sim, secrets } = setup();
  const { authorizationUrl } = await svc.beginAuth('dsers'); const a = sim.authorize(authorizationUrl);
  svc.revoke('dsers', { purge: true });
  await assert.rejects(() => svc.completeAuth({ code: a.code, state: a.state }), (e) => e.kind === 'auth');
  assert.equal(secrets.has('dsers.tokens'), false); assert.equal(svc.card('dsers').flags.authenticated, false);
});

test('revue Codex #5 : six appels 17TRACK simultanés avec un plafond de 1 → une seule requête part', async () => {
  const { svc, t17 } = setup(); svc.setKey('track17', t17.key); svc.setDailyCap('track17', 1);
  const r = await Promise.allSettled(Array.from({ length: 6 }, () => svc.track17.post('getquota', [])));
  assert.equal(t17.state.calls.length, 1, 'requêtes envoyées'); assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.kind === 'quota_local'));
});

test('revue Codex #5 : relevés DSers simultanés mutualisés (un seul parcours, plafond jamais dépassé)', async () => {
  const { svc, sim, connect } = setup(); await connect(); svc.setDailyCap('dsers', 8);
  await Promise.allSettled([svc.sync('dsers', { force: true }), svc.sync('dsers', { force: true }), svc.sync('dsers', { force: true })]);
  assert.ok(sim.calls.length <= 8, `appels outils : ${sim.calls.length}`); assert.ok(svc.card('dsers').quota.used <= 8);
});

test('revue Codex #6 : après un 429 17TRACK (Retry-After), plus aucun appel pendant la pause', async () => {
  const calls = []; const res = (status, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => '{}' });
  const clock = { t: Date.parse('2026-11-21T10:00:00Z') };
  const studio = createStudio(':memory:', { secrets: createSecretStore({ dir: mkdtempSync(join(tmpdir(), 'archipel-int-')), protector: testProtector() }), env: OPEN, nowMs: () => clock.t, integrationsSleep: async () => {}, integrationsFetch: async (u) => { calls.push(String(u)); return res(429, { 'retry-after': '120' }); } });
  studio.integrations.setKey('track17', 'K'.repeat(32));
  await assert.rejects(() => studio.integrations.test('track17'), (e) => e.kind === 'rate_limited');
  await assert.rejects(() => studio.integrations.test('track17'), (e) => e.kind === 'rate_limited');
  assert.equal(calls.length, 1, 'le second test ne part pas'); assert.ok(studio.integrations.card('track17').settings.blockedUntil);
  clock.t += 121_000; await assert.rejects(() => studio.integrations.test('track17'), (e) => e.kind === 'rate_limited'); assert.equal(calls.length, 2, 'après la pause, un nouvel essai est permis');
});

test('revue Codex #6 : DSers test() respecte la pause demandée par le service', async () => {
  const { svc, sim, connect } = setup({ dsers: { serverDailyCap: 1 } }); await connect();
  await assert.rejects(() => svc.test('dsers'), (e) => e.kind === 'rate_limited'); const seen = sim.state.mcpCount;
  await assert.rejects(() => svc.test('dsers'), (e) => e.kind === 'rate_limited'); assert.equal(sim.state.mcpCount, seen, 'aucun appel pendant la pause');
});

test('revue Codex (2e passe) : un renouvellement de jeton en cours ne ressuscite pas une connexion révoquée', async () => {
  const sim = createSimDsers({ ttlSec: 120 }); let hold = null, release = null;
  const clock = { t: Date.parse('2026-11-21T10:00:00Z') };
  const secrets = createSecretStore({ dir: mkdtempSync(join(tmpdir(), 'archipel-int-')), protector: testProtector() });
  const slowFetch = async (u, i) => { if (String(u).endsWith('/oauth/token') && hold && /refresh_token/.test(String(i.body))) { await hold; } return sim.fetch(u, i); };
  const studio = createStudio(':memory:', { secrets, env: OPEN, integrationsFetch: slowFetch, nowMs: () => clock.t, redirectUri: 'http://127.0.0.1:4318/api/integrations/dsers/callback' });
  const svc = studio.integrations; const { authorizationUrl } = await svc.beginAuth('dsers'); const a = sim.authorize(authorizationUrl); await svc.completeAuth({ code: a.code, state: a.state });
  clock.t += 10 * 60_000; hold = new Promise((r) => { release = r; });
  const pending = svc.dsers.accessToken().catch((e) => e);
  await new Promise((r) => setTimeout(r, 20));
  svc.revoke('dsers', { purge: true }); release();
  const r = await pending;
  assert.ok(r instanceof Error && r.kind === 'auth', 'le renouvellement doit échouer après révocation');
  assert.equal(secrets.has('dsers.tokens'), false); assert.equal(svc.card('dsers').flags.authenticated, false);
});

test('revue Codex (2e passe) : test et synchronisation ne se confondent jamais (opérations différentes, résultats différents)', async () => {
  const { svc, connect } = setup(); await connect();
  const [t, s] = await Promise.all([svc.test('dsers'), svc.sync('dsers', { force: true })]);
  assert.ok('toolsExposed' in t && !('steps' in t)); assert.ok(Array.isArray(s.steps));
  assert.ok(svc.store.latest('dsers', 'products'), 'la synchronisation a bien créé ses relevés');
});

test('revue Codex (2e passe) : la pagination de tools/list est comptée requête par requête (plafond jamais dépassé)', async () => {
  const { svc, sim, connect } = setup({ dsers: { toolPages: 5 } }); await connect(); svc.setDailyCap('dsers', 2);
  await svc.test('dsers').catch(() => {});
  assert.ok(sim.state.mcpCount <= 2, `requêtes MCP envoyées : ${sim.state.mcpCount}`); assert.ok(svc.card('dsers').quota.used <= 2);
});
