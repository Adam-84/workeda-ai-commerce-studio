// Serveurs SIMULÉS (aucun réseau réel) : DSers (OAuth 2.1 + PKCE, MCP, 60 outils, plans, quotas, SSE) et 17TRACK (API v2.4, débit 3/s).
// Les données contiennent volontairement de FAUSSES données personnelles : les tests prouvent qu'elles ne ressortent jamais d'Archipel.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DSERS_ALLOWED_TOOLS, DSERS_WRITE_TOOLS, DSERS_UNUSED_READ_TOOLS } from '../../src/integrations-core.js';

const fixture = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), 'utf8'));
export const PII = { names: ['Jean Dupont', 'Marie Curie', 'Dupont', 'Curie'], emails: ['jean.dupont@exemple.fr', 'marie@exemple.fr'], phones: ['0612345678', '+33 6 12 34 56 78', '0698765432'], streets: ['12 rue des Lilas', '5 avenue Victor Hugo'], cities: ['Lyon', 'Paris'], zips: ['69003', '75016'] };
const reply = (status, body, headers = {}) => { const text = typeof body === 'string' ? body : JSON.stringify(body); const h = Object.fromEntries(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v])); return { status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text }; };
const form = (body) => Object.fromEntries(new URLSearchParams(body));

export const shopCatalog = (n = 38) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), handle: `produit-${i}`, title: `Produit numéro ${i}`, priceMin: 20 + i }));

export function createSimDsers({ plan = 'advanced', sse = false, serverDailyCap = null, extraTools = [], extraScope = null, ttlSec = 3600, products = shopCatalog(38), nowMs = () => Date.now(), unmatchedDsers = 2, toolPages = 1 } = {}) {
  const meta = fixture('dsers-authorization-server.json');
  const state = { plan, calls: [], writeAttempts: [], registered: [], codes: new Map(), access: new Set(), refresh: new Map(), mcpCount: 0, http: [], ttlSec, revokedAll: false, tokenRequests: [] };
  const rawProducts = products.map((p, i) => ({ id: `dp${i}`, title: p.title, handle: i % 2 ? p.handle : undefined, store_url: i % 2 ? undefined : `https://workeda.com/products/${p.handle}`, shopify_product_id: i % 3 === 0 ? p.id : undefined, price: p.priceMin, currency: 'EUR',
    supplier_product_id: `sp${i}`, supplier_name: `Fournisseur ${i % 4}`, supplier_price: i % 7 === 0 ? undefined : 5 + (i % 9), supplier_currency: 'USD', mapped: i % 5 !== 0, owner_email: PII.emails[0], store_owner: PII.names[0] }));
  for (let i = 0; i < unmatchedDsers; i += 1) rawProducts.push({ id: `dx${i}`, title: `Produit DSers orphelin ${i}`, handle: `orphelin-${i}`, supplier_name: 'Fournisseur X', supplier_price: 3, mapped: false });
  const statuses = ['Delivered', 'In transit', 'Out for delivery', 'Delivery failed', 'label created', 'returned to sender', 'In transit'];
  const rawPackages = Array.from({ length: 24 }, (_, i) => ({ order_name: `#${1100 + i}`, tracking_number: `RR${String(100000000 + i * 7919)}CN`, carrier: i % 2 ? 'Yanwen' : 'YunExpress', status: statuses[i % statuses.length], destination_country: ['FR', 'DE', 'BE', 'ES'][i % 4],
    shipped_at: new Date(nowMs() - (6 + i * 2) * 86_400_000).toISOString(), updated_at: new Date(nowMs() - (i % 9) * 86_400_000).toISOString(),
    customer: { first_name: 'Jean', last_name: 'Dupont', email: PII.emails[i % 2], phone: PII.phones[i % 3] }, shipping_address: { name: PII.names[i % 2], address1: PII.streets[i % 2], city: PII.cities[i % 2], zip: PII.zips[i % 2], phone: PII.phones[(i + 1) % 3] },
    events: [{ time: new Date(nowMs() - 5 * 86_400_000).toISOString(), description: `Remis à ${PII.names[i % 2]}, ${PII.streets[i % 2]}, tél ${PII.phones[i % 3]}` }, { time: new Date(nowMs() - 86_400_000).toISOString(), description: `Au dépôt RR${String(100000000 + i * 7919)}CN, contact ${PII.emails[i % 2]}` }] }));
  const toolNames = [...DSERS_ALLOWED_TOOLS, ...DSERS_WRITE_TOOLS, ...DSERS_UNUSED_READ_TOOLS, ...extraTools];
  const pageOf = (arr, args) => { const size = args.page_size ?? 50, page = args.page ?? 1, slice = arr.slice((page - 1) * size, page * size); return { items: slice, has_more: page * size < arr.length, page, total: arr.length }; };

  function toolResult(name, args) {
    switch (name) {
      case 'list_stores': return { stores: [{ id: 's1', name: 'Workeda', platform: 'shopify', owner_email: PII.emails[0] }] };
      case 'list_managed_store_products': { const p = pageOf(rawProducts, args); return { products: p.items, has_more: p.has_more, page: p.page, total: p.total }; }
      case 'list_packages': { const p = pageOf(rawPackages, args); return { packages: p.items, has_more: p.has_more, page: p.page, total: p.total }; }
      case 'list_supplier_product_shipping_methods_and_cost': return { shipping_methods: [{ method: 'Standard', country: args.country ?? 'FR', cost: 3.5 + (args.product_id?.length ?? 0) / 10, currency: 'USD', days_min: 8, days_max: 15 }, { method: 'Express', country: args.country ?? 'FR', cost: 9.9, currency: 'USD', days_min: 3, days_max: 6 }] };
      case 'get_plan_and_credits': return { plan: plan === 'basic' ? 'Basic' : 'Advanced', credits: 120 };
      default: return { ok: true };
    }
  }
  const rpcReply = (id, result, error) => { const msg = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }; return sse ? reply(200, `event: message\ndata: ${JSON.stringify(msg)}\n\n`, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' }) : reply(200, msg, { 'mcp-session-id': 'sess-1' }); };

  async function fetchImpl(url, init = {}) {
    const u = new URL(url); state.http.push({ method: init.method ?? 'GET', url: u.href, redirect: init.redirect });
    if (u.hostname !== 'ai.dsers.com') throw new Error(`hôte inattendu : ${u.hostname}`);
    if (init.method !== 'POST' && u.pathname === '/.well-known/oauth-authorization-server') return reply(200, meta);
    if (u.pathname === '/oauth/register') { const b = JSON.parse(init.body); state.registered.push(b); return reply(201, { client_id: 'sim-client-1', client_id_issued_at: 1 }); }
    if (u.pathname === '/oauth/token') {
      const f = form(init.body); state.tokenRequests.push(f);
      const issue = (scope) => { const access = `at-${randomUUID()}`, refresh = `rt-${randomUUID()}`; state.access.add(access); state.refresh.set(refresh, scope); return reply(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: state.ttlSec, scope }); };
      if (f.grant_type === 'authorization_code') {
        const c = state.codes.get(f.code); state.codes.delete(f.code);
        if (!c || c.clientId !== f.client_id || c.redirect !== f.redirect_uri) return reply(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return reply(400, { error: 'invalid_grant', error_description: 'PKCE' });
        return issue(extraScope ? `${c.scope} ${extraScope}` : c.scope);
      }
      if (f.grant_type === 'refresh_token') { const scope = state.refresh.get(f.refresh_token); if (!scope || state.revokedAll) return reply(400, { error: 'invalid_grant' }); state.refresh.delete(f.refresh_token); return issue(scope); }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/mcp') {
      const bearer = /^Bearer (.+)$/.exec(init.headers?.authorization ?? '')?.[1];
      if (!bearer || !state.access.has(bearer)) return reply(401, { error: 'invalid_request' }, { 'www-authenticate': 'Bearer resource_metadata="https://ai.dsers.com/.well-known/oauth-protected-resource"' });
      if (state.plan === 'basic') return reply(403, { error: 'PLAN_RESTRICTION', error_description: 'MCP Connection is not included in the Basic plan.' });
      const body = JSON.parse(init.body);
      if (body.method === 'notifications/initialized') return reply(202, '');
      state.mcpCount += 1;
      if (serverDailyCap != null && state.mcpCount > serverDailyCap) return rpcReply(body.id, null, { code: -32000, message: 'RATE_LIMITED: daily quota reached', data: { reset: 'tomorrow' } });
      if (body.method === 'initialize') return rpcReply(body.id, { protocolVersion: '2025-11-25', serverInfo: { name: 'dsers-mcp-sim', version: '0' }, capabilities: { tools: {} } });
      if (body.method === 'tools/list') {
        const per = Math.ceil(toolNames.length / toolPages), start = Number(body.params?.cursor ?? 0), slice = toolNames.slice(start, start + per);
        return rpcReply(body.id, { tools: slice.map((name) => ({ name, description: `Outil ${name}`, annotations: { readOnlyHint: !DSERS_WRITE_TOOLS.includes(name) } })), ...(start + per < toolNames.length ? { nextCursor: String(start + per) } : {}) });
      }
      if (body.method === 'tools/call') {
        const { name, arguments: args = {} } = body.params; state.calls.push({ name, args });
        if (DSERS_WRITE_TOOLS.includes(name)) state.writeAttempts.push(name);
        return rpcReply(body.id, { content: [{ type: 'text', text: JSON.stringify(toolResult(name, args)) }], isError: false });
      }
      return rpcReply(body.id, null, { code: -32601, message: 'Method not found' });
    }
    return reply(404, 'not found');
  }
  // L'étape « navigateur » : l'utilisateur se connecte à DSers puis est renvoyé avec un code. (Jamais de mot de passe ici.)
  function authorize(authorizationUrl) {
    const u = new URL(authorizationUrl), p = Object.fromEntries(u.searchParams);
    if (u.origin !== 'https://ai.dsers.com' || u.pathname !== '/oauth/authorize') throw new Error('URL d’autorisation inattendue');
    if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge || !p.state) throw new Error('paramètres OAuth invalides');
    const code = `code-${randomUUID()}`; state.codes.set(code, { challenge: p.code_challenge, scope: p.scope, clientId: p.client_id, redirect: p.redirect_uri });
    return { code, state: p.state, scope: p.scope, redirectUri: p.redirect_uri, params: p };
  }
  return { fetch: fetchImpl, state, calls: state.calls, writeAttempts: state.writeAttempts, authorize, setPlan: (p) => { state.plan = p; }, expireAccessTokens: () => state.access.clear(), toolNames, rawProducts, rawPackages };
}

export function createSimTrack17({ key = 'K'.repeat(32), whitelistOk = true, total = 100, used = 7, numbers = 85, clock = () => Date.now(), perSecond = 3 } = {}) {
  const state = { calls: [], registerCalls: 0, stamps: [], rateLimited: 0, headers: [] };
  const all = Array.from({ length: numbers }, (_, i) => `RR${String(200000000 + i * 104729)}CN`);
  const item = (number, i) => ({ number, carrier: 3011, track_info: { shipping_info: { shipper_address: { country: 'CN', city: 'SHENZHEN', street: 'Entrepôt 12', postal_code: '518000' }, recipient_address: { country: ['FR', 'DE', 'BE'][i % 3], state: null, city: PII.cities[i % 2], street: PII.streets[i % 2], postal_code: PII.zips[i % 2] } },
    latest_status: { status: ['InTransit', 'Delivered', 'Exception', 'InfoReceived'][i % 4], sub_status: 'InTransit_Other' }, latest_event: { time_utc: new Date(clock() - (i % 12) * 86_400_000).toISOString(), description: `Livré à ${PII.names[i % 2]} ${PII.phones[i % 3]}` },
    tracking: { providers: [{ provider: { name: 'Yanwen' }, events: [{ time_utc: new Date(clock() - 20 * 86_400_000).toISOString(), description: `Collecte, expéditeur ${PII.emails[0]}`, stage: 'PickedUp' }, { time_utc: new Date(clock() - 3 * 86_400_000).toISOString(), description: `Au centre de tri`, stage: 'InTransit' }] }] } } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url); state.headers.push(init.headers ?? {});
    if (u.hostname !== 'api.17track.net' || !u.pathname.startsWith('/track/v2.4/')) throw new Error(`hôte inattendu : ${u.href}`);
    const endpoint = u.pathname.split('/').pop(); state.calls.push(endpoint);
    if (init.headers?.['17token'] !== key || !whitelistOk) return reply(401, { code: -18010001, message: 'IP not in the whitelist or bad key' });
    const t = clock(); state.stamps = state.stamps.filter((x) => t - x < 1000); state.stamps.push(t);
    if (state.stamps.length > perSecond) { state.rateLimited += 1; return reply(429, { code: -18019903, message: 'rate limited' }); }
    const body = JSON.parse(init.body ?? '[]');
    if (endpoint === 'register') { state.registerCalls += 1; return reply(200, { code: 0, data: { accepted: body.map((b) => ({ number: b.number })), rejected: [] } }); }
    if (endpoint === 'getquota') return reply(200, { code: 0, data: { quota_total: total, quota_used: used, quota_remain: total - used, today_used: 1 } });
    if (endpoint === 'gettracklist') { const page = body.page_no ?? 1, size = 40, slice = all.slice((page - 1) * size, page * size); return reply(200, { code: 0, data: { accepted: slice.map((number) => ({ number })), page: { data_total: all.length, page_total: Math.ceil(all.length / size), page_no: page } } }); }
    if (endpoint === 'gettrackinfo') { if (body.length > 40) return reply(200, { code: -18010012, message: 'too many numbers' }); return reply(200, { code: 0, data: { accepted: body.map((b) => item(b.number, all.indexOf(b.number))), rejected: [] } }); }
    return reply(200, { code: -1, message: 'unknown endpoint' });
  }
  return { fetch: fetchImpl, state, all, key };
}
