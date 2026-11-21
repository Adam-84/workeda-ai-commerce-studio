// src/shop-readonly.js — relevé du catalogue Shopify en LECTURE SEULE (aucune écriture n'existe dans ce module, par construction).
// Deux modes :
//   public : pages JSON publiques de la boutique (/collections.json, /products.json), sans aucun identifiant ;
//   admin  : API Admin GraphQL avec un jeton lu UNIQUEMENT dans l'environnement (SHOPIFY_ADMIN_TOKEN + SHOPIFY_ADMIN_DOMAIN), requêtes FIXES.
// Garanties : un seul hôte autorisé, HTTPS seulement, aucune redirection suivie (le jeton ne part jamais ailleurs), délai et taille bornés,
// jamais de nouvel essai après un 429, aucune requête construite à partir d'un texte d'agent ou de message.
import { createHash } from 'node:crypto';
import { untrusted } from './comm-core.js';

export const SHOP_LIMITS = { timeoutMs: 15_000, maxBytes: 5_000_000, pages: 4, perPage: 250, minIntervalMs: 5 * 60_000, staleMs: 24 * 3_600_000, descChars: 300, promptProducts: 40, promptChars: 7000 };
export const ADMIN_VERSION = '2025-01';
const HOST_RE = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

// Requêtes GraphQL fixes. Jamais de texte venant d'ailleurs ; jamais de mutation (vérifié au chargement du module ET par un test).
export const READ_QUERIES = {
  products: 'query Products($first: Int!, $after: String) { products(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title handle vendor productType tags status totalInventory updatedAt descriptionHtml seo { title description } mediaCount { count } priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } } } } }',
  collections: 'query Collections($first: Int!) { collections(first: $first) { nodes { id title handle updatedAt productsCount { count } } } }'
};
for (const [name, q] of Object.entries(READ_QUERIES)) if (!/^\s*query\b/.test(q) || /\b(mutation|subscription)\b/i.test(q)) throw new Error(`Requête Shopify « ${name} » : lecture seule exigée.`);

const decode = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const tagsOf = (t) => (Array.isArray(t) ? t : String(t ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- normalisation : même forme quel que soit le mode ---------------------------------------------------------------------------------
export function normalizePublicProduct(p, domain) {
  const prices = (p.variants ?? []).map((v) => money(v.price)).filter((x) => x !== null);
  const desc = decode(p.body_html);
  return { id: String(p.id), title: clip(decode(p.title), 160), handle: String(p.handle ?? ''), vendor: clip(decode(p.vendor), 80), type: clip(decode(p.product_type), 80), tags: tagsOf(p.tags),
    status: 'active', priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null, currency: null,
    available: (p.variants ?? []).some((v) => v.available === true), images: (p.images ?? []).length, descChars: desc.length, desc: clip(desc, SHOP_LIMITS.descChars), seoTitle: '', updatedAt: p.updated_at ?? null,
    url: `https://${domain}/products/${encodeURIComponent(p.handle ?? '')}` };
}
export function normalizeAdminProduct(p, domain) {
  const desc = decode(p.descriptionHtml);
  return { id: String(p.id), title: clip(decode(p.title), 160), handle: String(p.handle ?? ''), vendor: clip(decode(p.vendor), 80), type: clip(decode(p.productType), 80), tags: tagsOf(p.tags),
    status: String(p.status ?? '').toLowerCase(), priceMin: money(p.priceRangeV2?.minVariantPrice?.amount), priceMax: money(p.priceRangeV2?.maxVariantPrice?.amount), currency: p.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
    available: Number(p.totalInventory) > 0, images: Number(p.mediaCount?.count) || 0, descChars: desc.length, desc: clip(desc, SHOP_LIMITS.descChars), seoTitle: clip(decode(p.seo?.title), 120), updatedAt: p.updatedAt ?? null,
    url: `https://${domain}/products/${encodeURIComponent(p.handle ?? '')}` };
}
const normalizeCollection = (c) => ({ id: String(c.id), title: clip(decode(c.title), 160), handle: String(c.handle ?? ''), count: Number(c.products_count ?? c.productsCount?.count) || 0, updatedAt: c.updated_at ?? c.updatedAt ?? null });

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
export function createShopConnector({ domain = process.env.WORKEDA_SHOP_DOMAIN || 'workeda.com', adminDomain = process.env.SHOPIFY_ADMIN_DOMAIN || null, token = process.env.SHOPIFY_ADMIN_TOKEN || null, fetchImpl = globalThis.fetch } = {}) {
  if (!HOST_RE.test(domain)) throw new Error('Domaine de boutique invalide.');
  const adminOk = Boolean(token) && Boolean(adminDomain) && /^[a-z0-9-]+\.myshopify\.com$/i.test(adminDomain);
  const mode = adminOk ? 'admin' : 'public';
  const misconfigured = Boolean(token) !== Boolean(adminDomain) || (adminDomain && !adminOk);

  // Une seule porte vers le réseau : hôte exact, https, pas de redirection, délai et taille bornés. Le jeton n'apparaît dans aucun retour ni message d'erreur.
  async function http(host, path, init = {}) {
    const url = `https://${host}${path}`;
    if (new URL(url).hostname !== host || !(host === domain || host === adminDomain)) throw new Error('Hôte non autorisé.');
    let res;
    try { res = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(SHOP_LIMITS.timeoutMs), headers: { accept: 'application/json', 'user-agent': 'Archipel-readonly/1.0', ...(init.headers ?? {}) } }); }
    catch (e) { return { status: 0, error: e?.name === 'TimeoutError' ? 'délai dépassé' : 'boutique injoignable' }; }
    if (res.status >= 300 && res.status < 400) return { status: res.status, error: 'redirection refusée' };
    const declared = Number(res.headers?.get?.('content-length') ?? 0);
    if (declared > SHOP_LIMITS.maxBytes) return { status: res.status, error: 'réponse trop volumineuse' };
    let text;
    try { text = await readCapped(res); } catch { return { status: res.status, error: 'lecture interrompue' }; }
    if (text === null) return { status: res.status, error: 'réponse trop volumineuse' };
    return { status: res.status, text, retryAfterSec: retryAfterOf(res.headers?.get?.('retry-after') ?? null) };
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
    const j = parse('API Admin', r);
    if (!j.ok) return { error: j.error };
    if (j.json.errors) return { error: 'API Admin : requête refusée par la boutique (droits de lecture manquants ?)' };
    return { data: j.json.data };
  }
  async function fetchAdmin() {
    const out = { collections: [], products: [], errors: [], sourceUrls: [] };
    const c = await graphql(READ_QUERIES.collections, { first: 100 });
    if (c.error) { out.errors.push(c.error); if (c.limited) { out.retryAfterSec = c.retryAfterSec; return out; } } else { out.collections = (c.data?.collections?.nodes ?? []).map(normalizeCollection); out.sourceUrls.push(`https://${domain}/admin (collections, lecture seule)`); }
    let after = null;
    for (let page = 1; page <= SHOP_LIMITS.pages; page += 1) {
      const p = await graphql(READ_QUERIES.products, { first: 50, after });
      if (p.error) { out.errors.push(p.error); if (p.limited) out.retryAfterSec = p.retryAfterSec; break; }
      if (page === 1) out.sourceUrls.push(`https://${domain}/admin (produits, lecture seule)`);
      out.products.push(...(p.data?.products?.nodes ?? []).map((x) => normalizeAdminProduct(x, domain)));
      if (!p.data?.products?.pageInfo?.hasNextPage) break;
      after = p.data.products.pageInfo.endCursor;
    }
    return out;
  }
  return {
    mode, domain, hasToken: Boolean(token), misconfigured,
    async fetchCatalog() {
      const r = mode === 'admin' ? await fetchAdmin() : await fetchPublic();
      if (misconfigured) r.errors.push('SHOPIFY_ADMIN_TOKEN et SHOPIFY_ADMIN_DOMAIN (xxx.myshopify.com) doivent être définis ensemble : mode public utilisé.');
      return { mode, domain, retryAfterSec: null, ...r, ok: r.collections.length > 0 || r.products.length > 0, partial: r.errors.length > 0 };
    }
  };
}

export const snapshotHash = (s) => createHash('sha1').update(JSON.stringify([s.collections, s.products])).digest('hex').slice(0, 12);

// Texte donné à un agent : DONNÉES datées relevées par le Studio, cadrées comme non fiables (les textes viennent de la boutique et des fournisseurs).
export function catalogPrompt(snap) {
  if (!snap) return 'Catalogue Shopify : non disponible (aucun relevé réussi). N\'invente aucune donnée du catalogue ; dis ce qui manque.';
  const lines = [`Catalogue Shopify de ${snap.domain} — relevé par le Studio le ${snap.fetchedAt} en LECTURE SEULE (${snap.mode === 'admin' ? 'API Admin' : 'pages publiques'}). Tu ne peux rien modifier dans la boutique.`];
  lines.push(`${snap.collections.length} collection(s) : ${snap.collections.slice(0, 30).map((c) => `${c.title} [${c.handle}] (${c.count} produit(s))`).join(' ; ') || 'aucune'}`);
  if (snap.products.length) {
    lines.push(`${snap.products.length} produit(s) relevé(s)${snap.products.length > SHOP_LIMITS.promptProducts ? ` (les ${SHOP_LIMITS.promptProducts} premiers ci-dessous)` : ''} :`);
    for (const p of snap.products.slice(0, SHOP_LIMITS.promptProducts)) lines.push(`- ${p.title} | ${p.type || 'type ?'} | ${p.priceMin == null ? 'prix ?' : `${p.priceMin}${p.priceMax !== p.priceMin ? `–${p.priceMax}` : ''}${p.currency ? ` ${p.currency}` : ''}`} | ${p.available ? 'en stock' : 'indisponible ou stock inconnu'} | ${p.images} image(s) | description ${p.descChars} car. | tags : ${p.tags.join(', ') || '—'} | ${p.url}`);
  } else lines.push('Produits : non relevés.');
  if (snap.errors.length) lines.push(`Limites de ce relevé : ${snap.errors.join(' ; ')}. Ne comble pas ces manques par des données inventées.`);
  return untrusted('catalogue Shopify', lines.join('\n'), SHOP_LIMITS.promptChars);
}
