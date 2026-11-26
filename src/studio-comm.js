// src/studio-comm.js — fils, messages, délégations (sous-missions), résultats et exécutions des agents.
// Ajoute des tables seulement (aucune table existante n'est modifiée ; chaque tâche est aussi une ligne de `missions`).
// Invariants garantis ici, pas dans l'interface :
//   - un message d'agent n'existe que rattaché à une exécution réelle (comm_runs) de cet agent ;
//   - une tâche n'est « terminée » que si un résultat vérifié est enregistré ;
//   - profondeur, nombre de tâches, cycles, doublons et messages automatiques sont bornés.
// Synchronisation entre ordinateurs : journal comm/journal/<appareil>.jsonl (versionné dans git). Les agents y sont désignés
// par leur fiche (slug), jamais par leur identifiant local. Un import ne lance jamais rien : il ne fait que recopier des données.
import { scrubContacts, scrubContactData } from './catalog-privacy.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  THREAD_KINDS, MESSAGE_KINDS, DELIVERY_STATES, TASK_STATES, TASK_KINDS, TASK_TRANSITIONS, OPEN_STATES, MISSION_STATE, LIMITS, WEB_TOOLS,
  bad, ID_RE, isoOf, clean, assertNoSecret, normalizeRefs, fingerprint, parseJsonList, normUrl
} from './comm-core.js';
import { findSecret } from './memory-core.js';
import { INTEGRATION_IDS } from './integrations-core.js';

export const COMM_MIGRATIONS = [{
  version: 1,
  name: 'communication entre agents : fils, messages, tâches, résultats, exécutions, import du journal',
  up: `
    CREATE TABLE IF NOT EXISTS comm_threads (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, mission_id TEXT, department TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE IF NOT EXISTS comm_thread_members (thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (thread_id, agent_id));
    CREATE TABLE IF NOT EXISTS comm_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_agent_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]', task_id TEXT, run_id TEXT, reply_to TEXT, event_id TEXT, device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS comm_messages_thread_time ON comm_messages(thread_id, created_at, id);
    CREATE TABLE IF NOT EXISTS comm_deliveries (message_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (message_id, agent_id));
    CREATE TABLE IF NOT EXISTS comm_tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, root_task_id TEXT NOT NULL, parent_task_id TEXT, thread_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL, requested_by TEXT NOT NULL, assignee_id TEXT NOT NULL, depth INTEGER NOT NULL, state TEXT NOT NULL, state_note TEXT NOT NULL DEFAULT '', depends_on TEXT NOT NULL DEFAULT '[]', allow_web INTEGER NOT NULL DEFAULT 0, requires_sources INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT NOT NULL, due_at TEXT NOT NULL, not_before TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS comm_tasks_state ON comm_tasks(state);
    CREATE INDEX IF NOT EXISTS comm_tasks_root ON comm_tasks(root_task_id);
    CREATE INDEX IF NOT EXISTS comm_tasks_mission ON comm_tasks(mission_id);
    CREATE TABLE IF NOT EXISTS comm_results (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, run_id TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', observed TEXT NOT NULL DEFAULT '{}', verified INTEGER NOT NULL, level TEXT NOT NULL, verification TEXT NOT NULL, verified_by TEXT NOT NULL DEFAULT 'systeme', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS comm_results_task ON comm_results(task_id, created_at);
    CREATE TABLE IF NOT EXISTS comm_runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, thread_id TEXT, model TEXT, web INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, error TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, device TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS comm_runs_state ON comm_runs(state, started_at);
    CREATE TABLE IF NOT EXISTS comm_versions (kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, rev INTEGER NOT NULL, device TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE TABLE IF NOT EXISTS comm_imported (eid TEXT PRIMARY KEY, imported_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // Retour arrière : supprime uniquement les tables de la communication (une sauvegarde est faite avant). Les missions restent.
  down: `
    DROP TABLE IF EXISTS comm_meta; DROP TABLE IF EXISTS comm_imported; DROP TABLE IF EXISTS comm_versions; DROP TABLE IF EXISTS comm_runs;
    DROP TABLE IF EXISTS comm_results; DROP TABLE IF EXISTS comm_tasks; DROP TABLE IF EXISTS comm_deliveries; DROP TABLE IF EXISTS comm_messages;
    DROP TABLE IF EXISTS comm_thread_members; DROP TABLE IF EXISTS comm_threads;
  `
}, {
  version: 2,
  name: 'catalogue Shopify en lecture seule et budget par mission',
  // with_catalog : le propriétaire a demandé que le catalogue (relevé en lecture seule par le Studio) soit fourni à la tâche.
  // budget_usd : plafond de coût rapporté pour une demande racine (NULL pour les sous-tâches, qui comptent dans celui de leur racine).
  up: `ALTER TABLE comm_tasks ADD COLUMN with_catalog INTEGER NOT NULL DEFAULT 0; ALTER TABLE comm_tasks ADD COLUMN budget_usd REAL;`,
  down: `ALTER TABLE comm_tasks DROP COLUMN with_catalog; ALTER TABLE comm_tasks DROP COLUMN budget_usd;`
}, {
  version: 3,
  name: 'intégrations en lecture seule (DSers, 17TRACK) demandées par tâche',
  // with_integrations : liste (JSON) des intégrations que le propriétaire demande de fournir à la tâche. Aucune donnée ici : l'accès réel
  // est vérifié à l'exécution contre les accès accordés à l'agent (jamais par défaut), et les données viennent du cache local.
  up: `ALTER TABLE comm_tasks ADD COLUMN with_integrations TEXT NOT NULL DEFAULT '[]';`,
  down: `ALTER TABLE comm_tasks DROP COLUMN with_integrations;`
}, {
  version: 4,
  name: 'origine locale Automation et idempotence de dispatch',
  up: `ALTER TABLE comm_tasks ADD COLUMN automation_key TEXT; ALTER TABLE comm_tasks ADD COLUMN automation_lease TEXT; CREATE UNIQUE INDEX comm_tasks_automation_key ON comm_tasks(automation_key);`,
  down: `DROP INDEX comm_tasks_automation_key; ALTER TABLE comm_tasks DROP COLUMN automation_key; ALTER TABLE comm_tasks DROP COLUMN automation_lease;`
}];
export const COMM_SCHEMA_VERSION = COMM_MIGRATIONS.at(-1).version;

const MAX_EVENT_BYTES = 96_000;
const MAX_FUTURE_MS = 24 * 3_600_000;
const DEVICE_RE = /^[a-z0-9_-]{1,32}$/i;
const cmpVersion = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rev - b.rev || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
const notFound = (what) => bad(`${what} introuvable.`, 404);
const short = (s, n) => { s = scrubContacts(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function createCommStore(db, { journalDir = null, device = 'inconnu', memory = null, missions, emit = () => null, backup = () => null, clock = () => new Date().toISOString(), readOnly = false } = {}) {
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  let held = null; // écritures du journal retenues jusqu'à la validation de la transaction ouverte ici
  const tx = (fn) => {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE'); held = [];
    let r;
    try { r = fn(); db.exec('COMMIT'); } catch (e) { held = null; if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
    const ready = held; held = null; for (const [kind, key] of ready) publish(kind, key);
    return r;
  };
  const now = () => clock();
  let journalError = null;
  let automationGate = () => false;
  let automationInterrupted = () => {};

  // --- schéma (numéroté, réversible) -----------------------------------------------------------------------------------------------
  const hasTable = (name) => Boolean(get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", name));
  const meta = (key) => { if (!hasTable('comm_meta')) return null; return get('SELECT value FROM comm_meta WHERE key = ?', key)?.value ?? null; };
  const setMeta = (key, value) => run('INSERT INTO comm_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const schemaVersion = () => Number(meta('schema_version') ?? 0);
  const migrate = () => {
    const current = schemaVersion(), todo = COMM_MIGRATIONS.filter((m) => m.version > current);
    if (!todo.length) return { from: current, to: current, backup: null };
    const saved = current > 0 || get('SELECT COUNT(*) AS n FROM agents').n > 0 ? backup(`avant-communication-v${todo[0].version}`) : null;
    tx(() => { for (const m of todo) { db.exec(m.up); setMeta('schema_version', m.version); } });
    return { from: current, to: schemaVersion(), backup: saved };
  };
  const rollback = (target = 0) => {
    const current = schemaVersion();
    if (!Number.isInteger(target) || target < 0 || target >= current) throw bad('Version cible invalide.');
    const saved = backup(`avant-retour-communication-v${target}`);
    tx(() => { for (const m of [...COMM_MIGRATIONS].reverse()) if (m.version > target && m.version <= current) { db.exec(m.down); } if (target > 0) setMeta('schema_version', target); });
    return { from: current, to: target, backup: saved };
  };
  if (!readOnly) db.exec('CREATE TABLE IF NOT EXISTS comm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const lastMigration = readOnly ? { from: schemaVersion(), to: schemaVersion(), backup: null } : migrate();

  // --- agents (identité portable = fiche) -------------------------------------------------------------------------------------------------
  const agentRow = (id) => get('SELECT a.id, a.name, a.role, a.enabled, a.status, d.name AS department, f.slug FROM agents a JOIN departments d ON d.id = a.department_id LEFT JOIN agent_files f ON f.agent_id = a.id WHERE a.id = ?', id);
  const slugOf = (id) => get('SELECT slug FROM agent_files WHERE agent_id = ?', id)?.slug ?? null;
  const agentOfSlug = (slug) => get('SELECT agent_id FROM agent_files WHERE slug = ?', slug)?.agent_id ?? null;
  const nameOf = (id) => agentRow(id)?.name ?? 'Agent';
  // Un agent « véritable » = recruté, actif et relié à sa fiche .claude/agents (c'est elle qui lui donne métier, outils et droits).
  const realAgent = (id, label = 'Agent') => {
    const a = typeof id === 'string' ? agentRow(id) : null;
    if (!a) throw bad(`${label} introuvable.`, 404);
    if (!a.slug) throw bad(`${a.name} n'a pas de fiche dans .claude/agents : il ne peut pas communiquer.`, 409);
    if (!a.enabled) throw bad(`${a.name} est désactivé : indisponible.`, 409, { unavailable: true });
    return a;
  };
  const available = (id) => { const a = agentRow(id); return Boolean(a?.slug && a.enabled); };

  // --- journal ----------------------------------------------------------------------------------------------------------------------------------
  const outbox = () => { const v = parseJsonList(meta('outbox'), []); return v.filter((x) => typeof x === 'string'); };
  const setOutbox = (v) => setMeta('outbox', JSON.stringify([...new Set(v)]));
  // Un résultat ou un message issu de données DSers/17TRACK reste LOCAL : le journal (versionné dans git) n'en emporte que l'existence.
  const LOCAL_ONLY = '[Contenu local non synchronisé : issu de données DSers/17TRACK.]';
  const redactFor = (taskId, text) => (taskId && parseJsonList(get('SELECT with_integrations FROM comm_tasks WHERE id = ?', taskId)?.with_integrations).length ? LOCAL_ONLY : text);
  // Une instruction déléguée PAR UN AGENT à partir de données DSers/17TRACK peut en contenir : elle reste locale aussi.
  const redactAgentAsk = (taskId, text) => { const t = taskId && get('SELECT requested_by, with_integrations FROM comm_tasks WHERE id = ?', taskId); return t && t.requested_by !== 'user' && parseJsonList(t.with_integrations).length ? LOCAL_ONLY : text; };
  const jsonObserved = (text) => { try { return JSON.parse(text); } catch { return {}; } };
  const portable = {
    thread: (id) => { const t = get('SELECT * FROM comm_threads WHERE id = ?', id); return t && { id: t.id, kind: t.kind, title: t.title, missionId: t.mission_id, department: t.department, createdBy: t.created_by === 'user' ? 'user' : slugOf(t.created_by), createdAt: t.created_at, closedAt: t.closed_at, members: all('SELECT agent_id FROM comm_thread_members WHERE thread_id = ? ORDER BY rowid', id).map((m) => slugOf(m.agent_id)).filter(Boolean) }; },
    message: (id) => { const m = get('SELECT * FROM comm_messages WHERE id = ?', id); return m && { id: m.id, threadId: m.thread_id, senderType: m.sender_type, sender: m.sender_agent_id ? slugOf(m.sender_agent_id) : null, kind: m.kind, body: m.kind === 'delegation' ? redactAgentAsk(m.task_id, m.body) : redactFor(m.task_id, m.body), refs: parseJsonList(m.refs).map((r) => (r && typeof r === 'object' && r.label && redactFor(m.task_id, 'x') === LOCAL_ONLY ? { ...r, label: LOCAL_ONLY } : r)), taskId: m.task_id, runId: m.run_id, replyTo: m.reply_to, createdAt: m.created_at, device: m.device }; },
    // La clé d'un accusé porte la FICHE de l'agent (jamais son identifiant local, qui diffère d'un ordinateur à l'autre).
    delivery: (key) => { const [mid, slug] = key.split('|'), aid = agentOfSlug(slug); const d = aid && get('SELECT * FROM comm_deliveries WHERE message_id = ? AND agent_id = ?', mid, aid); return d && { messageId: mid, agent: slug, status: d.status, detail: redactFor(get('SELECT task_id FROM comm_messages WHERE id = ?', mid)?.task_id, d.detail), updatedAt: d.updated_at }; },
    task: (id) => {
      const t = get('SELECT * FROM comm_tasks WHERE id = ?', id); if (!t) return null;
      const m = get('SELECT * FROM missions WHERE id = ?', t.mission_id);
      return { id: t.id, automationKey: t.automation_key ?? null, missionId: t.mission_id, rootTaskId: t.root_task_id, parentTaskId: t.parent_task_id, threadId: t.thread_id, kind: t.kind, title: redactAgentAsk(t.id, t.title), instruction: redactAgentAsk(t.id, t.instruction), requestedBy: t.requested_by === 'user' ? 'user' : slugOf(t.requested_by), assignee: slugOf(t.assignee_id), depth: t.depth, state: t.state, stateNote: t.state_note ? redactFor(t.id, t.state_note) : t.state_note, dependsOn: parseJsonList(t.depends_on), allowWeb: Boolean(t.allow_web), requiresSources: Boolean(t.requires_sources), withCatalog: Boolean(t.with_catalog), withIntegrations: parseJsonList(t.with_integrations), budgetUsd: t.budget_usd ?? null, dedupeKey: t.dedupe_key, dueAt: t.due_at, notBefore: t.not_before, attempts: t.attempts, maxAttempts: t.max_attempts, device: t.device, createdAt: t.created_at, updatedAt: t.updated_at, startedAt: t.started_at, finishedAt: t.finished_at,
        mission: m && { id: m.id, title: redactAgentAsk(t.id, m.title), objective: redactAgentAsk(t.id, m.objective), expectedResult: redactAgentAsk(t.id, m.expected_result), contextText: redactAgentAsk(t.id, m.context_text), priority: m.priority, requiresApproval: Boolean(m.requires_approval), requestedBy: m.requested_by ? slugOf(m.requested_by) : null, assignedTo: m.assigned_to ? slugOf(m.assigned_to) : null, createdAt: m.created_at } };
    },
    result: (id) => { const r = get('SELECT * FROM comm_results WHERE id = ?', id); return r && { id: r.id, taskId: r.task_id, agent: slugOf(r.agent_id), runId: r.run_id, summary: redactFor(r.task_id, r.summary), body: redactFor(r.task_id, r.body), sources: redactFor(r.task_id, 'x') === LOCAL_ONLY ? [] : parseJsonList(r.sources), observed: redactFor(r.task_id, 'x') === LOCAL_ONLY ? {} : jsonObserved(r.observed), verified: Boolean(r.verified), level: r.level, verification: redactFor(r.task_id, r.verification), verifiedBy: r.verified_by, createdAt: r.created_at }; },
    run: (id) => { const r = get('SELECT * FROM comm_runs WHERE id = ?', id); return r && { id: r.id, agent: slugOf(r.agent_id), kind: r.kind, taskId: r.task_id, threadId: r.thread_id, model: r.model, web: Boolean(r.web), state: r.state, error: r.error ? redactFor(r.task_id, r.error) : null, costUsd: r.cost_usd, inputTokens: r.input_tokens, outputTokens: r.output_tokens, durationMs: r.duration_ms, device: r.device, startedAt: r.started_at, finishedAt: r.finished_at }; }
  };
  const bump = (kind, key) => { const prev = get('SELECT rev FROM comm_versions WHERE kind = ? AND key = ?', kind, key); const rev = (prev?.rev ?? 0) + 1, at = now(); run('INSERT INTO comm_versions (kind, key, at, rev, device) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET at = excluded.at, rev = excluded.rev, device = excluded.device', kind, key, at, rev, device); return { at, rev }; };
  const lineOf = (e) => `${JSON.stringify({ ...e, data: scrubContactData(e.data) })}\n`;
  const append = (e) => {
    mkdirSync(journalDir, { recursive: true });
    const line = lineOf(e);
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error('événement trop volumineux');
    appendFileSync(join(journalDir, `${device}.jsonl`), line);
    run('INSERT OR IGNORE INTO comm_imported (eid, imported_at) VALUES (?, ?)', e.eid, now());
  };
  const eventFor = (kind, key) => { const v = get('SELECT * FROM comm_versions WHERE kind = ? AND key = ?', kind, key); const data = portable[kind]?.(key); return data ? { v: 1, eid: randomUUID(), device, at: v?.at ?? now(), kind, key, rev: v?.rev ?? 1, data } : null; };
  // Refuse à l'écriture ce que l'autre ordinateur ignorerait (trop gros) : l'enregistrement n'a pas lieu.
  const assertFits = (kind, key) => { const e = eventFor(kind, key); if (e && Buffer.byteLength(lineOf(e)) > MAX_EVENT_BYTES) throw bad('Ce contenu est trop volumineux pour être synchronisé entre ordinateurs.'); };
  const flushOutbox = () => {
    if (!journalDir || readOnly) return;
    const left = [];
    for (const tag of outbox()) {
      const [kind, ...rest] = tag.split('#'); const e = eventFor(kind, rest.join('#'));
      if (!e) continue;
      try { append(e); } catch (err) { left.push(tag); journalError = `Journal non écrit : ${err.message}`; }
    }
    setOutbox(left); if (!left.length) journalError = null;
  };
  // Appelé après chaque changement : la base reste la source locale, le journal est la copie qui voyage avec git.
  const journal = (kind, key) => {
    // Automated work stays local; importing a journal cannot turn it into ordinary runnable work.
    const linked = kind === 'task' ? key : kind === 'message' ? get('SELECT task_id FROM comm_messages WHERE id=?', key)?.task_id : kind === 'result' ? get('SELECT task_id FROM comm_results WHERE id=?', key)?.task_id : kind === 'run' ? get('SELECT task_id FROM comm_runs WHERE id=?', key)?.task_id : null;
    if (linked && schemaVersion() >= 4 && get('SELECT automation_key FROM comm_tasks WHERE id=?', linked)?.automation_key) return;
    bump(kind, key);
    if (held) held.push([kind, key]); else publish(kind, key);
  };
  const publish = (kind, key) => {
    if (!journalDir) return;
    const tag = `${kind}#${key}`;
    try { const e = eventFor(kind, key); if (e) append(e); journalError = null; const q = outbox(); if (q.includes(tag)) setOutbox(q.filter((x) => x !== tag)); }
    catch (err) { journalError = `Journal non écrit : ${err.message}`; try { setOutbox([...outbox(), tag]); } catch { /* base en panne : rien de plus à faire */ } return; }
    flushOutbox();
  };

  // --- fils ---------------------------------------------------------------------------------------------------------------------------------------
  const mapThread = (t) => t && { id: t.id, kind: t.kind, title: t.title, missionId: t.mission_id, department: t.department, createdBy: t.created_by, createdAt: t.created_at, closedAt: t.closed_at, members: all('SELECT agent_id FROM comm_thread_members WHERE thread_id = ? ORDER BY rowid', t.id).map((m) => m.agent_id) };
  const thread = (id) => { const t = get('SELECT * FROM comm_threads WHERE id = ?', id); if (!t) throw notFound('Fil'); return mapThread(t); };
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const createThread = (input = {}, by = { type: 'user' }) => {
    if (!THREAD_KINDS.includes(input.kind)) throw bad('Type de fil invalide.');
    let members = [...new Set(Array.isArray(input.members) ? input.members : [])];
    let department = null, missionId = null, title = clean(input.title, 'Le titre', LIMITS.title);
    if (input.kind === 'department') {
      department = clean(input.department, 'Le département', 80, { required: true });
      if (!get('SELECT 1 AS ok FROM departments WHERE name = ?', department)) throw bad('Département inconnu.', 404);
      members = all('SELECT a.id FROM agents a JOIN departments d ON d.id = a.department_id JOIN agent_files f ON f.agent_id = a.id WHERE d.name = ? AND a.enabled = 1 ORDER BY a.created_at', department).map((r) => r.id);
      title ||= `Département ${department}`;
      const existing = get("SELECT * FROM comm_threads WHERE kind = 'department' AND department = ?", department);
      if (existing) { for (const id of members) addMember(existing.id, id); return { ...mapThread(get('SELECT * FROM comm_threads WHERE id = ?', existing.id)), created: false }; }
    }
    if (input.kind === 'mission') {
      missionId = clean(input.missionId, 'La mission', 64, { required: true });
      const m = get('SELECT * FROM missions WHERE id = ?', missionId); if (!m) throw bad('Mission introuvable.', 404);
      if (!members.length) members = [m.assigned_to, ...all('SELECT agent_id FROM mission_collaborators WHERE mission_id = ?', missionId).map((r) => r.agent_id)].filter(Boolean);
      title ||= m.title;
      const existing = get("SELECT * FROM comm_threads WHERE kind = 'mission' AND mission_id = ?", missionId);
      if (existing) { for (const id of members) addMember(existing.id, id); return { ...mapThread(get('SELECT * FROM comm_threads WHERE id = ?', existing.id)), created: false }; }
    }
    if (input.kind === 'direct' && (members.length < 1 || members.length > 2)) throw bad('Un fil privé réunit un ou deux agents (en plus du propriétaire).');
    if (input.kind === 'group' && members.length < 2) throw bad('Un fil de groupe réunit au moins deux agents.');
    if (members.length > LIMITS.members) throw bad(`${LIMITS.members} participants au maximum.`);
    if (!members.length) throw bad('Aucun agent disponible pour ce fil.');
    for (const id of members) realAgent(id, 'Participant');
    if (input.kind === 'direct') {
      for (const t of all("SELECT id FROM comm_threads WHERE kind = 'direct'")) if (sameSet(all('SELECT agent_id FROM comm_thread_members WHERE thread_id = ?', t.id).map((r) => r.agent_id), members)) return { ...thread(t.id), created: false };
    }
    title ||= members.map(nameOf).join(', ');
    if (!title) throw bad('Le titre est obligatoire.');
    const id = randomUUID();
    tx(() => {
      run('INSERT INTO comm_threads (id, kind, title, mission_id, department, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.kind, title, missionId, department, by.type === 'agent' ? by.agentId : 'user', now());
      for (const m of members) run('INSERT INTO comm_thread_members (thread_id, agent_id) VALUES (?, ?)', id, m);
    });
    journal('thread', id);
    emit(null, 'comm.thread.created', `Fil « ${title} » créé.`, 'manual', true);
    return { ...thread(id), created: true };
  };
  function addMember(threadId, agentId) {
    const t = thread(threadId); realAgent(agentId, 'Participant');
    if (t.members.includes(agentId)) return t;
    if (t.members.length >= LIMITS.members) throw bad(`${LIMITS.members} participants au maximum.`);
    run('INSERT INTO comm_thread_members (thread_id, agent_id) VALUES (?, ?)', threadId, agentId);
    journal('thread', threadId);
    return thread(threadId);
  }
  const threadForMission = (missionId) => {
    const t = get("SELECT id FROM comm_threads WHERE kind = 'mission' AND mission_id = ?", missionId);
    return t ? thread(t.id) : createThread({ kind: 'mission', missionId });
  };

  // --- messages ---------------------------------------------------------------------------------------------------------------------------------------
  const aggregate = (deliveries, senderType) => {
    if (!deliveries.length) return senderType === 'system' ? 'processed' : 'sent';
    if (deliveries.some((d) => d.status === 'error')) return 'error';
    if (deliveries.every((d) => d.status === 'processed')) return 'processed';
    if (deliveries.some((d) => d.status !== 'sent')) return 'received';
    return 'sent';
  };
  // Une référence de mémoire n'est montrée que si TOUS les participants actuels du fil peuvent la lire (contrôle refait à la lecture :
  // un participant ajouté ensuite, ou un message reçu d'un autre ordinateur, ne peut pas rendre un souvenir privé visible).
  const shownRefs = (m) => {
    const refs = parseJsonList(m.refs);
    if (!refs.some((r) => r.type === 'memory')) return refs;
    const members = all('SELECT agent_id FROM comm_thread_members WHERE thread_id = ?', m.thread_id).map((x) => x.agent_id);
    return refs.map((r) => {
      if (r.type !== 'memory') return r;
      let ok = false; try { ok = Boolean(memory?.readableBy(r.id, members)); } catch { /* souvenir absent ici */ }
      return ok ? r : { type: 'masked', label: '[souvenir masqué : non lisible par tous les participants]' };
    });
  };
  const mapMessage = (m) => {
    const deliveries = all('SELECT agent_id, status, detail, updated_at FROM comm_deliveries WHERE message_id = ? ORDER BY rowid', m.id).map((d) => ({ agentId: d.agent_id, status: d.status, detail: d.detail, updatedAt: d.updated_at }));
    return { id: m.id, threadId: m.thread_id, senderType: m.sender_type, senderAgentId: m.sender_agent_id, kind: m.kind, body: m.body, refs: shownRefs(m), taskId: m.task_id, runId: m.run_id, replyTo: m.reply_to, eventId: m.event_id, createdAt: m.created_at, status: aggregate(deliveries, m.sender_type), deliveries };
  };
  const getMessage = (id) => { const m = get('SELECT * FROM comm_messages WHERE id = ?', id); return m ? mapMessage(m) : null; };
  // Contrôle des références : forme, existence, puis droit de lecture de CHAQUE participant (aucune fuite de mémoire privée vers un fil collectif).
  const checkRefs = (refs, t) => {
    for (const r of refs) {
      if (r.type === 'memory') {
        if (!memory) throw bad('La mémoire n’est pas disponible.');
        let ok = false; try { ok = memory.readableBy(r.id, t.members); } catch (e) { if (e.status !== 404) throw e; throw bad('Souvenir référencé introuvable.', 404); }
        if (!ok) throw bad('Un souvenir joint n’est pas lisible par tous les participants de ce fil : il n’est pas transmis.', 403);
      } else if (r.type === 'mission') {
        if (!get('SELECT 1 AS ok FROM missions WHERE id = ?', r.id)) throw bad('Mission référencée introuvable.', 404);
      } else if (['message', 'result', 'thread'].includes(r.type)) {
        const tid = r.type === 'thread' ? r.id : r.type === 'message' ? get('SELECT thread_id AS t FROM comm_messages WHERE id = ?', r.id)?.t : get('SELECT k.thread_id AS t FROM comm_results r JOIN comm_tasks k ON k.id = r.task_id WHERE r.id = ?', r.id)?.t;
        if (!tid) throw bad('Élément référencé introuvable.', 404);
        const src = new Set(all('SELECT agent_id FROM comm_thread_members WHERE thread_id = ?', tid).map((m) => m.agent_id));
        if (t.members.some((m) => !src.has(m))) throw bad('Cet élément vient d’un fil auquel certains participants n’ont pas accès : il n’est pas transmis.', 403);
      }
    }
  };
  const postMessage = (threadId, { kind = 'message', body, refs = [], taskId = null, replyTo = null, to = null } = {}, by = { type: 'user' }) => {
    const t = thread(threadId);
    if (t.closedAt) throw bad('Ce fil est clos.', 409);
    if (!MESSAGE_KINDS.includes(kind)) throw bad('Type de message invalide.');
    const text = clean(body, 'Le message', LIMITS.body, { required: true });
    assertNoSecret('Le message', text);
    const list = normalizeRefs(refs);
    for (const r of list) assertNoSecret('Une référence', r.label);
    let senderAgent = null, runId = null;
    if (by.type === 'agent') {
      realAgent(by.agentId, 'Expéditeur');
      if (!t.members.includes(by.agentId)) throw bad('Seul un participant du fil peut y écrire.', 403);
      const r = get('SELECT * FROM comm_runs WHERE id = ?', by.runId);
      if (!r || r.agent_id !== by.agentId || !['running', 'done'].includes(r.state)) throw bad('Un message d’agent doit provenir d’une exécution réelle de cet agent.', 403);
      // Pas de boucle de messages automatiques : au-delà du plafond, il faut un message du propriétaire pour reprendre.
      const lastUser = get("SELECT rowid AS n FROM comm_messages WHERE thread_id = ? AND sender_type = 'user' ORDER BY rowid DESC LIMIT 1", threadId)?.n ?? 0;
      const auto = get("SELECT COUNT(*) AS n FROM comm_messages WHERE thread_id = ? AND sender_type = 'agent' AND rowid > ?", threadId, lastUser).n;
      if (auto >= LIMITS.maxAutoMessages) throw bad(`Limite de ${LIMITS.maxAutoMessages} messages automatiques atteinte dans ce fil : un message du propriétaire est nécessaire pour reprendre.`, 429);
      senderAgent = by.agentId; runId = by.runId;
    } else if (by.type !== 'user' && by.type !== 'system') throw bad('Expéditeur invalide.');
    checkRefs(list, t);
    const id = randomUUID(), createdAt = now();
    // Sans destinataires précisés, tout le fil reçoit ; un résultat ou un blocage n'est adressé qu'à celui qui l'a demandé.
    const recipients = by.type === 'system' ? [] : t.members.filter((m) => m !== senderAgent && (to === null || (Array.isArray(to) && to.includes(m))));
    const eventId = emit(senderAgent, 'comm.message.posted', redactFor(taskId, short(text, 140)), by.type === 'agent' ? 'claude' : 'manual', true);
    tx(() => {
      run('INSERT INTO comm_messages (id, thread_id, sender_type, sender_agent_id, kind, body, refs, task_id, run_id, reply_to, event_id, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, threadId, by.type, senderAgent, kind, text, JSON.stringify(list), taskId, runId, replyTo, eventId, device, createdAt);
      for (const a of recipients) run("INSERT INTO comm_deliveries (message_id, agent_id, status, detail, updated_at) VALUES (?, ?, 'sent', '', ?)", id, a, createdAt);
    });
    assertFitsOrUndo(id);
    journal('message', id);
    for (const a of recipients) { journal('delivery', `${id}|${slugOf(a)}`); emit(a, 'comm.message.received', redactFor(taskId, `${t.title} : ${short(text, 120)}`), 'manual', true); }
    return getMessage(id);
  };
  // Un message trop gros pour le journal est annulé tout de suite plutôt que d'exister seulement sur cet ordinateur.
  const assertFitsOrUndo = (id) => { try { assertFits('message', id); } catch (e) { tx(() => { run('DELETE FROM comm_deliveries WHERE message_id = ?', id); run('DELETE FROM comm_messages WHERE id = ?', id); }); throw e; } };
  const DELIVERY_ORDER = { sent: 0, received: 1, processed: 2, error: 3 };
  const markDelivery = (messageId, agentId, status, detail = '') => {
    if (!DELIVERY_STATES.includes(status)) throw bad('Statut invalide.');
    const d = get('SELECT * FROM comm_deliveries WHERE message_id = ? AND agent_id = ?', messageId, agentId);
    if (!d) throw notFound('Distribution');
    if (d.status === status && d.detail === detail) return d;
    // « traité » est final ; une erreur peut être reprise (received) ; on ne revient jamais à « envoyé ».
    if (d.status === 'processed' && status !== 'processed') return d;
    if (status === 'sent' || (DELIVERY_ORDER[status] < DELIVERY_ORDER[d.status] && d.status !== 'error')) return d;
    run('UPDATE comm_deliveries SET status = ?, detail = ?, updated_at = ? WHERE message_id = ? AND agent_id = ?', status, short(String(detail), 300), now(), messageId, agentId);
    journal('delivery', `${messageId}|${slugOf(agentId)}`);
    return get('SELECT * FROM comm_deliveries WHERE message_id = ? AND agent_id = ?', messageId, agentId);
  };
  const pendingFor = (agentId, threadId = null) => all("SELECT m.id FROM comm_deliveries d JOIN comm_messages m ON m.id = d.message_id WHERE d.agent_id = ? AND d.status IN ('sent', 'received', 'error') AND (? IS NULL OR m.thread_id = ?) ORDER BY m.created_at, m.rowid", agentId, threadId, threadId).map((r) => r.id);
  // Ce qu'un agent a le droit de voir dans un fil : ses propres messages et ceux qui LUI ont été adressés. Un participant ajouté après coup
  // ne reçoit donc jamais l'historique antérieur (qui a pu être produit avec une mémoire qu'il ne peut pas lire).
  const visibleMessages = (threadId, agentId, limit = 30) => all(`SELECT * FROM (SELECT m.rowid AS rid, m.* FROM comm_messages m WHERE m.thread_id = ? AND m.sender_type != 'system'
    AND (m.sender_agent_id = ? OR EXISTS (SELECT 1 FROM comm_deliveries d WHERE d.message_id = m.id AND d.agent_id = ?)) ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?) ORDER BY created_at, rid`, threadId, agentId, agentId, Math.min(Math.max(Number(limit) || 30, 1), 100)).map(mapMessage);
  const listMessages = (threadId, before = null, limit = 50) => {
    thread(threadId);
    let date = null, key = null;
    if (before !== null) {
      try {
        if (typeof before !== 'string' || before.length > 512 || !/^[\w-]+$/.test(before)) throw new Error();
        const c = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));
        if (!isoOf(c.createdAt) || !Number.isInteger(c.n) || c.n < 0) throw new Error();
        date = c.createdAt; key = c.n;
      } catch { throw bad('Historique invalide. Rouvrez le fil.'); }
    }
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    // Même milliseconde : l'ordre d'arrivée (rowid) départage, jamais un identifiant aléatoire.
    const rows = all('SELECT rowid AS rid, * FROM comm_messages WHERE thread_id = ? AND (? IS NULL OR created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?', threadId, date, date, date, key, n + 1);
    const page = rows.slice(0, n), last = page.at(-1);
    return { items: page.reverse().map(mapMessage), nextCursor: rows.length > n ? Buffer.from(JSON.stringify({ createdAt: last.created_at, n: last.rid })).toString('base64url') : null };
  };

  // --- exécutions (traces d'exécutions réelles) -------------------------------------------------------------------------------------------
  const startRun = ({ agentId, kind, taskId = null, threadId = null, model = null, web = false }) => {
    realAgent(agentId);
    const id = randomUUID();
    run("INSERT INTO comm_runs (id, agent_id, kind, task_id, thread_id, model, web, state, device, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)", id, agentId, kind, taskId, threadId, model, Number(web), device, now());
    journal('run', id);
    return getRun(id);
  };
  const getRun = (id) => { const r = get('SELECT * FROM comm_runs WHERE id = ?', id); return !r ? null : { id: r.id, agentId: r.agent_id, kind: r.kind, taskId: r.task_id, threadId: r.thread_id, model: r.model, web: Boolean(r.web), state: r.state, error: r.error, costUsd: r.cost_usd, inputTokens: r.input_tokens, outputTokens: r.output_tokens, durationMs: r.duration_ms, device: r.device, startedAt: r.started_at, finishedAt: r.finished_at }; };
  const endRun = (id, { state = 'done', error = null, costUsd = null, usage = null } = {}) => {
    const r = getRun(id); if (!r) throw notFound('Exécution');
    if (r.state !== 'running') return r;
    const finished = now();
    run('UPDATE comm_runs SET state = ?, error = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, duration_ms = ?, finished_at = ? WHERE id = ?', state === 'done' ? 'done' : 'error', error ? short(String(error), 500) : null, costUsd, usage?.input ?? null, usage?.output ?? null, Math.max(0, Date.parse(finished) - Date.parse(r.startedAt)), finished, id);
    journal('run', id);
    return getRun(id);
  };

  // --- tâches (délégations = sous-missions) --------------------------------------------------------------------------------------------------
  // Coût rapporté par Claude Code pour toutes les exécutions d'une demande racine (une exécution sans coût rapporté compte pour 0).
  const spentOf = (rootId) => {
    // Toutes les exécutions de la demande : ses tâches ET les réponses données dans le fil de sa mission.
    const root = get('SELECT mission_id FROM comm_tasks WHERE id = ?', rootId);
    const c = get("SELECT COALESCE(SUM(r.cost_usd), 0) AS c FROM comm_runs r WHERE r.task_id IN (SELECT id FROM comm_tasks WHERE root_task_id = ?) OR (r.kind = 'reply' AND r.thread_id IN (SELECT id FROM comm_threads WHERE mission_id = ?))", rootId, root?.mission_id ?? '').c;
    // D3 : une exécution EN ERREUR sans coût rapporté (délai dépassé, arrêt) a pu coûter : on compte une estimation prudente, jamais 0.
    const unknown = get("SELECT COUNT(*) AS n FROM comm_runs r WHERE r.state = 'error' AND r.cost_usd IS NULL AND (r.task_id IN (SELECT id FROM comm_tasks WHERE root_task_id = ?) OR (r.kind = 'reply' AND r.thread_id IN (SELECT id FROM comm_threads WHERE mission_id = ?)))", rootId, root?.mission_id ?? '').n;
    return Math.round((c + unknown * LIMITS.unreportedRunUsd) * 1e4) / 1e4;
  };
  const unreportedOf = (rootId) => { const root = get('SELECT mission_id FROM comm_tasks WHERE id = ?', rootId); return get("SELECT COUNT(*) AS n FROM comm_runs r WHERE r.state = 'error' AND r.cost_usd IS NULL AND (r.task_id IN (SELECT id FROM comm_tasks WHERE root_task_id = ?) OR (r.kind = 'reply' AND r.thread_id IN (SELECT id FROM comm_threads WHERE mission_id = ?)))", rootId, root?.mission_id ?? '').n; };
  // Le budget d'une mission est-il épuisé ? (utilisé aussi pour les réponses dans son fil)
  const budgetExceeded = (missionId) => {
    for (const r of all('SELECT id, budget_usd FROM comm_tasks WHERE mission_id = ? AND root_task_id = id AND budget_usd IS NOT NULL', missionId || '')) if (spentOf(r.id) >= r.budget_usd) return `Budget de la mission atteint (${spentOf(r.id).toFixed(2)} sur ${r.budget_usd.toFixed(2)} $) : augmentez-le pour continuer.`;
    return null;
  };
  // Les tâches bloquées parce qu'elles attendaient celle-ci repartent avec elle (récursif : consolidations en chaîne).
  const unblockDependents = (id) => {
    for (const d of all("SELECT id FROM comm_tasks WHERE state = 'blocked' AND state_note LIKE 'Une tâche dont elle dépend%'")) {
      if (task(d.id).dependsOn.includes(id)) { setTaskState(d.id, 'queued', 'Relancée avec sa dépendance', { extra: { adopt: true } }); unblockDependents(d.id); }
    }
  };
  const mapTask = (t) => {
    if (!t) return null;
    const res = get('SELECT * FROM comm_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', t.id);
    return { id: t.id, automationKey: t.automation_key ?? null, missionId: t.mission_id, rootTaskId: t.root_task_id, parentTaskId: t.parent_task_id, threadId: t.thread_id, kind: t.kind, title: t.title, instruction: t.instruction, requestedBy: t.requested_by, assigneeId: t.assignee_id, depth: t.depth, state: t.state, stateNote: t.state_note, dependsOn: parseJsonList(t.depends_on), allowWeb: Boolean(t.allow_web), requiresSources: Boolean(t.requires_sources), withCatalog: Boolean(t.with_catalog), withIntegrations: parseJsonList(t.with_integrations), budgetUsd: t.budget_usd ?? null, spentUsd: t.budget_usd == null ? null : spentOf(t.root_task_id), unreportedRuns: t.budget_usd == null ? null : unreportedOf(t.root_task_id), dueAt: t.due_at, notBefore: t.not_before, attempts: t.attempts, maxAttempts: t.max_attempts, device: t.device, createdAt: t.created_at, updatedAt: t.updated_at, startedAt: t.started_at, finishedAt: t.finished_at, resultId: res?.id ?? null, verified: res ? Boolean(res.verified) : false };
  };
  const task = (id) => { const t = get('SELECT * FROM comm_tasks WHERE id = ?', id); if (!t) throw notFound('Tâche'); return mapTask(t); };
  const mapResult = (r) => !r ? null : { id: r.id, taskId: r.task_id, agentId: r.agent_id, runId: r.run_id, summary: r.summary, body: r.body, sources: parseJsonList(r.sources), observed: (() => { try { return JSON.parse(r.observed); } catch { return {}; } })(), verified: Boolean(r.verified), level: r.level, verification: r.verification, verifiedBy: r.verified_by, createdAt: r.created_at };
  const resultOf = (taskId) => mapResult(get('SELECT * FROM comm_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId));
  const setMissionState = (missionId, state) => { try { missions.setState(missionId, MISSION_STATE[state] ?? state); } catch { /* mission absente : sans conséquence pour la tâche */ } };
  const ancestors = (t) => { const out = []; let cur = t; while (cur?.parentTaskId) { cur = task(cur.parentTaskId); out.push(cur); } return out; };

  const createTaskRaw = (input = {}, by = { type: 'user' }) => {
    const automated = by.type === 'automation';
    if (automated) {
      if (!automationGate(by.runId)) throw bad('Autorisation Automation invalide.', 403);
      const existing = get('SELECT * FROM comm_tasks WHERE automation_key=?', by.runId);
      if (existing) return { task: mapTask(existing), created: false, reused: 'origin' };
      if (input.parentTaskId || input.allowWeb || !input.cacheKey) throw bad('Origine Automation non conforme.', 403);
    }
    const instruction = clean(input.instruction, 'La demande', LIMITS.instruction, { required: true });
    assertNoSecret('La demande', instruction);
    const assignee = realAgent(input.assigneeId, 'Agent destinataire');
    const requesterId = by.type === 'agent' ? by.agentId : null;
    const kind = TASK_KINDS.includes(input.kind) ? input.kind : 'work';
    if (kind === 'consolidation' && (!input.parentTaskId || by.type !== 'agent' || by.agentId !== assignee.id)) throw bad('Une consolidation prolonge la tâche de son propre agent.');
    if (requesterId) { realAgent(requesterId, 'Demandeur'); if (requesterId === assignee.id && kind !== 'consolidation') throw bad('Un agent ne peut pas se déléguer une tâche à lui-même.', 409); }
    const parent = input.parentTaskId ? task(input.parentTaskId) : null;
    if (parent && TERMINAL_CLOSED.includes(parent.state)) throw bad('La tâche parente est close : aucune délégation possible.', 409);
    // Budget : racine seulement, validé AVANT toute création (une demande refusée ne laisse jamais de tâche sans plafond).
    const budget = parent ? null : Number(input.budgetUsd ?? LIMITS.defaultBudgetUsd);
    if (budget !== null && !(budget >= 0.1 && budget <= LIMITS.maxBudgetUsd)) throw bad(`Le budget doit être compris entre 0,10 et ${LIMITS.maxBudgetUsd} $.`);
    const depth = parent ? parent.depth + (kind === 'consolidation' ? 0 : 1) : 0;
    if (depth > LIMITS.maxDepth) throw bad(`Profondeur de délégation maximale (${LIMITS.maxDepth}) atteinte : la demande n'est pas créée.`, 409, { limit: 'depth' });
    const rootId = parent ? parent.rootTaskId : null;
    if (parent && kind !== 'consolidation') { // cycle : un agent déjà présent plus haut dans la chaîne ne reçoit pas la demande
      const chain = [parent, ...ancestors(parent)].map((t) => t.assigneeId);
      if (chain.includes(assignee.id)) throw bad(`${assignee.name} fait déjà partie de cette chaîne de délégation : demande refusée (boucle).`, 409, { limit: 'cycle' });
    }
    if (rootId && get('SELECT COUNT(*) AS n FROM comm_tasks WHERE root_task_id = ?', rootId).n >= LIMITS.maxPerRoot) throw bad(`Limite de ${LIMITS.maxPerRoot} tâches pour une même demande atteinte.`, 409, { limit: 'root' });
    const allowWeb = Boolean(input.allowWeb) && (by.type === 'user' || Boolean(parent?.allowWeb)); // un agent ne peut jamais élargir l'accès web
    const withCatalog = Boolean(input.withCatalog) && (by.type === 'user' || automated || Boolean(parent?.withCatalog));
    // Intégrations : un agent ne peut jamais élargir ce que le propriétaire a demandé ; seules les intégrations connues sont retenues.
    const wantedInts = [...new Set(Array.isArray(input.withIntegrations) ? input.withIntegrations.filter((x) => INTEGRATION_IDS.includes(x)) : [])];
    const withIntegrations = by.type === 'user' || automated ? wantedInts : wantedInts.filter((x) => (parent?.withIntegrations ?? []).includes(x));
    const key = automated ? `automation:${assignee.slug}:${input.cacheKey}` : fingerprint(assignee.slug, instruction, allowWeb, withCatalog, withIntegrations);
    if (!input.forceFresh) {
      const open = get(`SELECT * FROM comm_tasks WHERE dedupe_key = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')}) ${rootId ? 'AND root_task_id = ?' : ''} ORDER BY created_at LIMIT 1`, key, ...OPEN_STATES, ...(rootId ? [rootId] : []));
      if (open) return { task: mapTask(open), created: false, reused: 'open' };
      const since = new Date(Date.parse(now()) - LIMITS.reuseMs).toISOString();
      const done = get("SELECT t.* FROM comm_tasks t JOIN comm_results r ON r.task_id = t.id WHERE t.dedupe_key = ? AND t.state = 'done' AND r.verified = 1 AND t.finished_at >= ? ORDER BY t.finished_at DESC LIMIT 1", key, since);
      if (done && !automated) return { task: mapTask(done), created: false, reused: 'result' };
    }
    const deps = [...new Set(Array.isArray(input.dependsOn) ? input.dependsOn : [])].map((d) => task(d));
    if (rootId && deps.some((d) => d.rootTaskId !== rootId && !(d.state === 'done' && d.verified))) throw bad('Une dépendance appartient à une autre demande.', 409);
    const id = randomUUID(), t0 = now();
    const requester = requesterId ? agentRow(requesterId) : null;
    // Mission : la racine peut s'attacher à une mission existante ; toute sous-tâche a sa propre mission (moteur de missions existant).
    let missionId = parent ? null : input.missionId ?? null, mission = missionId ? get('SELECT * FROM missions WHERE id = ?', missionId) : null;
    if (missionId && !mission) throw bad('Mission introuvable.', 404);
    const rootMission = parent ? get('SELECT * FROM missions WHERE id = ?', get('SELECT mission_id AS m FROM comm_tasks WHERE id = ?', rootId)?.m) : mission;
    // Le propriétaire qui crée une tâche l'approuve. Une consolidation prolonge une tâche déjà approuvée. Une délégation d'un agent
    // attend la validation du propriétaire, sauf si la mission ne demande pas de validation humaine.
    const autoApprove = by.type === 'user' || automated || kind === 'consolidation' || Boolean(rootMission && !rootMission.requires_approval);
    const stateNow = autoApprove ? 'queued' : 'pending_approval';
    if (!mission) {
      mission = missions.create({ title: clean(input.title, 'Le titre', LIMITS.title) || short(instruction.replace(/\s+/g, ' '), 100), assignedTo: assignee.id, requestedBy: requesterId, objective: short(instruction, 2000), expectedResult: '', priority: input.priority ?? 'normal', requiresApproval: rootMission ? Boolean(rootMission.requires_approval) : input.requiresApproval !== false });
      missionId = mission.id;
    }
    const threadId = (parent ? get('SELECT thread_id AS t FROM comm_tasks WHERE id = ?', rootId).t : threadForMission(missionId).id);
    const due = isoOf(input.dueAt) ?? new Date(Date.parse(t0) + LIMITS.taskTtlMs).toISOString();
    if (Date.parse(due) <= Date.parse(t0)) throw bad('L’échéance doit être dans le futur.');
    tx(() => {
      run('INSERT INTO comm_tasks (id, mission_id, root_task_id, parent_task_id, thread_id, kind, title, instruction, requested_by, assignee_id, depth, state, depends_on, allow_web, requires_sources, dedupe_key, due_at, attempts, max_attempts, device, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
        id, missionId, rootId ?? id, parent?.id ?? null, threadId, kind, short(mission.title, LIMITS.title), instruction, requesterId ?? 'user', assignee.id, depth, stateNow, JSON.stringify(deps.map((d) => d.id)), Number(allowWeb), Number(input.requiresSources ?? allowWeb), key, due, LIMITS.maxAttempts, device, t0, t0);
      for (const a of [assignee.id, requesterId].filter(Boolean)) { const th = thread(threadId); if (!th.members.includes(a)) run('INSERT INTO comm_thread_members (thread_id, agent_id) VALUES (?, ?)', threadId, a); }
      run('UPDATE comm_tasks SET with_catalog = ?, budget_usd = ?, with_integrations = ? WHERE id = ?', Number(withCatalog), budget, JSON.stringify(withIntegrations), id); // même transaction : jamais de tâche sans ses champs v2
    });
    if (automated) run('UPDATE comm_tasks SET automation_key=?,max_attempts=1 WHERE id=?', by.runId, id);
    setMissionState(missionId, stateNow);
    assertFitsOrUndoTask(id);
    journal('thread', threadId); journal('task', id);
    emit(assignee.id, 'comm.task.created', `${short(instruction, 120)} (de ${requester?.name ?? 'vous'})`, 'manual', true);
    const msg = postMessage(threadId, { kind: 'delegation', to: [assignee.id], body: `${requester ? requester.name : 'Propriétaire'} → ${assignee.name} : ${instruction}${stateNow === 'pending_approval' ? '\n\n(en attente de validation du propriétaire)' : ''}`, refs: [{ type: 'mission', id: missionId, label: mission.title }], taskId: id }, by.type === 'agent' ? by : { type: 'user' });
    return { task: task(id), created: true, message: msg };
  };
  const createTask = (input, by) => tx(() => createTaskRaw(input, by));
  const TERMINAL_CLOSED = ['cancelled'];
  const assertFitsOrUndoTask = (id) => { try { assertFits('task', id); } catch (e) { tx(() => { run('DELETE FROM comm_tasks WHERE id = ?', id); }); throw e; } };

  const setTaskState = (id, to, note = '', { extra = {} } = {}) => {
    const t = task(id);
    if (!TASK_STATES.includes(to)) throw bad('État de tâche invalide.');
    if (t.state === to) return t;
    if (!TASK_TRANSITIONS[t.state].includes(to)) throw bad(`Transition impossible : ${t.state} → ${to}.`, 409);
    // « Terminée » n'est jamais affirmée sans résultat vérifié.
    if (to === 'done') { const r = resultOf(id); if (!r?.verified) throw bad('Une tâche ne peut pas être terminée sans résultat vérifié.', 409); }
    const t1 = now();
    run('UPDATE comm_tasks SET state = ?, state_note = ?, updated_at = ?, started_at = COALESCE(?, started_at), finished_at = ?, not_before = ?, attempts = COALESCE(?, attempts), due_at = COALESCE(?, due_at), device = ? WHERE id = ?',
      to, short(String(note ?? ''), 500), t1, extra.startedAt ?? null, ['done', 'failed', 'cancelled', 'expired'].includes(to) ? t1 : null, extra.notBefore ?? null, extra.attempts ?? null, extra.dueAt ?? null, to === 'running' || extra.adopt ? device : t.device, id);
    setMissionState(t.missionId, to);
    journal('task', id);
    emit(t.assigneeId, `comm.task.${to}`, `${short(t.instruction, 100)}${note ? ` — ${short(String(note), 120)}` : ''}`, 'manual', true);
    return task(id);
  };
  const approveTask = (id) => { const t = task(id); if (t.state !== 'pending_approval') throw bad('Cette tâche n’attend pas de validation.', 409); return setTaskState(id, 'queued', 'Validée par le propriétaire', { extra: { adopt: true } }); };
  const cancelTask = (id, reason = 'Annulée par le propriétaire') => {
    const t = task(id);
    if (t.state === 'running') throw bad('Une tâche en cours ne peut pas être annulée avant la fin de son exécution.', 409);
    const out = setTaskState(id, 'cancelled', reason);
    postMessage(t.threadId, { kind: 'system', body: `Tâche annulée : ${short(t.instruction, 140)} (${reason})`, taskId: id }, { type: 'system' });
    return out;
  };
  const retryTask = (id) => {
    const t = task(id);
    if (!['failed', 'blocked', 'expired', 'review'].includes(t.state)) throw bad('Seule une tâche échouée, bloquée, expirée ou à vérifier peut être relancée.', 409);
    const due = Date.parse(t.dueAt) <= Date.now() ? new Date(Date.now() + LIMITS.taskTtlMs).toISOString() : null;
    const out = setTaskState(id, 'queued', 'Relancée par le propriétaire', { extra: { attempts: 0, dueAt: due, adopt: true } });
    // Les tâches qui attendaient celle-ci et ont été bloquées à cause d'elle repartent avec elle.
    unblockDependents(id);
    return out;
  };
  // Une tâche reçue d'un autre ordinateur n'est JAMAIS exécutée ici d'office (deux machines ne doivent pas faire le même travail) :
  // le propriétaire la reprend explicitement sur cet ordinateur.
  // Le propriétaire fixe le budget d'une demande racine ; les tâches bloquées pour budget repartent.
  const setBudget = (id, usd) => {
    const t = task(id);
    if (t.rootTaskId !== t.id) throw bad('Le budget se règle sur la demande racine.', 409);
    const v = Number(usd);
    if (!(v >= 0.1 && v <= LIMITS.maxBudgetUsd)) throw bad(`Le budget doit être compris entre 0,10 et ${LIMITS.maxBudgetUsd} $.`);
    run('UPDATE comm_tasks SET budget_usd = ?, updated_at = ? WHERE id = ?', v, now(), id);
    journal('task', id);
    for (const r of all("SELECT id FROM comm_tasks WHERE root_task_id = ? AND state = 'blocked' AND state_note LIKE 'Budget de la mission%'", id)) if (spentOf(id) < v) { setTaskState(r.id, 'queued', 'Budget augmenté par le propriétaire', { extra: { adopt: true } }); unblockDependents(r.id); }
    return task(id);
  };
  const adoptTask = (id) => {
    const t = task(id);
    if (!['queued', 'pending_approval', 'blocked'].includes(t.state)) throw bad('Seule une tâche en file, à valider ou bloquée peut être reprise ici.', 409);
    if (t.device === device) throw bad('Cette tâche est déjà exécutée par cet ordinateur.', 409);
    run('UPDATE comm_tasks SET device = ?, updated_at = ? WHERE id = ?', device, now(), id);
    journal('task', id);
    return task(id);
  };
  // Vérification humaine : le propriétaire valide un résultat que le Studio n'a pas pu confirmer lui-même.
  const verifyTask = (id, note = '') => {
    const t = task(id); if (t.state !== 'review') throw bad('Seule une tâche « à vérifier » peut être validée.', 409);
    const r = resultOf(id); if (!r) throw bad('Aucun résultat à valider.', 409);
    run("UPDATE comm_results SET verified = 1, level = 'manual', verified_by = 'proprietaire', verification = ? WHERE id = ?", short(`Validé par le propriétaire${note ? ` : ${note}` : ''}`, 400), r.id);
    journal('result', r.id);
    return setTaskState(id, 'done', 'Résultat validé par le propriétaire');
  };
  const expireDue = () => {
    const t0 = now(); let n = 0;
    for (const r of all(`SELECT id FROM comm_tasks WHERE state IN ('pending_approval', 'queued', 'blocked') AND due_at < ?`, t0)) { setTaskState(r.id, 'expired', 'Échéance dépassée'); n += 1; }
    return n;
  };
  const runsToday = () => get('SELECT COUNT(*) AS n FROM comm_runs WHERE device = ? AND started_at >= ?', device, `${now().slice(0, 10)}T00:00:00.000Z`).n;
  const interruptAutomation = (id, note) => {
    for (const r of all("SELECT id FROM comm_runs WHERE task_id=? AND state='running'", id)) endRun(r.id, { state: 'error', error: note });
    setTaskState(id, 'blocked', note);
    automationInterrupted();
  };
  // Choisit la prochaine tâche exécutable : prête (dépendances terminées), agent libre et disponible, quota respecté.
  const claimNextRaw = ({ busy = new Set() } = {}) => {
    expireDue();
    for (const stale of all("SELECT id FROM comm_tasks WHERE state='running' AND automation_key IS NOT NULL AND automation_lease<=?", now())) interruptAutomation(stale.id, 'Résultat incertain : bail expiré, décision humaine requise.');
    for (const r of all("SELECT * FROM comm_tasks WHERE state = 'queued' AND device = ? ORDER BY depth, created_at, rowid", device)) {
      const t = mapTask(r);
      if (t.automationKey && !automationGate(t.automationKey, t)) { setTaskState(t.id, 'blocked', 'Autorisation Automation, source ou fraîcheur indisponible avant lancement.'); continue; }
      // Les tâches « en cours » importées d'un autre ordinateur ne comptent pas : leur fin ne dépend pas de celui-ci.
      if (get("SELECT count(*) AS n FROM comm_tasks WHERE state='running' AND device=?", device).n >= LIMITS.maxActive) return { task: null };
      if (get("SELECT id FROM comm_tasks WHERE state='running' AND assignee_id=? AND device=?", t.assigneeId, device)) continue;
      if (t.notBefore && t.notBefore > now()) continue;
      let waiting = false, failedDep = null;
      for (const d of t.dependsOn) { const dep = get('SELECT state FROM comm_tasks WHERE id = ?', d); if (!dep || ['failed', 'cancelled', 'expired', 'blocked'].includes(dep.state)) { failedDep = d; break; } if (dep.state !== 'done') waiting = true; }
      if (failedDep) { setTaskState(t.id, 'blocked', 'Une tâche dont elle dépend est bloquée, en échec ou annulée : elle repartira quand vous la relancerez.'); continue; }
      if (waiting) continue;
      if (!available(t.assigneeId)) { setTaskState(t.id, 'blocked', 'Agent indisponible (désactivé ou sans fiche).'); postMessage(t.threadId, { kind: 'system', body: `${nameOf(t.assigneeId)} est indisponible : la tâche est bloquée.`, taskId: t.id }, { type: 'system' }); continue; }
      // Budget de la demande racine : au-delà du coût rapporté, plus aucune nouvelle exécution ne démarre (celles en cours finissent).
      const rootRow = get('SELECT budget_usd FROM comm_tasks WHERE id = ?', t.rootTaskId);
      if (rootRow?.budget_usd != null && spentOf(t.rootTaskId) >= rootRow.budget_usd) {
        setTaskState(t.id, 'blocked', `Budget de la mission atteint (${spentOf(t.rootTaskId).toFixed(2)} sur ${rootRow.budget_usd.toFixed(2)} $) : augmentez-le pour continuer.`);
        postMessage(t.threadId, { kind: 'system', body: `Budget atteint : « ${short(t.instruction, 80)} » est bloquée. Vous pouvez augmenter le budget de la mission.`, taskId: t.id }, { type: 'system' });
        continue;
      }
      if (busy.has(t.assigneeId)) continue;
      if (runsToday() >= LIMITS.maxRunsPerDay) return { quota: true };
      if (t.automationKey) run('UPDATE comm_tasks SET automation_lease=? WHERE id=?', new Date(Date.parse(now()) + 90000).toISOString(), t.id);
      return { task: setTaskState(t.id, 'running', '', { extra: { startedAt: now(), attempts: t.attempts + 1 } }) };
    }
    return { task: null };
  };
  const claimNext = (options) => tx(() => claimNextRaw(options));
  // Résultat d'une exécution. Le Studio évalue lui-même (verified) ; jamais la parole de l'agent seule.
  const recordResult = (taskId, { agentId, runId, summary = '', body, sources = [], observed = {}, verified, level, verification }) => {
    const t = task(taskId), text = clean(body, 'Le résultat', LIMITS.result, { required: true });
    assertNoSecret('Le résultat', text);
    ({ sources, observed } = scrubContactData({ sources, observed }));
    const r = getRun(runId); if (!r || r.agentId !== agentId || r.taskId !== taskId) throw bad('Résultat sans exécution correspondante.', 403);
    const id = randomUUID();
    run('INSERT INTO comm_results (id, task_id, agent_id, run_id, summary, body, sources, observed, verified, level, verification, verified_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, t.id, agentId, runId, short(summary, 400), text, JSON.stringify(sources), JSON.stringify(observed), Number(Boolean(verified)), level, short(verification, 400), 'systeme', now());
    try { assertFits('result', id); } catch (e) { run('DELETE FROM comm_results WHERE id = ?', id); throw e; }
    journal('result', id);
    return mapResult(get('SELECT * FROM comm_results WHERE id = ?', id));
  };
  const results = (taskId) => all('SELECT * FROM comm_results WHERE task_id = ? ORDER BY created_at, rowid', taskId).map(mapResult);

  const listThreads = ({ agentId = null, kind = null, missionId = null } = {}) => all('SELECT * FROM comm_threads ORDER BY created_at DESC, rowid DESC').map(mapThread)
    .filter((t) => (!agentId || t.members.includes(agentId)) && (!kind || t.kind === kind) && (!missionId || t.missionId === missionId))
    .map((t) => { const last = get('SELECT body, created_at, sender_type FROM comm_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', t.id); return { ...t, lastMessage: last ? { body: short(last.body, 140), createdAt: last.created_at, senderType: last.sender_type } : null, messageCount: get('SELECT COUNT(*) AS n FROM comm_messages WHERE thread_id = ?', t.id).n }; });
  const listTasks = ({ missionId = null, state = null, agentId = null, rootTaskId = null } = {}) => all('SELECT * FROM comm_tasks ORDER BY created_at DESC, rowid DESC').map(mapTask)
    .filter((t) => (!missionId || t.missionId === missionId) && (!state || t.state === state) && (!agentId || t.assigneeId === agentId || t.requestedBy === agentId) && (!rootTaskId || t.rootTaskId === rootTaskId));

  const runsOfTask = (taskId) => all('SELECT id FROM comm_runs WHERE task_id = ? ORDER BY started_at, rowid', taskId).map((r) => getRun(r.id));

  // --- vues pour l'interface -------------------------------------------------------------------------------------------------------------------------
  const activeRuns = () => all("SELECT * FROM comm_runs WHERE state = 'running' ORDER BY started_at").map((r) => getRun(r.id));
  // Historique des exécutions réelles (la preuve que chaque message d'agent vient d'un vrai travail), de la plus récente à la plus ancienne.
  const recentRuns = (limit = 50) => all('SELECT r.id, t.title AS task_title FROM comm_runs r LEFT JOIN comm_tasks t ON t.id = r.task_id ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?', Math.min(Math.max(Number(limit) || 50, 1), 200)).map((r) => ({ ...getRun(r.id), taskTitle: r.task_title ?? null }));
  const usage = () => {
    const today = `${now().slice(0, 10)}T00:00:00.000Z`;
    const sum = (where, ...a) => get(`SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inT, COALESCE(SUM(output_tokens), 0) AS outT FROM comm_runs WHERE ${where}`, ...a);
    const t = sum('started_at >= ?', today), a = sum('1 = 1');
    return { today: { runs: t.runs, costUsd: t.cost, inputTokens: t.inT, outputTokens: t.outT }, total: { runs: a.runs, costUsd: a.cost }, quota: { runsPerDay: LIMITS.maxRunsPerDay, remaining: Math.max(0, LIMITS.maxRunsPerDay - runsToday()) }, note: 'Coût et jetons tels que rapportés par Claude Code ; abonnement existant, aucune API payante.',
      byAgent: all("SELECT agent_id, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost FROM comm_runs GROUP BY agent_id ORDER BY runs DESC").map((r) => ({ agentId: r.agent_id, runs: r.runs, costUsd: r.cost })) };
  };
  const notifications = () => {
    const seen = meta('seen_at') ?? '';
    const out = [];
    for (const t of listTasks()) {
      if (t.state === 'pending_approval') out.push({ type: 'approval', id: t.id, taskId: t.id, threadId: t.threadId, title: 'Délégation à valider', detail: short(t.instruction, 140), at: t.createdAt });
      else if (t.state === 'review') out.push({ type: 'review', id: t.id, taskId: t.id, threadId: t.threadId, title: 'Résultat à vérifier', detail: short(t.instruction, 140), at: t.updatedAt });
      else if (['blocked', 'failed', 'expired'].includes(t.state)) out.push({ type: t.state, id: t.id, taskId: t.id, threadId: t.threadId, title: { blocked: 'Tâche bloquée', failed: 'Tâche en échec', expired: 'Tâche expirée' }[t.state], detail: `${short(t.instruction, 100)}${t.stateNote ? ` — ${t.stateNote}` : ''}`, at: t.updatedAt });
    }
    for (const m of all("SELECT * FROM comm_messages WHERE sender_type = 'agent' AND created_at > ? ORDER BY created_at DESC LIMIT 30", seen)) out.push({ type: 'message', id: m.id, threadId: m.thread_id, title: `Message de ${nameOf(m.sender_agent_id)}`, detail: short(m.body, 140), at: m.created_at });
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  };
  // Échanges entre agents au format des anciens messages : l'affichage des faisceaux de la carte les reconnaît tels quels.
  const exchanges = (limit = 200) => {
    const out = [];
    for (const m of all("SELECT * FROM comm_messages WHERE sender_type = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT ?", Math.min(Math.max(Number(limit) || 200, 1), 500))) {
      for (const d of all('SELECT agent_id FROM comm_deliveries WHERE message_id = ?', m.id)) out.push({ id: `comm:${m.id}:${d.agent_id}`, from_agent_id: m.sender_agent_id, to_agent_id: d.agent_id, mission_id: null, body: '', created_at: m.created_at });
    }
    return out;
  };

  // --- synchronisation --------------------------------------------------------------------------------------------------------------------------------------
  const needAgent = (slug) => { const id = agentOfSlug(slug); if (!id) throw new Error(`agent « ${String(slug).slice(0, 40)} » absent sur cet ordinateur`); return id; };
  const agentOrUser = (v) => (v === 'user' ? 'user' : needAgent(v));
  const APPLY = {
    thread(d) {
      const members = d.members.map(needAgent);
      run('INSERT INTO comm_threads (id, kind, title, mission_id, department, created_by, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, closed_at = excluded.closed_at', d.id, d.kind, d.title, d.missionId ?? null, d.department ?? null, agentOrUser(d.createdBy ?? 'user'), d.createdAt, d.closedAt ?? null);
      for (const m of members) run('INSERT OR IGNORE INTO comm_thread_members (thread_id, agent_id) VALUES (?, ?)', d.id, m);
    },
    message(d) {
      if (!get('SELECT 1 AS ok FROM comm_threads WHERE id = ?', d.threadId)) throw new Error('fil inconnu');
      // Un import applique les MÊMES règles qu'une écriture locale : un événement bien formé mais contraire aux invariants est refusé.
      if (!MESSAGE_KINDS.includes(d.kind) || !['user', 'agent', 'system'].includes(d.senderType)) throw new Error('message invalide');
      const body = clean(d.body, 'Le message', LIMITS.body, { required: true }); assertNoSecret('Le message', body);
      const refs = normalizeRefs(d.refs);
      if (d.senderType === 'agent') {
        const sid = d.sender ? needAgent(d.sender) : null, r = sid && d.runId ? get('SELECT agent_id FROM comm_runs WHERE id = ?', d.runId) : null;
        if (!r || r.agent_id !== sid) throw new Error('message d’agent sans exécution enregistrée');
      }
      run('INSERT OR IGNORE INTO comm_messages (id, thread_id, sender_type, sender_agent_id, kind, body, refs, task_id, run_id, reply_to, event_id, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', d.id, d.threadId, d.senderType, d.sender ? needAgent(d.sender) : null, d.kind, body, JSON.stringify(refs), d.taskId ?? null, d.runId ?? null, d.replyTo ?? null, null, d.device ?? '', d.createdAt);
    },
    delivery(d) {
      run('INSERT INTO comm_deliveries (message_id, agent_id, status, detail, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id, agent_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at', d.messageId, needAgent(d.agent), d.status, d.detail ?? '', d.updatedAt);
    },
    task(d) {
      if (!TASK_STATES.includes(d.state) || !Number.isInteger(d.depth) || d.depth < 0 || d.depth > LIMITS.maxDepth) throw new Error('tâche invalide');
      assertNoSecret('La demande', clean(d.instruction, 'La demande', LIMITS.instruction, { required: true }));
      if (d.state === 'done' && !get('SELECT 1 AS ok FROM comm_results WHERE task_id = ? AND verified = 1', d.id)) throw new Error('tâche terminée sans résultat vérifié');
      const m = d.mission;
      if (m && !get('SELECT 1 AS ok FROM missions WHERE id = ?', m.id)) {
        run('INSERT INTO missions (id, title, requested_by, assigned_to, state, requires_approval, created_at, objective, expected_result, context_text, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', m.id, m.title, m.requestedBy ? needAgent(m.requestedBy) : null, m.assignedTo ? needAgent(m.assignedTo) : null, MISSION_STATE[d.state] ?? 'draft', Number(m.requiresApproval), m.createdAt, m.objective ?? '', m.expectedResult ?? '', m.contextText ?? '', m.priority ?? 'normal');
      } else if (m) run('UPDATE missions SET state = ? WHERE id = ?', MISSION_STATE[d.state] ?? 'draft', m.id);
      run(`INSERT INTO comm_tasks (id, mission_id, root_task_id, parent_task_id, thread_id, kind, title, instruction, requested_by, assignee_id, depth, state, state_note, depends_on, allow_web, requires_sources, dedupe_key, due_at, not_before, attempts, max_attempts, device, created_at, updated_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state = excluded.state, state_note = excluded.state_note, not_before = excluded.not_before, attempts = excluded.attempts, due_at = excluded.due_at, device = excluded.device, updated_at = excluded.updated_at, started_at = excluded.started_at, finished_at = excluded.finished_at`,
      d.id, d.missionId, d.rootTaskId, d.parentTaskId ?? null, d.threadId, d.kind, d.title, d.instruction, agentOrUser(d.requestedBy), needAgent(d.assignee), d.depth, d.state, d.stateNote ?? '', JSON.stringify(d.dependsOn ?? []), Number(d.allowWeb), Number(d.requiresSources), d.dedupeKey, d.dueAt, d.notBefore ?? null, d.attempts, d.maxAttempts, d.device ?? '', d.createdAt, d.updatedAt, d.startedAt ?? null, d.finishedAt ?? null);
      // Champs de la migration v2 : absents des journaux écrits avant elle (valeurs par défaut).
      // Un champ ABSENT (journal écrit avant la v2) ne remet jamais à zéro un plafond ou un catalogue déjà connus ici.
      if (Object.hasOwn(d, 'withCatalog')) run('UPDATE comm_tasks SET with_catalog = ? WHERE id = ?', Number(Boolean(d.withCatalog)), d.id);
      if (Object.hasOwn(d, 'withIntegrations')) run('UPDATE comm_tasks SET with_integrations = ? WHERE id = ?', JSON.stringify(Array.isArray(d.withIntegrations) ? d.withIntegrations.filter((x) => INTEGRATION_IDS.includes(x)) : []), d.id);
      if (Object.hasOwn(d, 'budgetUsd')) run('UPDATE comm_tasks SET budget_usd = ? WHERE id = ?', Number.isFinite(d.budgetUsd) && d.budgetUsd >= 0.1 && d.budgetUsd <= LIMITS.maxBudgetUsd ? d.budgetUsd : null, d.id);
    },
    result(d) {
      assertNoSecret('Le résultat', clean(d.body, 'Le résultat', LIMITS.result, { required: true }));
      if (!get('SELECT 1 AS ok FROM comm_tasks WHERE id = ?', d.taskId) || !get('SELECT 1 AS ok FROM comm_runs WHERE id = ?', d.runId)) throw new Error('résultat sans tâche ou sans exécution');
      run('INSERT INTO comm_results (id, task_id, agent_id, run_id, summary, body, sources, observed, verified, level, verification, verified_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET verified = excluded.verified, level = excluded.level, verification = excluded.verification, verified_by = excluded.verified_by',
        d.id, d.taskId, needAgent(d.agent), d.runId, d.summary ?? '', d.body, JSON.stringify(d.sources ?? []), JSON.stringify(d.observed ?? {}), Number(d.verified), d.level, d.verification, d.verifiedBy ?? 'systeme', d.createdAt);
    },
    run(d) {
      run('INSERT INTO comm_runs (id, agent_id, kind, task_id, thread_id, model, web, state, error, cost_usd, input_tokens, output_tokens, duration_ms, device, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, error = excluded.error, cost_usd = excluded.cost_usd, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, duration_ms = excluded.duration_ms, finished_at = excluded.finished_at',
        d.id, needAgent(d.agent), d.kind, d.taskId ?? null, d.threadId ?? null, d.model ?? null, Number(d.web), d.state, d.error ?? null, d.costUsd ?? null, d.inputTokens ?? null, d.outputTokens ?? null, d.durationMs ?? null, d.device ?? '', d.startedAt, d.finishedAt ?? null);
    }
  };
  const IMMUTABLE = new Set(['message']);
  const importJournal = () => {
    const result = { files: 0, events: 0, applied: 0, superseded: 0, invalid: 0, deferred: 0, warnings: [] };
    if (!journalDir || !existsSync(journalDir)) return result;
    try { flushOutbox(); } catch { /* réessayé au prochain changement */ }
    const events = [], limit = new Date(Date.parse(now()) + MAX_FUTURE_MS).toISOString();
    for (const file of readdirSync(journalDir).filter((f) => f.endsWith('.jsonl')).sort()) {
      result.files += 1;
      readFileSync(join(journalDir, file), 'utf8').split(/\r?\n/).forEach((line, n) => {
        if (!line.trim()) return;
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) { result.invalid += 1; result.warnings.push(`${file}:${n + 1} ignoré (trop long).`); return; }
        try {
          const ev = JSON.parse(line), at = isoOf(ev?.at);
          if (ev?.v !== 1 || typeof ev.eid !== 'string' || !ID_RE.test(ev.eid) || !APPLY[ev.kind] || typeof ev.key !== 'string' || ev.key.length > 140 || typeof ev.device !== 'string' || !DEVICE_RE.test(ev.device) || !at || !ev.data || typeof ev.data !== 'object') throw new Error('forme invalide');
          if (!Number.isInteger(ev.rev) || ev.rev < 1) throw new Error('révision invalide');
          if (at > limit) { result.deferred += 1; result.warnings.push(`${file}:${n + 1} en attente (daté du futur : vérifiez l’horloge de l’appareil « ${ev.device} »).`); return; }
          ev.at = at; events.push(ev);
        } catch (e) { result.invalid += 1; result.warnings.push(`${file}:${n + 1} ignoré (${e.message}).`); }
      });
    }
    const seen = new Set(all('SELECT eid FROM comm_imported').map((r) => r.eid));
    let todo = events.filter((e) => !seen.has(e.eid)).sort((a, b) => cmpVersion(a, b) || a.eid.localeCompare(b.eid));
    result.events = todo.length;
    for (let pass = 0; pass < 3 && todo.length; pass += 1) { // un événement qui attend un autre (fil, tâche) est réessayé après les autres
      const retry = [];
      for (const ev of todo) {
        try {
          tx(() => {
            const mine = get('SELECT * FROM comm_versions WHERE kind = ? AND key = ?', ev.kind, ev.key);
            const newer = !mine || cmpVersion(ev, mine) > 0;
            if (ev.key !== (ev.kind === 'delivery' ? `${ev.data.messageId}|${ev.data.agent}` : ev.data.id)) throw new Error('clé incohérente avec le contenu');
            if (newer || IMMUTABLE.has(ev.kind)) {
              APPLY[ev.kind](ev.data);
              if (newer) run('INSERT INTO comm_versions (kind, key, at, rev, device) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET at = excluded.at, rev = excluded.rev, device = excluded.device', ev.kind, ev.key, ev.at, ev.rev, ev.device);
              result.applied += 1;
            } else result.superseded += 1;
            run('INSERT OR IGNORE INTO comm_imported (eid, imported_at) VALUES (?, ?)', ev.eid, now());
          });
        } catch (e) { retry.push([ev, e.message]); }
      }
      todo = retry.map(([ev]) => ev);
      if (pass === 2 || !retry.length) for (const [ev, why] of retry) { result.invalid += 1; result.warnings.push(`Événement ${ev.eid.slice(0, 8)} (${ev.device}, ${ev.kind}) ignoré : ${why}.`); }
    }
    return result;
  };

  // Contrôle (lecture seule) : invariants qui doivent toujours tenir.
  const check = () => {
    const problems = [], notes = [];
    let files = 0; try { files = journalDir && existsSync(journalDir) ? readdirSync(journalDir).filter((f) => f.endsWith('.jsonl')).length : 0; } catch { notes.push('Le dossier du journal est inaccessible.'); }
    if (!hasTable('comm_tasks')) return { ok: true, problems, notes: ['La communication n’est pas encore initialisée sur cet ordinateur (elle le sera au prochain « npm start »).'], journalFiles: files, journalError, tasks: 0, messages: 0 };
    for (const t of all("SELECT t.id, t.instruction FROM comm_tasks t WHERE t.state = 'done' AND NOT EXISTS (SELECT 1 FROM comm_results r WHERE r.task_id = t.id AND r.verified = 1)")) problems.push(`Tâche ${t.id.slice(0, 8)} « ${short(t.instruction, 50)} » terminée sans résultat vérifié.`);
    for (const m of all("SELECT m.id FROM comm_messages m WHERE m.sender_type = 'agent' AND (m.run_id IS NULL OR NOT EXISTS (SELECT 1 FROM comm_runs r WHERE r.id = m.run_id))")) problems.push(`Message ${m.id.slice(0, 8)} d'un agent sans exécution enregistrée.`);
    for (const t of all('SELECT id, depth FROM comm_tasks WHERE depth > ?', LIMITS.maxDepth)) problems.push(`Tâche ${t.id.slice(0, 8)} au-delà de la profondeur maximale.`);
    for (const m of all('SELECT id, body FROM comm_messages')) { const s = findSecret(m.body); if (s) problems.push(`Message ${m.id.slice(0, 8)} semble contenir ${s}.`); }
    const stale = all("SELECT id FROM comm_runs WHERE state = 'running' AND device = ? AND started_at < ?", device, new Date(Date.parse(now()) - 3_600_000).toISOString());
    if (stale.length) notes.push(`${stale.length} exécution(s) « en cours » depuis plus d'une heure (reprises au prochain démarrage).`);
    const errors = get("SELECT COUNT(*) AS n FROM comm_deliveries WHERE status = 'error'").n;
    if (errors) notes.push(`${errors} message(s) en erreur de traitement.`);
    const queued = readOnly ? 0 : outbox().length;
    if (queued) notes.push(`${queued} changement(s) en attente d’écriture dans le journal (réessayé automatiquement).`);
    return { ok: problems.length === 0, problems, notes, journalFiles: files, journalError, tasks: get('SELECT COUNT(*) AS n FROM comm_tasks').n, messages: get('SELECT COUNT(*) AS n FROM comm_messages').n };
  };
  // Au démarrage : ce qui tournait quand le processus s'est arrêté n'a pas fini ; on le dit et on le reprend ou on l'échoue.
  const recover = () => {
    let n = 0;
    for (const r of all("SELECT * FROM comm_runs WHERE state = 'running' AND device = ?", device)) { const taskLease = r.task_id ? get('SELECT automation_key,automation_lease FROM comm_tasks WHERE id=?', r.task_id) : null; if (taskLease?.automation_key && taskLease.automation_lease > now()) continue; endRun(r.id, { state: 'error', error: 'Interrompue par un arrêt du Studio.' }); n += 1; }
    for (const t of all("SELECT id, attempts, max_attempts, automation_key, automation_lease FROM comm_tasks WHERE state = 'running' AND device = ?", device)) {
      if (t.automation_key && t.automation_lease > now()) continue;
      if (t.automation_key) { interruptAutomation(t.id, 'Résultat incertain après interruption : décision humaine requise.'); continue; }
      if (t.attempts < t.max_attempts) setTaskState(t.id, 'queued', 'Reprise après un arrêt du Studio.', { extra: { notBefore: now() } });
      else setTaskState(t.id, 'failed', 'Interrompue par un arrêt du Studio (plus d’essai disponible).');
    }
    return n;
  };

  return {
    reusableAutomation: (slug, cacheKey, freshnessMs) => { const row = get("SELECT t.* FROM comm_tasks t JOIN comm_results r ON r.task_id=t.id WHERE t.dedupe_key=? AND t.state='done' AND r.verified=1 AND t.finished_at>=? ORDER BY t.finished_at DESC LIMIT 1", `automation:${slug}:${cacheKey}`, new Date(Date.parse(now()) - Math.min(LIMITS.reuseMs, freshnessMs)).toISOString()); return row ? mapTask(row) : null; },
    renewAutomation: (id) => run("UPDATE comm_tasks SET automation_lease=? WHERE id=? AND state='running' AND automation_key IS NOT NULL", new Date(Date.parse(now()) + 90000).toISOString(), id),
    setAutomationGate: (gate, onInterrupted = () => {}) => { automationGate = gate; automationInterrupted = onInterrupted; }, automationAllowed: (t) => !t.automationKey || automationGate(t.automationKey, t),
    device, schemaVersion, lastMigration, rollback, journalError: () => journalError,
    status: () => ({ schemaVersion: schemaVersion(), device, journalDir: journalDir ? resolve(journalDir) : null, journalError, lastMigration, limits: LIMITS, webTools: WEB_TOOLS }),
    createThread, addMember, thread, threadForMission, listThreads, postMessage, getMessage, listMessages, markDelivery, pendingFor,
    startRun, endRun, getRun, activeRuns, recentRuns, runsOfTask, usage, available, agentInfo: (id) => agentRow(id), slugOf, agentOfSlug, realAgent, nameOf,
    visibleMessages, quotaExceeded: () => runsToday() >= LIMITS.maxRunsPerDay,
    createTask, task, listTasks, setTaskState, approveTask, cancelTask, retryTask, adoptTask, setBudget, spentOf, budgetExceeded, verifyTask, expireDue, claimNext, recordResult, resultOf, results, recover,
    notifications, markSeen: () => { setMeta('seen_at', now()); return { seenAt: meta('seen_at') }; }, exchanges,
    importJournal, check, flushOutbox
  };
}
