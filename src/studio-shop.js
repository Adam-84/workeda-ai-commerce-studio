// src/studio-shop.js — relevés datés du catalogue Shopify (cache LOCAL : chaque PC relève lui-même, rien n'est synchronisé par git).
// Aucune écriture vers Shopify n'existe ici. Un relevé est refait au plus toutes les 5 minutes, échecs compris (jamais de martèlement).
import { randomUUID } from 'node:crypto';
import { SHOP_LIMITS, snapshotHash } from './shop-readonly.js';

const json = (t, d) => { try { return JSON.parse(t) ?? d; } catch { return d; } };
const KEEP = 8;

export function createShopStore(db, { connector, clock = () => new Date().toISOString() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS shop_snapshots (id TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, mode TEXT NOT NULL, domain TEXT NOT NULL, ok INTEGER NOT NULL, partial INTEGER NOT NULL, errors TEXT NOT NULL, collections TEXT NOT NULL, products TEXT NOT NULL, source_urls TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shop_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const meta = (k) => get('SELECT value FROM shop_meta WHERE key = ?', k)?.value ?? null;
  const setMeta = (k, v) => db.prepare('INSERT INTO shop_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  const map = (r) => !r ? null : { id: r.id, fetchedAt: r.fetched_at, mode: r.mode, domain: r.domain, ok: Boolean(r.ok), partial: Boolean(r.partial), errors: json(r.errors, []), collections: json(r.collections, []), products: json(r.products, []), sourceUrls: json(r.source_urls, []), hash: r.hash };
  const latest = () => map(get('SELECT * FROM shop_snapshots WHERE ok = 1 ORDER BY fetched_at DESC, rowid DESC LIMIT 1'));
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
        const r = await connector.fetchCatalog();
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
    latest, refresh,
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
