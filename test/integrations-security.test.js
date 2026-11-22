// Phase 6 — tests de sécurité : lecture seule par construction, aucun secret ni donnée client qui sorte, réseau réel verrouillé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DSERS_ALLOWED_TOOLS, DSERS_WRITE_TOOLS, DSERS_UNUSED_READ_TOOLS, assertAllowed, classifyDsersTool, classifyTrack17Endpoint, scrubText, containsPii } from '../src/integrations-core.js';
import { scrubSecrets, hasSecretShape, createSecretStore, testProtector } from '../src/secret-store.js';
import { createMcpClient, networkGate, IntegrationError } from '../src/mcp-client.js';
import { assertReadScopes, assertDsersEndpoint, assertLoopbackRedirect, createPkce, exchangeCode, grantedScopes, fetchMetadata } from '../src/oauth-pkce.js';
import { createStudio } from '../src/studio.js';
import { createSimDsers, createSimTrack17 } from './helpers/sim-servers.js';

const src = (f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
const FILES = ['integrations-core.js', 'mcp-client.js', 'oauth-pkce.js', 'dsers-connector.js', 'track17-connector.js', 'integrations.js', 'studio-integrations.js', 'secret-store.js'];

test('OAuth : les erreurs et portées distantes ne reflètent aucun texte libre', async () => {
  const reflected = 'valeur-opaque-confidentielle Jean Dupont 12 rue des Lilas';
  await assert.rejects(() => exchangeCode({ fetchImpl: async () => ({ status: 400, text: async () => JSON.stringify({ error: reflected }) }), metadata: { token_endpoint: 'https://ai.dsers.com/oauth/token' }, scopes: ['store:read'] }), (e) => !e.message.includes(reflected));
  assert.throws(() => grantedScopes({ scope: reflected }, ['store:read']), (e) => !/Jean|Dupont|Lilas|opaque/.test(e.message));
});

test('OAuth : métadonnées et réponse de jeton trop volumineuses refusées', async () => {
  const metadata = { authorization_endpoint: 'https://ai.dsers.com/oauth/authorize', token_endpoint: 'https://ai.dsers.com/oauth/token', registration_endpoint: 'https://ai.dsers.com/oauth/register' };
  const fetchImpl = async () => new Response(JSON.stringify({ ...metadata, access_token: 'factice', extra: 'x'.repeat(2_000_001) }));
  await assert.rejects(() => fetchMetadata(fetchImpl), (e) => e.kind === 'protocol');
  await assert.rejects(() => exchangeCode({ fetchImpl, metadata, scopes: ['store:read'] }), (e) => e.kind === 'protocol');
});

test('liste blanche : seuls 12 outils DSers de lecture passent ; écriture, lecture inutile et inconnus refusés', () => {
  assert.equal(DSERS_ALLOWED_TOOLS.length, 12);
  for (const t of DSERS_ALLOWED_TOOLS) assert.equal(classifyDsersTool(t).allowed, true, t);
  for (const t of [...DSERS_WRITE_TOOLS, ...DSERS_UNUSED_READ_TOOLS]) assert.equal(classifyDsersTool(t).allowed, false, t);
  for (const t of ['', null, undefined, 'x', 'LIST_STORES', 'list_stores ', 'list_stores;delete_product', '__proto__', 'constructor', 'toString', 'list_stores\n', 'create_order', 'pay', 'refund', 'publish_product', 'delete_everything']) assert.throws(() => assertAllowed('dsers', t), (e) => e.kind === 'forbidden', String(t));
  assert.equal(new Set([...DSERS_ALLOWED_TOOLS, ...DSERS_WRITE_TOOLS, ...DSERS_UNUSED_READ_TOOLS]).size, DSERS_ALLOWED_TOOLS.length + DSERS_WRITE_TOOLS.length + DSERS_UNUSED_READ_TOOLS.length, 'aucune ambiguïté entre listes');
  for (const t of DSERS_ALLOWED_TOOLS) assert.ok(!/^(create|update|delete|push|publish|place|confirm|cancel|pay|refund|set|remove|add|import|sync|reset|apply|submit)_/.test(t), `outil autorisé à allure d'écriture : ${t}`);
});

test('17TRACK : seuls getquota, gettracklist, gettrackinfo ; register (payant) et tout le reste refusés', () => {
  for (const e of ['getquota', 'gettracklist', 'gettrackinfo']) assert.equal(classifyTrack17Endpoint(e).allowed, true);
  for (const e of ['register', 'changecarrier', 'changeinfo', 'deletetrack', 'stoptrack', 'retrack', 'push', 'getrealtimetrackinfo', 'GETQUOTA', 'getquota/../register', '']) assert.throws(() => assertAllowed('track17', e), (x) => x.kind === 'forbidden', e);
});

test('client MCP : un outil d’écriture n’atteint JAMAIS le réseau, même appelé directement', async () => {
  let n = 0; const mcp = createMcpClient({ url: 'https://ai.dsers.com/mcp', fetchImpl: async () => { n += 1; throw new Error('réseau'); }, getToken: async () => 'tok' });
  for (const t of DSERS_WRITE_TOOLS) await assert.rejects(() => mcp.callTool(t, {}), (e) => e.kind === 'forbidden', t);
  assert.equal(n, 0);
});

test('client MCP : HTTPS seulement, redirection refusée, réponse trop grosse refusée, jeton jamais dans une erreur', async () => {
  assert.throws(() => createMcpClient({ url: 'http://ai.dsers.com/mcp', fetchImpl: async () => ({}), getToken: async () => 't' }), /HTTPS|https/i);
  const res = (status, text, h = {}) => ({ status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text });
  const redirect = createMcpClient({ url: 'https://ai.dsers.com/mcp', fetchImpl: async () => res(302, '', { location: 'https://evil.example/' }), getToken: async () => 'SECRET-TOKEN-1234567890' });
  await assert.rejects(() => redirect.initialize(), (e) => e instanceof IntegrationError && !/SECRET-TOKEN/.test(e.message));
  const big = createMcpClient({ url: 'https://ai.dsers.com/mcp', maxBytes: 100, fetchImpl: async () => res(200, 'x'.repeat(5000)), getToken: async () => 'SECRET-TOKEN-1234567890' });
  await assert.rejects(() => big.initialize(), (e) => !/SECRET-TOKEN/.test(e.message));
});

test('OAuth : portées hors lecture refusées ; hôte hors ai.dsers.com refusé ; redirection seulement boucle locale', () => {
  assertReadScopes(['store:read', 'product:read']);
  for (const s of ['billing:read', 'staff:read', 'product:mapping', 'order:write', 'store:write', 'openid profile', '*', 'product:read product:write']) assert.throws(() => assertReadScopes(s.split(' ')), /port|scope/i, s);
  for (const u of ['http://ai.dsers.com/x', 'https://evil.dsers.com.evil.net/x', 'https://ai.dsers.com.evil.net/x', 'https://evil.net/ai.dsers.com']) assert.throws(() => assertDsersEndpoint(u, 'test'), /ai\.dsers\.com|refus|hôte/i, u);
  for (const u of ['https://evil.example/cb', 'http://192.168.1.5:4318/cb', 'http://localhost.evil.net/cb', 'javascript:alert(1)']) assert.throws(() => assertLoopbackRedirect(u), /boucle|locale|loopback|refus/i, u);
  assert.ok(assertLoopbackRedirect('http://127.0.0.1:4318/api/integrations/dsers/callback'));
  const a = createPkce(), b = createPkce(); assert.notEqual(a.state, b.state); assert.notEqual(a.verifier, b.verifier); assert.ok(a.verifier.length >= 43);
});

test('masquage des secrets : jetons, en-têtes, JWT, clés dans les erreurs et journaux', () => {
  for (const raw of ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789', 'access_token=abcdefghijklmnop1234567890', '{"refresh_token":"abcdefghijklmnop1234567890"}', '17token: ABCDEFGH12345678ABCDEFGH', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz', ['shpat', '0123456789abcdef0123456789abcdef'].join('_'), ('sk' + '-abcdefghijklmnopqrstuvwxyz0123456789')]) {
    const out = scrubSecrets(`erreur ${raw} fin`), value = raw.match(/[A-Za-z0-9._-]{20,}/)?.[0];
    assert.ok(value && !out.includes(value), `valeur sensible conservée : ${out}`);
  }
});

test('données personnelles : e-mails, téléphones, numéros de suivi nettoyés ; texte libre jamais transmis', () => {
  const dirty = 'Colis RR123456789CN pour jean.dupont@exemple.fr, tél 06 12 34 56 78 ou +33 6 98 76 54 32';
  const clean = scrubText(dirty, 400); assert.equal(containsPii(clean), false); assert.ok(!/RR123456789CN/.test(clean));
  for (const bad of ['jean.dupont@exemple.fr', '06 12 34 56 78', '+33 6 98 76 54 32']) assert.ok(!clean.includes(bad), bad);
});

test('stockage des secrets : jamais en clair, pas de repli, noms contrôlés (traversée de dossier impossible)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-sec-')), s = createSecretStore({ dir, protector: testProtector() });
  for (const n of ['../x', '..\\x', 'a/b', 'a\\b', 'C:x', '.hidden', 'x'.repeat(65)]) assert.throws(() => s.set(n, 'v'), /invalide/, n);
  s.set('dsers.tokens', 'SECRET-VALUE-0123456789'); for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f), 'utf8').includes('SECRET-VALUE'));
  const none = createSecretStore({ dir, protector: { id: 'aucun', available: false } }); assert.throws(() => none.set('a', 'b'), (e) => e.status === 503); assert.equal(none.info().plaintextFallback, false);
});

test('DPAPI réel (Windows) : le secret ne passe jamais par les arguments de la ligne de commande', { skip: process.platform !== 'win32' }, () => {
  const seen = []; const spy = (cmd, args, opts) => { seen.push(JSON.stringify([cmd, args])); return execFileSync(cmd, args, opts); };
  const dir = mkdtempSync(join(tmpdir(), 'archipel-dpapi-')); const { dpapiProtector } = awaitImport();
  const s = createSecretStore({ dir, protector: dpapiProtector({ run: spy }) }); s.set('t', 'FAUX-SECRET-DPAPI-0123456789'); assert.equal(s.get('t'), 'FAUX-SECRET-DPAPI-0123456789');
  assert.ok(seen.every((x) => !x.includes('FAUX-SECRET')), 'secret dans les arguments');
});
function awaitImport() { return { dpapiProtector: (opts) => import_dpapi(opts) }; }
import { dpapiProtector as import_dpapi } from '../src/secret-store.js';

test('réseau réel verrouillé : sans ARCHIPEL_ALLOW_REAL_NETWORK=1, AUCUNE requête (DSers, 17TRACK) ne part', async () => {
  let n = 0; const f = networkGate({ env: {}, fetchImpl: async () => { n += 1; return {}; } });
  await assert.rejects(() => f('https://ai.dsers.com/mcp'), (e) => e.kind === 'real_network_disabled'); await assert.rejects(() => f('https://api.17track.net/track/v2.4/getquota'), (e) => e.kind === 'real_network_disabled');
  for (const v of ['0', 'true', 'yes', '', ' 1', '1 ']) { const g = networkGate({ env: { ARCHIPEL_ALLOW_REAL_NETWORK: v }, fetchImpl: async () => { n += 1; return {}; } }); await assert.rejects(() => g('https://x'), (e) => e.kind === 'real_network_disabled', JSON.stringify(v)); }
  assert.equal(n, 0);
  const sim = createSimDsers(), t17 = createSimTrack17();
  const studio = createStudio(':memory:', { secrets: createSecretStore({ dir: mkdtempSync(join(tmpdir(), 'archipel-sec-')), protector: testProtector() }), env: {}, integrationsFetch: (u, i) => (String(u).includes('17track') ? t17.fetch(u, i) : sim.fetch(u, i)) });
  studio.integrations.setKey('track17', t17.key);
  await assert.rejects(() => studio.integrations.test('track17'), (e) => e.kind === 'real_network_disabled');
  studio.integrations.store.patch('dsers', { settings: { plan: 'advanced' } });
  await assert.rejects(() => studio.integrations.beginAuth('dsers'), (e) => e.kind === 'real_network_disabled');
  assert.equal(t17.state.calls.length + sim.state.http.length, 0);
});

test('analyse du code : pas d’appel direct à fetch hors passerelle, pas de journalisation de jetons, pas d’outil d’écriture appelé', () => {
  for (const f of FILES) {
    const code = src(f);
    assert.ok(!/console\.(log|error|warn|info|debug)/.test(code), `${f} : console.*`);
    if (f !== 'secret-store.js') assert.ok(!/child_process|execSync|spawn\(|eval\(|new Function/.test(code), `${f} : exécution de processus`);
    if (!['mcp-client.js', 'integrations.js'].includes(f)) assert.ok(!/globalThis\.fetch|[^.\w]fetch\(/.test(code), `${f} : fetch direct`);
  }
  for (const f of ['dsers-connector.js', 'track17-connector.js']) { const code = src(f); for (const w of DSERS_WRITE_TOOLS) assert.ok(!code.includes(`'${w}'`), `${f} référence l'outil d'écriture ${w}`); }
  const routes = readFileSync(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8');
  const ints = routes.split('\n').filter((l) => /api.{0,2}integrations/.test(l));
  assert.ok(ints.length > 5); for (const l of ints) assert.ok(!/\b(PUT|DELETE|PATCH)\b/.test(l), `route non POST/GET : ${l.slice(0, 80)}`);
});

test('.gitignore : données locales et secrets jamais versionnés ; aucun secret dans les fichiers suivis', () => {
  const ig = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8'); assert.match(ig, /^data\/$/m); assert.match(ig, /^\.env$/m);
  const out = execFileSync('git', ['check-ignore', 'data/secrets/dsers.tokens.secret', 'data/workeda.db'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }); assert.match(out, /dsers\.tokens\.secret/);
  for (const f of readdirSync(fileURLToPath(new URL('../src', import.meta.url))).filter((x) => x.endsWith('.js') && !/secret-store|integrations-core/.test(x))) assert.ok(!/(shpat_|sk-)[A-Za-z0-9]{16,}/.test(src(f)), `${f} : jeton en dur`);
});
