// src/track17-connector.js — 17TRACK API v2.4 en LECTURE SEULE : getquota, gettracklist, gettrackinfo.
// `register` (qui CONSOMME du quota payant) et tous les autres points d'accès sont refusés avant tout réseau.
// Aucun compte n'est créé, aucun essai activé, aucun numéro enregistré : sans clé déjà fournie par le propriétaire, le connecteur reste « non configuré ».
// Limites officielles respectées : 3 requêtes par seconde, 40 numéros par requête ; 429 respecté.
import { assertAllowed, normalizeCarrier, CACHE_TTL_MS, TRACK17_LIMITS, maskTracking, trackingKey, normalizeStatus, analyzeLogistics } from './integrations-core.js';
import { IntegrationError, readCapped } from './mcp-client.js';

export const TRACK17_URL = 'https://api.17track.net/track/v2.4';
export const TRACK17_DEFAULT_CAP = 300;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const iso = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
const country = (v) => { const s = String(v ?? '').trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : ''; };

// Projection d'un suivi 17TRACK : liste blanche. Adresse du destinataire : le PAYS seulement. Aucun texte libre d'événement.
export function projectTrack17Item(raw) {
  const info = raw?.track_info ?? {}, latest = info.latest_status ?? {}, ev = info.latest_event ?? {};
  const all = (info.tracking?.providers?.[0]?.events ?? []).map((e) => ({ at: iso(e.time_utc ?? e.time_iso), status: normalizeStatus(e.stage ?? e.sub_status ?? e.description) }));
  const events = all.slice(0, 8), times = all.map((e) => e.at).filter(Boolean).sort();
  const status = normalizeStatus(latest.status);
  return { orderRef: '', carrier: normalizeCarrier(info.tracking?.providers?.[0]?.provider?.name ?? raw?.carrier), tracking: maskTracking(raw?.number), trackingKey: raw?.number ? trackingKey(raw.number) : '', status, statusRaw: '',
    destCountry: country(info.shipping_info?.recipient_address?.country), shippedAt: times[0] ?? iso(raw?.register_time ?? raw?.track_time) ?? null, // premier événement connu (à défaut, date d'enregistrement)
    deliveredAt: status === 'Delivered' ? iso(ev.time_utc) : null, lastEventAt: iso(ev.time_utc), events };
}

export function createTrack17Connector({ store, secrets, fetchImpl, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const ID = 'track17';
  const nowIso = () => new Date(now()).toISOString();
  const minGap = Math.ceil(1000 / TRACK17_LIMITS.perSecond) + 10;
  let lastAt = 0, queue = Promise.resolve(), generation = 0; const running = new Map();
  const stillCurrent = (gen) => { if (gen !== generation) throw new IntegrationError('auth', 'Opération annulée par une révocation ou un changement de clé.'); };
  // Un seul appel à la fois : quota vérifié, cadence attendue, requête, journal — sans qu'un autre appel ne s'intercale (jamais de dépassement par concurrence).
  const exclusive = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const pausedUntil = () => store.state(ID).settings.blockedUntil;
  const fresh = (kind) => { const s = store.latest(ID, kind); return s && now() - Date.parse(s.fetchedAt) < (CACHE_TTL_MS[kind] ?? 3_600_000) ? s : null; };
  const hasKey = () => secrets.info().available && secrets.has('track17.key');

  function setKey(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key.trim())) throw new IntegrationError('forbidden', 'Clé 17TRACK invalide (8 à 128 caractères alphanumériques).', { status: 400 });
    secrets.set('track17.key', key.trim());
    generation += 1;
    store.patch(ID, { authenticated: false, revokedAt: null, lastTestOk: null, lastTestError: null, settings: { ...store.state(ID).settings, keyStoredAt: nowIso() } });
    return { stored: true };
  }

  // Le seul chemin vers le réseau : liste blanche → plafond → cadence de 3/s → journal.
  const post = (endpoint, body) => { const gen = generation; return exclusive(() => { stillCurrent(gen); return postNow(endpoint, body); }); };
  async function postNow(endpoint, body) {
    const gen = generation;
    assertAllowed(ID, endpoint);                                         // `register` et consorts : refus sans réseau
    if (!hasKey()) throw new IntegrationError('auth', '17TRACK non configuré : aucune clé n’a été fournie.');
    const paused = pausedUntil(); if (paused && Date.parse(paused) > now()) throw new IntegrationError('rate_limited', `17TRACK a demandé une pause jusqu'au ${paused} : aucun appel avant.`, { status: 429 });
    const q = store.quota(ID);
    if (q.remaining <= 0) throw new IntegrationError('quota_local', `Plafond quotidien Archipel atteint (${q.cap} appels 17TRACK).`, { status: 429 });
    const wait = lastAt + minGap - now(); if (wait > 0) await sleep(wait); lastAt = now(); // cadence de 3 requêtes par seconde (horloge injectable)
    stillCurrent(gen);
    const t0 = Date.now();
    let res;
    try { res = await fetchImpl(`${TRACK17_URL}/${endpoint}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { '17token': secrets.get('track17.key'), 'content-type': 'application/json' }, body: JSON.stringify(body ?? []) }); }
    catch (e) { const err = e instanceof IntegrationError ? e : new IntegrationError(e?.name === 'TimeoutError' ? 'timeout' : 'network', e?.name === 'TimeoutError' ? 'Délai dépassé.' : 'Service injoignable.'); store.recordCall(ID, { tool: endpoint, ok: false, ms: Date.now() - t0, error: err.message }); throw err; }
    const fail = (e) => { if (e.kind === 'auth') store.patch(ID, { authenticated: false }); store.recordCall(ID, { tool: endpoint, ok: false, ms: Date.now() - t0, error: e.message }); throw e; };
    if (res.status >= 300 && res.status < 400) fail(new IntegrationError('protocol', 'Redirection refusée.'));
    if (res.status === 429) { const wait = Math.min(Math.max(Number(res.headers?.get?.('retry-after')) || 60, 5), 86_400); store.patch(ID, { settings: { ...store.state(ID).settings, blockedUntil: new Date(now() + wait * 1000).toISOString() } }); fail(new IntegrationError('rate_limited', '17TRACK : fréquence ou quota dépassé, pause enregistrée.', { retryAfterSec: wait })); }
    if (res.status === 401) fail(new IntegrationError('auth', '17TRACK : clé refusée, adresse IP non autorisée ou compte désactivé.'));
    if (res.status >= 400) fail(new IntegrationError('http', `17TRACK : erreur HTTP ${res.status}.`));
    let text; try { text = await readCapped(res); } catch { return fail(new IntegrationError('network', '17TRACK : lecture interrompue.')); }
    if (text === null) return fail(new IntegrationError('protocol', '17TRACK : réponse trop volumineuse.'));
    let j; try { j = JSON.parse(text); } catch { return fail(new IntegrationError('protocol', '17TRACK : réponse illisible.')); }
    stillCurrent(gen);
    if (j.code !== 0) fail(new IntegrationError(j.code === -18010001 || j.code === -18010002 ? 'auth' : 'protocol', '17TRACK : réponse refusée par le service.'));
    store.recordCall(ID, { tool: endpoint, ok: true, ms: Date.now() - t0 });
    return j.data;
  }

  const once = (key, fn) => { if (running.has(key)) return running.get(key); const p = fn().finally(() => running.delete(key)); running.set(key, p); return p; }; // seulement une opération IDENTIQUE
  const test = () => once('test', testNow);
  async function testNow() {
    const gen = generation;
    try {
      const q = await post('getquota', []);
      stillCurrent(gen);
      const count = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
      const detail = { quotaTotal: count(q?.quota_total), quotaUsed: count(q?.quota_used), quotaRemain: count(q?.quota_remain), todayUsed: count(q?.today_used) };
      store.patch(ID, { authenticated: true, lastTestAt: nowIso(), lastTestOk: true, lastTestError: null, lastTestDetail: detail, connectedAt: store.state(ID).connectedAt ?? nowIso() });
      store.saveSnapshot({ integration: ID, kind: 'quota', payload: { quota: { total: detail.quotaTotal, used: detail.quotaUsed, remain: detail.quotaRemain } } });
      return { ok: true, ...detail };
    } catch (e) { store.patch(ID, { lastTestAt: nowIso(), lastTestOk: false, lastTestError: e.message, lastTestDetail: { kind: e.kind ?? 'error' } }); throw e; }
  }

  // Suivis DÉJÀ enregistrés dans le compte (jamais d'enregistrement) → gettrackinfo par lots de 40.
  const sync = (opts) => once(opts?.force ? 'sync-force' : 'sync', () => syncNow(opts));
  async function syncNow({ force = false } = {}) {
    const gen = generation;
    if (!force && fresh('tracklist')) return { ok: true, fromCache: true, quota: store.quota(ID) };
    try {
      const numbers = []; let page = 1;
      for (; page <= 5; page += 1) {
        const d = await post('gettracklist', { page_no: page }); const items = d?.accepted ?? d?.list ?? [];
        numbers.push(...items.map((x) => x.number).filter(Boolean));
        if (!d?.page || (d.page.data_total ?? 0) <= numbers.length || !items.length) break;
      }
      const packages = [];
      for (let i = 0; i < numbers.length; i += TRACK17_LIMITS.perRequest) {
        const d = await post('gettrackinfo', numbers.slice(i, i + TRACK17_LIMITS.perRequest).map((number) => ({ number })));
        packages.push(...(d?.accepted ?? []).map(projectTrack17Item));
      }
      stillCurrent(gen);
      store.saveSnapshot({ integration: ID, kind: 'tracklist', payload: { packages }, note: `${numbers.length} suivi(s) déjà enregistré(s)` });
      store.patch(ID, { lastSyncAt: nowIso(), lastSyncOk: true, lastSyncError: null });
      return { ok: true, count: packages.length, quota: store.quota(ID) };
    } catch (e) { store.patch(ID, { lastSyncAt: nowIso(), lastSyncOk: false, lastSyncError: e.message }); return { ok: false, error: e.message, kind: e.kind ?? 'error', quota: store.quota(ID) }; }
  }
  function data() {
    const list = store.latest(ID, 'tracklist'), quota = store.latest(ID, 'quota');
    if (!list && !quota) return null;
    const packages = list?.payload?.packages ?? [];
    return { fetchedAt: (list ?? quota).fetchedAt, sources: [list, quota].filter(Boolean).map((s) => `archipel://integrations/track17/${s.id}`), logistics: packages.length ? analyzeLogistics(packages, { now: now() }) : null, packages, quota: quota ? { used: quota.payload.quota.used, total: quota.payload.quota.total } : null };
  }
  function revoke({ purge = false } = {}) {
    generation += 1;
    secrets.delete('track17.key');
    store.patch(ID, { authenticated: false, revokedAt: nowIso(), lastTestOk: null, lastTestError: null, lastTestDetail: {} });
    if (purge) { store.purge(ID); store.revokeAllGrants(ID); }
    return { revoked: true, purged: purge, note: 'Clé supprimée de cet ordinateur. Pensez à la renouveler dans votre compte 17TRACK si elle a été exposée.' };
  }
  return { id: ID, setKey, test, sync, data, revoke, post, hasKey };
}
