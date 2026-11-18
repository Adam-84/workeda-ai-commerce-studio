// src/studio-skills.js — tables et requêtes des Skills. Ajoute des tables seulement (CREATE TABLE IF NOT EXISTS) :
// aucune table existante n'est touchée. La bibliothèque sur disque (skills/) fait foi ; la base la reflète et
// garde l'historique, les statistiques déclarées et les résultats de contrôle.
import { randomUUID } from 'node:crypto';
import { hasBlocking } from './skills.js';

export const SKILL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_categories (slug TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS skill_sources (name TEXT PRIMARY KEY, url TEXT, license TEXT, verdict TEXT, notes TEXT);
  CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT, origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', version TEXT NOT NULL, license TEXT, tokens INTEGER NOT NULL, hash TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]', roles TEXT NOT NULL DEFAULT '[]', source_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS skill_versions (id TEXT PRIMARY KEY, skill_name TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, tokens INTEGER NOT NULL, content TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(skill_name, hash));
  CREATE TABLE IF NOT EXISTS agent_skills (agent_id TEXT NOT NULL REFERENCES agents(id), skill_name TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY (agent_id, skill_name));
  CREATE TABLE IF NOT EXISTS skill_events (id TEXT PRIMARY KEY, skill_name TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS skill_events_skill_time ON skill_events(skill_name, created_at);
  CREATE TABLE IF NOT EXISTS skill_usage (id TEXT PRIMARY KEY, skill_name TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), note TEXT NOT NULL DEFAULT '', declared_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS skill_usage_skill ON skill_usage(skill_name, declared_at);
  CREATE TABLE IF NOT EXISTS skill_tests (id TEXT PRIMARY KEY, skill_name TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, passed INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '', tested_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS skill_tests_skill ON skill_tests(skill_name, tested_at);
`;

const now = () => new Date().toISOString();
const json = (text, fallback = []) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback; } catch { return fallback; } };
const notFound = (what) => Object.assign(new Error(`${what} introuvable.`), { status: 404 });

export function createSkillStore(db) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const event = (skill, agentId, kind, detail) => db.prepare('INSERT INTO skill_events (id, skill_name, agent_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), skill, agentId ?? null, kind, detail, now());
  const inTransaction = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
  };
  const mapSkill = (r) => ({
    name: r.name, title: r.title, description: r.description, category: r.category, origin: r.origin, status: r.status, version: r.version,
    license: r.license, tokens: r.tokens, hash: r.hash, dependsOn: json(r.depends_on), roles: json(r.roles), source: r.source_url, updatedAt: r.updated_at
  });
  const agentsOf = (name) => all(`SELECT a.id, a.name, f.slug FROM agent_skills s JOIN agents a ON a.id = s.agent_id LEFT JOIN agent_files f ON f.agent_id = a.id WHERE s.skill_name = ? ORDER BY a.name`, name)
    .map((r) => ({ id: r.id, name: r.name, slug: r.slug }));

  // Résultat de contrôle de structure : une ligne par (Skill, empreinte), donc pas de doublon à chaque démarrage.
  const recordStructureTest = (skill) => {
    if (get("SELECT id FROM skill_tests WHERE skill_name = ? AND kind = 'structure' AND hash = ?", skill.name, skill.hash)) return;
    const issues = [...skill.compat.claude.issues, ...skill.compat.codex.issues.filter((x) => !skill.compat.claude.issues.includes(x)), ...skill.findings.filter((f) => f.severity === 'bloquant').map((f) => f.message)];
    const passed = skill.compat.claude.ok && skill.compat.codex.ok && !hasBlocking(skill.findings);
    db.prepare('INSERT INTO skill_tests (id, skill_name, kind, hash, passed, detail, tested_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), skill.name, 'structure', skill.hash, Number(passed), issues.join(' ; '), now());
  };

  return {
    // Reflète la bibliothèque du disque dans la base. N'écrase aucune donnée : les Skills absents du disque passent « missing ».
    syncSkills(library) {
      const result = { added: [], updated: [], missing: [], restored: [] };
      return inTransaction(() => {
        for (const c of library.categories) if (c?.slug && c?.name) db.prepare('INSERT INTO skill_categories (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name').run(String(c.slug), String(c.name));
        for (const s of library.sources) if (s?.name) db.prepare('INSERT INTO skill_sources (name, url, license, verdict, notes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET url = excluded.url, license = excluded.license, verdict = excluded.verdict, notes = excluded.notes').run(String(s.name), s.url ?? null, s.license ?? null, s.verdict ?? null, s.notes ?? null);
        const seen = new Set();
        for (const s of library.skills) {
          seen.add(s.name);
          const status = s.archived ? 'archived' : 'active';
          const previous = get('SELECT * FROM skills WHERE name = ?', s.name);
          const t = now();
          if (!previous) {
            db.prepare('INSERT INTO skills (name, title, description, category, origin, status, version, license, tokens, hash, depends_on, roles, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(s.name, s.title, s.description, s.category, s.origin, status, s.version, s.license, s.tokens, s.hash, JSON.stringify(s.dependsOn), JSON.stringify(s.roles), s.source, t, t);
            result.added.push(s.name);
            event(s.name, null, 'skill.added', `Skill ajouté (version ${s.version}).`);
          } else {
            const changed = previous.hash !== s.hash || previous.version !== s.version || previous.status !== status;
            if (previous.status === 'missing') { result.restored.push(s.name); event(s.name, null, 'skill.restored', 'Le fichier est de nouveau présent.'); }
            else if (changed) { result.updated.push(s.name); event(s.name, null, previous.status !== status ? (status === 'archived' ? 'skill.archived' : 'skill.unarchived') : 'skill.updated', previous.hash !== s.hash ? `Contenu modifié (version ${s.version}).` : 'Métadonnées modifiées.'); }
            db.prepare('UPDATE skills SET title = ?, description = ?, category = ?, origin = ?, status = ?, version = ?, license = ?, tokens = ?, hash = ?, depends_on = ?, roles = ?, source_url = ?, updated_at = ? WHERE name = ?')
              .run(s.title, s.description, s.category, s.origin, status, s.version, s.license, s.tokens, s.hash, JSON.stringify(s.dependsOn), JSON.stringify(s.roles), s.source, changed ? t : previous.updated_at, s.name);
          }
          // Un même contenu n'a qu'une entrée (clé unique nom + empreinte) : un retour à un ancien texte la retrouve, et
      // l'événement « skill.updated » garde la trace du changement de version.
      if (!get('SELECT id FROM skill_versions WHERE skill_name = ? AND hash = ?', s.name, s.hash)) {
            db.prepare('INSERT INTO skill_versions (id, skill_name, version, hash, tokens, content, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), s.name, s.version, s.hash, s.tokens, s.content, '', t);
          }
          recordStructureTest(s);
        }
        for (const row of all("SELECT name FROM skills WHERE status != 'missing'")) {
          if (seen.has(row.name)) continue;
          db.prepare("UPDATE skills SET status = 'missing', updated_at = ? WHERE name = ?").run(now(), row.name);
          result.missing.push(row.name);
          event(row.name, null, 'skill.missing', 'Le fichier n’est plus dans skills/ (rien n’a été supprimé de la base).');
        }
        return result;
      });
    },
    // Reflète les listes `skills:` des fiches. Une fiche absente ou illisible laisse ses affectations telles quelles.
    syncAgentSkills(profiles) {
      const result = { assigned: [], unassigned: [], unknown: [] };
      const known = new Set(all('SELECT name FROM skills').map((r) => r.name));
      return inTransaction(() => {
        for (const p of profiles) {
          const link = get('SELECT agent_id FROM agent_files WHERE slug = ?', p.slug);
          if (!link) continue;
          const current = new Set(all('SELECT skill_name FROM agent_skills WHERE agent_id = ?', link.agent_id).map((r) => r.skill_name));
          const wanted = new Set(p.skills ?? []);
          for (const name of wanted) {
            if (!known.has(name)) result.unknown.push({ agent: p.slug, skill: name });
            if (current.has(name)) continue;
            db.prepare('INSERT INTO agent_skills (agent_id, skill_name, assigned_at) VALUES (?, ?, ?)').run(link.agent_id, name, now());
            event(name, link.agent_id, 'skill.assigned', `Affecté à ${p.displayName} (fiche ${p.slug}.md).`);
            result.assigned.push({ agent: p.slug, skill: name });
          }
          for (const name of current) {
            if (wanted.has(name)) continue;
            db.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_name = ?').run(link.agent_id, name);
            event(name, link.agent_id, 'skill.unassigned', `Retiré de ${p.displayName} (fiche ${p.slug}.md).`);
            result.unassigned.push({ agent: p.slug, skill: name });
          }
        }
        return result;
      });
    },
    listSkillCategories: () => all('SELECT slug, name FROM skill_categories ORDER BY rowid'),
    listSkillSources: () => all('SELECT name, url, license, verdict, notes FROM skill_sources ORDER BY rowid'),
    listSkills() {
      const uses = new Map(all('SELECT skill_name, COUNT(*) AS n, MAX(declared_at) AS last FROM skill_usage GROUP BY skill_name').map((r) => [r.skill_name, r]));
      const owners = new Map();
      for (const r of all('SELECT s.skill_name, a.id, a.name FROM agent_skills s JOIN agents a ON a.id = s.agent_id ORDER BY a.name')) {
        if (!owners.has(r.skill_name)) owners.set(r.skill_name, []);
        owners.get(r.skill_name).push({ id: r.id, name: r.name });
      }
      const tests = new Map(all("SELECT t.skill_name, t.passed FROM skill_tests t JOIN skills s ON s.name = t.skill_name AND s.hash = t.hash WHERE t.kind = 'structure'").map((r) => [r.skill_name, Boolean(r.passed)]));
      return all('SELECT * FROM skills ORDER BY category, name').map((r) => ({
        ...mapSkill(r), agents: owners.get(r.name) ?? [], declaredUses: uses.get(r.name)?.n ?? 0, lastDeclaredUse: uses.get(r.name)?.last ?? null, structureOk: tests.get(r.name) ?? null
      }));
    },
    getSkill(name) {
      const r = get('SELECT * FROM skills WHERE name = ?', name);
      if (!r) throw notFound('Skill');
      return {
        ...mapSkill(r), agents: agentsOf(name),
        dependents: all('SELECT name, depends_on FROM skills ORDER BY name').filter((x) => json(x.depends_on).includes(name)).map((x) => x.name),
        versions: all('SELECT version, hash, tokens, note, created_at FROM skill_versions WHERE skill_name = ? ORDER BY rowid DESC', name).map((v) => ({ version: v.version, hash: v.hash, tokens: v.tokens, note: v.note, createdAt: v.created_at })),
        events: all('SELECT e.kind, e.detail, e.created_at, e.agent_id, a.name AS agent_name FROM skill_events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.skill_name = ? ORDER BY e.rowid DESC LIMIT 30', name).map((e) => ({ kind: e.kind, detail: e.detail, at: e.created_at, agentId: e.agent_id, agentName: e.agent_name })),
        tests: all('SELECT kind, hash, passed, detail, tested_at FROM skill_tests WHERE skill_name = ? ORDER BY rowid DESC LIMIT 10', name).map((t) => ({ kind: t.kind, hash: t.hash, passed: Boolean(t.passed), detail: t.detail, at: t.tested_at, current: t.hash === r.hash })),
        usage: all('SELECT u.note, u.declared_at, u.agent_id, a.name AS agent_name FROM skill_usage u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.skill_name = ? ORDER BY u.rowid DESC LIMIT 20', name).map((u) => ({ note: u.note, at: u.declared_at, agentId: u.agent_id, agentName: u.agent_name }))
      };
    },
    getSkillVersion(name, hash) {
      const v = get('SELECT * FROM skill_versions WHERE skill_name = ? AND hash = ?', name, hash);
      if (!v) throw notFound('Version');
      return { version: v.version, hash: v.hash, tokens: v.tokens, content: v.content, createdAt: v.created_at };
    },
    listAgentSkills(agentId) {
      if (!get('SELECT id FROM agents WHERE id = ?', agentId)) throw notFound('Agent');
      return all('SELECT s.* FROM agent_skills a JOIN skills s ON s.name = a.skill_name WHERE a.agent_id = ? ORDER BY s.name', agentId).map(mapSkill);
    },
    // Statistique déclarée à la main : Archipel ne voit pas ce que fait un agent, il ne l'invente donc pas.
    declareSkillUse({ skill, agentId = null, note = '' }) {
      if (!get('SELECT name FROM skills WHERE name = ?', skill)) throw notFound('Skill');
      if (agentId && !get('SELECT id FROM agents WHERE id = ?', agentId)) throw notFound('Agent');
      const text = String(note ?? '').trim().slice(0, 500);
      db.prepare('INSERT INTO skill_usage (id, skill_name, agent_id, note, declared_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), skill, agentId, text, now());
      event(skill, agentId, 'skill.use.declared', text || 'Utilisation déclarée à la main.');
      return { skill, agentId, note: text };
    },
    recordSkillEvent: (skill, agentId, kind, detail) => event(skill, agentId, kind, detail),
    recordSkillTest({ skill, kind, passed, detail = '' }) {
      const row = get('SELECT hash FROM skills WHERE name = ?', skill);
      if (!row) throw notFound('Skill');
      db.prepare('INSERT INTO skill_tests (id, skill_name, kind, hash, passed, detail, tested_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), skill, String(kind).slice(0, 40), row.hash, Number(Boolean(passed)), String(detail).slice(0, 1000), now());
    },
    skillStats() {
      const c = get("SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'archived') AS archived, SUM(status = 'missing') AS missing, COALESCE(SUM(CASE WHEN status = 'active' THEN tokens END), 0) AS tokens FROM skills");
      const agentsWith = get('SELECT COUNT(DISTINCT agent_id) AS n FROM agent_skills').n;
      const perAgent = all(`SELECT a.id, a.name, COUNT(s.name) AS skills, COALESCE(SUM(s.tokens), 0) AS tokens FROM agent_skills x JOIN agents a ON a.id = x.agent_id JOIN skills s ON s.name = x.skill_name GROUP BY a.id ORDER BY a.name`);
      return { total: c.total, active: c.active ?? 0, archived: c.archived ?? 0, missing: c.missing ?? 0, libraryTokens: c.tokens, agentsWithSkills: agentsWith, perAgent: perAgent.map((r) => ({ id: r.id, name: r.name, skills: r.skills, preloadedTokens: r.tokens })) };
    }
  };
}
