// src/studio-integrations.js — état, accès par agent, journal d'appels (quota) et relevés des intégrations. Tables à part (additif).
// Tout est LOCAL à chaque ordinateur : ni jetons, ni accès, ni relevés ne voyagent par git (chaque PC s'authentifie lui-même).
// Aucun secret ici : les jetons vivent dans le magasin de secrets chiffré (secret-store.js).
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_DAILY_CAP, MAX_DAILY_CAP, INTEGRATION_IDS, ACCESS_LEVELS, sanitizeDeep } from './integrations-core.js';
import { scrubSecrets, hasSecretShape } from './secret-store.js';

const json = (t, d) => { try { return JSON.parse(t) ?? d; } catch { return d; } };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const KEEP = 5;

export function createIntegrationStore(db, { clock = () => new Date().toISOString(), defaultCaps = {} } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_state (id TEXT PRIMARY KEY, authenticated INTEGER NOT NULL DEFAULT 0, scopes TEXT NOT NULL DEFAULT '[]', connected_at TEXT, revoked_at TEXT, last_test_at TEXT, last_test_ok INTEGER, last_test_error TEXT, last_test_detail TEXT NOT NULL DEFAULT '{}', last_sync_at TEXT, last_sync_ok INTEGER, last_sync_error TEXT, daily_cap INTEGER, settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_grants (integration TEXT NOT NULL, agent_slug TEXT NOT NULL, access TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY (integration, agent_slug));
    CREATE TABLE IF NOT EXISTS integration_calls (id TEXT PRIMARY KEY, integration TEXT NOT NULL, tool TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER, error TEXT);
    CREATE INDEX IF NOT EXISTS integration_calls_day ON integration_calls(integration, at);
    CREATE TABLE IF NOT EXISTS integration_snapshots (id TEXT PRIMARY KEY, integration TEXT NOT NULL, kind TEXT NOT NULL, fetched_at TEXT NOT NULL, ok INTEGER NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS integration_snapshots_kind ON integration_snapshots(integration, kind, fetched_at);
  `);
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const now = () => clock();
  const known = (id) => { if (!INTEGRATION_IDS.includes(id)) throw bad('Intégration inconnue.', 404); return id; };
  const dayStart = () => `${now().slice(0, 10)}T00:00:00.000Z`;

  const mapState = (id, r) => ({ id, authenticated: Boolean(r?.authenticated), scopes: json(r?.scopes, []), connectedAt: r?.connected_at ?? null, revokedAt: r?.revoked_at ?? null, lastTestAt: r?.last_test_at ?? null, lastTestOk: r?.last_test_ok == null ? null : Boolean(r.last_test_ok), lastTestError: r?.last_test_error ?? null, lastTestDetail: json(r?.last_test_detail, {}),
    lastSyncAt: r?.last_sync_at ?? null, lastSyncOk: r?.last_sync_ok == null ? null : Boolean(r.last_sync_ok), lastSyncError: r?.last_sync_error ?? null, dailyCap: r?.daily_cap ?? null, settings: json(r?.settings, {}) });
  const state = (id) => mapState(known(id), get('SELECT * FROM integration_state WHERE id = ?', id));
  const COLS = { authenticated: 'authenticated', scopes: 'scopes', connectedAt: 'connected_at', revokedAt: 'revoked_at', lastTestAt: 'last_test_at', lastTestOk: 'last_test_ok', lastTestError: 'last_test_error', lastTestDetail: 'last_test_detail', lastSyncAt: 'last_sync_at', lastSyncOk: 'last_sync_ok', lastSyncError: 'last_sync_error', dailyCap: 'daily_cap', settings: 'settings' };
  const patch = (id, changes) => {
    known(id);
    const cur = state(id), next = { ...cur, ...changes };
    const val = (k) => (k === 'scopes' || k === 'lastTestDetail' || k === 'settings' ? JSON.stringify(next[k] ?? (k === 'scopes' ? [] : {})) : typeof next[k] === 'boolean' ? Number(next[k]) : next[k] ?? null);
    for (const k of ['lastTestError', 'lastSyncError']) if (typeof next[k] === 'string') next[k] = scrubSecrets(next[k]).slice(0, 400);
    run(`INSERT INTO integration_state (id, ${Object.values(COLS).join(', ')}, updated_at) VALUES (?, ${Object.keys(COLS).map(() => '?').join(', ')}, ?)
      ON CONFLICT(id) DO UPDATE SET ${Object.values(COLS).map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`, id, ...Object.keys(COLS).map(val), now());
    return state(id);
  };
  const dailyCap = (id) => state(id).dailyCap ?? defaultCaps[id] ?? DEFAULT_DAILY_CAP;
  const setDailyCap = (id, n) => { const v = Number(n); if (!Number.isInteger(v) || v < 1 || v > MAX_DAILY_CAP) throw bad(`Le plafond quotidien doit être un entier entre 1 et ${MAX_DAILY_CAP}.`); return patch(id, { dailyCap: v }); };

  // --- journal d'appels et quota (aucun contenu, seulement l'outil, l'heure et le résultat) ---
  const recordCall = (id, { tool, ok, ms = 0, error = null }) => { known(id); run('INSERT INTO integration_calls (id, integration, tool, at, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)', randomUUID(), id, String(tool).slice(0, 80), now(), Number(Boolean(ok)), Math.round(ms), error ? scrubSecrets(String(error)).slice(0, 300) : null); };
  const callsToday = (id) => get('SELECT COUNT(*) AS n FROM integration_calls WHERE integration = ? AND at >= ?', known(id), dayStart()).n;
  const quota = (id) => { const cap = dailyCap(id), used = callsToday(id); return { cap, used, remaining: Math.max(0, cap - used), resetsAt: new Date(Date.parse(dayStart()) + 86_400_000).toISOString() }; };
  const recentCalls = (id, n = 20) => all('SELECT tool, at, ok, ms, error FROM integration_calls WHERE integration = ? ORDER BY at DESC, rowid DESC LIMIT ?', known(id), Math.min(Math.max(Number(n) || 20, 1), 100)).map((r) => ({ tool: r.tool, at: r.at, ok: Boolean(r.ok), ms: r.ms, error: r.error }));
  const recentErrors = (id, n = 5) => all('SELECT tool, at, error FROM integration_calls WHERE integration = ? AND ok = 0 ORDER BY at DESC, rowid DESC LIMIT ?', known(id), n);

  // --- accès par agent : AUCUN accès par défaut, lecture seule ---
  const grant = (id, slug, access = 'read') => {
    known(id);
    if (!ACCESS_LEVELS.includes(access)) throw bad('Seul l’accès en lecture existe.');
    if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(slug)) throw bad('Agent invalide.');
    run('INSERT INTO integration_grants (integration, agent_slug, access, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(integration, agent_slug) DO UPDATE SET access = excluded.access', id, slug, access, now());
    return grantsOf(id);
  };
  const revokeGrant = (id, slug) => { run('DELETE FROM integration_grants WHERE integration = ? AND agent_slug = ?', known(id), slug); return grantsOf(id); };
  const revokeAllGrants = (id) => { run('DELETE FROM integration_grants WHERE integration = ?', known(id)); };
  const grantsOf = (id) => all('SELECT agent_slug, access, granted_at FROM integration_grants WHERE integration = ? ORDER BY agent_slug', known(id)).map((r) => ({ agent: r.agent_slug, access: r.access, grantedAt: r.granted_at }));
  const hasGrant = (id, slug) => Boolean(get('SELECT 1 AS ok FROM integration_grants WHERE integration = ? AND agent_slug = ? AND access = ?', known(id), slug, 'read'));

  // --- relevés : toujours passés par le nettoyage anti-PII, et refusés s'ils ressemblent à un secret ---
  const saveSnapshot = ({ integration, kind, payload, ok = true, note = '' }) => {
    known(integration);
    const clean = sanitizeDeep(payload), text = JSON.stringify(clean);
    if (hasSecretShape(text)) throw bad('Un secret semble présent dans le relevé : refusé.', 500);
    const id = randomUUID(), hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
    run('INSERT INTO integration_snapshots (id, integration, kind, fetched_at, ok, payload, hash, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, integration, String(kind).slice(0, 40), now(), Number(Boolean(ok)), text, hash, String(note).slice(0, 200));
    run('DELETE FROM integration_snapshots WHERE integration = ? AND kind = ? AND id NOT IN (SELECT id FROM integration_snapshots WHERE integration = ? AND kind = ? ORDER BY fetched_at DESC, rowid DESC LIMIT ?)', integration, kind, integration, kind, KEEP);
    return latest(integration, kind, { anyOk: true });
  };
  const mapSnap = (r) => r && { id: r.id, integration: r.integration, kind: r.kind, fetchedAt: r.fetched_at, ok: Boolean(r.ok), payload: json(r.payload, null), hash: r.hash, note: r.note };
  const latest = (integration, kind, { anyOk = false } = {}) => mapSnap(get(`SELECT * FROM integration_snapshots WHERE integration = ? AND kind = ? ${anyOk ? '' : 'AND ok = 1'} ORDER BY fetched_at DESC, rowid DESC LIMIT 1`, known(integration), kind)) ?? null;
  const purge = (id) => { run('DELETE FROM integration_snapshots WHERE integration = ?', known(id)); };

  return { state, patch, dailyCap, setDailyCap, recordCall, callsToday, quota, recentCalls, recentErrors, grant, revokeGrant, revokeAllGrants, grantsOf, hasGrant, saveSnapshot, latest, purge, now };
}
