// src/integrations-core.js — règles pures de l'Integration Center (aucun réseau, aucune base) :
//   - registre des intégrations et liste blanche d'outils/points d'accès (DÉFAUT : REFUS) ;
//   - projection anti-données personnelles (liste blanche de champs, jamais liste noire) et masquage des numéros de suivi ;
//   - analyse logistique, correspondance Shopify ↔ DSers (jamais approximative), bloc de données donné aux agents.
import { createHash } from 'node:crypto';
import { scrubContacts, scrubContactData } from './catalog-privacy.js';
import { untrusted } from './comm-core.js';

export const INTEGRATION_IDS = ['dsers', 'track17'];
export const ACCESS_LEVELS = ['read'];
export const DEFAULT_DAILY_CAP = 100;       // appels DSers par jour pour Archipel (le quota DSers est partagé avec vos autres clients MCP)
export const MAX_DAILY_CAP = 2000;
export const CACHE_TTL_MS = { stores: 6 * 3_600_000, products: 6 * 3_600_000, shipping: 12 * 3_600_000, packages: 3_600_000, quota: 600_000, tracklist: 3_600_000 };
export const SNAPSHOT_STALE_MS = 48 * 3_600_000;

// Portées OAuth : exactement les noms publiés par DSers (vérifiés dans /.well-known/oauth-protected-resource), en LECTURE seule.
export const DSERS_READ_SCOPES = ['store:read', 'supplier:read', 'product:read', 'order:read', 'tracking:read', 'plan:read'];
export const DSERS_PUBLISHED_SCOPES = ['user:read', 'user:write', 'store:read', 'store:write', 'theme:read', 'theme:write', 'staff:read', 'staff:write', 'supplier:read', 'product:read', 'product:write', 'product:import', 'product:push', 'product:mapping', 'settings:read', 'settings:write', 'billing:read', 'plan:read', 'order:read', 'order:write', 'tracking:read', 'notification:read'];

// Outils MCP DSers (index officiel du 18 septembre 2026 : 60 outils, 34 lectures, 26 écritures).
export const DSERS_WRITE_TOOLS = ['start_store_connection', 'start_store_reauthorization', 'create_shopify_shipping_profile', 'update_pricing_rule', 'create_pre_publish_products', 'update_pre_publish_product_content', 'update_pre_publish_product_organization', 'update_pre_publish_product_price', 'delete_pre_publish_products', 'publish_products_to_stores', 'import_store_products_to_dsers', 'apply_product_mapping', 'start_ai_product_mapping', 'apply_ai_mapping', 'update_managed_store_product', 'update_store_product_price_in_bulk', 'update_order_information', 'update_order_supplier', 'place_orders_to_suppliers', 'cancel_supplier_order', 'create_order_payment_link', 'update_supplier_order', 'sync_supply_order_tracking_number', 'sync_existing_tracking_numbers_to_store', 'update_tracking_numbers_to_store', 'send_buyer_tracking_notification'];
// Lectures utilisées par Archipel (tout le reste est refusé, même en lecture).
export const DSERS_ALLOWED_TOOLS = ['get_plan_and_credits', 'list_stores', 'list_managed_store_products', 'get_managed_store_product', 'search_store_products', 'get_supplier_product', 'list_supplier_product_shipping_methods_and_cost', 'list_platform_shipping_methods', 'list_supplier_product_change_notifications', 'get_pricing_rule', 'list_packages', 'get_package_details'];
// Lectures connues mais NON utilisées : comptes/facturation (sensibles), commandes détaillées (données clients), IA (crédits payants), correspondances (portée product:mapping non demandée).
export const DSERS_UNUSED_READ_TOOLS = ['get_account_profile', 'get_plan_and_credit_billing', 'get_order_paymentlink_and_billing', 'recommend_apps_to_install', 'list_shopify_shipping_zones', 'list_supported_countries', 'list_supplier_search_filters', 'list_featured_product_collections', 'search_supplier_products', 'list_pre_publish_products', 'get_pre_publish_product', 'get_pre_publish_product_organization', 'get_push_shipping_recommendation', 'get_store_product_mapping', 'search_ai_mapping_candidates', 'simulate_pricing_rule', 'list_orders', 'get_order', 'diagnose_order_issue', 'validate_order_address', 'get_job_status', 'find_feature_entry'];

// 17TRACK API v2.4 : seuls ces points d'accès sont appelables. `register` (payant) et tous les autres sont REFUSÉS.
export const TRACK17_ALLOWED_ENDPOINTS = ['getquota', 'gettracklist', 'gettrackinfo'];
export const TRACK17_FORBIDDEN_ENDPOINTS = ['register', 'changeinfo', 'stoptrack', 'retrack', 'deletetrack', 'getRealTimeTrackInfo'];
export const TRACK17_LIMITS = { perSecond: 3, perRequest: 40 };
export const TRACK17_STATUSES = ['NotFound', 'InfoReceived', 'InTransit', 'Expired', 'AvailableForPickup', 'OutForDelivery', 'DeliveryFailure', 'Delivered', 'Exception'];

export const REGISTRY = {
  dsers: { id: 'dsers', label: 'DSers (MCP)', kind: 'mcp', host: 'ai.dsers.com', url: 'https://ai.dsers.com/mcp', auth: 'OAuth 2.1 + PKCE (aucune clé d’API)', readScopes: DSERS_READ_SCOPES, allowedTools: DSERS_ALLOWED_TOOLS, deniedTools: [...DSERS_WRITE_TOOLS, ...DSERS_UNUSED_READ_TOOLS],
    plan: 'Inclus dans les plans DSers Advanced, Pro et Enterprise ; absent du plan Basic.', quotaNote: 'Quota DSers de 500 (Advanced), 1 250 (Pro) ou 12 500 (Enterprise) appels par jour, partagé avec tous vos clients MCP.' },
  track17: { id: 'track17', label: '17TRACK (API v2.4)', kind: 'api', host: 'api.17track.net', url: 'https://api.17track.net/track/v2.4', auth: 'Clé de sécurité (17token) du compte développeur api.17track.net', readScopes: [], allowedTools: TRACK17_ALLOWED_ENDPOINTS, deniedTools: TRACK17_FORBIDDEN_ENDPOINTS,
    plan: 'Chaque numéro enregistré consomme un envoi du quota (payant) : Archipel ne les enregistre jamais.', quotaNote: '3 requêtes par seconde, 40 numéros par requête.' }
};

// --- liste blanche : DÉFAUT = REFUS ----------------------------------------------------------------------------------------------------------------
export function classifyDsersTool(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{1,80}$/.test(name)) return { allowed: false, kind: 'invalid', reason: 'nom d’outil invalide' };
  if (DSERS_ALLOWED_TOOLS.includes(name)) return { allowed: true, kind: 'allowed', reason: 'lecture autorisée' };
  if (DSERS_WRITE_TOOLS.includes(name)) return { allowed: false, kind: 'write', reason: 'outil d’écriture : interdit côté Archipel' };
  if (DSERS_UNUSED_READ_TOOLS.includes(name)) return { allowed: false, kind: 'read_unused', reason: 'lecture non utilisée par Archipel (données sensibles, crédits IA ou portée non demandée)' };
  const writeish = /^(start|create|update|delete|publish|import|apply|place|cancel|sync|send|set|remove|replace|refresh|retry|run|push|pay|charge|refund|ship|fulfill)_/.test(name);
  return { allowed: false, kind: 'unknown', reason: writeish ? 'nouvel outil inconnu, d’allure écriture : refusé' : 'outil inconnu : refusé par défaut' };
}
export function classifyTrack17Endpoint(name) {
  if (TRACK17_ALLOWED_ENDPOINTS.includes(name)) return { allowed: true, kind: 'allowed', reason: 'lecture autorisée' };
  if (TRACK17_FORBIDDEN_ENDPOINTS.includes(name)) return { allowed: false, kind: 'write', reason: name === 'register' ? 'enregistrement payant : interdit sans accord explicite' : 'point d’accès modifiant ou payant : interdit' };
  return { allowed: false, kind: 'unknown', reason: 'point d’accès inconnu : refusé par défaut' };
}
export class ForbiddenToolError extends Error { constructor(integration, name, verdict) { super(`${integration} : outil refusé (${verdict.reason}).`); this.name = 'ForbiddenToolError'; this.kind = 'forbidden'; this.status = 403; this.verdict = verdict; } }
export function assertAllowed(integration, name) {
  const verdict = integration === 'dsers' ? classifyDsersTool(name) : integration === 'track17' ? classifyTrack17Endpoint(name) : { allowed: false, kind: 'unknown', reason: 'intégration inconnue' };
  if (!verdict.allowed) throw new ForbiddenToolError(integration, name, verdict);
  return verdict;
}
// Les outils réellement exposés par le serveur, classés (pour l'affichage et la détection d'outils nouveaux).
export function classifyExposedTools(names) {
  const out = { allowed: [], write: [], readUnused: [], unknown: [], missing: [] };
  for (const n of names) { const v = classifyDsersTool(n); (v.kind === 'allowed' ? out.allowed : v.kind === 'write' ? out.write : v.kind === 'read_unused' ? out.readUnused : out.unknown).push(n); }
  out.missing = DSERS_ALLOWED_TOOLS.filter((t) => !names.includes(t));
  return out;
}

// --- confidentialité ---------------------------------------------------------------------------------------------------------------------------
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/g;
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{7,}\d/g;
const TRACKISH_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,30}\b|\b\d{12,30}\b/g;
export function maskTracking(n) {
  const s = String(n ?? '').trim();
  if (!s) return '';
  return s.length >= 8 ? `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}` : '*'.repeat(s.length);
}
export const trackingKey = (n) => createHash('sha1').update(String(n ?? '').trim().toUpperCase()).digest('hex').slice(0, 10); // identifiant stable, non réversible
// Retire e-mails, téléphones et numéros de suivi d'un texte libre (descriptions d'événements, notes). Les dates ne sont jamais prises pour des téléphones.
export function scrubText(text, max = 160) {
  let s = scrubContacts(text);
  const dates = []; s = s.replace(DATE_RE, (d) => { dates.push(d); return `\u0001${dates.length - 1}\u0001`; });
  // Ordre : e-mails, puis numéros de suivi (masqués), puis téléphones (sinon un suivi serait pris pour un téléphone).
  s = s.replace(EMAIL_RE, '[e-mail retiré]').replace(TRACKISH_RE, (m) => maskTracking(m)).replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[téléphone retiré]' : m));
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => dates[Number(i)]).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
// Un identifiant de relevé (uuid) n'est jamais un numéro de téléphone.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function containsPii(value) {
  const hit = (s) => { const t = String(s).replace(DATE_RE, ' ').replace(UUID_RE, ' '); EMAIL_RE.lastIndex = 0; PHONE_RE.lastIndex = 0; return EMAIL_RE.test(t) || [...t.matchAll(PHONE_RE)].some((m) => m[0].replace(/\D/g, '').length >= 9); };
  const walk = (v) => (typeof v === 'string' ? hit(v) : Array.isArray(v) ? v.some(walk) : v && typeof v === 'object' ? Object.values(v).some(walk) : false);
  return walk(value);
}
// Défense en profondeur : après projection, tout texte est nettoyé ; si un e-mail ou un téléphone subsistait, on LÈVE.
export function sanitizeDeep(value) {
  const walk = (v) => (typeof v === 'string' ? scrubText(v, 400) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  const out = walk(value);
  if (containsPii(out)) throw Object.assign(new Error('Donnée personnelle détectée après nettoyage : relevé refusé.'), { status: 500 });
  return out;
}

const get = (raw, keys) => { for (const k of keys) { const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), raw); if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
const num = (v) => { const n = Number(typeof v === 'string' ? v.replace(',', '.') : v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const str = (v, max = 160) => (v == null ? '' : scrubText(String(v), max));
const iso = (v) => { if (v == null || v === '') return null; const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const arr = (v) => (Array.isArray(v) ? v : []);
// Champs « sûrs » : alphabet restreint (référence de commande, transporteur, statut). Tout ce qui sort de l'alphabet est jeté, pas nettoyé.
const safe = (v, re, max) => { const s = String(v ?? '').trim(); return s && s.length <= max && re.test(s) ? s : ''; };
const country = (v) => { const s = String(v ?? '').trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : ''; };

// Projecteurs par LISTE BLANCHE de champs. Les noms de champs sources sont plusieurs candidats : le format exact de DSers ne sera confirmé
// qu'à la première connexion réelle (limite connue) ; un champ inconnu est ignoré, jamais copié.
export function projectStoreProduct(raw) {
  const handleFromUrl = String(get(raw, ['handle', 'store_handle', 'shopify_handle', 'url_handle']) ?? '').trim() || (String(get(raw, ['store_url', 'url', 'product_url']) ?? '').match(/\/products\/([^/?#]+)/)?.[1] ?? '');
  return { id: String(get(raw, ['id', 'product_id', 'store_product_id']) ?? ''), shopifyId: String(get(raw, ['shopify_product_id', 'store_product_external_id', 'external_id', 'platform_product_id']) ?? '').replace(/^gid:\/\/shopify\/Product\//, ''), handle: handleFromUrl.toLowerCase(),
    title: str(get(raw, ['title', 'name', 'product_title'])), status: str(get(raw, ['status', 'publish_status']), 40), price: num(get(raw, ['price', 'sale_price', 'min_price'])), currency: str(get(raw, ['currency', 'currency_code']), 8),
    supplierProductId: String(get(raw, ['supplier_product_id', 'supplier.product_id', 'source_product_id']) ?? ''), supplierName: str(get(raw, ['supplier_name', 'supplier.name', 'supplier.title', 'source_name']), 80),
    supplierCost: num(get(raw, ['supplier_price', 'cost', 'supplier.price', 'source_price', 'cost_price'])), supplierCurrency: str(get(raw, ['supplier_currency', 'supplier.currency']), 8), variants: arr(get(raw, ['variants'])).length || (num(get(raw, ['variant_count'])) ?? 0), mapped: Boolean(get(raw, ['mapped', 'is_mapped', 'mapping_status'])) };
}
export function projectSupplierProduct(raw) {
  const prices = arr(get(raw, ['variants'])).map((v) => num(get(v, ['price', 'sale_price']))).filter((x) => x !== null);
  return { id: String(get(raw, ['id', 'product_id', 'supplier_product_id']) ?? ''), title: str(get(raw, ['title', 'name'])), supplierName: str(get(raw, ['supplier_name', 'store_name', 'seller_name']), 80), priceMin: prices.length ? Math.min(...prices) : num(get(raw, ['price', 'min_price'])), priceMax: prices.length ? Math.max(...prices) : num(get(raw, ['max_price', 'price'])), currency: str(get(raw, ['currency', 'currency_code']), 8), stock: num(get(raw, ['stock', 'inventory', 'total_stock'])), rating: num(get(raw, ['rating', 'score'])) };
}
export function projectShippingQuote(raw) {
  return { method: str(get(raw, ['method', 'name', 'shipping_method', 'service']), 80), country: country(get(raw, ['country', 'country_code', 'to'])), cost: num(get(raw, ['cost', 'price', 'freight', 'amount'])), currency: str(get(raw, ['currency', 'currency_code']), 8), daysMin: num(get(raw, ['days_min', 'min_days', 'delivery_days_min'])), daysMax: num(get(raw, ['days_max', 'max_days', 'delivery_days_max'])) };
}
// Transporteurs : vocabulaire FERMÉ (une valeur inconnue devient « Autre » : jamais un nom ou une adresse glissés dans ce champ).
const CARRIERS = [['yanwen', 'Yanwen'], ['yunexpress', 'YunExpress'], ['4px', '4PX'], ['cainiao', 'Cainiao'], ['china post', 'China Post'], ['chinapost', 'China Post'], ['ems', 'EMS'], ['dhl', 'DHL'], ['fedex', 'FedEx'], ['ups', 'UPS'], ['usps', 'USPS'], ['la poste', 'La Poste'], ['colissimo', 'Colissimo'], ['royal mail', 'Royal Mail'], ['dpd', 'DPD'], ['gls', 'GLS'], ['sf express', 'SF Express'], ['aliexpress', 'AliExpress Standard'], ['sunyou', 'SunYou'], ['speedpak', 'SpeedPAK'], ['cne', 'CNE'], ['postnl', 'PostNL'], ['bpost', 'bpost']];
export function normalizeCarrier(v) {
  const t = String(v ?? '').trim().toLowerCase(); if (!t) return '';
  return CARRIERS.find(([k]) => (k.length <= 3 ? t === k || t.split(/[^a-z0-9]+/).includes(k) : t.includes(k)))?.[1] ?? 'Autre';
}
// Référence de commande : numérotation Shopify (« #1042 ») conservée ; toute autre valeur (pouvant être un nom) devient un identifiant opaque non réversible.
export function orderRefOf(v) {
  const t = String(v ?? '').trim(); if (!t) return '';
  return /^#?\d{3,9}$/.test(t) ? (t.startsWith('#') ? t : `#${t}`) : `cmd-${createHash('sha256').update(t).digest('hex').slice(0, 6)}`;
}
export function projectPackage(raw) {
  const tracking = String(get(raw, ['tracking_number', 'trackingNumber', 'tracking_no', 'waybill', 'tracking.number']) ?? '').trim();
  // AUCUN texte libre d'événement (« remis à M. Dupont, 12 rue… ») : seulement la date et un statut normalisé issu d'un vocabulaire fermé.
  const events = arr(get(raw, ['events', 'tracking_events', 'checkpoints', 'tracking.events'])).slice(-8).map((e) => ({ at: iso(get(e, ['time', 'at', 'date', 'timestamp', 'time_utc'])), status: normalizeStatus(get(e, ['description', 'status', 'message', 'desc'])) }));
  return { orderRef: orderRefOf(get(raw, ['order_name', 'order_number', 'order_ref', 'order.name', 'order.number'])), carrier: normalizeCarrier(get(raw, ['carrier', 'carrier_name', 'logistics', 'shipping_company'])), tracking: maskTracking(tracking), trackingKey: tracking ? trackingKey(tracking) : '',
    status: normalizeStatus(get(raw, ['status', 'tracking_status', 'delivery_status', 'latest_status.status'])), statusRaw: '', destCountry: country(get(raw, ['destination_country', 'country', 'country_code', 'to_country', 'shipping_country'])),
    shippedAt: iso(get(raw, ['shipped_at', 'shipping_time', 'ship_time', 'created_at', 'fulfilled_at'])), deliveredAt: iso(get(raw, ['delivered_at', 'delivery_time', 'signed_at'])), lastEventAt: iso(get(raw, ['last_event_at', 'updated_at', 'latest_event_time'])) ?? events.at(-1)?.at ?? null, events };
}
export function normalizeStatus(v) {
  const s = String(v ?? '').toLowerCase().replace(/[_-]+/g, ' ');
  if (!s.trim()) return 'Unknown';
  for (const k of TRACK17_STATUSES) if (s.replace(/\s/g, '') === k.toLowerCase()) return k;
  if (/fail|undeliver|attempt/.test(s)) return 'DeliveryFailure';
  if (/out for|courier|delivering/.test(s)) return 'OutForDelivery';
  if (/deliver|signed|received by/.test(s)) return 'Delivered';
  if (/pick ?up|collect/.test(s)) return 'AvailableForPickup';
  if (/expir/.test(s)) return 'Expired';
  if (/exception|return|lost|damag|held|customs|seiz|reject/.test(s)) return 'Exception';
  if (/transit|ship|dispatch|depart|arriv|sort/.test(s)) return 'InTransit';
  if (/not ?found|no info/.test(s)) return 'NotFound';
  if (/info|label|pending|await|creat|process|prepar/.test(s)) return 'InfoReceived';
  return 'Unknown';
}

// --- analyse logistique ---------------------------------------------------------------------------------------------------------------------------
const FAIL_STATES = ['Exception', 'DeliveryFailure', 'Expired'];
const days = (a, b) => (a && b ? Math.round(((Date.parse(b) - Date.parse(a)) / 86_400_000) * 10) / 10 : null);
export function analyzeLogistics(packages, { now = Date.now(), delayDays = 20, staleDays = 7 } = {}) {
  const nowIso = new Date(now).toISOString();
  const byStatus = {}, byCountry = {}, byCarrier = {}, delivered = [], anomalies = [];
  const missing = { shippedAt: 0, carrier: 0, status: 0, country: 0 };
  for (const p of packages) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    if (!p.shippedAt) missing.shippedAt += 1; if (!p.carrier) missing.carrier += 1; if (p.status === 'Unknown') missing.status += 1; if (!p.destCountry) missing.country += 1;
    const done = p.status === 'Delivered', d = done ? days(p.shippedAt, p.deliveredAt ?? p.lastEventAt) : days(p.shippedAt, nowIso);
    for (const [map, key] of [[byCountry, p.destCountry || '??'], [byCarrier, p.carrier || '??']]) { map[key] ??= { n: 0, delivered: 0, days: [] }; map[key].n += 1; if (done && d != null) { map[key].delivered += 1; map[key].days.push(d); } }
    if (done && d != null) delivered.push(d);
    const reasons = [];
    if (FAIL_STATES.includes(p.status)) reasons.push(`statut ${p.status}`);
    if (!done && d != null && d > delayDays) reasons.push(`en route depuis ${d} j (> ${delayDays} j)`);
    const quiet = !done && days(p.lastEventAt, nowIso);
    if (quiet != null && quiet !== false && quiet > staleDays) reasons.push(`aucun événement depuis ${quiet} j`);
    if (reasons.length) anomalies.push({ orderRef: p.orderRef, tracking: p.tracking, status: p.status, carrier: p.carrier, country: p.destCountry, days: d, reason: reasons.join(' ; ') });
  }
  const sorted = [...delivered].sort((a, b) => a - b), avg = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
  const group = (m) => Object.entries(m).map(([k, v]) => ({ key: k, packages: v.n, delivered: v.delivered, avgDays: avg(v.days) })).sort((a, b) => b.packages - a.packages).slice(0, 12);
  return { total: packages.length, byStatus, deliveredCount: delivered.length, avgDeliveryDays: avg(delivered), medianDeliveryDays: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, p90DeliveryDays: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : null,
    delayed: anomalies.filter((a) => /en route depuis/.test(a.reason)).length, exceptions: anomalies.filter((a) => /statut/.test(a.reason)).length, stale: anomalies.filter((a) => /aucun événement/.test(a.reason)).length,
    byCountry: group(byCountry), byCarrier: group(byCarrier), anomalies: anomalies.sort((a, b) => (b.days ?? 0) - (a.days ?? 0)).slice(0, 25), missing, thresholds: { delayDays, staleDays } };
}

// --- correspondance Shopify ↔ DSers : exacte (identifiant, puis adresse), JAMAIS approximative ---------------------------------------------------------
const norm = (s) => String(s ?? '').trim().toLowerCase();
export function matchCatalog(shopProducts, dsersProducts) {
  const byId = new Map(), byHandle = new Map();
  for (const d of dsersProducts) { if (d.shopifyId) byId.set(d.shopifyId, [...(byId.get(d.shopifyId) ?? []), d]); if (d.handle && scrubContacts(d.handle) === d.handle && !/[\[*]/.test(d.handle)) byHandle.set(norm(d.handle), [...(byHandle.get(norm(d.handle)) ?? []), d]); }
  const matched = [], unmatchedShop = [], ambiguous = [], used = new Set();
  for (const p of shopProducts) {
    const byid = byId.get(String(p.id)) ?? [], byh = (scrubContacts(p.handle) === p.handle && !/[\[*]/.test(p.handle) ? byHandle.get(norm(p.handle)) : null) ?? [], hits = byid.length ? byid : byh, basis = byid.length ? 'id' : 'handle';
    if (hits.length === 1) { const d = hits[0]; used.add(d.id); matched.push({ shopId: String(p.id), handle: p.handle, title: p.title, shopPrice: p.priceMin ?? null, dsersId: d.id, supplierName: d.supplierName, supplierCost: d.supplierCost, supplierCurrency: d.supplierCurrency, basis, mapped: d.mapped }); }
    else if (hits.length > 1) ambiguous.push({ shopId: String(p.id), handle: p.handle, title: p.title, candidates: hits.map((h) => h.id) });
    else unmatchedShop.push({ shopId: String(p.id), handle: p.handle, title: p.title });
  }
  const unmatchedDsers = dsersProducts.filter((d) => !used.has(d.id) && !ambiguous.some((a) => a.candidates.includes(d.id))).map((d) => ({ dsersId: d.id, title: d.title, handle: d.handle }));
  const missing = { noSupplierCost: matched.filter((m) => m.supplierCost == null).length, noSupplier: matched.filter((m) => !m.supplierName).length, noShopPrice: matched.filter((m) => m.shopPrice == null).length, notMapped: matched.filter((m) => !m.mapped).length };
  const cleanRows = (rows) => rows.map((r) => ({ ...r, title: scrubContacts(r.title), handle: scrubContacts(r.handle), ...(Object.hasOwn(r, 'supplierName') ? { supplierName: scrubContacts(r.supplierName) } : {}) }));
  return { matched: cleanRows(matched), unmatchedShop: cleanRows(unmatchedShop), unmatchedDsers: cleanRows(unmatchedDsers), ambiguous: cleanRows(ambiguous), missing, counts: { shop: shopProducts.length, dsers: dsersProducts.length, matched: matched.length } };
}

// --- bloc donné aux agents ------------------------------------------------------------------------------------------------------------------------------
export const INTEGRATION_PROMPT_CHARS = 12_000;
const money = (n, c) => (n == null ? '?' : `${n}${c ? ` ${c}` : ''}`);
export function integrationPrompt({ dsers = null, track17 = null, notes = [] } = {}) {
  ({ dsers, track17, notes } = scrubContactData({ dsers, track17, notes }));
  const lines = ['Données fournisseurs et logistiques relevées par le Studio en LECTURE SEULE. Les données clients structurées sont exclues ; e-mails, téléphones et numéros de suivi des champs libres sont neutralisés. Les noms et adresses éventuellement présents dans les textes commerciaux sont conservés. Chaque relevé est daté : cite sa date.'];
  const provided = [];
  for (const n of notes) lines.push(n);
  if (dsers) {
    provided.push(...dsers.sources);
    lines.push(`DSers — relevé du ${dsers.fetchedAt} (sources : ${dsers.sources.join(', ') || 'aucune'}).`);
    if (dsers.match) {
      const m = dsers.match;
      lines.push(`Correspondance Shopify ↔ DSers (identifiant exact ou adresse exacte, jamais approximative) : ${m.counts.matched} liés sur ${m.counts.shop} produits Shopify ; ${m.unmatchedShop.length} sans lien DSers ; ${m.ambiguous.length} ambigus ; ${m.unmatchedDsers.length} produits DSers absents du relevé Shopify.`);
      lines.push(`Données manquantes parmi les liés : ${m.missing.noSupplierCost} sans coût fournisseur, ${m.missing.noSupplier} sans fournisseur, ${m.missing.noShopPrice} sans prix Shopify, ${m.missing.notMapped} non mappés.`);
      lines.push(`Produits liés (titre | identifiant | fournisseur | coût fournisseur | prix Shopify | base du lien) :`);
      let used = lines.join('\n').length, listed = 0;
      for (const x of m.matched) {
        const line = `- ${x.title.slice(0, 70)} | ${x.handle} | ${x.supplierName || 'fournisseur ?'} | ${money(x.supplierCost, x.supplierCurrency)} | ${money(x.shopPrice)} | ${x.basis}`;
        if (used + line.length + 1 > INTEGRATION_PROMPT_CHARS * 0.6) break;
        lines.push(line); used += line.length + 1; listed += 1;
      }
      if (listed < m.matched.length) lines.push(`ATTENTION : ${m.matched.length - listed} produit(s) lié(s) NON listé(s) faute de place : ton analyse est partielle pour eux, dis-le.`);
      if (m.unmatchedShop.length) lines.push(`Sans lien DSers : ${m.unmatchedShop.slice(0, 25).map((x) => x.handle || x.title.slice(0, 30)).join(', ')}${m.unmatchedShop.length > 25 ? ` (+${m.unmatchedShop.length - 25})` : ''}.`);
    }
    if (dsers.shipping?.length) lines.push(`Frais d'expédition relevés (${dsers.shipping.length}) : ${dsers.shipping.slice(0, 12).map((s) => `${s.method || '?'} ${s.country || '??'} ${money(s.cost, s.currency)}${s.daysMin != null ? ` ${s.daysMin}-${s.daysMax ?? '?'} j` : ''}`).join(' ; ')}.`);
    else lines.push('Frais d\'expédition fournisseur : non relevés (donnée manquante : ne pas inventer de coût logistique).');
  } else lines.push('DSers : aucun relevé disponible (connexion, plan ou accès manquant). N\'invente aucune donnée fournisseur.');
  if (track17?.logistics || dsers?.logistics) {
    const L = track17?.logistics ?? dsers.logistics;
    lines.push(`Logistique (${track17?.logistics ? '17TRACK' : 'colis DSers'}, ${L.total} colis) : statuts ${Object.entries(L.byStatus).map(([k, v]) => `${k}=${v}`).join(', ')} ; livraison moyenne ${L.avgDeliveryDays ?? '?'} j (médiane ${L.medianDeliveryDays ?? '?'}, p90 ${L.p90DeliveryDays ?? '?'}) ; ${L.delayed} en retard (> ${L.thresholds.delayDays} j), ${L.exceptions} en anomalie, ${L.stale} sans nouvelle depuis ${L.thresholds.staleDays} j.`);
    if (L.byCountry.length) lines.push(`Par pays : ${L.byCountry.slice(0, 8).map((c) => `${c.key} ${c.packages} colis (moy. ${c.avgDays ?? '?'} j)`).join(' ; ')}.`);
    for (const a of L.anomalies.slice(0, 15)) lines.push(`- anomalie : ${a.orderRef || 'commande ?'} | ${a.tracking || '—'} | ${a.carrier || '?'} | ${a.country || '??'} | ${a.reason}`);
    if (L.missing.shippedAt || L.missing.carrier || L.missing.status) lines.push(`Données manquantes sur les colis : ${L.missing.shippedAt} sans date d'expédition, ${L.missing.carrier} sans transporteur, ${L.missing.status} sans statut lisible.`);
  } else lines.push('Logistique : aucun colis relevé. N\'invente aucun indicateur de livraison.');
  if (track17?.quota) lines.push(`17TRACK — quota : ${track17.quota.used ?? '?'} utilisés sur ${track17.quota.total ?? '?'} (relevé du ${track17.fetchedAt}).`);
  return { text: untrusted('données fournisseurs et logistiques', lines.join('\n'), INTEGRATION_PROMPT_CHARS), provided };
}
