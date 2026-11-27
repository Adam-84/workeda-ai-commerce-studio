// src/studio-engines.js — choix du moteur par agent ou mission, résolution et disponibilité.
// Les tables sont créées par les migrations de la communication. Les choix restent sur cet ordinateur.
import { CATALOG, DEFAULT_PROVIDER, catalogReason, cleanSignal, engineId, parseEngine, resolveEngine, signalReason, signalStale } from './engines.js';

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
  const mapSignal = (r) => ({ provider: r.provider, source: r.source, window: r.rate_window, status: r.status, utilization: r.utilization, resetsAt: r.resets_at, overage: Boolean(r.overage), observedAt: r.observed_at, confirmedUntil: r.confirmed_until });
  const recordSignals = (provider, list = []) => {
    for (const raw of list) {
      const s = cleanSignal(raw); if (!s) continue;
      const source = raw.source ?? 'local';
      run(`INSERT INTO provider_signals (provider, source, rate_window, status, utilization, resets_at, overage, observed_at, confirmed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(provider, source, rate_window) DO UPDATE SET status = excluded.status, utilization = excluded.utilization, resets_at = excluded.resets_at, overage = excluded.overage, observed_at = excluded.observed_at,
        confirmed_until = CASE WHEN excluded.status = 'rejected' OR provider_signals.resets_at IS NOT excluded.resets_at THEN NULL ELSE provider_signals.confirmed_until END`,
      provider, source, s.window, s.status, s.utilization, s.resetsAt, Number(s.overage), clock());
      // Plus de dépense supplémentaire en cours : les anciens relevés de dépassement de cette source ne valent plus.
      if (!s.overage) run('UPDATE provider_signals SET overage = 0 WHERE provider = ? AND source = ?', provider, source);
    }
  };
  const quotaReason = (engine, source = 'local') => {
    if (!engine) return '';
    const now = Date.parse(clock());
    for (const r of all('SELECT * FROM provider_signals WHERE provider = ? AND source = ? ORDER BY rate_window', engine.provider, source)) { const why = signalReason(mapSignal(r), engine, now); if (why) return why; }
    return '';
  };
  const signals = () => {
    const now = Date.parse(clock());
    return all('SELECT * FROM provider_signals ORDER BY provider, source, rate_window').map((r) => {
      const s = mapSignal(r), blocking = signalReason(s, { provider: s.provider, model: s.window === 'seven_day_sonnet' ? 'sonnet' : 'opus' }, now);
      // Un refus daté se lève seul à sa remise à zéro : il n'y a rien à confirmer.
      return { ...s, stale: signalStale(s, now), blocking, resumable: Boolean(blocking) && (s.status !== 'rejected' || !s.resetsAt) };
    });
  };
  const resume = (provider, source) => {
    const endOfDay = `${clock().slice(0, 10)}T23:59:59.999Z`;
    const targets = signals().filter((s) => s.provider === provider && s.source === source && s.resumable);
    if (!targets.length) throw refuse('Rien à confirmer : une limite datée se lève seule à sa remise à zéro.', 409);
    for (const s of targets) run('UPDATE provider_signals SET confirmed_until = ? WHERE provider = ? AND source = ? AND rate_window = ?', s.status === 'rejected' ? endOfDay : s.resetsAt ?? endOfDay, provider, source, s.window);
    emit(null, 'engine.resume.confirmed', `Reprise confirmée par le propriétaire (${provider}, ${source}).`, 'manual', true);
    return signals();
  };
  const reason = (engine, source = 'local') => catalogReason(engine) || quotaReason(engine, source);
  const catalog = (reasonOf = (e) => reason(e)) => CATALOG.map((p) => ({ provider: p.provider, label: p.label, state: p.state, reason: p.reason, models: p.models.map((model) => ({ model, reason: reasonOf({ provider: p.provider, model }) })) }));
  return {
    recordSignals, signals, quotaReason, resume, learn, choice, rootMissionOf, resolve, ofTask, keySuffix, setAgentChoice, setMissionChoice, adoptMissionChoice, missionEngine, reason, catalog,
    missionChoices: () => all("SELECT ref, provider, model FROM engine_choices WHERE scope = 'mission'").map((r) => ({ missionId: r.ref, provider: r.provider, model: r.model }))
  };
}
