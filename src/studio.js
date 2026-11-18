import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isValidAppearance } from '../public/sprites.js';
import { isValidIslandStyle, normalizeIslandStyle } from '../public/island-style.js';
import { SKILL_SCHEMA, createSkillStore } from './studio-skills.js';
import { createMemoryStore } from './studio-memory.js';
import { findSecret } from './memory-core.js';

const DEPARTMENTS = [
  ['Direction', 'Pilotage et validations'], ['Catalogue', 'Produits et collections'],
  ['Création', 'Contenus et thème'], ['Marketing', 'Acquisition et campagnes'],
  ['Service client', 'Support et retours'], ['Opérations', 'Commandes et flux'],
  ['Données', 'Analyses et qualité'], ['Laboratoire', 'Expérimentations approuvées']
];

const now = () => new Date().toISOString();
const asBoolean = (value) => Boolean(value);
const mapDepartment = (row) => ({ ...row, enabled: asBoolean(row.enabled) });
const mapAgent = (row) => ({ ...row, enabled: asBoolean(row.enabled), statusSource: row.status_source });
const mapMission = ({ expected_result, context_text, context_links, updated_at, ...row }, collaborators = []) => ({ ...row, requiresApproval: asBoolean(row.requires_approval), assignedTo: row.assigned_to, requestedBy: row.requested_by, expectedResult: expected_result, contextText: context_text, contextLinks: JSON.parse(context_links), updatedAt: updated_at, collaborators });
// Colonnes ajoutées aux missions existantes (ajout seul, valeurs par défaut : les anciennes missions restent lisibles).
const MISSION_COLUMNS = [['objective', "TEXT NOT NULL DEFAULT ''"], ['priority', "TEXT NOT NULL DEFAULT 'normal'"], ['expected_result', "TEXT NOT NULL DEFAULT ''"], ['context_text', "TEXT NOT NULL DEFAULT ''"], ['context_links', "TEXT NOT NULL DEFAULT '[]'"], ['constraints', "TEXT NOT NULL DEFAULT ''"], ['validations', "TEXT NOT NULL DEFAULT ''"], ['updated_at', 'TEXT']];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const MEMORY_KINDS = ['fact', 'decision', 'open'];
// Consignes permanentes de l'utilisateur pour un agent : texte libre qui complète la fiche, sans jamais la réécrire.
const INSTRUCTION_FIELDS = [['objective', 'L’objectif principal'], ['priorities', 'Les priorités'], ['preferences', 'Les préférences de travail'], ['limits', 'Les limites']];
const mapInstructions = (r) => ({ agentId: r.agent_id, objective: r.objective, priorities: r.priorities, preferences: r.preferences, limits: r.limits, updatedAt: r.updated_at });
// Plan d'action : chaque version est figée ; seul l'état des étapes (déclaré par l'utilisateur) évolue sur place.
export const STEP_STATES = ['todo', 'doing', 'blocked', 'done'];
const MAX_STEPS = 30;
const mapTeamMessage = (r) => ({ id: r.id, missionId: r.mission_id, agentId: r.agent_id, body: r.body, source: r.source, createdAt: r.created_at });
const mapMemory = (r) => ({ id: r.id, missionId: r.mission_id, kind: r.kind, body: r.body, sourceAgentId: r.source_agent_id, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at });
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const text = (value, label, max = 4000) => {
  if (value == null) return '';
  if (typeof value !== 'string') throw bad(`${label} : texte attendu.`);
  if (value.trim().length > max) throw bad(`${label} : ${max} caractères au maximum.`);
  return value.trim();
};
// Un lien n'est qu'une référence enregistrée : il n'est jamais ouvert ni lu par le serveur.
const links = (list) => {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad('Les liens doivent être une liste.');
  const out = [];
  for (const raw of list) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s && typeof raw === 'string') continue;
    let url = null; try { url = new URL(s); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || s.length > 2048) throw bad(`Lien invalide : « ${s.slice(0, 80)} ». Indiquez une adresse complète commençant par http:// ou https://.`);
    if (!out.includes(url.href)) out.push(url.href);
  }
  if (out.length > 20) throw bad('20 liens au maximum.');
  return out;
};
const mapMessage = (row) => ({ ...row, fromAgentId: row.from_agent_id, toAgentId: row.to_agent_id, missionId: row.mission_id });

export function createStudio(filename = 'data/workeda.db', options = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, department_id TEXT NOT NULL REFERENCES departments(id), enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'idle', status_source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, title TEXT NOT NULL, requested_by TEXT REFERENCES agents(id), assigned_to TEXT REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'draft', requires_approval INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_agent_id TEXT NOT NULL REFERENCES agents(id), to_agent_id TEXT NOT NULL REFERENCES agents(id), mission_id TEXT REFERENCES missions(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), kind TEXT NOT NULL, detail TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), action TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_appearance (agent_id TEXT PRIMARY KEY REFERENCES agents(id), hair_style TEXT NOT NULL, hair_color TEXT NOT NULL, skin TEXT NOT NULL, eyes TEXT NOT NULL, outfit TEXT NOT NULL, top_color TEXT NOT NULL, accessory TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS island_styles (department_id TEXT PRIMARY KEY REFERENCES departments(id), label TEXT, accent TEXT, floor TEXT, wall TEXT, emblem TEXT, tree TEXT, ground TEXT, lanterns INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_files (agent_id TEXT PRIMARY KEY REFERENCES agents(id), slug TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_messages (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS user_messages_agent_time ON user_messages(agent_id, created_at, id);
    CREATE TABLE IF NOT EXISTS agent_replies (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_replies_agent_time ON agent_replies(agent_id, created_at, id);
    CREATE TABLE IF NOT EXISTS mission_collaborators (mission_id TEXT NOT NULL REFERENCES missions(id), agent_id TEXT NOT NULL REFERENCES agents(id), PRIMARY KEY (mission_id, agent_id));
    CREATE TABLE IF NOT EXISTS mission_memory (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), kind TEXT NOT NULL, body TEXT NOT NULL, source_agent_id TEXT REFERENCES agents(id), created_at TEXT NOT NULL, updated_at TEXT, archived_at TEXT);
    CREATE INDEX IF NOT EXISTS mission_memory_mission_time ON mission_memory(mission_id, created_at);
    CREATE TABLE IF NOT EXISTS mission_discussion (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), agent_id TEXT REFERENCES agents(id), body TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS mission_discussion_mission_time ON mission_discussion(mission_id, created_at);
    CREATE TABLE IF NOT EXISTS mission_plans (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), version INTEGER NOT NULL, origin TEXT NOT NULL, author_agent_id TEXT REFERENCES agents(id), revision_note TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL, missing TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (mission_id, version));
    CREATE TABLE IF NOT EXISTS plan_decisions (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES mission_plans(id), decision TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_instructions (agent_id TEXT PRIMARY KEY REFERENCES agents(id), objective TEXT NOT NULL DEFAULT '', priorities TEXT NOT NULL DEFAULT '', preferences TEXT NOT NULL DEFAULT '', limits TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
  `);
  const tx = (fn) => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } };
  const have = new Set(db.prepare('PRAGMA table_info(missions)').all().map((c) => c.name));
  const missing = MISSION_COLUMNS.filter(([name]) => !have.has(name));
  if (missing.length) tx(() => { for (const [name, type] of missing) db.exec(`ALTER TABLE missions ADD COLUMN ${name} ${type}`); });
  db.exec(SKILL_SCHEMA);
  const seeded = db.prepare('SELECT COUNT(*) AS count FROM departments').get().count;
  if (seeded === 0) {
    const insert = db.prepare('INSERT INTO departments (id, name, description, created_at) VALUES (?, ?, ?, ?)');
    for (const [name, description] of DEPARTMENTS) insert.run(randomUUID(), name, description, now());
  }

  const emit = (agentId, kind, detail, source = 'manual', verified = true) => {
    db.prepare('INSERT INTO events (id, agent_id, kind, detail, source, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), agentId ?? null, kind, detail, source, Number(verified), now());
  };
  const one = (sql, id, map = (x) => x) => { const result = db.prepare(sql).get(id); return result && map(result); };

  const mapAppearance = (r) => ({ agentId: r.agent_id, hairStyle: r.hair_style, hairColor: r.hair_color, skin: r.skin, eyes: r.eyes, outfit: r.outfit, topColor: r.top_color, accessory: r.accessory, updatedAt: r.updated_at });
  const requireAgent = (id) => { if (!one('SELECT id FROM agents WHERE id = ?', id)) throw Object.assign(new Error('Agent introuvable.'), { status: 404 }); };

  const mapIslandStyle = (r) => ({ departmentId: r.department_id, label: r.label, accent: r.accent, floor: r.floor, wall: r.wall, emblem: r.emblem, tree: r.tree, ground: r.ground, lanterns: r.lanterns === null ? null : Boolean(r.lanterns), updatedAt: r.updated_at });
  const requireDepartment = (id) => { const d = one('SELECT id, name FROM departments WHERE id = ?', id); if (!d) throw Object.assign(new Error('Département introuvable.'), { status: 404 }); return d; };

  const getMission = (id) => one('SELECT * FROM missions WHERE id = ?', id, (r) => mapMission(r, db.prepare('SELECT agent_id FROM mission_collaborators WHERE mission_id = ? ORDER BY rowid').all(id).map((c) => c.agent_id)));
  const setCollaborators = (id, agentIds) => {
    db.prepare('DELETE FROM mission_collaborators WHERE mission_id = ?').run(id);
    const add = db.prepare('INSERT INTO mission_collaborators (mission_id, agent_id) VALUES (?, ?)');
    for (const agentId of agentIds) add.run(id, agentId);
  };
  const agentRef = (id) => { if (typeof id !== 'string') throw bad('Agent invalide.'); requireAgent(id); return id; };
  const missionFields = (m) => {
    const title = text(m.title, 'Le titre', 120); if (!title) throw bad('Le titre de mission est obligatoire.');
    const priority = m.priority ?? 'normal'; if (!PRIORITIES.includes(priority)) throw bad('Priorité invalide.');
    const assignedTo = m.assignedTo ? agentRef(m.assignedTo) : null;
    if (m.collaborators != null && !Array.isArray(m.collaborators)) throw bad('Les collaborateurs doivent être une liste.');
    const collaborators = [...new Set(m.collaborators ?? [])].filter((c) => c !== assignedTo).map(agentRef); // le responsable n'est pas aussi collaborateur
    return { title, priority, assignedTo, collaborators, objective: text(m.objective, 'L’objectif'), expectedResult: text(m.expectedResult, 'Le résultat attendu'), contextText: text(m.contextText, 'Le contexte'), contextLinks: links(m.contextLinks), constraints: text(m.constraints, 'Les contraintes'), validations: text(m.validations, 'Les validations'), requiresApproval: m.requiresApproval !== false };
  };
  const getInstructions = (agentId) => { requireAgent(agentId); return one('SELECT * FROM agent_instructions WHERE agent_id = ?', agentId, mapInstructions) ?? { agentId, objective: '', priorities: '', preferences: '', limits: '', updatedAt: null }; };
  const decisionsOf = (planId) => db.prepare('SELECT decision, note, created_at FROM plan_decisions WHERE plan_id = ? ORDER BY created_at, rowid').all(planId).map((d) => ({ decision: d.decision, note: d.note, createdAt: d.created_at }));
  const mapPlan = (r) => {
    const decisions = decisionsOf(r.id), last = decisions.at(-1);
    return { id: r.id, missionId: r.mission_id, version: r.version, origin: r.origin, authorAgentId: r.author_agent_id, revisionNote: r.revision_note, steps: JSON.parse(r.steps), missing: r.missing, createdAt: r.created_at, decisions, status: last?.decision ?? 'proposed', decidedAt: last?.createdAt ?? null };
  };
  const latestPlan = (missionId) => { const r = db.prepare('SELECT * FROM mission_plans WHERE mission_id = ? ORDER BY version DESC LIMIT 1').get(missionId); return r ? mapPlan(r) : null; };
  const planSteps = (list, previous = []) => {
    if (!Array.isArray(list)) throw bad('Les étapes doivent être une liste.');
    if (list.length > MAX_STEPS) throw bad(`${MAX_STEPS} étapes au maximum.`);
    const known = new Map(previous.map((s) => [s.id, s]));
    return list.map((s, i) => {
      if (!s || typeof s !== 'object') throw bad(`Étape ${i + 1} invalide.`);
      const action = text(s.action, `Étape ${i + 1}, action`, 500); if (!action) throw bad(`Étape ${i + 1} : l’action est obligatoire.`);
      const state = s.state ?? known.get(s.id)?.state ?? 'todo'; if (!STEP_STATES.includes(state)) throw bad(`Étape ${i + 1} : état invalide.`);
      const id = typeof s.id === 'string' && /^[\da-f-]{36}$/.test(s.id) ? s.id : randomUUID();
      return { id, action, agentId: s.agentId ? agentRef(s.agentId) : null, expected: text(s.expected, `Étape ${i + 1}, résultat attendu`, 1000), prerequisites: text(s.prerequisites, `Étape ${i + 1}, prérequis`, 1000), state, stateUpdatedAt: state === known.get(id)?.state ? known.get(id).stateUpdatedAt ?? null : null };
    });
  };
  const requireMission = (id) => { if (!one('SELECT id FROM missions WHERE id = ?', id)) throw Object.assign(new Error('Mission introuvable.'), { status: 404 }); };
  const getMemory = (id) => one('SELECT * FROM mission_memory WHERE id = ?', id, mapMemory);
  const memoryFields = (e) => {
    if (!MEMORY_KINDS.includes(e.kind)) throw bad('Type de note invalide.');
    const body = text(e.body, 'La note'); if (!body) throw bad('Écrivez la note avant de l’ajouter.');
    const secret = findSecret(body); // ces notes sont relues par les agents : jamais de mot de passe, clé ou numéro sensible
    if (secret) throw bad(`Cette note semble contenir ${secret} : retirez-le, la mémoire ne garde aucun secret.`);
    return { kind: e.kind, body, sourceAgentId: e.sourceAgentId ? agentRef(e.sourceAgentId) : null }; // source déclarée par la personne, pas par l'agent
  };

  const memory = createMemoryStore(db, { filename, journalDir: options.memoryJournalDir ?? null, device: options.device ?? process.env.WORKEDA_DEVICE ?? null });

  return {
    ...createSkillStore(db),
    memory,
    listDepartments: () => db.prepare('SELECT * FROM departments ORDER BY created_at').all().map(mapDepartment),
    createDepartment({ name, description = '' }) {
      if (!name?.trim()) throw new Error('Le nom du département est obligatoire.');
      const id = randomUUID(); db.prepare('INSERT INTO departments (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(id, name.trim(), description.trim(), now());
      return one('SELECT * FROM departments WHERE id = ?', id, mapDepartment);
    },
    updateDepartment(id, { name, description, enabled }) {
      const existing = one('SELECT * FROM departments WHERE id = ?', id); if (!existing) throw new Error('Département introuvable.');
      db.prepare('UPDATE departments SET name = ?, description = ?, enabled = ? WHERE id = ?').run(name?.trim() || existing.name, description?.trim() ?? existing.description, enabled === undefined ? existing.enabled : Number(enabled), id);
      return one('SELECT * FROM departments WHERE id = ?', id, mapDepartment);
    },
    listAgents: () => db.prepare(`SELECT a.*, d.name AS department_name FROM agents a JOIN departments d ON d.id=a.department_id ORDER BY a.created_at DESC`).all().map(mapAgent),
    hireAgent({ name, role, departmentId }) {
      if (!name?.trim() || !role?.trim() || !departmentId) throw new Error('Nom, rôle et département sont obligatoires.');
      if (!one('SELECT id FROM departments WHERE id = ?', departmentId)) throw new Error('Département introuvable.');
      const id = randomUUID(); const timestamp = now();
      db.prepare('INSERT INTO agents (id, name, role, department_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name.trim(), role.trim(), departmentId, timestamp, timestamp);
      emit(id, 'agent.hired', `${name.trim()} a été recruté.`, 'manual', true);
      return one('SELECT * FROM agents WHERE id = ?', id, mapAgent);
    },
    updateAgent(id, { name, role, departmentId, enabled }) {
      const existing = one('SELECT * FROM agents WHERE id = ?', id); if (!existing) throw new Error('Agent introuvable.');
      db.prepare('UPDATE agents SET name=?, role=?, department_id=?, enabled=?, updated_at=? WHERE id=?').run(name?.trim() || existing.name, role?.trim() || existing.role, departmentId || existing.department_id, enabled === undefined ? existing.enabled : Number(enabled), now(), id);
      emit(id, enabled === false ? 'agent.disabled' : 'agent.updated', 'Configuration mise à jour.', 'manual', true);
      return one('SELECT * FROM agents WHERE id = ?', id, mapAgent);
    },
    recordActivity({ agentId, status, source, verified, detail = '' }) {
      if (!['idle', 'working', 'waiting', 'blocked'].includes(status)) throw new Error('Statut invalide.');
      if (!verified) throw new Error('Une activité externe doit être vérifiée avant affichage.');
      if (!['claude', 'codex', 'shopify', 'manual'].includes(source)) throw new Error('Source inconnue.');
      if (!one('SELECT id FROM agents WHERE id = ?', agentId)) throw new Error('Agent introuvable.');
      db.prepare('UPDATE agents SET status=?, status_source=?, updated_at=? WHERE id=?').run(status, source, now(), agentId);
      emit(agentId, 'activity.recorded', detail || `Statut ${status}`, source, true);
      return one('SELECT * FROM agents WHERE id = ?', agentId, mapAgent);
    },
    listEvents: (agentId) => db.prepare('SELECT * FROM events WHERE agent_id = ? ORDER BY rowid DESC').all(agentId),
    // Enregistrement seul : créer ou modifier une mission ne sollicite aucun agent ni aucune IA.
    createMission(input = {}) {
      const m = missionFields(input), id = randomUUID();
      tx(() => {
        db.prepare('INSERT INTO missions (id, title, requested_by, assigned_to, requires_approval, created_at, objective, priority, expected_result, context_text, context_links, constraints, validations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, m.title, input.requestedBy ?? null, m.assignedTo, Number(m.requiresApproval), now(), m.objective, m.priority, m.expectedResult, m.contextText, JSON.stringify(m.contextLinks), m.constraints, m.validations);
        setCollaborators(id, m.collaborators);
      });
      if (m.assignedTo) emit(m.assignedTo, 'mission.assigned', m.title, 'manual', true);
      return getMission(id);
    },
    updateMission(id, input = {}) {
      const existing = getMission(id); if (!existing) throw Object.assign(new Error('Mission introuvable.'), { status: 404 });
      const m = missionFields({ ...existing, ...input });
      tx(() => {
        db.prepare('UPDATE missions SET title=?, assigned_to=?, requires_approval=?, objective=?, priority=?, expected_result=?, context_text=?, context_links=?, constraints=?, validations=?, updated_at=? WHERE id=?')
          .run(m.title, m.assignedTo, Number(m.requiresApproval), m.objective, m.priority, m.expectedResult, m.contextText, JSON.stringify(m.contextLinks), m.constraints, m.validations, now(), id);
        setCollaborators(id, m.collaborators);
      });
      if (m.assignedTo) emit(m.assignedTo, m.assignedTo === existing.assignedTo ? 'mission.updated' : 'mission.assigned', m.title, 'manual', true);
      return getMission(id);
    },
    // Mémoire : notes saisies à la main, corrigées ou archivées, jamais effacées. Aucun agent ne la lit pour l'instant.
    listMemory(missionId) { requireMission(missionId); return db.prepare('SELECT * FROM mission_memory WHERE mission_id = ? ORDER BY created_at DESC, rowid DESC').all(missionId).map(mapMemory); },
    addMemory(missionId, input = {}) {
      requireMission(missionId);
      const e = memoryFields(input), id = randomUUID();
      db.prepare('INSERT INTO mission_memory (id, mission_id, kind, body, source_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, missionId, e.kind, e.body, e.sourceAgentId, now());
      return getMemory(id);
    },
    updateMemory(missionId, entryId, input = {}) {
      const existing = getMemory(entryId);
      if (!existing || existing.missionId !== missionId) throw Object.assign(new Error('Note introuvable.'), { status: 404 });
      if (typeof input.archived === 'boolean') { // archiver ou restaurer, sans toucher au texte
        db.prepare('UPDATE mission_memory SET archived_at = ? WHERE id = ?').run(input.archived ? existing.archivedAt ?? now() : null, entryId);
        return getMemory(entryId);
      }
      const e = memoryFields({ ...existing, ...input });
      if (e.kind !== existing.kind || e.body !== existing.body || e.sourceAgentId !== existing.sourceAgentId) // « corrigée le » seulement si quelque chose change
        db.prepare('UPDATE mission_memory SET kind = ?, body = ?, source_agent_id = ?, updated_at = ? WHERE id = ?').run(e.kind, e.body, e.sourceAgentId, now(), entryId);
      return getMemory(entryId);
    },
    // Discussion d'équipe d'une mission : vos messages (agent_id NULL) et les réponses des agents désignés.
    listDiscussion(missionId) { requireMission(missionId); return db.prepare('SELECT * FROM mission_discussion WHERE mission_id = ? ORDER BY created_at, rowid').all(missionId).map(mapTeamMessage); },
    postDiscussion(missionId, { body } = {}) {
      requireMission(missionId);
      const t = text(body, 'Le message', 20000); if (!t) throw bad('Écrivez un message avant de l’envoyer.');
      const id = randomUUID(); db.prepare('INSERT INTO mission_discussion (id, mission_id, agent_id, body, source, created_at) VALUES (?, ?, NULL, ?, ?, ?)').run(id, missionId, t, 'user', now());
      return one('SELECT * FROM mission_discussion WHERE id = ?', id, mapTeamMessage);
    },
    // Réponse réellement produite par un modèle : appelée par le serveur seulement.
    saveDiscussionReply(missionId, agentId, body, source) {
      requireMission(missionId); requireAgent(agentId);
      const id = randomUUID(); db.prepare('INSERT INTO mission_discussion (id, mission_id, agent_id, body, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, missionId, agentId, body, source, now());
      emit(agentId, 'team.reply.sent', `Réponse dans la discussion de « ${getMission(missionId).title} »`, source, true);
      return one('SELECT * FROM mission_discussion WHERE id = ?', id, mapTeamMessage);
    },
    getMission: (id) => getMission(id),
    getInstructions,
    // Plan d'action. Toute modification du contenu crée une nouvelle version ; les versions précédentes et leurs décisions restent.
    listPlans(missionId) { requireMission(missionId); return db.prepare('SELECT * FROM mission_plans WHERE mission_id = ? ORDER BY version DESC').all(missionId).map(mapPlan); },
    currentPlan(missionId) { requireMission(missionId); return latestPlan(missionId); },
    savePlan(missionId, input = {}, { origin = 'user', authorAgentId = null, revisionNote = '' } = {}) {
      requireMission(missionId);
      const previous = latestPlan(missionId), steps = planSteps(input?.steps, previous?.steps);
      if (!steps.length) throw bad('Le plan doit contenir au moins une étape.');
      const id = randomUUID(), version = (previous?.version ?? 0) + 1;
      db.prepare('INSERT INTO mission_plans (id, mission_id, version, origin, author_agent_id, revision_note, steps, missing, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, missionId, version, origin === 'ai' ? 'ai' : 'user', authorAgentId, text(revisionNote, 'Les indications', 2000), JSON.stringify(steps), text(input?.missing, 'Les informations manquantes', 4000), now());
      return mapPlan(db.prepare('SELECT * FROM mission_plans WHERE id = ?').get(id));
    },
    // Avancement déclaré par l'utilisateur, sur la version courante seulement ; ne crée pas de version.
    setStepState(missionId, planId, stepId, state) {
      const plan = latestPlan(missionId);
      if (!plan || plan.id !== planId) throw Object.assign(new Error('Seule la version courante du plan peut être suivie.'), { status: 409 });
      if (!STEP_STATES.includes(state)) throw bad('État invalide.');
      const step = plan.steps.find((s) => s.id === stepId); if (!step) throw Object.assign(new Error('Étape introuvable.'), { status: 404 });
      step.state = state; step.stateUpdatedAt = now();
      db.prepare('UPDATE mission_plans SET steps = ? WHERE id = ?').run(JSON.stringify(plan.steps), planId);
      return latestPlan(missionId);
    },
    // Décision de l'utilisateur sur une version précise. Elle ne lance rien et n'accorde aucune permission.
    decidePlan(missionId, planId, { decision, note = '' } = {}) {
      const plan = latestPlan(missionId);
      if (!plan || plan.id !== planId) throw Object.assign(new Error('Cette version n’est plus la version courante : décidez sur la dernière.'), { status: 409 });
      if (!['validated', 'rejected'].includes(decision)) throw bad('Décision invalide.');
      db.prepare('INSERT INTO plan_decisions (id, plan_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), planId, decision, text(note, 'Le commentaire', 2000), now());
      return latestPlan(missionId);
    },
    // Un champ absent garde sa valeur ; un champ vide l'efface. Aucune permission n'en découle : seul le texte de consigne change.
    setInstructions(agentId, input = {}) {
      const existing = getInstructions(agentId), v = Object.fromEntries(INSTRUCTION_FIELDS.map(([k, label]) => [k, text((input ?? {})[k] ?? existing[k], label, 2000)]));
      db.prepare(`INSERT INTO agent_instructions (agent_id, objective, priorities, preferences, limits, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET objective = excluded.objective, priorities = excluded.priorities, preferences = excluded.preferences, limits = excluded.limits, updated_at = excluded.updated_at`)
        .run(agentId, v.objective, v.priorities, v.preferences, v.limits, now());
      emit(agentId, 'agent.instructions.updated', 'Consignes modifiées.', 'manual', true);
      return getInstructions(agentId);
    },
    listMissions: () => {
      const team = new Map();
      for (const r of db.prepare('SELECT mission_id, agent_id FROM mission_collaborators ORDER BY rowid').all()) team.set(r.mission_id, [...(team.get(r.mission_id) ?? []), r.agent_id]);
      return db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all().map((r) => mapMission(r, team.get(r.id)));
    },
    sendMessage({ fromAgentId, toAgentId, missionId = null, body }) {
      if (!body?.trim()) throw new Error('Le message est obligatoire.');
      const id = randomUUID(); db.prepare('INSERT INTO messages (id, from_agent_id, to_agent_id, mission_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, fromAgentId, toAgentId, missionId, body.trim(), now());
      emit(toAgentId, 'message.received', body.trim(), 'manual', true);
      return one('SELECT * FROM messages WHERE id = ?', id, mapMessage);
    },
    listMessages: (missionId) => db.prepare('SELECT * FROM messages WHERE mission_id = ? ORDER BY created_at ASC').all(missionId).map(mapMessage),
    listRecentMessages: ({ missionId = null, limit = 200 } = {}) => db.prepare('SELECT * FROM messages WHERE (? IS NULL OR mission_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT ?').all(missionId, missionId, Math.min(Math.max(Number(limit) || 200, 1), 500)).map(mapMessage),
    sendUserMessage(agentId, { body }) {
      requireAgent(agentId);
      if (typeof body !== 'string' || !body.trim()) throw new Error('Écrivez un message avant de l’envoyer.');
      const id = randomUUID(), created_at = now();
      db.prepare('INSERT INTO user_messages (id, agent_id, body, created_at) VALUES (?, ?, ?, ?)').run(id, agentId, body.trim(), created_at);
      return { id: `user:${id}`, body: body.trim(), created_at, senderType: 'user', fromAgentId: null, toAgentId: agentId };
    },
    // Réponse réellement produite par un modèle : appelée par le serveur seulement, jamais depuis une route client.
    saveAgentReply(agentId, body, source) {
      requireAgent(agentId);
      const id = randomUUID(), created_at = now();
      db.prepare('INSERT INTO agent_replies (id, agent_id, body, source, created_at) VALUES (?, ?, ?, ?, ?)').run(id, agentId, body, source, created_at);
      emit(agentId, 'reply.sent', 'Réponse à l’utilisateur', source, true);
      return { id: `assistant:${id}`, body, created_at, senderType: 'assistant', fromAgentId: agentId, toAgentId: null };
    },
    listConversation(agentId, before = null) {
      requireAgent(agentId);
      let date = null, key = null;
      if (before !== null) {
        try {
          if (typeof before !== 'string' || before.length > 512 || !/^[\w-]+$/.test(before)) throw new Error();
          const cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));
          if (typeof cursor.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.createdAt) || !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.id !== 'string' || !/^(user|agent|assistant):[\da-f-]{36}$/.test(cursor.id)) throw new Error();
          date = cursor.createdAt; key = cursor.id;
        } catch { throw new Error('Historique invalide. Rouvrez la discussion.'); }
      }
      const rows = db.prepare(`SELECT * FROM (
        SELECT 'agent:' || id AS id, body, created_at, 'agent' AS senderType, from_agent_id AS fromAgentId, to_agent_id AS toAgentId
        FROM messages WHERE from_agent_id = ? OR to_agent_id = ?
        UNION ALL
        SELECT 'user:' || id, body, created_at, 'user', NULL, agent_id FROM user_messages WHERE agent_id = ?
        UNION ALL
        SELECT 'assistant:' || id, body, created_at, 'assistant', agent_id, NULL FROM agent_replies WHERE agent_id = ?
      ) WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT 51`).all(agentId, agentId, agentId, agentId, date, date, date, key);
      const items = rows.slice(0, 50).map((r) => ({ ...r }));
      const last = items.at(-1);
      const nextCursor = rows.length > 50 ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null;
      return { items, nextCursor };
    },
    listAppearances: () => db.prepare('SELECT * FROM agent_appearance').all().map(mapAppearance),
    setAppearance(agentId, look) {
      requireAgent(agentId);
      if (!isValidAppearance(look)) throw Object.assign(new Error('Apparence invalide.'), { status: 400 });
      db.prepare(`INSERT INTO agent_appearance (agent_id, hair_style, hair_color, skin, eyes, outfit, top_color, accessory, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET hair_style = excluded.hair_style, hair_color = excluded.hair_color, skin = excluded.skin, eyes = excluded.eyes, outfit = excluded.outfit, top_color = excluded.top_color, accessory = excluded.accessory, updated_at = excluded.updated_at`)
        .run(agentId, look.hairStyle, look.hairColor, look.skin, look.eyes, look.outfit, look.topColor, look.accessory, now());
      emit(agentId, 'agent.appearance.updated', 'Apparence modifiée.', 'manual', true);
      return one('SELECT * FROM agent_appearance WHERE agent_id = ?', agentId, mapAppearance);
    },
    clearAppearance(agentId) {
      requireAgent(agentId);
      db.prepare('DELETE FROM agent_appearance WHERE agent_id = ?').run(agentId);
      emit(agentId, 'agent.appearance.reset', 'Apparence automatique rétablie.', 'manual', true);
      return { agentId, reset: true };
    },
    listIslandStyles: () => db.prepare('SELECT * FROM island_styles').all().map(mapIslandStyle),
    listIslandEvents: () => db.prepare("SELECT kind, detail, source FROM events WHERE agent_id IS NULL AND kind LIKE 'island.style.%' ORDER BY rowid DESC").all(),
    setIslandStyle(departmentId, input) {
      const dept = requireDepartment(departmentId);
      if (!isValidIslandStyle(input)) throw Object.assign(new Error('Style d’île invalide.'), { status: 400 });
      const s = normalizeIslandStyle(input);
      db.prepare(`INSERT INTO island_styles (department_id, label, accent, floor, wall, emblem, tree, ground, lanterns, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(department_id) DO UPDATE SET label = excluded.label, accent = excluded.accent, floor = excluded.floor, wall = excluded.wall, emblem = excluded.emblem, tree = excluded.tree, ground = excluded.ground, lanterns = excluded.lanterns, updated_at = excluded.updated_at`)
        .run(departmentId, s.label, s.accent, s.floor, s.wall, s.emblem, s.tree, s.ground, s.lanterns === null ? null : Number(s.lanterns), now());
      emit(null, 'island.style.updated', `Style de l’île ${dept.name} modifié.`, 'manual', true);
      return one('SELECT * FROM island_styles WHERE department_id = ?', departmentId, mapIslandStyle);
    },
    clearIslandStyle(departmentId) {
      const dept = requireDepartment(departmentId);
      db.prepare('DELETE FROM island_styles WHERE department_id = ?').run(departmentId);
      emit(null, 'island.style.reset', `Identité d’origine de l’île ${dept.name} rétablie.`, 'manual', true);
      return { departmentId, reset: true };
    },
    listAgentFiles: () => db.prepare('SELECT agent_id, slug FROM agent_files ORDER BY slug').all().map((r) => ({ agentId: r.agent_id, slug: r.slug })),
    // Relie chaque fiche .claude/agents/<slug>.md à un agent. Ne modifie ni ne supprime jamais un agent existant.
    syncAgentFiles(profiles) {
      const result = { created: [], linked: [], warnings: [] };
      const link = db.prepare('INSERT INTO agent_files (agent_id, slug, linked_at) VALUES (?, ?, ?)');
      db.exec('BEGIN');
      try {
        for (const p of profiles) {
          if (one('SELECT slug FROM agent_files WHERE slug = ?', p.slug)) continue; // 1. déjà lié : rien ne change
          const wanted = p.displayName.toLocaleLowerCase('fr');
          const free = db.prepare('SELECT id, name FROM agents WHERE id NOT IN (SELECT agent_id FROM agent_files) ORDER BY created_at').all();
          const same = free.find((a) => a.name.toLocaleLowerCase('fr') === wanted);
          if (same) { link.run(same.id, p.slug, now()); result.linked.push(p.slug); continue; } // 2. même prénom : liaison seule
          const dept = one('SELECT id FROM departments WHERE name = ?', p.department);
          if (!dept) { result.warnings.push({ file: `${p.slug}.md`, reason: `département inconnu : ${p.department}` }); continue; }
          const id = randomUUID(), timestamp = now(); // 3. création
          db.prepare('INSERT INTO agents (id, name, role, department_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, p.displayName, p.role, dept.id, timestamp, timestamp);
          link.run(id, p.slug, timestamp);
          emit(id, 'agent.hired', `recruté depuis .claude/agents/${p.slug}.md`, 'manual', true);
          result.created.push(p.slug);
        }
        db.exec('COMMIT');
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
      return result;
    },
    close: () => db.close()
  };
}
