// src/studio-shop.js — relevés datés du catalogue Shopify (cache LOCAL : chaque PC relève lui-même, rien n'est synchronisé par git).
// Aucune écriture vers Shopify n'existe ici. Un relevé est refait au plus toutes les 5 minutes, échecs compris (jamais de martèlement).
import { randomUUID } from 'node:crypto';
import { SHOP_LIMITS, SHOP_RETENTION_MS, ADMIN_SCOPES, snapshotHash, sanitizeCatalog } from './shop-readonly.js';

const json = (t, d) => { try { return JSON.parse(t) ?? d; } catch { return d; } };
const KEEP = 8;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

export function createShopStore(db, { connector, clock = () => new Date().toISOString() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS shop_snapshots (id TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, mode TEXT NOT NULL, domain TEXT NOT NULL, ok INTEGER NOT NULL, partial INTEGER NOT NULL, errors TEXT NOT NULL, collections TEXT NOT NULL, products TEXT NOT NULL, source_urls TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shop_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shop_admin_snapshots (id TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, domain TEXT NOT NULL, payload TEXT NOT NULL);`);
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const meta = (k) => get('SELECT value FROM shop_meta WHERE key = ?', k)?.value ?? null;
  const setMeta = (k, v) => db.prepare('INSERT INTO shop_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  const map = (r) => !r ? null : sanitizeCatalog({ id: r.id, fetchedAt: r.fetched_at, mode: r.mode, domain: r.domain, ok: Boolean(r.ok), partial: Boolean(r.partial), errors: json(r.errors, []), collections: json(r.collections, []), products: json(r.products, []), sourceUrls: json(r.source_urls, []), hash: r.hash });
  const purgeExpired = () => {
    const before = new Date(Date.parse(clock()) - SHOP_RETENTION_MS).toISOString();
    db.prepare('DELETE FROM shop_snapshots WHERE fetched_at <= ?').run(before);
    db.prepare('DELETE FROM shop_admin_snapshots WHERE fetched_at <= ?').run(before);
  };
  purgeExpired();
  const timer = setInterval(() => { try { purgeExpired(); } catch { /* fermeture de la base */ } }, 60_000); timer.unref?.();
  const latest = () => { purgeExpired(); return map(get("SELECT * FROM shop_snapshots WHERE ok = 1 AND mode = 'public' AND (? IS NULL OR domain = ?) ORDER BY fetched_at DESC, rowid DESC LIMIT 1", connector?.domain ?? null, connector?.domain ?? null)); };
  const config = () => json(meta('admin_consent'), null);
  // Une ancienne réponse ne prouve pas l'authentification du jeton chargé par ce processus.
  setMeta('admin_authenticated', '');
  const latestAdmin = () => {
    purgeExpired();
    const cfg = config();
    if (!cfg?.enabled || !cfg.at || cfg.domain !== connector?.adminDomain) return null;
    const r = get('SELECT * FROM shop_admin_snapshots WHERE domain = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1', connector?.adminDomain ?? '');
    return r ? json(r.payload, null) : null;
  };
  const configureAdmin = ({ confirm, enabled, orders = false } = {}) => {
    if (confirm !== true || typeof enabled !== 'boolean' || typeof orders !== 'boolean') throw bad('Confirmation explicite requise pour les capacités Shopify Admin.');
    setMeta('admin_consent', JSON.stringify({ enabled, orders, at: clock(), domain: connector?.adminDomain ?? null, revision: randomUUID() }));
    setMeta('admin_authenticated', ''); setMeta('admin_scopes', '[]'); setMeta('admin_error', '');
    db.prepare('DELETE FROM shop_admin_snapshots').run();
    return adminStatus();
  };
  const adminStatus = () => {
    const cfg = config();
    const ready = Boolean(cfg?.enabled && cfg.at && cfg.domain === connector?.adminDomain && connector?.adminConfigured && connector?.adminNetworkAllowed?.());
    const authenticated = ready && Boolean(meta('admin_authenticated'));
    return { source: 'shopify_admin', state: authenticated ? 'authenticated' : ready ? 'configured' : 'not_configured', stateLabel: authenticated ? 'Authentifié' : ready ? 'Configuré — non vérifié' : 'À configurer', authenticated,
      consent: cfg, requiredScopes: [...ADMIN_SCOPES, ...(cfg?.orders ? ['read_orders'] : [])], scopes: json(meta('admin_scopes'), []), lastTestAt: meta('admin_test_at'), lastError: meta('admin_error') || null, realNetworkAllowed: Boolean(connector?.adminNetworkAllowed?.()), readOnly: true };
  };
  let adminRunning = null;
  const refreshAdmin = async ({ force = false } = {}) => {
    if (adminStatus().state === 'not_configured') throw bad('Shopify Admin : À configurer (accord local et autorisation réseau nécessaires).');
    if (adminRunning) return adminRunning;
    const wait = meta('admin_next_allowed');
    if (wait && Date.parse(clock()) < Date.parse(wait)) return { skipped: `La boutique demande d'attendre jusqu'à ${wait}.`, snapshot: latestAdmin() };
    const last = meta('admin_attempt');
    if (!force && last && Date.parse(clock()) - Date.parse(last) < SHOP_LIMITS.minIntervalMs) return { skipped: 'Relevé récent : réessayez dans quelques minutes.', snapshot: latestAdmin() };
    setMeta('admin_attempt', clock());
    const consentText = meta('admin_consent');
    const valid = () => consentText === meta('admin_consent') && adminStatus().state !== 'not_configured';
    adminRunning = (async () => {
      try {
        const r = await connector.fetchAdmin({ authorization: { ...config(), valid } });
        if (!valid()) return { ok: false, errors: ['Autorisation Shopify Admin modifiée pendant le relevé.'], snapshot: null };
        setMeta('admin_test_at', clock()); setMeta('admin_authenticated', r.authenticated ? clock() : '');
        setMeta('admin_scopes', JSON.stringify(r.scopes ?? [])); setMeta('admin_error', (r.errors ?? []).join(' ; '));
        if (r.retryAfterSec) setMeta('admin_next_allowed', new Date(Date.parse(clock()) + Math.max(r.retryAfterSec * 1000, SHOP_LIMITS.minIntervalMs)).toISOString()); else setMeta('admin_next_allowed', '');
        if (r.authenticated && (r.ok || r.products?.length || r.orders?.length)) {
          const snap = { ...r, id: randomUUID(), fetchedAt: clock(), source: 'shopify_admin' };
          db.prepare('INSERT INTO shop_admin_snapshots (id, fetched_at, domain, payload) VALUES (?, ?, ?, ?)').run(snap.id, snap.fetchedAt, connector.adminDomain, JSON.stringify(snap));
          db.prepare('DELETE FROM shop_admin_snapshots WHERE id NOT IN (SELECT id FROM shop_admin_snapshots ORDER BY fetched_at DESC, rowid DESC LIMIT ?)').run(KEEP);
        }
        return { refreshed: true, ok: r.ok, errors: r.errors ?? [], snapshot: latestAdmin() };
      } finally { adminRunning = null; }
    })();
    return adminRunning;
  };
  let running = null;

  async function refresh({ force = false } = {}) {
    if (!connector) return { skipped: 'Aucun connecteur Shopify configuré.', snapshot: latest() };
    if (running) return running; // un seul relevé à la fois
    const wait = meta('next_allowed'); // Retry-After de la boutique : respecté même si on force
    if (wait && Date.parse(clock()) < Date.parse(wait)) return { skipped: `La boutique demande d'attendre jusqu'à ${wait}.`, snapshot: latest() };
    const last = meta('last_attempt');
    if (!force && last && Date.parse(clock()) - Date.parse(last) < SHOP_LIMITS.minIntervalMs) return { skipped: 'Relevé récent : réessayez dans quelques minutes.', snapshot: latest() };
    setMeta('last_attempt', clock()); // l'essai compte même s'il échoue
    running = (async () => {
      try {
        const r = sanitizeCatalog(await connector.fetchCatalog());
        const id = randomUUID(), snap = { ...r, id, fetchedAt: clock() };
        db.prepare('INSERT INTO shop_snapshots (id, fetched_at, mode, domain, ok, partial, errors, collections, products, source_urls, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, snap.fetchedAt, r.mode, r.domain, Number(r.ok), Number(r.partial), JSON.stringify(r.errors), JSON.stringify(r.collections), JSON.stringify(r.products), JSON.stringify(r.sourceUrls), snapshotHash(r));
        setMeta('last_error', r.errors.join(' ; '));
        if (r.retryAfterSec) setMeta('next_allowed', new Date(Date.parse(clock()) + Math.max(r.retryAfterSec * 1000, SHOP_LIMITS.minIntervalMs)).toISOString()); else setMeta('next_allowed', '');
        db.prepare('DELETE FROM shop_snapshots WHERE id NOT IN (SELECT id FROM shop_snapshots ORDER BY fetched_at DESC, rowid DESC LIMIT ?)').run(KEEP);
        return { refreshed: true, ok: r.ok, errors: r.errors, snapshot: latest() }; // jamais un relevé en échec comme s'il pouvait servir
      } finally { running = null; }
    })();
    return running;
  }
  return {
    latest, refresh, latestAdmin, adminStatus, configureAdmin, refreshAdmin, testAdmin: () => refreshAdmin({ force: true }), purgeExpired, close: () => clearInterval(timer),
    // Relevé suffisamment récent pour une tâche ; sinon une tentative (qui respecte l'intervalle minimal). Ne lève jamais.
    async ensureFresh() {
      const s = latest();
      if (s && Date.parse(clock()) - Date.parse(s.fetchedAt) < SHOP_LIMITS.staleMs) return s;
      try { await refresh(); } catch { /* la tâche partira avec « catalogue non disponible » */ }
      return latest();
    },
    status() {
      const s = latest();
      return { mode: connector?.mode ?? 'none', domain: connector?.domain ?? null, hasToken: Boolean(connector?.hasToken), misconfigured: Boolean(connector?.misconfigured), writable: false,
        lastAttempt: meta('last_attempt'), lastError: meta('last_error') || null,
        snapshot: s && { id: s.id, fetchedAt: s.fetchedAt, mode: s.mode, partial: s.partial, collections: s.collections.length, products: s.products.length, errors: s.errors, hash: s.hash },
        note: 'Lecture seule : le Studio ne peut rien écrire dans la boutique. Chaque ordinateur relève son propre catalogue.' };
    }
  };
}
