// src/studio-apps.js — stockage LOCAL de l'inventaire des applications Shopify (tables à part, additif). Rien ne voyage par git.
// Inventaire : conservé jusqu'à suppression par le propriétaire, signalé « à revérifier » après 30 jours sans mise à jour.
// Relevés de détection/mesure : purgés après 30 jours. Aucune donnée client, aucun secret.
import { randomUUID } from 'node:crypto';
import { normalizeApp, SCAN_RETENTION_MS, MAX_APPS } from './shop-apps.js';
import { hasSecretShape } from './secret-store.js';

const json = (t, d) => { try { return JSON.parse(t) ?? d; } catch { return d; } };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export function createAppStore(db, { clock = () => new Date().toISOString() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL DEFAULT '', fn TEXT NOT NULL DEFAULT 'autre', status TEXT NOT NULL DEFAULT 'declared',
      plan TEXT NOT NULL DEFAULT '', cost_amount REAL, cost_currency TEXT, billing_period TEXT NOT NULL DEFAULT 'unknown', installed_on TEXT, note TEXT NOT NULL DEFAULT '', detected_keys TEXT NOT NULL DEFAULT '[]',
      confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shop_app_scans (id TEXT PRIMARY KEY, at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shop_apps_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const get = (sql, ...a) => db.prepare(sql).get(...a), all = (sql, ...a) => db.prepare(sql).all(...a), run = (sql, ...a) => db.prepare(sql).run(...a);
  const now = () => clock();
  const map = (r) => r && { id: r.id, name: r.name, vendor: r.vendor, function: r.fn, status: r.status, plan: r.plan, costAmount: r.cost_amount, costCurrency: r.cost_currency, billingPeriod: r.billing_period,
    installedOn: r.installed_on, note: r.note, detectedKeys: json(r.detected_keys, []), confirmedAt: r.confirmed_at, createdAt: r.created_at, updatedAt: r.updated_at };
  const keyOf = (name) => name.toLocaleLowerCase('fr');
  const check = (app) => { if (hasSecretShape(JSON.stringify(app))) throw bad('Un secret semble présent dans la fiche : refusé.'); };
  const list = () => all('SELECT * FROM shop_apps ORDER BY name_key').map(map);
  const byId = (id) => map(get('SELECT * FROM shop_apps WHERE id = ?', id));
  const count = () => get('SELECT COUNT(*) AS n FROM shop_apps').n;

  function insert(app, source) {
    check(app);
    const id = randomUUID(), t = now();
    run('INSERT INTO shop_apps (id, name, name_key, vendor, fn, status, plan, cost_amount, cost_currency, billing_period, installed_on, note, detected_keys, confirmed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, app.name, keyOf(app.name), app.vendor, app.function, source ?? app.status, app.plan, app.costAmount, app.costCurrency, app.billingPeriod, app.installedOn, app.note, JSON.stringify(app.detectedKeys ?? []), (source ?? app.status) === 'confirmed' ? t : null, t, t);
    return byId(id);
  }
  const clash = (name, exceptId = null) => { const r = get('SELECT id FROM shop_apps WHERE name_key = ?', keyOf(name)); return r && r.id !== exceptId; };
  const touch = () => run("INSERT INTO shop_apps_meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", randomUUID());

  const add = (input) => {
    const r = normalizeApp(input); if (!r.ok) throw bad(r.errors.join(' '));
    if (count() >= MAX_APPS) throw bad(`Limite de ${MAX_APPS} applications atteinte.`, 409);
    if (clash(r.app.name)) throw bad(`« ${r.app.name} » existe déjà : modifiez la fiche existante.`, 409);
    const a = insert(r.app); touch(); return a;
  };
  // Correction manuelle d'une fiche : seuls les champs fournis changent ; le statut « détectée » ne peut pas être rétabli à la main.
  const update = (id, patch) => {
    const cur = byId(id); if (!cur) throw bad('Application inconnue.', 404);
    const p = patch ?? {};
    const merged = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([k]) => ['name', 'vendor', 'function', 'status', 'plan', 'costAmount', 'costCurrency', 'billingPeriod', 'installedOn', 'note', 'detectedKeys'].includes(k))) };
    if ('costAmount' in p && (p.costAmount === null || p.costAmount === '')) { merged.costAmount = null; merged.costCurrency = null; if (!('billingPeriod' in p)) merged.billingPeriod = 'unknown'; }
    const r = normalizeApp(merged, { allowStatus: cur.status === 'detected' && merged.status === 'detected' ? ['declared', 'confirmed', 'detected'] : ['declared', 'confirmed'] });
    if (!r.ok) throw bad(r.errors.join(' '));
    if (clash(r.app.name, id)) throw bad(`« ${r.app.name} » existe déjà.`, 409);
    check(r.app);
    const t = now(), confirmedAt = r.app.status === 'confirmed' ? (cur.status === 'confirmed' ? cur.confirmedAt : t) : null;
    run('UPDATE shop_apps SET name=?, name_key=?, vendor=?, fn=?, status=?, plan=?, cost_amount=?, cost_currency=?, billing_period=?, installed_on=?, note=?, detected_keys=?, confirmed_at=?, updated_at=? WHERE id=?',
      r.app.name, keyOf(r.app.name), r.app.vendor, r.app.function, r.app.status, r.app.plan, r.app.costAmount, r.app.costCurrency, r.app.billingPeriod, r.app.installedOn, r.app.note, JSON.stringify(r.app.detectedKeys), confirmedAt, t, id);
    touch(); return byId(id);
  };
  const remove = (id) => { const r = run('DELETE FROM shop_apps WHERE id = ?', id); if (!r.changes) throw bad('Application inconnue.', 404); touch(); return { removed: true }; };
  const clearAll = () => { run('DELETE FROM shop_apps'); run('DELETE FROM shop_app_scans'); touch(); };

  // Import CSV : fusion par nom (les fiches absentes du fichier ne sont JAMAIS supprimées), le tout dans une transaction.
  function importRows(rows) {
    db.exec('BEGIN IMMEDIATE');
    try {
      let added = 0, updated = 0;
      for (const row of rows) {
        const cur = get('SELECT id, status, detected_keys FROM shop_apps WHERE name_key = ?', keyOf(row.name));
        if (cur) { update(cur.id, { ...row, detectedKeys: json(cur.detected_keys, []) }); updated++; }
        else { if (count() >= MAX_APPS) throw bad(`Limite de ${MAX_APPS} applications atteinte.`, 409); const { line, ...app } = row; insert(app); added++; }
      }
      touch(); db.exec('COMMIT'); return { added, updated };
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
  }
  // Promotion d'un indice : crée une fiche « détectée », jamais « confirmée ». Le nom est celui que le propriétaire choisit.
  function promote({ key, name, function: fn }) {
    const scan = latestScan(); const f = scan?.findings?.find((x) => x.key === key);
    if (!f) throw bad('Indice inconnu : relancez une détection.', 404);
    const r = normalizeApp({ name, function: fn ?? 'autre', status: 'declared', detectedKeys: [key], note: `Indice : ${f.label} (non confirmé).` });
    if (!r.ok) throw bad(r.errors.join(' '));
    if (clash(r.app.name)) throw bad(`« ${r.app.name} » existe déjà : liez l'indice à cette fiche.`, 409);
    const a = insert({ ...r.app, status: 'detected' }, 'detected'); touch(); return a;
  }
  const link = (id, key) => { const cur = byId(id); if (!cur) throw bad('Application inconnue.', 404); const scan = latestScan(); if (!scan?.findings?.some((x) => x.key === key)) throw bad('Indice inconnu : relancez une détection.', 404); return update(id, { detectedKeys: [...new Set([...cur.detectedKeys, key])] }); };

  // Relevés de détection/mesure.
  const purgeExpired = () => run('DELETE FROM shop_app_scans WHERE at <= ?', new Date(Date.parse(now()) - SCAN_RETENTION_MS).toISOString());
  const saveScan = (scan) => { const text = JSON.stringify(scan); if (hasSecretShape(text)) throw bad('Un secret semble présent dans le relevé : refusé.', 500); const id = randomUUID(); run('INSERT INTO shop_app_scans (id, at, payload) VALUES (?, ?, ?)', id, scan.at ?? now(), text); run('DELETE FROM shop_app_scans WHERE id NOT IN (SELECT id FROM shop_app_scans ORDER BY at DESC, rowid DESC LIMIT 5)'); return { id, ...scan }; };
  const latestScan = () => { const r = get('SELECT id, payload FROM shop_app_scans ORDER BY at DESC, rowid DESC LIMIT 1'); return r ? { id: r.id, ...json(r.payload, {}) } : null; };
  const revision = () => get("SELECT value FROM shop_apps_meta WHERE key = 'revision'")?.value ?? null;
  const setting = (k, d = null) => json(get('SELECT value FROM shop_apps_meta WHERE key = ?', `s:${k}`)?.value, d);
  const setSetting = (k, v) => run('INSERT INTO shop_apps_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `s:${k}`, JSON.stringify(v));
  purgeExpired();
  return { list, byId, count, add, update, remove, clearAll, importRows, promote, link, saveScan, latestScan, purgeExpired, revision, setting, setSetting, now };
}
