// src/shop-readonly.js — relevé du catalogue Shopify en LECTURE SEULE (aucune écriture n'existe dans ce module, par construction).
// Deux modes :
//   public : pages JSON publiques de la boutique (/collections.json, /products.json), sans aucun identifiant ;
//   admin  : API Admin GraphQL avec un jeton lu UNIQUEMENT dans l'environnement (SHOPIFY_ADMIN_TOKEN + SHOPIFY_ADMIN_DOMAIN), requêtes FIXES.
// Garanties : un seul hôte autorisé, HTTPS seulement, aucune redirection suivie (le jeton ne part jamais ailleurs), délai et taille bornés,
// jamais de nouvel essai après un 429, aucune requête construite à partir d'un texte d'agent ou de message.
import { createHash } from 'node:crypto';
import { scrubContacts, scrubContactData } from './catalog-privacy.js';
import { untrusted } from './comm-core.js';
import { networkGate, realNetworkAllowed } from './mcp-client.js';
import { maskTracking, normalizeCarrier } from './integrations-core.js';

export const SHOP_LIMITS = { timeoutMs: 15_000, maxBytes: 5_000_000, pages: 4, perPage: 250, minIntervalMs: 5 * 60_000, staleMs: 24 * 3_600_000, descChars: 300, promptProducts: 120, promptChars: 14_000 };
export const ADMIN_VERSION = '2026-10';
export const ADMIN_SCOPES = ['read_products', 'read_inventory'];
export const SHOP_RETENTION_MS = 7 * 86_400_000;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

// Requêtes GraphQL fixes. Jamais de texte venant d'ailleurs ; jamais de mutation (vérifié au chargement du module ET par un test).
export const READ_QUERIES = {
  scopes: 'query AccessScopes { currentAppInstallation { accessScopes { handle } } }',
  orders: 'query Orders($first: Int!, $after: String, $filter: String!) { orders(first: $first, after: $after, query: $filter, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { id createdAt updatedAt displayFulfillmentStatus fulfillments(first: 50) { status trackingInfo(first: 20) { company number } } } } }',
  products: 'query Products($first: Int!, $after: String) { products(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id variants(first: 50) { pageInfo { hasNextPage } nodes { id sku price inventoryItem { id inventoryLevels(first: 20) { pageInfo { hasNextPage } nodes { id location { id } quantities(names: ["available"]) { name quantity } } } } } } title handle vendor productType tags status totalInventory updatedAt descriptionHtml seo { title description } mediaCount { count } priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } } } } }',
  collections: 'query Collections($first: Int!) { collections(first: $first) { nodes { id title handle updatedAt productsCount { count } } } }'
};
for (const [name, q] of Object.entries(READ_QUERIES)) if (!/^\s*query\b/.test(q) || /\b(mutation|subscription)\b/i.test(q)) throw new Error(`Requête Shopify « ${name} » : lecture seule exigée.`);

const decode = (s) => scrubContacts(String(s ?? '')).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const tagsOf = (t) => (Array.isArray(t) ? t : String(t ?? '').split(',')).map((x) => scrubContacts(String(x)).trim()).filter(Boolean).slice(0, 12);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- normalisation : même forme quel que soit le mode ---------------------------------------------------------------------------------
export function normalizePublicProduct(p, domain) {
  const prices = (p.variants ?? []).map((v) => money(v.price)).filter((x) => x !== null);
  const desc = decode(p.body_html);
  return { id: String(p.id), title: clip(decode(p.title), 160), handle: scrubContacts(p.handle), vendor: clip(decode(p.vendor), 80), type: clip(decode(p.product_type), 80), tags: tagsOf(p.tags),
    status: 'active', priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null, currency: null,
    available: (p.variants ?? []).some((v) => v.available === true), images: (p.images ?? []).length, descChars: desc.length, desc: clip(desc, SHOP_LIMITS.descChars), seoTitle: '', updatedAt: p.updated_at ?? null,
    url: `https://${domain}/products/${encodeURIComponent(scrubContacts(p.handle))}` };
}
export function normalizeAdminProduct(p, domain) {
  const desc = decode(p.descriptionHtml);
  return { id: /^\d{1,30}$/.test(String(p.id ?? '')) ? String(p.id) : gid(p.id, 'Product'), title: clip(decode(p.title), 160), handle: scrubContacts(p.handle), vendor: clip(decode(p.vendor), 80), type: clip(decode(p.productType), 80), tags: tagsOf(p.tags),
    status: ['ACTIVE', 'ARCHIVED', 'DRAFT'].includes(p.status) ? p.status.toLowerCase() : 'unknown', priceMin: money(p.priceRangeV2?.minVariantPrice?.amount), priceMax: money(p.priceRangeV2?.maxVariantPrice?.amount), currency: /^[A-Z]{3}$/.test(p.priceRangeV2?.minVariantPrice?.currencyCode ?? '') ? p.priceRangeV2.minVariantPrice.currencyCode : null,
    available: Number(p.totalInventory) > 0, images: Number(p.mediaCount?.count) || 0, descChars: desc.length, desc: clip(desc, SHOP_LIMITS.descChars), seoTitle: clip(decode(p.seo?.title), 120), updatedAt: isoDate(p.updatedAt),
    url: `https://${domain}/products/${encodeURIComponent(scrubContacts(p.handle))}` };
}
const gid = (v, resource) => new RegExp(`^gid://shopify/${resource}/[0-9]+$`).test(String(v ?? '')) ? String(v) : null;
const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const isoDate = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const STATUS_VALUES = new Set(['SUCCESS', 'FAILURE', 'CANCELLED', 'PENDING', 'OPEN', 'ERROR', 'FULFILLED', 'UNFULFILLED', 'PARTIALLY_FULFILLED', 'RESTOCKED', 'SCHEDULED', 'ON_HOLD', 'IN_PROGRESS', 'REQUEST_DECLINED']);
const closedStatus = (v) => STATUS_VALUES.has(v) ? v : 'UNKNOWN';
const projectVariants = (nodes = []) => nodes.slice(0, 50).map((v) => ({ id: gid(v.id, 'ProductVariant'), sku: clip(decode(v.sku), 160), price: v.price == null || v.price === '' ? null : money(v.price),
  inventoryItemId: gid(v.inventoryItem?.id, 'InventoryItem'), inventory: (v.inventoryItem?.inventoryLevels?.nodes ?? []).slice(0, 20).map((i) => ({ id: gid(i.id, 'InventoryLevel'), locationId: gid(i.location?.id, 'Location'), available: finite(i.quantities?.find((q) => q.name === 'available')?.quantity) })) }));
const projectOrder = (o) => ({ id: gid(o.id, 'Order'), createdAt: isoDate(o.createdAt), updatedAt: isoDate(o.updatedAt), displayFulfillmentStatus: closedStatus(o.displayFulfillmentStatus),
  fulfillments: (o.fulfillments ?? []).slice(0, 50).map((f) => ({ status: closedStatus(f.status), trackingInfo: (f.trackingInfo ?? []).slice(0, 20).map((t) => ({ company: normalizeCarrier(t.company), number: /^[A-Z0-9 -]{1,100}$/i.test(String(t.number ?? '')) ? maskTracking(t.number) : '' })) })) });

const normalizeCollection = (c) => ({ id: String(c.id), title: clip(decode(c.title), 160), handle: scrubContacts(c.handle), count: Number(c.products_count ?? c.productsCount?.count) || 0, updatedAt: c.updated_at ?? c.updatedAt ?? null });

// Lecture du corps AU FIL DE L'EAU, abandonnée dès que la taille maximale est dépassée (jamais de corps géant en mémoire).
async function readCapped(res) {
  if (res.body?.getReader) {
    const reader = res.body.getReader(), chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > SHOP_LIMITS.maxBytes) { try { await reader.cancel(); } catch { /* flux déjà fermé */ } return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const t = await res.text();
  return Buffer.byteLength(t) > SHOP_LIMITS.maxBytes ? null : t;
}
// Retry-After : secondes ou date HTTP → secondes (borné à 24 h).
const retryAfterOf = (v) => { if (v == null) return null; const n = Number(v); const sec = Number.isFinite(n) ? n : (Date.parse(v) - Date.now()) / 1000; return Number.isFinite(sec) && sec > 0 ? Math.min(Math.ceil(sec), 86_400) : null; };

// --- connecteur -----------------------------------------------------------------------------------------------------------------------------
export function createShopConnector({ domain = process.env.WORKEDA_SHOP_DOMAIN || 'workeda.com', adminDomain = process.env.SHOPIFY_ADMIN_DOMAIN || null, token = process.env.SHOPIFY_ADMIN_TOKEN || null, fetchImpl = globalThis.fetch, env = process.env, adminFetchImpl = null, now = () => Date.now() } = {}) {
  if (!HOST_RE.test(domain)) throw new Error('Domaine de boutique invalide.');
  const adminOk = Boolean(token) && Boolean(adminDomain) && /^[a-z0-9-]+\.myshopify\.com$/i.test(adminDomain);
  const mode = 'public';
  // Même une fonction réseau injectée passe par la passerelle ; aucun jeton ni simulateur ne l'autorise seul.
  const gatedAdminFetch = networkGate({ env, fetchImpl: adminFetchImpl ?? fetchImpl });
  const adminNetworkAllowed = () => realNetworkAllowed(env);
  const misconfigured = Boolean(token) !== Boolean(adminDomain) || (adminDomain && !adminOk);

  // Une seule porte vers le réseau : hôte exact, https, pas de redirection, délai et taille bornés. Le jeton n'apparaît dans aucun retour ni message d'erreur.
  async function http(host, path, init = {}) {
    const url = `https://${host}${path}`;
    if (new URL(url).hostname !== host || !(host === domain || host === adminDomain)) throw new Error('Hôte non autorisé.');
    let res;
    try { res = await (path.startsWith('/admin/api/') ? gatedAdminFetch : fetchImpl)(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(SHOP_LIMITS.timeoutMs), headers: { accept: 'application/json', 'user-agent': 'Archipel-readonly/1.0', ...(init.headers ?? {}) } }); }
    catch (e) { return { status: 0, error: e?.name === 'TimeoutError' ? 'délai dépassé' : 'boutique injoignable' }; }
    if (res.status >= 300 && res.status < 400) return { status: res.status, error: 'redirection refusée' };
    const declared = Number(res.headers?.get?.('content-length') ?? 0);
    if (declared > SHOP_LIMITS.maxBytes) return { status: res.status, error: 'réponse trop volumineuse' };
    let text;
    try { text = await readCapped(res); } catch { return { status: res.status, error: 'lecture interrompue' }; }
    if (text === null) return { status: res.status, error: 'réponse trop volumineuse' };
    return { status: res.status, text, apiVersion: res.headers?.get?.('x-shopify-api-version') ?? null, retryAfterSec: retryAfterOf(res.headers?.get?.('retry-after') ?? null) };
  }
  const explain = (what, r) => (r.status === 429 ? `${what} : la boutique limite les requêtes (429) — aucune nouvelle tentative avant le prochain relevé`
    : r.status === 401 || r.status === 403 ? `${what} : accès refusé (${r.status})` : r.error ? `${what} : ${r.error}` : `${what} : réponse ${r.status}`);
  const parse = (what, r) => { try { return { ok: true, json: JSON.parse(r.text) }; } catch { return { ok: false, error: `${what} : réponse illisible` }; } };

  async function fetchPublic() {
    const out = { collections: [], products: [], errors: [], sourceUrls: [] };
    const c = await http(domain, `/collections.json?limit=${SHOP_LIMITS.perPage}`);
    if (c.status === 200 && !c.error) { const j = parse('collections', c); if (j.ok && Array.isArray(j.json.collections)) { out.collections = j.json.collections.map(normalizeCollection); out.sourceUrls.push(`https://${domain}/collections.json`); } else out.errors.push(j.error ?? 'collections : format inattendu'); }
    else out.errors.push(explain('collections', c));
    if (c.status === 429) { out.retryAfterSec = c.retryAfterSec; return out; } // la boutique limite : on s'arrête là, aucune autre requête
    for (let page = 1; page <= SHOP_LIMITS.pages; page += 1) {
      const p = await http(domain, `/products.json?limit=${SHOP_LIMITS.perPage}&page=${page}`);
      if (p.status !== 200 || p.error) { out.errors.push(explain('produits', p)); if (p.status === 429) out.retryAfterSec = p.retryAfterSec; break; }
      const j = parse('produits', p);
      if (!j.ok || !Array.isArray(j.json.products)) { out.errors.push(j.error ?? 'produits : format inattendu'); break; }
      if (page === 1) out.sourceUrls.push(`https://${domain}/products.json`);
      out.products.push(...j.json.products.map((x) => normalizePublicProduct(x, domain)));
      if (j.json.products.length < SHOP_LIMITS.perPage) break;
    }
    return out;
  }
  async function graphql(query, variables) {
    const r = await http(adminDomain, `/admin/api/${ADMIN_VERSION}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables }) });
    if (r.status !== 200 || r.error) return { error: explain('API Admin', r), limited: r.status === 429, retryAfterSec: r.retryAfterSec ?? null };
    if (r.apiVersion !== ADMIN_VERSION) return { error: 'API Admin : version servie différente ou absente ; relevé refusé.' };
    const j = parse('API Admin', r);
    if (!j.ok) return { error: j.error };
    if (j.json.errors) return { error: 'API Admin : requête refusée par la boutique (droits de lecture manquants ?)' };
    return { data: j.json.data };
  }
  async function fetchAdmin({ authorization = null } = {}) {
    const out = { mode: 'admin', domain: adminDomain, source: 'shopify_admin', collections: [], products: [], orders: [], scopes: [], errors: [], sourceUrls: [] };
    const finish = () => ({ ...out, ok: out.errors.length === 0, partial: out.errors.length > 0 });
    if (!adminOk || !authorization?.enabled || !Number.isFinite(Date.parse(authorization?.at)) || !adminNetworkAllowed()) {
      out.errors.push('Shopify Admin : À configurer (accord local daté et autorisation réseau nécessaires).'); return finish();
    }
    const request = (query, variables) => authorization.valid && !authorization.valid() ? { error: 'Autorisation Shopify Admin retirée.' } : graphql(query, variables);
    const access = await request(READ_QUERIES.scopes, {});
    if (access.error) { out.errors.push(access.error); return finish(); }
    out.scopes = (access.data?.currentAppInstallation?.accessScopes ?? []).map((x) => x.handle).filter((x) => [...ADMIN_SCOPES, 'read_orders'].includes(x));
    const required = [...ADMIN_SCOPES, ...(authorization.orders ? ['read_orders'] : [])];
    if (required.some((x) => !out.scopes.includes(x))) { out.errors.push('API Admin : droits de lecture manquants pour les capacités autorisées.'); return finish(); }
    out.authenticated = true;
    for (const kind of ['products', ...(authorization.orders ? ['orders'] : [])]) {
      let after = null;
      for (let page = 1; page <= SHOP_LIMITS.pages; page += 1) {
        const filter = `created_at:>=${new Date(now() - 60 * 86_400_000).toISOString()}`;
        const r = await request(READ_QUERIES[kind], { first: 50, after, ...(kind === 'orders' ? { filter } : {}) });
        if (r.error) { out.errors.push(r.error); if (r.limited) out.retryAfterSec = r.retryAfterSec; break; }
        const connection = r.data?.[kind];
        if (!Array.isArray(connection?.nodes) || !connection.pageInfo) { out.errors.push('API Admin : format de réponse inattendu.'); break; }
        if (kind === 'products') {
          out.products.push(...connection.nodes.slice(0, 50).map((x) => ({ ...normalizeAdminProduct(x, domain), variants: projectVariants(x.variants?.nodes) })));
          if (connection.nodes.some((x) => x.variants?.pageInfo?.hasNextPage || x.variants?.nodes?.some((v) => v.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage))) out.errors.push('API Admin : variantes ou emplacements partiellement relevés (limite de pagination).');
        } else {
          if (connection.nodes.some((x) => x.fulfillments?.length >= 50 || x.fulfillments?.some((f) => f.trackingInfo?.length >= 20))) out.errors.push('API Admin : liste des traitements ou suivis potentiellement partielle.');
          out.orders.push(...connection.nodes.slice(0, 50).filter((x) => {
          const date = Date.parse(x.createdAt); return date >= now() - 60 * 86_400_000 && date <= now();
        }).map(projectOrder));
        }
        if (!connection.pageInfo.hasNextPage) break;
        if (!connection.pageInfo.endCursor || page === SHOP_LIMITS.pages) { out.errors.push('API Admin : pagination limitée ; relevé partiel.'); break; }
        after = connection.pageInfo.endCursor;
      }
      if (out.retryAfterSec) break;
    }
    return finish();
  }
  return {
    mode, domain, hasToken: Boolean(token), misconfigured, adminConfigured: adminOk, adminDomain, adminNetworkAllowed, fetchAdmin,
    async fetchCatalog() {
      const r = await fetchPublic();
      if (misconfigured) r.errors.push('SHOPIFY_ADMIN_TOKEN et SHOPIFY_ADMIN_DOMAIN (xxx.myshopify.com) doivent être définis ensemble : mode public utilisé.');
      return { mode, domain, retryAfterSec: null, ...r, ok: r.collections.length > 0 || r.products.length > 0, partial: r.errors.length > 0 };
    }
  };
}

export const snapshotHash = (s) => createHash('sha1').update(JSON.stringify([s.collections, s.products])).digest('hex').slice(0, 12);

// Texte donné à un agent : DONNÉES datées relevées par le Studio, cadrées comme non fiables (les textes viennent de la boutique et des fournisseurs).
export function catalogPrompt(snap) {
  if (!snap) return 'Catalogue Shopify : non disponible (aucun relevé réussi). N\'invente aucune donnée du catalogue ; dis ce qui manque.';
  snap = sanitizeCatalog(snap);
  const lines = [`Catalogue Shopify de ${snap.domain} — relevé par le Studio le ${snap.fetchedAt} en LECTURE SEULE (${snap.mode === 'admin' ? 'API Admin' : 'pages publiques'}). Tu ne peux rien modifier dans la boutique.`];
  lines.push(`${snap.collections.length} collection(s) : ${snap.collections.slice(0, 30).map((c) => `${c.title} [${c.handle}] (${c.count} produit(s))`).join(' ; ') || 'aucune'}`);
  if (snap.products.length) {
    lines.push(`${snap.products.length} produit(s) relevé(s) (domaine ${snap.domain} ; adresse d'un produit = https://${snap.domain}/products/<identifiant>) :`);
    // Une ligne COMPACTE par produit ; on s'arrête avant de dépasser le budget et on le DIT (jamais de coupure silencieuse en milieu de ligne).
    let used = lines.join('\n').length, listed = 0;
    for (const p of snap.products.slice(0, SHOP_LIMITS.promptProducts)) {
      const price = p.priceMin == null ? 'prix ?' : `${p.priceMin}${p.priceMax !== p.priceMin ? `–${p.priceMax}` : ''}${p.currency ? ` ${p.currency}` : ''}`;
      const line = `- ${p.title.slice(0, 80)} | ${p.type || 'type ?'} | ${price} | ${p.available ? 'stock' : 'indispo'} | ${p.images} img | desc ${p.descChars} car. | ${p.tags.length} tag(s)${p.tags.length ? ': ' + p.tags.slice(0, 6).join(', ') + (p.tags.length > 6 ? ` (+${p.tags.length - 6} autres)` : '') : ''} | ${p.handle}`;
      if (used + line.length + 1 > SHOP_LIMITS.promptChars - 700) break;
      lines.push(line); used += line.length + 1; listed += 1;
    }
    if (listed < snap.products.length) lines.push(`ATTENTION : ${snap.products.length - listed} produit(s) NON listé(s) faute de place : ton audit est partiel pour eux, dis-le.`);
  } else lines.push('Produits : non relevés.');
  if (snap.errors.length) lines.push(`Limites de ce relevé : ${snap.errors.join(' ; ')}. Ne comble pas ces manques par des données inventées.`);
  return untrusted('catalogue Shopify', lines.join('\n'), SHOP_LIMITS.promptChars);
}

export function sanitizeCatalog(snap) {
  if (!snap) return snap;
  const clean = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, ['title', 'handle', 'vendor', 'type', 'tags', 'desc', 'seoTitle', 'url', 'body_html'].includes(k) ? scrubContactData(v) : v]));
  return { ...snap, collections: (snap.collections ?? []).map(clean), products: (snap.products ?? []).map(clean), errors: scrubContactData(snap.errors ?? []), sourceUrls: scrubContactData(snap.sourceUrls ?? []) };
}
