// src/shop-apps.js — inventaire des applications Shopify de Workeda : logique PURE (validation, CSV, analyse, détection, mesure).
// Principes : Archipel ne sait PAS quelles applications sont installées (l'API Admin ne les liste pas). Une application n'existe ici que
// parce que le propriétaire l'a DÉCLARÉE (ou promue depuis un indice) ; « confirmée » = vérifiée par le propriétaire dans son admin Shopify.
// Un script repéré dans le HTML public est un INDICE, jamais une preuve. Aucun coût n'est jamais inventé : absent = « inconnu ».
import { scrubContacts } from './catalog-privacy.js';
import { parseCsvRecords, isFormula, CSV_LIMITS } from './manual-import.js';

export const APP_STATUSES = ['declared', 'detected', 'confirmed'];
export const STATUS_LABELS = { declared: 'Déclarée', detected: 'Détectée (indice, non confirmée)', confirmed: 'Confirmée par le propriétaire' };
export const FUNCTIONS = {
  avis: 'Avis clients', email_marketing: 'E-mail marketing', sms: 'SMS', upsell: 'Ventes additionnelles', popup: 'Fenêtres contextuelles', recherche: 'Recherche et filtres',
  seo: 'Référencement', analytics: 'Mesure et analyse', livraison: 'Livraison et suivi', paiement: 'Paiement', traduction: 'Traduction', fidelite: 'Fidélité et parrainage',
  support: 'Support et chat', social: 'Réseaux sociaux', dropshipping: 'Dropshipping', images: 'Images et performance', autre: 'Autre'
};
export const BILLING = { monthly: 'Mensuel', yearly: 'Annuel', one_time: 'Paiement unique', usage: 'À l’usage', free: 'Gratuit', unknown: 'Inconnu' };
export const STALE_MS = 30 * 86_400_000;
export const SCAN_RETENTION_MS = 30 * 86_400_000;
export const APP_CSV_HEADERS = Object.freeze(['name', 'vendor', 'function', 'status', 'plan', 'cost_amount', 'currency', 'billing_period', 'installed_on', 'note']);
export const APP_CSV_TEMPLATE = `${APP_CSV_HEADERS.join(';')}\r\n`;
export const MAX_APPS = 300;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency').filter((c) => !['XXX', 'XTS'].includes(c)));
const text = (v, max) => scrubContacts(String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);
const decimal = (v) => { if (v === '' || v == null) return null; const s = String(v).trim(); if (!/^\d+(?:[.,]\d{1,2})?$/.test(s)) return undefined; const n = Number(s.replace(',', '.')), cents = Math.round(n * 100); return Number.isSafeInteger(cents) && cents <= Math.floor(Number.MAX_SAFE_INTEGER / (MAX_APPS * 12)) ? n : undefined; };
const dateOnly = (v) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined; const t = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().startsWith(v) ? v : undefined; };

// --- une application : validation commune (interface, CSV) ----------------------------------------------------------------------------
// Le statut « detected » n'est jamais accepté ici : il ne naît que d'une promotion explicite d'un indice (voir promoteFinding).
export function normalizeApp(input = {}, { allowStatus = ['declared', 'confirmed'] } = {}) {
  const errors = [], o = input ?? {};
  const name = text(o.name, 80); if (!name) errors.push('Nom de l’application obligatoire.');
  const fn = o.function ? String(o.function) : 'autre'; if (!Object.hasOwn(FUNCTIONS, fn)) errors.push(`Fonction inconnue : ${text(fn, 30)}.`);
  const status = o.status ? String(o.status) : 'declared'; if (!allowStatus.includes(status)) errors.push('Statut refusé : « déclarée » ou « confirmée » seulement (une détection n’est jamais enregistrée comme certaine).');
  const amount = decimal(o.costAmount ?? o.cost_amount ?? ''); if (amount === undefined) errors.push('Montant : nombre positif avec au plus deux décimales, dans la plage de calcul sûre pour 300 fiches, attendu.');
  const currency = String(o.costCurrency ?? o.currency ?? '').toUpperCase() || null; if (currency && !CURRENCIES.has(currency)) errors.push('Devise ISO 4217 non reconnue.');
  const billing = String(o.billingPeriod ?? o.billing_period ?? '') || (amount != null ? '' : 'unknown');
  if (billing && !Object.hasOwn(BILLING, billing)) errors.push('Périodicité : mensuel, annuel, paiement unique, à l’usage, gratuit ou inconnu.');
  if (amount != null) { if (!currency) errors.push('Une devise est obligatoire lorsqu’un montant est fourni.'); if (!billing || ['free', 'unknown'].includes(billing)) errors.push('La périodicité (mensuel, annuel, unique ou à l’usage) est obligatoire lorsqu’un montant est fourni.'); }
  if (billing === 'free' && amount != null && amount !== 0) errors.push('Une application gratuite n’a pas de montant.');
  const installedOn = dateOnly(String(o.installedOn ?? o.installed_on ?? '')); if (installedOn === undefined) errors.push('Date d’installation : AAAA-MM-JJ attendu.');
  const keys = Array.isArray(o.detectedKeys) ? [...new Set(o.detectedKeys.map((k) => text(k, 120)).filter(Boolean))].slice(0, 10) : [];
  if (errors.length) return { ok: false, errors };
  const known = amount != null && amount >= 0;
  return { ok: true, app: { name, vendor: text(o.vendor, 80), function: fn, status, plan: text(o.plan, 80), costAmount: known ? amount : null, costCurrency: known ? currency : null,
    billingPeriod: known ? billing : (billing === 'free' ? 'free' : billing || 'unknown'), installedOn, note: text(o.note, 400), detectedKeys: keys } };
}

// --- CSV Archipel « applications » (mêmes limites et protections que l'import manuel) --------------------------------------------------
export function validateAppsCsv(csv) {
  const failed = (line, message) => ({ ok: false, rows: [], errors: [{ line, message }] });
  if (typeof csv !== 'string') return failed(1, 'Fichier CSV UTF-8 attendu.');
  if (Buffer.byteLength(csv, 'utf8') > CSV_LIMITS.maxBytes) return failed(1, 'Fichier trop volumineux (maximum 500 Ko).');
  if (/[\u0000�]/.test(csv)) return failed(1, 'Encodage CSV invalide : UTF-8 exigé.');
  let records; try { records = parseCsvRecords(csv.replace(/^﻿/, '')); } catch (e) { return failed(e.line ?? 1, e.message ?? 'CSV mal formé.'); }
  if (!records.length) return failed(1, 'Le fichier CSV est vide.');
  const headers = records[0].cells.map((v) => v.trim());
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) return failed(1, 'En-têtes vides ou dupliqués.');
  if (!headers.includes('name')) return failed(1, 'Colonne « name » du modèle Archipel requise.');
  if (records.length - 1 > MAX_APPS) return failed(1, `Trop d’applications (maximum ${MAX_APPS}).`);
  const rows = [], errors = [], seen = new Set();
  for (const rec of records.slice(1)) {
    if (rec.cells.length !== headers.length) return failed(rec.line, 'Nombre de cellules différent des en-têtes.');
    const raw = Object.fromEntries(headers.map((h, i) => [h, rec.cells[i].trim()]).filter(([h]) => APP_CSV_HEADERS.includes(h)));
    if (Object.values(raw).some(isFormula)) { errors.push({ line: rec.line, message: 'Les formules ne sont pas acceptées.' }); continue; }
    const r = normalizeApp({ name: raw.name, vendor: raw.vendor, function: raw.function, status: raw.status, plan: raw.plan, costAmount: raw.cost_amount, costCurrency: raw.currency, billingPeriod: raw.billing_period, installedOn: raw.installed_on, note: raw.note });
    if (!r.ok) { for (const m of r.errors) errors.push({ line: rec.line, message: m }); continue; }
    const key = r.app.name.toLocaleLowerCase('fr'); if (seen.has(key)) { errors.push({ line: rec.line, message: `Application « ${r.app.name} » en double dans le fichier.` }); continue; }
    seen.add(key); rows.push({ line: rec.line, ...r.app });
  }
  return { ok: errors.length === 0, rows, errors };
}

// --- analyse déterministe (aucune IA, aucun chiffre inventé) --------------------------------------------------------------------------
const monthlyOf = (a) => (a.billingPeriod === 'free' ? 0 : a.costAmount == null ? null : a.billingPeriod === 'monthly' ? a.costAmount : a.billingPeriod === 'yearly' ? a.costAmount / 12 : a.billingPeriod === 'free' ? 0 : null);
const r2 = (n) => Math.round(n * 100) / 100;
export function analyzeApps(apps, { now = Date.now(), measures = null } = {}) {
  const list = apps.map((a) => ({ ...a, monthly: monthlyOf(a) }));
  const byFn = new Map(); for (const a of list) { if (a.function === 'autre') continue; (byFn.get(a.function) ?? byFn.set(a.function, []).get(a.function)).push(a); }
  const duplicates = [...byFn].filter(([, g]) => g.length > 1).map(([fn, g]) => ({ function: fn, label: FUNCTIONS[fn], apps: g.map((a) => ({ id: a.id, name: a.name, status: a.status })), note: 'Fonctions déclarées identiques : chevauchement POSSIBLE à vérifier (une même fonction peut être légitimement répartie sur deux applications).' }));
  const totals = {}; const unknownCost = [], oneTime = [], usage = [];
  for (const a of list) {
    if (a.billingPeriod === 'one_time' && a.costAmount != null) { oneTime.push({ id: a.id, name: a.name, amount: a.costAmount, currency: a.costCurrency }); continue; }
    if (a.billingPeriod === 'usage') { usage.push({ id: a.id, name: a.name, amount: a.costAmount, currency: a.costCurrency }); continue; }
    if (a.monthly == null) { unknownCost.push({ id: a.id, name: a.name }); continue; }
    if (a.billingPeriod === 'free') continue;
    const t = (totals[a.costCurrency] ??= { currency: a.costCurrency, monthly: 0, yearly: 0, apps: 0 }); t.yearly += a.billingPeriod === 'yearly' ? Math.round(a.costAmount * 100) : Math.round(a.costAmount * 100) * 12; t.apps++;
  }
  for (const t of Object.values(totals)) { t.monthly = r2(t.yearly / 1200); t.yearly /= 100; }
  const stale = list.filter((a) => now - Date.parse(a.updatedAt ?? 0) > STALE_MS).map((a) => ({ id: a.id, name: a.name, updatedAt: a.updatedAt }));
  const unconfirmed = list.filter((a) => a.status !== 'confirmed').map((a) => ({ id: a.id, name: a.name, status: a.status }));
  const impact = list.filter((a) => a.detectedKeys?.length).map((a) => {
    const ms = measures?.byKey ?? {}; const parts = a.detectedKeys.map((k) => ms[k]).filter((p) => p && p.measured > 0);
    return { id: a.id, name: a.name, linkedKeys: a.detectedKeys, measured: parts.length > 0, bytes: parts.length ? parts.reduce((s, p) => s + (p.bytes ?? 0), 0) : null, ms: parts.length ? parts.reduce((s, p) => s + (p.ms ?? 0), 0) : null, renderBlocking: parts.length ? parts.reduce((s, p) => s + (p.renderBlocking ?? 0), 0) : null };
  });
  return { count: list.length, byStatus: Object.fromEntries(APP_STATUSES.map((s) => [s, list.filter((a) => a.status === s).length])), duplicates,
    costs: { totals: Object.values(totals), unknownCost, oneTime, usage, note: 'Totaux par devise, sans conversion. Seuls les montants fournis par le propriétaire sont comptés ; coût absent = inconnu, jamais zéro.' }, stale, unconfirmed, impact };
}

// --- détection publique : lecture du HTML public, indices SEULEMENT --------------------------------------------------------------------
const HOST_OK = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;
const PLATFORM = (h) => h === 'cdn.shopify.com' || h === 'shopify.com' || h.endsWith('.shopify.com') || h.endsWith('.shopifycloud.com') || h === 'shop.app' || h.endsWith('.shopifysvc.com');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null; };
const hasFlag = (tag, name) => new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(tag);
export const isPublicHost = (h) => HOST_OK.test(h) && !/^\d+(\.\d+){3}$/.test(h) && !/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(h);

export function extractResources(html, domain) {
  const src = String(html ?? ''), headEnd = src.search(/<\/head\s*>/i), out = []; let inline = 0;
  for (const m of src.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0], kind = m[1].toLowerCase(), raw = kind === 'script' ? attr(tag, 'src') : (/\brel\s*=\s*["']?stylesheet/i.test(tag) ? attr(tag, 'href') : null);
    if (kind === 'script' && raw == null) { inline++; continue; }
    if (!raw) continue;
    let u; try { u = new URL(raw.trim(), `https://${domain}/`); } catch { continue; }
    if (u.protocol !== 'https:' || !isPublicHost(u.hostname)) continue;
    const host = u.hostname.toLowerCase(), own = host === domain || host.endsWith(`.${domain}`);
    const ext = host === 'cdn.shopify.com' ? u.pathname.match(/^\/extensions\/([0-9a-f-]{8,40})\//i)?.[1] ?? null : null;
    out.push({ kind, url: `${u.protocol}//${host}${u.pathname}`, host, party: own ? 'boutique' : ext ? 'extension_shopify' : PLATFORM(host) ? 'plateforme_shopify' : 'tiers', extensionId: ext,
      renderBlocking: kind === 'script' ? !(hasFlag(tag, 'async') || hasFlag(tag, 'defer') || /type\s*=\s*["']?module/i.test(tag)) && (headEnd < 0 || m.index < headEnd) : (headEnd < 0 || m.index < headEnd) });
  }
  return { resources: out, inlineScripts: inline };
}
export function findingsOf(resources) {
  const map = new Map();
  for (const r of resources.filter((x) => x.party === 'tiers' || x.party === 'extension_shopify')) {
    const key = r.party === 'extension_shopify' ? `ext:${r.extensionId}` : `host:${r.host}`;
    const f = map.get(key) ?? { key, kind: r.party === 'extension_shopify' ? 'extension_shopify' : 'hote_tiers', label: r.party === 'extension_shopify' ? `Extension d’application Shopify (identifiant ${r.extensionId})` : r.host, count: 0, renderBlocking: 0, samples: [], certainty: 'indice_non_prouve' };
    f.count++; if (r.renderBlocking) f.renderBlocking++; if (f.samples.length < 3 && !f.samples.includes(r.url)) f.samples.push(r.url); map.set(key, f);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// --- mesure réelle : transfert et durée de chargement, depuis CET ordinateur, sans rendu navigateur -----------------------------------
export const MEASURE_LIMITS = { timeoutMs: 10_000, maxBytes: 2_000_000, maxResources: 0 };
async function readBytes(res, max) {
  if (!res.body?.getReader) { const b = Buffer.from(await res.arrayBuffer()); return { bytes: b.length, text: b.toString('utf8'), truncated: b.length > max }; }
  const rd = res.body.getReader(), chunks = []; let n = 0, truncated = false;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; chunks.push(value); if (n > max) { truncated = true; try { await rd.cancel(); } catch { /* fermé */ } break; } }
  return { bytes: n, text: Buffer.concat(chunks).toString('utf8'), truncated };
}
async function timed(fetchImpl, url, tick) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), MEASURE_LIMITS.timeoutMs), t0 = tick();
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'Archipel-AppAudit/1 (lecture seule)', accept: '*/*' }, credentials: 'omit' });
    const body = await readBytes(res, MEASURE_LIMITS.maxBytes);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: Math.round(tick() - t0), bytes: body.bytes, truncated: body.truncated, transferBytes: Number(res.headers?.get?.('content-length')) || null, cache: res.headers?.get?.('cache-control') ?? null, text: body.text };
  } catch (e) { return { ok: false, status: 0, ms: Math.round(tick() - t0), bytes: 0, error: e?.name === 'AbortError' ? 'délai dépassé' : 'échec réseau' }; } finally { clearTimeout(timer); }
}
export async function measureStorefront({ fetchImpl, domain, tick = () => performance.now(), now = () => new Date().toISOString() }) {
  if (!isPublicHost(domain)) throw Object.assign(new Error('Domaine de boutique invalide.'), { status: 400 });
  const page = await timed(fetchImpl, `https://${domain}/`, tick);
  const scan = { at: now(), domain, page: { ok: page.ok, status: page.status, ms: page.ms, bytes: page.bytes }, findings: [], resources: [], byKey: {}, inlineScripts: 0, partial: false, method: 'Mesure réelle depuis cet ordinateur : une passe, HTML seul, sans rendu navigateur (ni LCP ni INP). Les scripts tiers restent des indices non mesurés. Les durées varient d’une passe à l’autre.' };
  if (!page.ok) { scan.error = page.error ?? `Page d’accueil indisponible (HTTP ${page.status}).`; return scan; }
  const { resources, inlineScripts } = extractResources(page.text, domain); scan.inlineScripts = inlineScripts;
  // Le HTML distant ne peut jamais élargir les destinations réseau autorisées.
  scan.partial = Boolean(page.truncated);
  scan.findings = findingsOf(resources).map((f) => ({ ...f, bytes: null, ms: null, measured: 0 }));
  scan.totals = { thirdPartyBytes: null, thirdPartyMs: null, thirdPartyRequests: 0, renderBlocking: scan.findings.reduce((s, f) => s + f.renderBlocking, 0), failed: 0 };
  return scan;
}
