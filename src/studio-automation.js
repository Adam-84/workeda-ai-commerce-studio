import { randomUUID } from 'node:crypto';
import { condition, error, hash, LIMITS, validateDefinition, EVENTS } from './automation-core.js';
import { nextSlots } from './automation-schedule.js';

const CLOSED = ['done', 'skipped', 'blocked', 'failed', 'expired', 'uncertain', 'cancelled'];
export function createAutomationStore(db, { clock = () => new Date().toISOString(), identity = null, validateAgent = () => false, backup = () => null, cancelTask = () => true, aiAvailable = () => true } = {}) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const sql = (query, ...args) => db.prepare(query).run(...args);
  const tx = (fn) => { if (db.isTransaction) return fn(); db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const exists = get("SELECT 1 FROM sqlite_master WHERE name='automation_meta'");
  if (!exists) {
    backup('avant-automation-v1');
    tx(() => db.exec(`
      CREATE TABLE automation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO automation_meta VALUES ('schema_version','1'), ('paused','false'), ('aiPaused','false');
      CREATE TABLE automation_rules (id TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, consent TEXT NOT NULL DEFAULT '{}', next_at TEXT, activated_at TEXT);
      CREATE TABLE automation_runs (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, revision INTEGER NOT NULL, occurrence_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at TEXT NOT NULL, due_at TEXT NOT NULL, worker TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, task_id TEXT, mission_id TEXT, data_hash TEXT, note TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, ai_day TEXT, ai_reserved INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX automation_runs_ready ON automation_runs(state,created_at);
      CREATE TABLE automation_history (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TABLE automation_observations (source TEXT NOT NULL, subject TEXT NOT NULL, revision TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(source,subject));
      CREATE TABLE automation_edges (rule_id TEXT NOT NULL, subject TEXT NOT NULL, matched INTEGER NOT NULL, last_at TEXT, PRIMARY KEY(rule_id,subject));
      CREATE TABLE automation_values (rule_id TEXT NOT NULL, subject TEXT NOT NULL, at TEXT NOT NULL, value REAL NOT NULL, currency TEXT NOT NULL, PRIMARY KEY(rule_id,subject));
      CREATE TABLE automation_events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL);
    `));
  }
  const meta = (key) => get('SELECT value FROM automation_meta WHERE key=?', key)?.value;
  const setMeta = (key, value) => sql('INSERT INTO automation_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  const owner = () => Boolean(identity && meta('owner') === identity);
  const checkOwner = () => { if (!owner()) throw error('Confirmez cet ordinateur comme exécutant.', 409); if (meta('paused') === 'true') throw error('Automatisations suspendues.', 409); };
  const map = (r) => r && ({ ...JSON.parse(r.definition), enabled: Boolean(r.enabled), consent: JSON.parse(r.consent), nextAt: r.next_at, activatedAt: r.activated_at });
  const rule = (id) => map(get('SELECT * FROM automation_rules WHERE id=?', id)) ?? (() => { throw error('Automatisation introuvable.', 404); })();
  const run = (id) => get('SELECT * FROM automation_runs WHERE id=?', id) ?? (() => { throw error('Exécution introuvable.', 404); })();
  const history = ({ ruleId, offset = 0, limit = 50 } = {}) => all(`SELECT * FROM automation_runs ${ruleId ? 'WHERE rule_id=?' : ''} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`, ...(ruleId ? [ruleId] : []), Math.min(100, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
  const finish = (id, state, note = '') => {
    if (![...CLOSED, 'queued', 'collecting', 'evaluating', 'awaiting_approval', 'waiting_ai', 'dispatched'].includes(state)) throw error('État invalide.');
    const safe = String(note).slice(0, 500);
    sql('UPDATE automation_runs SET state=?,note=?,worker=NULL,lease_until=NULL WHERE id=?', state, safe, id);
    sql('INSERT INTO automation_history(run_id,at,state,note) VALUES(?,?,?,?)', id, clock(), state, safe);
    return run(id);
  };
  const cancelPending = (id = null) => {
    for (const r of all(`SELECT id,task_id FROM automation_runs WHERE state IN ('queued','collecting','evaluating','waiting_ai','awaiting_approval','dispatched') ${id ? 'AND rule_id=?' : ''}`, ...(id ? [id] : []))) { if (r.task_id && !cancelTask(r.task_id)) continue; finish(r.id, 'cancelled', 'Désactivation ou suspension'); }
  };
  const list = () => all('SELECT * FROM automation_rules ORDER BY rowid').map(map);
  const save = (input, { importing = false } = {}) => tx(() => {
    const d = validateDefinition(input), old = get('SELECT * FROM automation_rules WHERE id=?', d.id);
    if (!validateAgent(d.agentSlug)) throw error('Agent désactivé ou sans fiche.', 409);
    if (!old && list().length >= LIMITS.maxRules) throw error('Maximum 100 automatisations.', 409);
    if (old && !importing && input.revision !== JSON.parse(old.definition).revision) throw error('La définition a changé. Rechargez-la.', 409);
    if (old) {
      const previous = JSON.parse(old.definition);
      if (hash({ ...previous, revision: 1 }) === hash(d)) return map(old);
      d.revision = previous.revision + 1;
      cancelPending(d.id);
    }
    sql("INSERT INTO automation_rules(id,definition) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,enabled=0,consent='{}',next_at=NULL,activated_at=NULL", d.id, JSON.stringify(d));
    return rule(d.id);
  });
  const enqueue = (d, key, manual = false) => {
    const id = randomUUID(), at = clock();
    sql("INSERT OR IGNORE INTO automation_runs(id,rule_id,revision,occurrence_key,state,created_at,due_at,manual) VALUES(?,?,?,?,'queued',?,?,?)", id, d.id, d.revision, key, at, new Date(Date.parse(at) + LIMITS.ttlMs).toISOString(), Number(manual));
    return get('SELECT * FROM automation_runs WHERE occurrence_key=?', key);
  };
  const activate = (id, consent = {}) => tx(() => {
    checkOwner(); const d = rule(id);
    if (consent.confirm !== true) throw error('Confirmation explicite requise.');
    if (!validateAgent(d.agentSlug)) throw error('Agent indisponible.', 409);
    if (d.allowAi && consent.ai !== true) throw error('Autorisation IA explicite requise.');
    const collect = Array.isArray(consent.collect) ? consent.collect.filter((s) => d.sources.includes(s) && ['catalog', 'shopify_admin', 'track17'].includes(s)) : [];
    sql('UPDATE automation_rules SET enabled=1,consent=?,activated_at=?,next_at=? WHERE id=?', JSON.stringify({ ai: consent.ai === true, collect }), clock(), d.trigger.kind === 'time' ? nextSlots(d.trigger.schedule, clock(), 1)[0] ?? null : null, id);
    return rule(id);
  });
  const scheduleDue = () => tx(() => {
    if (!owner() || meta('paused') === 'true') return;
    for (const d of list().filter((d) => d.enabled && d.nextAt && d.nextAt <= clock())) {
      const floor = Math.max(Date.parse(d.nextAt) - 1, Date.parse(clock()) - LIMITS.ttlMs);
      let cursor = new Date(floor).toISOString(), latest = null;
      for (let i = 0; i < 100; i++) { const slot = nextSlots(d.trigger.schedule, cursor, 1)[0]; if (!slot || slot > clock()) break; latest = slot; cursor = slot; }
      if (latest) enqueue(d, `${d.id}:${d.revision}:time:${latest}`);
      else { const r = enqueue(d, `${d.id}:${d.revision}:time:${d.nextAt}`); finish(r.id, 'skipped', 'Créneau trop ancien ; aucun rattrapage en rafale.'); }
      sql('UPDATE automation_rules SET next_at=? WHERE id=?', nextSlots(d.trigger.schedule, clock(), 1)[0] ?? null, d.id);
    }
  });
  const allowed = (r) => { const d = rule(r.rule_id); return owner() && meta('paused') !== 'true' && d.revision === r.revision && (d.enabled || Boolean(r.manual)) && validateAgent(d.agentSlug); };
  const claim = (worker) => tx(() => {
    if (!owner() || meta('paused') === 'true') return null;
    const at = clock();
    for (const r of all("SELECT * FROM automation_runs WHERE state IN ('collecting','evaluating') AND lease_until<=?", at)) finish(r.id, r.attempts < 2 ? 'queued' : 'failed', 'Bail interrompu');
    for (const r of all("SELECT id FROM automation_runs WHERE state IN ('queued','waiting_ai','awaiting_approval') AND due_at<=?", at)) finish(r.id, 'expired', 'Échéance dépassée');
    if (get("SELECT id FROM automation_runs WHERE state IN ('collecting','evaluating') AND lease_until>?", at)) return null;
    const r = get("SELECT * FROM automation_runs WHERE state='queued' ORDER BY created_at,rowid LIMIT 1");
    if (!r) return null;
    if (!allowed(r)) { finish(r.id, 'cancelled', 'Règle ou agent indisponible'); return null; }
    sql("UPDATE automation_runs SET state='collecting',worker=?,lease_until=?,attempts=attempts+1 WHERE id=? AND state='queued'", worker, new Date(Date.parse(at) + LIMITS.leaseMs).toISOString(), r.id);
    return run(r.id);
  });
  const observe = ({ source, subject, revision, event, fetchedAt, partial = false }) => tx(() => {
    if (partial || event != null && !EVENTS.includes(event) || typeof revision !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) return null;
    const old = get('SELECT * FROM automation_observations WHERE source=? AND subject=?', source, subject);
    if (old && old.at > fetchedAt) return null;
    sql('INSERT INTO automation_observations VALUES(?,?,?,?) ON CONFLICT(source,subject) DO UPDATE SET revision=excluded.revision,at=excluded.at', source, subject, revision, fetchedAt);
    if (!old || old.revision === revision || event == null) return null;
    const id = hash({ source, subject, event, at: fetchedAt });
    sql('INSERT OR IGNORE INTO automation_events(id,source,subject,kind,at) VALUES(?,?,?,?,?)', id, source, subject, event, fetchedAt);
    for (const d of list().filter((d) => d.enabled && d.trigger.kind === 'event' && d.trigger.event === event && d.sources.includes(source) && d.activatedAt < fetchedAt)) {
      const edge = get('SELECT last_at FROM automation_edges WHERE rule_id=? AND subject=?', d.id, subject);
      if (edge?.last_at && Date.parse(fetchedAt) - Date.parse(edge.last_at) < d.cooldownMinutes * 60000) continue;
      if (owner() && meta('paused') !== 'true') enqueue(d, `${d.id}:${d.revision}:event:${id}`);
      sql('INSERT INTO automation_edges VALUES(?,?,1,?) ON CONFLICT(rule_id,subject) DO UPDATE SET last_at=excluded.last_at', d.id, subject, fetchedAt);
    }
    return id;
  });
  const evaluateCondition = (d, subject, data) => tx(() => {
    const result = condition(d.trigger.condition, data, Date.parse(clock()));
    if (!result.available || !owner() || meta('paused') === 'true' || !d.enabled) return result;
    const old = get('SELECT * FROM automation_edges WHERE rule_id=? AND subject=?', d.id, subject);
    const fire = result.matched && !old?.matched && (!old?.last_at || Date.parse(clock()) - Date.parse(old.last_at) >= d.cooldownMinutes * 60000);
    if (fire) enqueue(d, `${d.id}:${d.revision}:condition:${subject}:${clock()}`);
    sql('INSERT INTO automation_edges VALUES(?,?,?,?) ON CONFLICT(rule_id,subject) DO UPDATE SET matched=excluded.matched,last_at=excluded.last_at', d.id, subject, Number(result.matched), fire ? clock() : old?.last_at ?? null);
    return result;
  });
  return {
    tx, list, rule, run, save, activate, history, finish, claim, allowed, observe, evaluateCondition, scheduleDue,
    evaluatePrice(d, subject, { value, currency, fetchedAt }) { return tx(() => { if (!Number.isFinite(value) || value < 0 || !/^[A-Z]{3}$/.test(currency ?? '') || !Number.isFinite(Date.parse(fetchedAt))) return; const old = get('SELECT * FROM automation_values WHERE rule_id=? AND subject=?', d.id, subject); if (old && old.at >= fetchedAt) return; sql('INSERT INTO automation_values VALUES(?,?,?,?,?) ON CONFLICT(rule_id,subject) DO UPDATE SET at=excluded.at,value=excluded.value,currency=excluded.currency', d.id, subject, fetchedAt, value, currency); if (old && old.currency === currency && Date.parse(fetchedAt) - Date.parse(old.at) <= Math.min(7 * 86400000, d.freshnessMinutes * 60000)) return evaluateCondition(d, subject, { before: old.value, after: value }); }); },
    status: () => ({ schemaVersion: 1, owner: owner(), paused: meta('paused') === 'true', aiPaused: meta('aiPaused') === 'true', limits: LIMITS, note: 'Un seul PC désigné, serveur ouvert ; aucun verrou mondial hors ligne.' }),
    designate({ confirm } = {}) { if (confirm !== true || !identity) throw error('Confirmation de cet ordinateur requise.'); if (meta('owner') !== identity) { cancelPending(); sql("UPDATE automation_rules SET enabled=0,consent='{}',next_at=NULL"); } setMeta('owner', identity); return this.status(); },
    disable(id) { rule(id); sql("UPDATE automation_rules SET enabled=0,next_at=NULL,consent='{}' WHERE id=?", id); cancelPending(id); return rule(id); },
    pause(value) { setMeta('paused', value === true); if (value) cancelPending(); return this.status(); },
    pauseAi(value) { setMeta('aiPaused', value === true); if (!value) sql("UPDATE automation_runs SET state='queued' WHERE state='waiting_ai' AND due_at>?", clock()); return this.status(); },
    manual(id, { confirm, ai } = {}) { checkOwner(); if (confirm !== true) throw error('Confirmation du lancement unique requise.'); const d = rule(id); if (!validateAgent(d.agentSlug)) throw error('Agent indisponible.', 409); if (d.allowAi && !d.consent.ai && ai !== true) throw error('Autorisation IA explicite requise.'); return enqueue(d, `${id}:${d.revision}:manual:${randomUUID()}`, true); },
    exportDefinitions: () => list().map(({ enabled, consent, nextAt, activatedAt, ...d }) => d),
    importDefinitions(defs) { if (!Array.isArray(defs) || defs.length > 100 || JSON.stringify(defs).length > 200000) throw error('Import borné à 100 définitions / 200 ko.'); return tx(() => defs.map((d) => { const r = save(d, { importing: true }); this.disable(r.id); return rule(r.id); })); },
    owns(id, worker) { const r = run(id); return r.worker === worker && r.lease_until > clock() && ['collecting','evaluating'].includes(r.state); },
    renew(id, worker) { const changed = sql("UPDATE automation_runs SET lease_until=? WHERE id=? AND worker=? AND state IN ('collecting','evaluating')", new Date(Date.parse(clock()) + LIMITS.leaseMs).toISOString(), id, worker); return Boolean(changed.changes); },
    reserveAi(id) { return tx(() => { const r = run(id), d = rule(r.rule_id); if (!allowed(r) || !d.allowAi || (!d.consent.ai && !r.manual) || meta('aiPaused') === 'true' || !aiAvailable(d.agentSlug)) return false; if (r.ai_reserved) return false;
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock()));
      const global = get('SELECT count(*) AS n FROM automation_runs WHERE ai_day=? AND ai_reserved=1', day).n;
      const used = get('SELECT count(*) AS n FROM automation_runs WHERE ai_day=? AND ai_reserved=1 AND rule_id=?', day, d.id).n;
      if (global >= 20 || used >= d.perDay || get("SELECT id FROM automation_runs WHERE state='dispatched' AND id<>?", id)) return false;
      const hasRuns = get("SELECT 1 FROM sqlite_master WHERE name='comm_runs'");
      if (hasRuns) { const previous = all('SELECT c.cost_usd,c.input_tokens,c.output_tokens FROM comm_runs c JOIN automation_runs r ON r.task_id=c.task_id WHERE r.ai_day=? AND r.rule_id=?', day, d.id); if (previous.some((p) => p.cost_usd == null || p.input_tokens == null || p.output_tokens == null) || previous.reduce((n,p) => n+p.cost_usd,0) >= d.budgetUsd || previous.reduce((n,p) => n+p.input_tokens+p.output_tokens,0) >= d.tokenBudget) return false; }
      sql('UPDATE automation_runs SET ai_day=?,ai_reserved=1 WHERE id=?', day, id); return true;
    }); },
    link(id, taskId, dataHash) { sql('UPDATE automation_runs SET task_id=?,data_hash=? WHERE id=?', taskId, dataHash, id); return finish(id, 'dispatched', 'Mission Comms créée'); },
    forTask(taskId) { return get('SELECT * FROM automation_runs WHERE task_id=?', taskId) ?? null; },
    running() { return all("SELECT * FROM automation_runs WHERE state IN ('dispatched','awaiting_approval') AND task_id IS NOT NULL"); },
    linkMission(id, missionId) { sql('UPDATE automation_runs SET mission_id=? WHERE id=?', missionId, id); },
    isAutomationMission(missionId) { return Boolean(get('SELECT id FROM automation_runs WHERE mission_id=? OR task_id IN (SELECT id FROM comm_tasks WHERE mission_id=?)', missionId, missionId)); },
    observeNewRecommendation(m) { const at = m.updatedAt ?? m.createdAt; if (!Number.isFinite(Date.parse(at))) return; const subject = m.id; const old = get("SELECT revision FROM automation_observations WHERE source='recommendations' AND subject=?", subject); if (old) return; sql("INSERT INTO automation_observations VALUES('recommendations',?,'pending',?)", subject, at); this.recordEvent({ source: 'recommendations', subject, event: 'recommendation.pending', at }); },
    recordEvent({ source, subject, event, at = clock() }) { if (!EVENTS.includes(event)) return; const id = hash({ source, subject, event, at }); sql('INSERT OR IGNORE INTO automation_events(id,source,subject,kind,at) VALUES(?,?,?,?,?)', id, source, subject, event, at); if (!owner() || meta('paused') === 'true') return; for (const d of list().filter((d) => d.enabled && d.sources.includes(source) && d.trigger.kind === 'event' && d.trigger.event === event && d.activatedAt < at)) enqueue(d, `${d.id}:${d.revision}:event:${id}`); },
    transitions(id) { return all('SELECT * FROM automation_history WHERE run_id=? ORDER BY seq', id); },
    purge() { const before = new Date(Date.parse(clock()) - 90 * 86400000).toISOString(); sql('DELETE FROM automation_history WHERE at<?', before); sql('DELETE FROM automation_events WHERE at<?', before); sql('DELETE FROM automation_values WHERE at<?', new Date(Date.parse(clock()) - 7 * 86400000).toISOString()); sql("UPDATE automation_runs SET task_id=NULL,mission_id=NULL,data_hash=NULL,note='Historique purgé ; clé de déduplication conservée' WHERE created_at<? AND state IN ('done','skipped','blocked','failed','expired','uncertain','cancelled')", before); /* occurrence keys deliberately retained, without source payloads */ }
  };
}
