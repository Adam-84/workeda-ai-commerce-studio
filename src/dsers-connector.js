// src/dsers-connector.js — DSers en LECTURE SEULE via le MCP officiel.
// Chaque appel passe par `call()` : (1) liste blanche d'outils, (2) plafond quotidien configurable (100 par défaut), (3) journal sans contenu,
// (4) cache par durée de vie. Aucune écriture, aucune commande, aucun paiement, aucune publication : ces outils sont refusés avant tout réseau.
import { assertAllowed, classifyExposedTools, DSERS_READ_SCOPES, CACHE_TTL_MS, projectStoreProduct, projectPackage, projectShippingQuote, matchCatalog, analyzeLogistics } from './integrations-core.js';
import { createMcpClient, IntegrationError } from './mcp-client.js';
import { assertLoopbackRedirect, buildAuthorizationUrl, createFlowStore, createPkce, exchangeCode, fetchMetadata, refreshTokens, registerClient } from './oauth-pkce.js';

export const DSERS_MCP_URL = 'https://ai.dsers.com/mcp';
const MAX_PAGES = { products: 6, packages: 4 }, SHIPPING_BATCH = 15, PAGE_SIZE = 50;
const listOf = (r, keys = ['products', 'items', 'data', 'list', 'results', 'packages', 'stores']) => { if (Array.isArray(r)) return r; for (const k of keys) if (Array.isArray(r?.[k])) return r[k]; for (const k of keys) if (Array.isArray(r?.data?.[k])) return r.data[k]; return []; };
const hasMore = (r, got) => Boolean(r?.has_more ?? r?.hasMore ?? r?.next_page ?? r?.nextPage ?? r?.next_cursor ?? (r?.total != null && r?.page != null ? got < Number(r.total) : false));

export function createDsersConnector({ store, secrets, fetchImpl, now = () => Date.now(), redirectUri, flows = createFlowStore({ now }) }) {
  const ID = 'dsers';
  const nowIso = () => new Date(now()).toISOString();
  let queue = Promise.resolve(), generation = 0; const running = new Map();
  const stillCurrent = (gen) => { if (gen !== generation) throw new IntegrationError('auth', 'Opération annulée par une révocation.'); };
  // Un seul appel à la fois : le plafond est vérifié puis consommé sans qu'un appel concurrent ne puisse le dépasser.
  const exclusive = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const once = (key, fn) => { if (running.has(key)) return running.get(key); const p = fn().finally(() => running.delete(key)); running.set(key, p); return p; }; // une opération identique en cours est partagée ; jamais une opération DIFFÉRENTE
  const pause = (e) => { if (e instanceof IntegrationError && e.kind === 'rate_limited') store.patch(ID, { settings: { ...store.state(ID).settings, blockedUntil: new Date(now() + (e.retryAfterSec ?? 3600) * 1000).toISOString() } }); };
  const admit = (need = 1) => {
    const blocked = store.state(ID).settings.blockedUntil, q = store.quota(ID);
    if (blocked && Date.parse(blocked) > now()) throw new IntegrationError('rate_limited', `DSers a signalé un quota atteint : pause jusqu'au ${blocked}.`);
    if (q.remaining < need) throw new IntegrationError('quota_local', `Plafond quotidien Archipel atteint (${q.cap} appels DSers) : réessayez après ${q.resetsAt} ou augmentez-le.`, { status: 429 });
  };
  const fresh = (kind) => {
    const s = store.latest(ID, kind);
    if (kind === 'shipping' && !s?.payload?.quotes?.every((q) => q.quotes.every((x) => x.country === (store.state(ID).settings.shipCountry || 'FR')))) return null;
    return s && now() - Date.parse(s.fetchedAt) < (CACHE_TTL_MS[kind] ?? 3_600_000) ? s : null;
  };

  // --- authentification (OAuth 2.1 + PKCE, navigateur) ---
  const clientRecord = () => secrets.get('dsers.client', { json: true });
  async function beginAuth() {
    const gen = generation;
    if (!secrets.info().available) throw new IntegrationError('unavailable', 'Stockage sécurisé indisponible : impossible de conserver les jetons.');
    const redirect = assertLoopbackRedirect(redirectUri);
    const metadata = await fetchMetadata(fetchImpl);
    let client = clientRecord();
    stillCurrent(gen);
    if (!client?.clientId || client.redirectUri !== redirect) { client = { ...(await registerClient({ fetchImpl, metadata, redirectUri: redirect })), redirectUri: redirect }; stillCurrent(gen); secrets.set('dsers.client', client); }
    const pkce = createPkce();
    flows.put(pkce.state, { verifier: pkce.verifier, redirectUri: redirect, clientId: client.clientId, generation });
    return { authorizationUrl: buildAuthorizationUrl({ metadata, clientId: client.clientId, redirectUri: redirect, scopes: DSERS_READ_SCOPES, challenge: pkce.challenge, state: pkce.state }), scopes: [...DSERS_READ_SCOPES] };
  }
  async function completeAuth({ code, state }) {
    const flow = typeof state === 'string' ? flows.take(state) : null;
    if (!flow || flow.generation !== generation || typeof code !== 'string' || !code) throw new IntegrationError('auth', 'Retour de connexion inconnu, expiré ou déjà utilisé.');
    const metadata = await fetchMetadata(fetchImpl);
    try {
      const t = await exchangeCode({ fetchImpl, metadata, clientId: flow.clientId, redirectUri: flow.redirectUri, code, verifier: flow.verifier, scopes: DSERS_READ_SCOPES, now: now() });
      if (flow.generation !== generation) throw new IntegrationError('auth', 'Connexion annulée par une révocation.');
      secrets.set('dsers.tokens', t);
      store.patch(ID, { authenticated: true, scopes: t.scopes, connectedAt: nowIso(), revokedAt: null, lastTestOk: null, lastTestError: null });
      return { authenticated: true, scopes: t.scopes };
    } catch (e) {
      if (e instanceof IntegrationError && e.kind === 'forbidden') { secrets.delete('dsers.tokens'); store.patch(ID, { authenticated: false, scopes: [], lastTestOk: false, lastTestError: e.message }); }
      throw e;
    }
  }
  async function accessToken() {
    let t = secrets.has('dsers.tokens') ? secrets.get('dsers.tokens', { json: true }) : null;
    if (!t?.access) return null;
    if (t.expiresAt - 60_000 > now()) return t.access;
    if (!t.refresh) { store.patch(ID, { authenticated: false }); return null; }
    const gen = generation;
    try {
      const metadata = await fetchMetadata(fetchImpl), client = clientRecord();
      t = await refreshTokens({ fetchImpl, metadata, clientId: client?.clientId, refresh: t.refresh, scopes: DSERS_READ_SCOPES, now: now() });
      if (gen !== generation) throw new IntegrationError('auth', 'Connexion révoquée pendant le renouvellement du jeton.');
      secrets.set('dsers.tokens', t);
      return t.access;
    } catch (e) { store.patch(ID, { authenticated: false, lastTestError: e.message }); throw e; }
  }
  // Chaque requête MCP (initialize, chaque page de tools/list, chaque outil) est admise puis comptée ici : aucune pagination n'échappe au plafond.
  const mcp = createMcpClient({ url: DSERS_MCP_URL, integration: ID, fetchImpl, getToken: accessToken, beforeRpc: () => admit(1),
    afterRpc: ({ method, ok, ms, error }) => { if (method === 'initialize' || method === 'tools/list') store.recordCall(ID, { tool: method, ok, ms, error }); } });

  // --- appel comptabilisé : liste blanche → plafond → réseau → journal ---
  async function call(tool, args = {}) { assertAllowed(ID, tool); const gen = generation; return exclusive(() => { stillCurrent(gen); return callNow(tool, args); }); } // 1. refus d'un outil d'écriture/inconnu AVANT tout (même sans attendre son tour)
  async function callNow(tool, args) {
    const gen = generation;
    assertAllowed(ID, tool);
    admit();                                                           // 2. pause demandée par DSers, puis plafond quotidien
    const t0 = Date.now();
    try { const r = await mcp.callTool(tool, args); stillCurrent(gen); store.recordCall(ID, { tool, ok: true, ms: Date.now() - t0 }); return r; }
    catch (e) {
      if (e.kind === 'auth') store.patch(ID, { authenticated: false });
      store.recordCall(ID, { tool, ok: false, ms: Date.now() - t0, error: e.message });
      pause(e);
      throw e;
    }
  }

  // --- test de connexion : initialisation + liste des outils réellement exposés à VOTRE compte ---
  const test = () => once('test', () => exclusive(testNow));
  async function testNow() {
    const gen = generation;
    const t0 = Date.now();
    try {
      admit(2);
      await mcp.initialize();
      const tools = await mcp.listTools();
      stillCurrent(gen);
      const c = classifyExposedTools(tools.map((x) => x.name));
      const detail = { toolsExposed: tools.length, allowed: c.allowed.length, write: c.write.length, readUnused: c.readUnused.length, unknown: c.unknown.map(() => 'Nom distant non conservé'), missing: c.missing, note: c.unknown.length ? 'Outils inconnus : refusés par défaut.' : '' };
      store.patch(ID, { lastTestAt: nowIso(), lastTestOk: true, lastTestError: null, lastTestDetail: detail });
      return { ok: true, ...detail };
    } catch (e) {
      pause(e); // l'échec est déjà journalisé requête par requête ; un refus local ne consomme jamais de quota
      if (e.kind === 'auth') store.patch(ID, { authenticated: false });
      store.patch(ID, { lastTestAt: nowIso(), lastTestOk: false, lastTestError: e.message, lastTestDetail: { kind: e.kind ?? 'error' } });
      throw e;
    }
  }

  // --- relevés (cache, plafond, erreurs isolées par étape) ---
  async function pages(tool, key, project, max, extra = {}) {
    const out = []; let calls = 0;
    for (let page = 1; page <= max; page += 1) {
      const r = await call(tool, { page, page_size: PAGE_SIZE, ...extra }); calls += 1;
      const items = listOf(r); out.push(...items.map(project));
      if (!items.length || !hasMore(r, out.length)) break;
    }
    return { items: out, calls };
  }
  const sync = (opts) => once(opts?.force ? 'sync-force' : 'sync', () => syncNow(opts));
  async function syncNow({ force = false } = {}) {
    const gen = generation;
    const steps = [], fatal = (e) => e instanceof IntegrationError && ['auth', 'plan_restriction', 'rate_limited', 'quota_local', 'real_network_disabled', 'unavailable', 'forbidden'].includes(e.kind);
    const run = async (name, kind, fn) => {
      const cached = !force && fresh(kind);
      if (cached) { steps.push({ step: name, ok: true, fromCache: true, calls: 0, fetchedAt: cached.fetchedAt }); return; }
      try { const { calls, payload, note } = await fn(); stillCurrent(gen); const snap = store.saveSnapshot({ integration: ID, kind, payload, note }); steps.push({ step: name, ok: true, fromCache: false, calls, fetchedAt: snap.fetchedAt }); }
      catch (e) { steps.push({ step: name, ok: false, calls: 0, error: e.message, kind: e.kind ?? 'error' }); if (fatal(e)) throw Object.assign(e, { steps }); }
    };
    try {
      await run('boutiques', 'stores', async () => { const r = await call('list_stores', {}); return { calls: 1, payload: { stores: listOf(r, ['stores', 'items', 'data']).map((s) => ({ id: String(s.id ?? s.store_id ?? ''), name: String(s.name ?? s.store_name ?? '').slice(0, 80), platform: String(s.platform ?? s.type ?? '').slice(0, 30) })) } }; });
      await run('produits liés', 'products', async () => { const { items, calls } = await pages('list_managed_store_products', 'products', projectStoreProduct, MAX_PAGES.products); return { calls, payload: { products: items } }; });
      await run('colis', 'packages', async () => { const { items, calls } = await pages('list_packages', 'packages', projectPackage, MAX_PAGES.packages); return { calls, payload: { packages: items } }; });
      // Frais d'expédition : seulement pour un lot de produits à fournisseur connu, et seulement s'il reste du quota (réserve de 10 appels).
      const products = store.latest(ID, 'products')?.payload?.products ?? [];
      await run('frais d\'expédition', 'shipping', async () => {
        const country = store.state(ID).settings.shipCountry || 'FR';
        const prev = new Map((force ? [] : fresh('shipping')?.payload?.quotes ?? []).map((q) => [q.supplierProductId, q]));
        const todo = [...new Set(products.map((p) => p.supplierProductId).filter(Boolean))].filter((id) => !prev.has(id)).slice(0, SHIPPING_BATCH);
        let calls = 0;
        for (const id of todo) {
          if (store.quota(ID).remaining <= 10) break;
          const r = await call('list_supplier_product_shipping_methods_and_cost', { product_id: id, country }); calls += 1;
          const quotes = listOf(r, ['shipping_methods', 'methods', 'items', 'data']).map(projectShippingQuote).filter((x) => x.cost != null);
          prev.set(id, { supplierProductId: id, quotes });
        }
        return { calls, payload: { quotes: [...prev.values()] }, note: `${todo.length} produit(s) interrogé(s), pays ${country}` };
      });
      store.patch(ID, { lastSyncAt: nowIso(), lastSyncOk: steps.every((s) => s.ok), lastSyncError: steps.filter((s) => !s.ok).map((s) => `${s.step} : ${s.error}`).join(' ; ') || null });
    } catch (e) {
      store.patch(ID, { lastSyncAt: nowIso(), lastSyncOk: false, lastSyncError: e.message });
      return { ok: false, steps: e.steps ?? steps, error: e.message, kind: e.kind ?? 'error', quota: store.quota(ID) };
    }
    return { ok: steps.every((s) => s.ok), steps, quota: store.quota(ID) };
  }

  // --- données disponibles pour les agents (relevés déjà en cache : aucun appel réseau ici) ---
  function data(shopProducts = []) {
    const snaps = Object.fromEntries(['stores', 'products', 'packages', 'shipping'].map((k) => [k, store.latest(ID, k)]));
    if (!snaps.products && !snaps.packages && !snaps.stores) return null;
    const products = snaps.products?.payload?.products ?? [], packages = snaps.packages?.payload?.packages ?? [];
    const quotes = (snaps.shipping?.payload?.quotes ?? []).flatMap((q) => q.quotes.map((x) => ({ ...x, supplierProductId: q.supplierProductId })));
    const used = Object.values(snaps).filter(Boolean);
    return { fetchedAt: used.map((s) => s.fetchedAt).sort()[0], sources: used.map((s) => `archipel://integrations/dsers/${s.id}`), match: snaps.products ? matchCatalog(shopProducts, products) : null, shipping: quotes, logistics: packages.length ? analyzeLogistics(packages, { now: now() }) : null, packages, products, snapshotIds: used.map((s) => s.id) };
  }
  function revoke({ purge = false } = {}) {
    generation += 1; // invalide tout retour OAuth encore en attente
    secrets.delete('dsers.tokens'); secrets.delete('dsers.client');
    store.patch(ID, { authenticated: false, scopes: [], revokedAt: nowIso(), lastTestOk: null, lastTestError: null, lastTestDetail: {}, settings: { ...store.state(ID).settings, blockedUntil: null } });
    if (purge) { store.purge(ID); store.revokeAllGrants(ID); }
    return { revoked: true, purged: purge, note: 'Jetons supprimés de cet ordinateur. DSers n’offre pas de point de révocation : retirez aussi l’accès d’Archipel dans votre compte DSers.' };
  }
  return { id: ID, beginAuth, completeAuth, test, sync, call, data, revoke, accessToken, flows };
}
