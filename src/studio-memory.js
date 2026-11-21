// src/studio-memory.js — stockage de la mémoire d'Archipel. Ajoute des tables seulement (aucune table existante n'est touchée ;
// `mission_memory`, les notes de mission déjà saisies, reste telle quelle). Les changements de schéma sont des migrations
// numérotées, réversibles, précédées d'une sauvegarde. La synchronisation entre ordinateurs passe par un journal
// d'événements par appareil (memory/journal/<appareil>.jsonl), versionné dans git : la base, elle, n'est jamais copiée.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  LEVELS, KINDS, NATURES, STATES, VISIBILITIES, CONFIDENCES, normalizeItem, canRead, checkProposalScope, findDuplicate, findSecret,
  freshness, rank, buildContext, DEFAULT_BUDGET_TOKENS, DEFAULT_MAX_ITEMS
} from './memory-core.js';

export const MEMORY_MIGRATIONS = [{
  version: 1,
  name: 'mémoire avancée : souvenirs, historique, import du journal',
  up: `
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY, level TEXT NOT NULL, kind TEXT NOT NULL, nature TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, owner TEXT, department TEXT, mission_id TEXT,
      source TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL, importance INTEGER NOT NULL, visibility TEXT NOT NULL, readers TEXT NOT NULL DEFAULT '[]',
      sync INTEGER NOT NULL DEFAULT 1, proposed_by TEXT, rev INTEGER NOT NULL DEFAULT 1, last_device TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS memory_items_state_level ON memory_items(state, level);
    CREATE INDEX IF NOT EXISTS memory_items_owner ON memory_items(owner);
    CREATE INDEX IF NOT EXISTS memory_items_department ON memory_items(department);
    CREATE INDEX IF NOT EXISTS memory_items_mission ON memory_items(mission_id);
    CREATE TABLE IF NOT EXISTS memory_history (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, rev INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_history_item ON memory_history(item_id, created_at);
    CREATE TABLE IF NOT EXISTS memory_imported (eid TEXT PRIMARY KEY, imported_at TEXT NOT NULL);
  `,
  // Retour arrière : supprime les tables de la mémoire (une sauvegarde est faite avant). Rien d'autre n'est touché.
  down: `
    DROP TABLE IF EXISTS memory_imported;
    DROP TABLE IF EXISTS memory_history;
    DROP TABLE IF EXISTS memory_items;
  `
}];
export const MEMORY_SCHEMA_VERSION = MEMORY_MIGRATIONS.at(-1).version;

const now = () => new Date().toISOString();
const json = (text, fallback) => { try { const v = JSON.parse(text); return v ?? fallback; } catch { return fallback; } };
const notFound = () => Object.assign(new Error('Souvenir introuvable.'), { status: 404 });
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const ID_RE = /^[\w-]{1,64}$/, DEVICE_RE = /^[a-z0-9_-]{1,32}$/i;
const MAX_EVENT_BYTES = 24_000;          // taille maximale d'une ligne de journal, en octets UTF-8 (contrôlée à l'écriture ET à l'import)
const MAX_FUTURE_MS = 24 * 3_600_000;    // un événement daté de plus d'un jour dans le futur (horloge déréglée) attend au lieu d'écraser
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isoOf = (v) => (typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
// Ordre total des versions d'un même souvenir : date, puis numéro de révision, puis appareil (départage stable sur toutes les machines).
const cmpVersion = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rev - b.rev || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
const TRANSITIONS = { pending: ['active', 'rejected', 'deleted'], active: ['archived', 'deleted'], archived: ['active', 'deleted'], rejected: ['pending', 'deleted'], deleted: [] };
const ACTION_OF = { active: 'approved', rejected: 'rejected', archived: 'archived', deleted: 'deleted', pending: 'reopened' };

const COLUMNS = ['id', 'level', 'kind', 'nature', 'state', 'title', 'body', 'owner', 'department', 'mission_id', 'source', 'sources', 'tags', 'confidence', 'importance', 'visibility', 'readers', 'sync', 'proposed_by', 'rev', 'last_device', 'created_at', 'updated_at', 'last_used_at', 'use_count', 'expires_at'];

const mapItem = (r) => ({
  id: r.id, level: r.level, kind: r.kind, nature: r.nature, state: r.state, title: r.title, body: r.body, owner: r.owner, department: r.department, missionId: r.mission_id,
  source: r.source, sources: json(r.sources, []), tags: json(r.tags, []), confidence: r.confidence, importance: r.importance, visibility: r.visibility, readers: json(r.readers, []),
  sync: Boolean(r.sync), proposedBy: r.proposed_by, rev: r.rev, device: r.last_device, createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at, useCount: r.use_count, expiresAt: r.expires_at
});
const toValues = (i) => [i.id, i.level, i.kind, i.nature, i.state, i.title, i.body, i.owner ?? null, i.department ?? null, i.missionId ?? null, i.source ?? '', JSON.stringify(i.sources ?? []), JSON.stringify(i.tags ?? []), i.confidence, i.importance, i.visibility, JSON.stringify(i.readers ?? []), Number(i.sync !== false && i.sync !== 0), i.proposedBy ?? null, i.rev, i.device ?? '', i.createdAt, i.updatedAt, i.lastUsedAt ?? null, i.useCount ?? 0, i.expiresAt ?? null];
// Ce qui voyage dans le journal : tout sauf l'usage local (dernière utilisation, compteur).
const portable = (i) => ({ id: i.id, level: i.level, kind: i.kind, nature: i.nature, state: i.state, title: i.title, body: i.body, owner: i.owner, department: i.department, missionId: i.missionId, source: i.source, sources: i.sources, tags: i.tags, confidence: i.confidence, importance: i.importance, visibility: i.visibility, readers: i.readers, sync: true, proposedBy: i.proposedBy, createdAt: i.createdAt, updatedAt: i.updatedAt, expiresAt: i.expiresAt, rev: i.rev });
const comparable = (i) => JSON.stringify([i.level, i.kind, i.nature, i.title, i.body, i.owner, i.department, i.missionId, i.source, i.sources, i.tags, i.confidence, i.importance, i.visibility, [...i.readers].sort(), i.expiresAt]);

// readOnly : base ouverte en lecture seule (« npm run memory:check ») — aucune table créée, aucune migration, aucune écriture.
export function createMemoryStore(db, { filename = ':memory:', journalDir = null, device: deviceOption = null, readOnly = false } = {}) {
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } };
  const onDisk = Boolean(filename) && filename !== ':memory:';
  let journalError = null;

  // --- méta, appareil, migrations -------------------------------------------------------------------------------------
  if (!readOnly) db.exec('CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const meta = (key) => { try { return get('SELECT value FROM memory_meta WHERE key = ?', key)?.value ?? null; } catch (e) { if (readOnly) return null; throw e; } };
  const setMeta = (key, value) => run('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const wanted = deviceOption && DEVICE_RE.test(deviceOption) ? deviceOption.toLowerCase() : null;
  if (!readOnly) { if (wanted) setMeta('device', wanted); else if (!meta('device')) setMeta('device', randomUUID().slice(0, 8)); }
  const device = meta('device') ?? wanted ?? 'inconnu';

  const backup = (label = 'manuelle') => {
    if (!onDisk) return null;
    const dir = join(dirname(resolve(filename)), 'backups');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `workeda-${String(label).replace(/[^\w-]+/g, '-')}-${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 4)}.db`);
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return path;
  };
  const schemaVersion = () => Number(meta('schema_version') ?? 0);
  const migrate = () => {
    const current = schemaVersion(), todo = MEMORY_MIGRATIONS.filter((m) => m.version > current);
    if (!todo.length) return { from: current, to: current, backup: null };
    // Une base qui contient déjà des données est sauvegardée avant toute migration ; une base vide n'a rien à perdre.
    const hasData = current > 0 || get('SELECT COUNT(*) AS n FROM agents').n > 0;
    const saved = hasData ? backup(`avant-memoire-v${todo[0].version}`) : null;
    tx(() => { for (const m of todo) { db.exec(m.up); setMeta('schema_version', m.version); } });
    return { from: current, to: schemaVersion(), backup: saved };
  };
  const rollback = (target = 0) => {
    const current = schemaVersion();
    if (!Number.isInteger(target) || target < 0 || target >= current) throw bad('Version cible invalide.');
    const saved = backup(`avant-retour-v${target}`);
    tx(() => { for (const m of [...MEMORY_MIGRATIONS].reverse()) if (m.version > target && m.version <= current) { db.exec(m.down); setMeta('schema_version', m.version - 1); } });
    return { from: current, to: schemaVersion(), backup: saved };
  };
  const lastMigration = readOnly ? { from: schemaVersion(), to: schemaVersion(), backup: null } : migrate();

  // --- identités portables ---------------------------------------------------------------------------------------------
  const agentRefOf = (agentId) => get('SELECT slug FROM agent_files WHERE agent_id = ?', agentId)?.slug ?? `id:${agentId}`;
  const whoFor = (agentId) => {
    const a = get('SELECT a.id, d.name AS department, f.slug FROM agents a JOIN departments d ON d.id = a.department_id LEFT JOIN agent_files f ON f.agent_id = a.id WHERE a.id = ?', agentId);
    if (!a) throw bad('Agent introuvable.', 404);
    const missionIds = new Set(all('SELECT id AS m FROM missions WHERE assigned_to = ? UNION SELECT mission_id AS m FROM mission_collaborators WHERE agent_id = ?', agentId, agentId).map((r) => r.m));
    return { agentId, agentRef: a.slug ?? `id:${a.id}`, department: a.department, missionIds };
  };
  const checkRefs = (d) => {
    if (d.owner && !get('SELECT 1 AS ok FROM agent_files WHERE slug = ?', d.owner) && !d.owner.startsWith('id:')) throw bad(`Agent propriétaire inconnu : « ${d.owner.slice(0, 60)} ».`);
    if (d.department && !get('SELECT 1 AS ok FROM departments WHERE name = ?', d.department)) throw bad(`Département inconnu : « ${d.department.slice(0, 60)} ».`);
    if (d.missionId && !get('SELECT 1 AS ok FROM missions WHERE id = ?', d.missionId)) throw bad('Mission inconnue.');
  };

  // --- lecture / écriture de base --------------------------------------------------------------------------------------
  const row = (id) => get('SELECT * FROM memory_items WHERE id = ?', id);
  const item = (id) => { const r = row(id); if (!r) throw notFound(); return mapItem(r); };
  const put = (i) => run(`INSERT OR REPLACE INTO memory_items (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`, ...toValues(i));
  const decorate = (i, extra = {}) => { const f = freshness(i); return { ...i, expired: f.expired, stale: f.stale, ageDays: f.ageDays, ...extra }; };
  const record = (i, action, actor, note = '') => {
    const snapshot = i.state === 'deleted' ? '' : JSON.stringify(portable(i));
    run('INSERT INTO memory_history (id, item_id, rev, action, actor, note, snapshot, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', randomUUID(), i.id, i.rev, action, actor, note, snapshot, device, now());
  };
  const eventOf = (action, i) => ({ v: 1, eid: randomUUID(), item: i.id, rev: i.rev, at: i.updatedAt, device, action, data: action === 'delete' ? null : portable(i) });
  const lineOf = (event) => `${JSON.stringify(event)}\n`;
  // Refuse à l'écriture un souvenir dont l'événement dépasserait la limite du journal (sinon l'autre ordinateur l'ignorerait).
  const assertFits = (i) => {
    const probe = { ...i, id: i.id ?? randomUUID(), state: i.state ?? 'active', rev: i.rev ?? 1, createdAt: i.createdAt ?? now(), updatedAt: i.updatedAt ?? now() };
    if (Buffer.byteLength(lineOf(eventOf('upsert', probe))) > MAX_EVENT_BYTES) throw bad('Ce souvenir est trop volumineux pour être synchronisé entre ordinateurs : raccourcissez le contenu ou les sources.');
  };
  // File d'attente de ce qui n'a pas pu être écrit dans le journal (disque plein, fichier verrouillé…) : réexportée dès que possible.
  const outbox = () => { const v = json(meta('outbox'), []); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; };
  const setOutbox = (ids) => setMeta('outbox', JSON.stringify([...new Set(ids)]));
  const append = (event) => {
    mkdirSync(journalDir, { recursive: true });
    const line = lineOf(event);
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error('événement trop volumineux');
    appendFileSync(join(journalDir, `${device}.jsonl`), line);
    run('INSERT INTO memory_imported (eid, imported_at) VALUES (?, ?)', event.eid, now());
  };
  const flushOutbox = () => {
    if (!journalDir || readOnly) return;
    const pending = outbox(); if (!pending.length) return;
    const left = [];
    for (const id of pending) {
      const r = row(id);
      if (!r) continue;
      const i = mapItem(r);
      if (!i.sync) continue;
      try { append(eventOf(i.state === 'deleted' ? 'delete' : 'upsert', i)); } catch (e) { left.push(id); journalError = `Journal non écrit : ${e.message}`; }
    }
    setOutbox(left);
    if (!left.length) journalError = null;
  };
  const journal = (action, i) => {
    if (!journalDir || !i.sync) return;
    try { append(eventOf(action, i)); journalError = null; const q = outbox(); if (q.includes(i.id)) setOutbox(q.filter((x) => x !== i.id)); }
    catch (e) { journalError = `Journal non écrit : ${e.message}`; try { setOutbox([...outbox(), i.id]); } catch { /* base elle-même en panne : rien de plus à faire */ } return; }
    flushOutbox();
  };
  const actorLabel = (by) => (by?.type === 'agent' ? `agent:${by.ref ?? by.agentId}` : 'proprietaire');

  const insertNew = (draft, { state, proposedBy = null }, by) => {
    const t = now();
    const i = { ...draft, id: randomUUID(), state, proposedBy, rev: 1, device, createdAt: t, updatedAt: t, lastUsedAt: null, useCount: 0 };
    tx(() => { put(i); record(i, state === 'pending' ? 'proposed' : 'created', actorLabel(by)); });
    journal('upsert', i);
    return i;
  };
  const candidates = (level) => all("SELECT * FROM memory_items WHERE level = ? AND state IN ('pending', 'active', 'archived')", level).map(mapItem);

  return {
    device, schemaVersion, lastMigration, backup, rollback,
    // Le propriétaire crée un souvenir (actif tout de suite). Un quasi-doublon est refusé sauf { force: true }.
    create(input, by = { type: 'user' }) {
      const draft = normalizeItem(input, { actor: 'user' });
      checkRefs(draft); assertFits(draft);
      if (!input.force) { const dup = findDuplicate(draft, candidates(draft.level)); if (dup) throw bad(`Un souvenir presque identique existe déjà : « ${dup.item.title} ».`, 409, { duplicateOf: dup.item.id }); }
      return decorate(insertNew(draft, { state: 'active' }, by));
    },
    // Un agent PROPOSE : jamais directement actif, jamais « fait vérifié » ni « décision », jamais une règle.
    // Retourne { created, skipped } : les doublons et les propositions hors périmètre sont écartés et expliqués.
    propose(agentId, drafts, { missionId = null } = {}) {
      const who = whoFor(agentId);
      if (missionId && !who.missionIds.has(missionId)) throw bad('Cette mission ne concerne pas cet agent.', 403);
      if (!Array.isArray(drafts)) throw bad('Les propositions doivent être une liste.');
      const created = [], skipped = [];
      for (const [index, raw] of drafts.slice(0, 20).entries()) {
        try {
          const input = { ...raw, level: raw?.level ?? (missionId ? 'mission' : 'individual') };
          if (input.level === 'individual') input.owner = who.agentRef;
          if (input.level === 'department') input.department = who.department;
          if (input.level === 'mission') input.missionId = missionId ?? input.missionId;
          const draft = normalizeItem(input, { actor: 'agent' });
          checkProposalScope(draft, who); checkRefs(draft); assertFits(draft);
          draft.sync = true;
          const dup = findDuplicate(draft, candidates(draft.level));
          if (dup) { skipped.push({ index, title: draft.title, reason: `Doublon de « ${dup.item.title} ».` }); continue; }
          created.push(decorate(insertNew(draft, { state: 'pending', proposedBy: who.agentRef }, { type: 'agent', ref: who.agentRef })));
        } catch (e) { skipped.push({ index, title: String(raw?.title ?? '').slice(0, 80), reason: e.message }); }
      }
      return { created, skipped };
    },
    get: (id) => decorate(item(id)),
    update(id, patch = {}, by = { type: 'user' }) {
      const existing = item(id);
      if (['rejected', 'deleted'].includes(existing.state)) throw bad('Ce souvenir n’est plus modifiable.');
      const merged = normalizeItem({ ...existing, ...patch, sync: existing.sync }, { actor: 'user' });
      checkRefs(merged);
      const next = { ...existing, ...merged, sync: existing.sync };
      if (comparable(next) === comparable(existing)) return decorate(existing);
      next.rev = existing.rev + 1; next.updatedAt = now(); next.device = device;
      assertFits(next);
      const changed = ['title', 'body', 'nature', 'kind', 'level', 'confidence', 'importance', 'visibility', 'expiresAt'].filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(next[k]));
      tx(() => { put(next); record(next, 'updated', actorLabel(by), changed.length ? `Modifié : ${changed.join(', ')}.` : 'Sources, étiquettes ou lecteurs modifiés.'); });
      journal('upsert', next);
      return decorate(next);
    },
    // Changements d'état décidés par le propriétaire : valider/rejeter une proposition, archiver, restaurer, supprimer.
    // « Supprimer » vide le contenu (titre, texte, instantanés d'historique) et laisse une pierre tombale qui se propage aux autres PC.
    setState(id, to, { note = '', patch = null } = {}, by = { type: 'user' }) {
      if (!STATES.includes(to)) throw bad('État invalide.');
      const existing = item(id);
      if (!TRANSITIONS[existing.state].includes(to)) throw bad(`Passage impossible de « ${existing.state} » à « ${to} ».`);
      let next = { ...existing };
      if (patch && to === 'active') { const merged = normalizeItem({ ...existing, ...patch, sync: existing.sync }, { actor: 'user' }); checkRefs(merged); next = { ...existing, ...merged, sync: existing.sync }; assertFits(next); }
      next.state = to; next.rev = existing.rev + 1; next.updatedAt = now(); next.device = device;
      if (to === 'deleted') { next.title = '[supprimé]'; next.body = ''; next.sources = []; next.tags = []; next.source = ''; next.readers = []; }
      tx(() => {
        if (to === 'deleted') run("UPDATE memory_history SET snapshot = '', note = '' WHERE item_id = ?", id);
        put(next);
        record(next, ACTION_OF[to], actorLabel(by), to === 'deleted' ? '' : String(note).slice(0, 300));
      });
      journal(to === 'deleted' ? 'delete' : 'upsert', next);
      return decorate(next);
    },
    history(id) {
      item(id);
      return all('SELECT rev, action, actor, note, snapshot, device, created_at FROM memory_history WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100', id)
        .map((h) => ({ rev: h.rev, action: h.action, actor: h.actor, note: h.note, snapshot: json(h.snapshot, null), device: h.device, at: h.created_at }));
    },
    // Liste filtrée, éventuellement classée par requête. visibleTo : n'affiche que ce que cet agent a le droit de lire.
    list({ level, kind, nature, state, owner, department, missionId, tag, q, visibleTo, includeExpired = true, limit = 200 } = {}) {
      const where = [], args = [];
      for (const [col, val, allowed] of [['level', level, LEVELS], ['kind', kind, KINDS], ['nature', nature, NATURES], ['state', state, STATES]]) if (val) { if (!allowed.includes(val)) throw bad(`Filtre « ${col} » invalide.`); where.push(`${col} = ?`); args.push(val); }
      if (!state) where.push("state != 'deleted'");
      if (owner) { where.push('owner = ?'); args.push(String(owner)); }
      if (department) { where.push('department = ?'); args.push(String(department)); }
      if (missionId) { where.push('mission_id = ?'); args.push(String(missionId)); }
      let items = all(`SELECT * FROM memory_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id`, ...args).map(mapItem);
      if (tag) { const t = String(tag).toLocaleLowerCase('fr'); items = items.filter((i) => i.tags.includes(t)); }
      if (visibleTo) { const who = whoFor(visibleTo); items = items.filter((i) => canRead(i, who)); }
      if (!includeExpired) items = items.filter((i) => !freshness(i).expired);
      const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
      if (q && String(q).trim()) return rank(items, String(q), { dropExpired: false, dedupe: false }).slice(0, cap).map((r) => decorate(r.item, { score: r.score }));
      return items.slice(0, cap).map((i) => decorate(i));
    },
    // Le contexte d'une mission pour un agent : seulement du souvenir ACTIF, AUTORISÉ, pertinent, non expiré, dans un budget de jetons.
    // agentId peut être une LISTE d'agents (fil d'équipe, plan partagé) : seul ce que TOUS peuvent lire est transmis, car la
    // réponse d'un agent est lue par les autres — la mémoire privée de l'un ne doit jamais fuiter vers les autres.
    contextFor(agentId, { missionId = null, query = '', budgetTokens = DEFAULT_BUDGET_TOKENS, maxItems = DEFAULT_MAX_ITEMS, touch = true } = {}) {
      const whos = (Array.isArray(agentId) ? [...new Set(agentId)] : [agentId]).map(whoFor);
      if (!whos.length) throw bad('Aucun agent.');
      const readable = all("SELECT * FROM memory_items WHERE state = 'active'").map(mapItem)
        .filter((i) => whos.every((who) => canRead(i, who)) && (i.level !== 'mission' || (missionId && i.missionId === missionId)));
      const always = (i) => i.level === 'company' && ['rule', 'decision'].includes(i.kind) && i.importance >= 4;
      const scored = rank(readable, query, { keep: always });
      // Les règles et décisions d'entreprise importantes passent d'abord (3 au plus) : elles encadrent toute mission, pertinentes ou non.
      const pinned = scored.filter((r) => always(r.item)).slice(0, 3);
      const ranked = [...pinned, ...scored.filter((r) => !pinned.includes(r))];
      const ctx = buildContext(ranked, { budgetTokens, maxItems });
      if (touch && ctx.items.length) {
        const t = now();
        tx(() => { for (const r of ctx.items) run('UPDATE memory_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?', t, r.item.id); });
      }
      return { text: ctx.text, tokens: ctx.tokens, omitted: ctx.omitted, items: ctx.items.map((r) => ({ id: r.item.id, title: r.item.title, level: r.item.level, nature: r.item.nature, score: r.score, stale: r.stale })) };
    },
    stats() {
      const by = (col) => Object.fromEntries(all(`SELECT ${col} AS k, COUNT(*) AS n FROM memory_items WHERE state != 'deleted' GROUP BY ${col}`).map((r) => [r.k, r.n]));
      const live = all("SELECT * FROM memory_items WHERE state IN ('active', 'pending')").map(mapItem).map((i) => freshness(i));
      return { total: get("SELECT COUNT(*) AS n FROM memory_items WHERE state != 'deleted'").n, byLevel: by('level'), byState: by('state'), byNature: by('nature'), pending: get("SELECT COUNT(*) AS n FROM memory_items WHERE state = 'pending'").n, stale: live.filter((f) => f.stale).length, expired: live.filter((f) => f.expired).length };
    },
    // Tous ces agents peuvent-ils lire ce souvenir (actif) ? Sert à contrôler les références jointes à un message de fil.
    readableBy(id, agentIds) { const i = item(id); return i.state === 'active' && agentIds.map(whoFor).every((w) => canRead(i, w)); },
    status: () => ({ schemaVersion: schemaVersion(), device, journalDir: journalDir ? resolve(journalDir) : null, journalError, lastMigration, onDisk }),
    owners: () => all("SELECT DISTINCT owner FROM memory_items WHERE owner IS NOT NULL AND state != 'deleted' ORDER BY owner").map((r) => r.owner),

    // --- synchronisation par journal (git) -----------------------------------------------------------------------------
    // Importe les événements des autres appareils : idempotent (chaque événement une seule fois), le plus récent gagne,
    // et la version perdue reste dans l'historique. Rien n'est jamais supprimé de la base par un import silencieux.
    importJournal() {
      const result = { files: 0, events: 0, applied: 0, superseded: 0, invalid: 0, deferred: 0, warnings: [] };
      if (!journalDir || !existsSync(journalDir)) return result;
      try { flushOutbox(); } catch { /* le journal local sera réessayé au prochain changement */ }
      const events = [], limit = new Date(Date.now() + MAX_FUTURE_MS).toISOString();
      for (const file of readdirSync(journalDir).filter((f) => f.endsWith('.jsonl')).sort()) {
        result.files += 1;
        const lines = readFileSync(join(journalDir, file), 'utf8').split(/\r?\n/);
        lines.forEach((line, n) => {
          if (!line.trim()) return;
          if (Buffer.byteLength(line) > MAX_EVENT_BYTES) { result.invalid += 1; result.warnings.push(`${file}:${n + 1} ignoré (trop long).`); return; }
          try {
            const ev = JSON.parse(line);
            const at = isoOf(ev?.at);
            if (ev?.v !== 1 || typeof ev.eid !== 'string' || !ID_RE.test(ev.eid) || typeof ev.item !== 'string' || !ID_RE.test(ev.item) || !['upsert', 'delete'].includes(ev.action) || typeof ev.device !== 'string' || !DEVICE_RE.test(ev.device) || !at) throw new Error('forme invalide');
            if (!Number.isInteger(ev.rev) || ev.rev < 1) throw new Error('révision invalide');
            ev.at = at;
            if (ev.at > limit) { result.deferred += 1; result.warnings.push(`${file}:${n + 1} en attente (daté du futur : vérifiez l’horloge de l’appareil « ${ev.device} »).`); return; }
            events.push(ev);
          } catch (e) { result.invalid += 1; result.warnings.push(`${file}:${n + 1} ignoré (${e.message}).`); }
        });
      }
      const seen = new Set(all('SELECT eid FROM memory_imported').map((r) => r.eid));
      const todo = events.filter((e) => !seen.has(e.eid)).sort((a, b) => cmpVersion(a, b) || a.eid.localeCompare(b.eid));
      result.events = todo.length;
      for (const ev of todo) {
        try {
          tx(() => {
            const local = row(ev.item), mine = local && mapItem(local);
            const newer = !mine || cmpVersion(ev, { at: mine.updatedAt, rev: mine.rev, device: mine.device }) > 0;
            if (ev.action === 'delete') {
              // Une suppression est définitive : elle l'emporte sur toute version, même plus récente en apparence (pas de résurrection).
              if (mine?.state === 'deleted') result.superseded += 1;
              else {
                const tomb = { ...(mine ?? { id: ev.item, level: 'company', kind: 'knowledge', nature: 'hypothesis', owner: null, department: null, missionId: null, confidence: 'low', importance: 1, visibility: 'private', readers: [], createdAt: ev.at, lastUsedAt: null, useCount: 0, proposedBy: null, expiresAt: null }), state: 'deleted', title: '[supprimé]', body: '', sources: [], tags: [], source: '', readers: [], rev: Math.max(ev.rev, mine?.rev ?? 0), updatedAt: newer ? ev.at : mine.updatedAt, device: ev.device, sync: true };
                put(tomb); run("UPDATE memory_history SET snapshot = '', note = '' WHERE item_id = ?", ev.item); record(tomb, 'sync.deleted', `appareil:${ev.device}`); result.applied += 1;
              }
            } else {
              const draft = normalizeItem(ev.data ?? {}, { actor: 'user' });
              if (!STATES.includes(ev.data?.state) || ev.data?.id !== ev.item) throw new Error('données incohérentes');
              const incoming = { ...draft, id: ev.item, state: ev.data.state, proposedBy: typeof ev.data.proposedBy === 'string' ? ev.data.proposedBy.slice(0, 64) : null, rev: ev.rev, device: ev.device, createdAt: isoOf(ev.data.createdAt) ?? ev.at, updatedAt: ev.at, lastUsedAt: mine?.lastUsedAt ?? null, useCount: mine?.useCount ?? 0, sync: true };
              if (mine?.state === 'deleted') result.superseded += 1; // supprimé ici : une copie plus ancienne ou tardive ne le ressuscite pas
              else if (newer) { put(incoming); record(incoming, 'sync.imported', `appareil:${ev.device}`); result.applied += 1; }
              else { record({ ...incoming, rev: mine.rev }, 'sync.superseded', `appareil:${ev.device}`, 'Version plus ancienne reçue d’un autre appareil : conservée dans l’historique seulement.'); result.superseded += 1; }
            }
            run('INSERT INTO memory_imported (eid, imported_at) VALUES (?, ?)', ev.eid, now());
          });
        } catch (e) { result.invalid += 1; result.warnings.push(`Événement ${ev.eid.slice(0, 8)} (${ev.device}) ignoré : ${e.message}`); }
      }
      return result;
    },

    // Contrôle de santé (sans rien modifier) : secrets, références orphelines, états incohérents, journal.
    check() {
      const problems = [], notes = [];
      const files = journalDir && existsSync(journalDir) ? readdirSync(journalDir).filter((f) => f.endsWith('.jsonl')).length : 0;
      if (readOnly && schemaVersion() < MEMORY_SCHEMA_VERSION) return { ok: true, problems, notes: ['La mémoire n’est pas encore initialisée sur cet ordinateur (elle le sera au prochain « npm start »).'], journalFiles: files, journalError, total: 0, byLevel: {}, byState: {}, byNature: {}, pending: 0, stale: 0, expired: 0 };
      for (const r of all("SELECT * FROM memory_items WHERE state != 'deleted'")) {
        const i = mapItem(r);
        const secret = findSecret(`${i.title}\n${i.body}\n${i.source}\n${i.tags.join(' ')}\n${i.sources.map((s) => `${s.label} ${s.note ?? ''} ${s.url ?? ''}`).join(' ')}`);
        if (secret) problems.push(`${i.id.slice(0, 8)} « ${i.title.slice(0, 50)} » semble contenir ${secret} — à retirer.`);
        if (i.nature === 'fact' && !i.sources.length) problems.push(`${i.id.slice(0, 8)} « ${i.title.slice(0, 50)} » est un fait sans source.`);
        if (i.owner && !i.owner.startsWith('id:') && !get('SELECT 1 AS ok FROM agent_files WHERE slug = ?', i.owner)) notes.push(`${i.id.slice(0, 8)} : agent « ${i.owner} » absent sur cet ordinateur.`);
        if (i.department && !get('SELECT 1 AS ok FROM departments WHERE name = ?', i.department)) notes.push(`${i.id.slice(0, 8)} : département « ${i.department} » absent sur cet ordinateur.`);
        if (!VISIBILITIES.includes(i.visibility) || !CONFIDENCES.includes(i.confidence)) problems.push(`${i.id.slice(0, 8)} : valeurs invalides.`);
      }
      const queued = readOnly ? 0 : outbox().length;
      if (queued) notes.push(`${queued} changement(s) en attente d’écriture dans le journal (il sera réessayé automatiquement).`);
      return { ok: problems.length === 0, problems, notes, journalFiles: files, journalError, ...this.stats() };
    }
  };
}
