// src/studio-engines.js — choix du moteur par agent ou mission, résolution et disponibilité.
// Les tables sont créées par les migrations de la communication. Les choix restent sur cet ordinateur.
import { CATALOG, DEFAULT_PROVIDER, catalogReason, engineId, parseEngine, resolveEngine } from './engines.js';

const refuse = (message, status) => Object.assign(new Error(message), { status });

export function createEngineStore(db, { clock = () => new Date().toISOString(), emit = () => null } = {}) {
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const fiches = new Map(); // slug → modèle de la fiche, appris à chaque synchronisation des fiches
  const learn = (profiles) => { for (const p of profiles) fiches.set(p.slug, p.model); };
  const slugOf = (agentId) => get('SELECT slug FROM agent_files WHERE agent_id = ?', agentId ?? '')?.slug ?? null;
  const fiche = (agentId) => { const model = fiches.get(slugOf(agentId)); return model ? { provider: DEFAULT_PROVIDER, model } : null; };
  // Le choix d'une mission est rattaché à la mission racine : les sous-missions d'une délégation le partagent.
  const rootMissionOf = (missionId) => (missionId ? get('SELECT r.mission_id AS m FROM comm_tasks t JOIN comm_tasks r ON r.id = t.root_task_id WHERE t.mission_id = ? ORDER BY t.depth, t.created_at LIMIT 1', missionId)?.m ?? missionId : null);
  const choice = (scope, ref) => { const r = ref ? get('SELECT provider, model FROM engine_choices WHERE scope = ? AND ref = ?', scope, ref) : null; return r ? { provider: r.provider, model: r.model } : null; };
  const put = (scope, ref, engine) => {
    if (!engine) run('DELETE FROM engine_choices WHERE scope = ? AND ref = ?', scope, ref);
    else run('INSERT INTO engine_choices (scope, ref, provider, model, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, ref) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at', scope, ref, engine.provider, engine.model, clock());
    return choice(scope, ref);
  };
  const resolve = (agentId, missionId = null, missionOverride) => resolveEngine({
    mission: missionOverride !== undefined ? missionOverride : choice('mission', rootMissionOf(missionId)),
    agent: choice('agent', agentId), fiche: fiche(agentId)
  });
  // Moteur figé sur la tâche ; une tâche antérieure à la migration garde le modèle de la fiche.
  const ofTask = (task) => {
    if (task.provider) return { provider: task.provider, model: task.model, source: task.engineSource ?? 'task' };
    const own = fiche(task.assigneeId); return own ? { ...own, source: 'fiche' } : null;
  };
  // Part du moteur dans l'empreinte d'une demande : vide pour le modèle de la fiche, les empreintes existantes restent valables.
  const keySuffix = (engine, agentId) => (engine && engineId(engine) !== engineId(fiche(agentId)) ? engineId(engine) : '');
  const setAgentChoice = (agentId, input) => {
    if (!slugOf(agentId)) throw refuse('Cet agent n’a pas de fiche : aucun moteur à choisir.', 409);
    const saved = put('agent', agentId, parseEngine(input));
    emit(agentId, 'agent.engine.updated', saved ? `Moteur choisi : ${engineId(saved)}.` : 'Moteur de la fiche rétabli.', 'manual', true);
    return saved;
  };
  const missionEngine = (missionId) => { const root = rootMissionOf(missionId); return { missionId, rootMissionId: root, choice: choice('mission', root) }; };
  const setMissionChoice = (missionId, input) => {
    if (!get('SELECT 1 AS ok FROM missions WHERE id = ?', missionId)) throw refuse('Mission introuvable.', 404);
    put('mission', rootMissionOf(missionId), parseEngine(input));
    return missionEngine(missionId);
  };
  // Choix de mission reçu par le journal : il ne remplace jamais un choix fait ici.
  const adoptMissionChoice = (missionId, engine) => { if (engine && !catalogReason(engine) && !choice('mission', missionId)) put('mission', missionId, engine); };
  const reason = (engine) => catalogReason(engine);
  const catalog = (reasonOf = reason) => CATALOG.map((p) => ({ provider: p.provider, label: p.label, state: p.state, reason: p.reason, models: p.models.map((model) => ({ model, reason: reasonOf({ provider: p.provider, model }) })) }));
  return {
    learn, choice, rootMissionOf, resolve, ofTask, keySuffix, setAgentChoice, setMissionChoice, adoptMissionChoice, missionEngine, reason, catalog,
    missionChoices: () => all("SELECT ref, provider, model FROM engine_choices WHERE scope = 'mission'").map((r) => ({ missionId: r.ref, provider: r.provider, model: r.model }))
  };
}
