// src/comm-run.js — exécute réellement les tâches et les réponses des agents (Claude Code, abonnement existant, aucune API payante).
// Règles d'or :
//   - rien ne part tout seul : un message simple ne lance aucune IA ; seule une tâche approuvée ou une demande du propriétaire le fait ;
//   - un agent ne contacte personne directement : il demande, le Studio contrôle (droits de sa fiche, profondeur, doublons, quotas) ;
//   - tout ce qui vient d'un autre agent, d'un message ou du web est cadré comme donnée non fiable ;
//   - un résultat n'est « vérifié » que si le Studio le constate (outils réellement appelés), jamais sur parole.
import { runClaude as realClaude, fichePrompt, systemPrompt } from './claude-reply.js';
import { scrubContacts } from './catalog-privacy.js';
import { catalogPrompt } from './shop-readonly.js';
import {
  LIMITS, WEB_TOOLS, bad, taskSystemPrompt, taskPrompt, replyPrompt, parseAgentOutput, observeTools, evaluateResult, resolveAgent
} from './comm-core.js';

const TRANSIENT = /surcharg|à temps|n’a pas pu répondre|n'a pas pu répondre|réponse vide|code de sortie/i;
const short = (s, n) => { s = scrubContacts(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

const NOT_SHARED = '[Résultat issu de données DSers/17TRACK/imports/Shopify Admin : non transmis (accès différent ou tâche qui lit le web).]';
export function createOrchestrator({ studio, profiles = () => [], runner = realClaude, memoryFor = () => '', maxActive = LIMITS.maxActive, pumpEveryMs = 0, canRun = () => true, agentReady = () => true } = {}) {
  const comm = studio.comm;
  const active = new Map();      // clé d'exécution → { agentId, runId, taskId, threadId, kind, startedAt }
  const inflight = new Set();
  let pumping = false, timer = null, lastPump = { at: null, quota: false };

  const profileOf = (agentId) => { const slug = comm.slugOf(agentId); return slug ? profiles().find((p) => p.slug === slug) ?? null : null; };
  const webToolsOf = (profile) => (profile?.tools ?? []).filter((t) => WEB_TOOLS.includes(t));
  const mayDelegate = (profile, slug) => Boolean(profile) && (profile.collaboratesAll || profile.collaborates.includes(slug));
  const busyAgents = () => new Set([...active.values()].map((a) => a.agentId));
  const roster = () => studio.listAgents().filter((a) => a.enabled && comm.slugOf(a.id)).map((a) => ({ id: a.id, name: a.name, role: a.role, slug: comm.slugOf(a.id) }));
  const setActivity = (agentId, status, detail) => { try { studio.recordActivity({ agentId, status, source: 'claude', verified: true, detail }); } catch { /* l'agent a pu disparaître : sans conséquence */ } };
  const participants = (t) => [...new Set([...t.members])];
  // Le résultat d'une tâche revient à l'agent qui l'a demandée ; une tâche demandée par le propriétaire n'a pas de destinataire agent.
  const asker = (task) => (task.requestedBy !== 'user' && task.requestedBy !== task.assigneeId ? [task.requestedBy] : []);
  const privateMission = (missionId) => Boolean(missionId) && comm.listTasks({ missionId }).some((t) => t.requestedBy !== 'user' && (t.withIntegrations ?? []).length);

  // --- tâches --------------------------------------------------------------------------------------------------------------------------------------
  function buildTask(task) {
    const rawMission = studio.getMission(task.missionId);
    const mission = privateMission(task.missionId) ? { ...rawMission, title: 'Sous-mission issue des intégrations', objective: '' } : rawMission;
    const thread = comm.thread(task.threadId), me = comm.agentInfo(task.assigneeId), profile = profileOf(task.assigneeId);
    const requester = task.requestedBy === 'user' ? { type: 'user' } : { type: 'agent', name: comm.nameOf(task.requestedBy) };
    const deps = task.dependsOn.map((id) => {
      const d = comm.task(id), r = comm.resultOf(id);
      return { agentName: comm.nameOf(d.assigneeId), title: d.title, state: d.state === 'done' ? 'done' : 'review', verified: Boolean(r?.verified), report: r?.body ?? '', resultId: r?.id ?? null, sources: r?.sources ?? [], integrations: d.withIntegrations ?? [] };
    });
    // Seulement ce qui a été ADRESSÉ à cet agent (ou écrit par lui) : un participant ajouté après coup ne reçoit pas l'historique du fil.
    const visible = comm.visibleMessages(task.threadId, task.assigneeId, 100);
    const shown = visible.filter((m) => !(m.taskId === task.id && m.kind === 'delegation')).slice(-8);
    const recent = shown.map((m) => ({ who: m.senderType === 'agent' ? comm.nameOf(m.senderAgentId) : 'Propriétaire', at: m.createdAt, body: m.body, kind: m.kind, integrations: (m.taskId && comm.task(m.taskId)?.withIntegrations) || [] }));
    // Messages réellement présents dans le prompt (fil récent, résultats des tâches attendues, demande elle-même) : seuls ceux-là seront accusés.
    const included = new Set([...shown.map((m) => m.id), ...visible.filter((m) => (m.kind === 'result' && task.dependsOn.includes(m.taskId)) || (m.kind === 'delegation' && m.taskId === task.id)).map((m) => m.id)]);
    const web = task.allowWeb ? webToolsOf(profile) : [];
    const catalog = task.withCatalog ? studio.shop?.latest() ?? null : null;
    // Intégrations (DSers, 17TRACK) : accès vérifié ICI, côté serveur, agent par agent ; relevés déjà en cache (aucun appel réseau, aucun quota consommé).
    // Une exécution qui lit le web n'en reçoit aucune : une page piégée ne doit pas pouvoir faire sortir des données fournisseur.
    const wantsInts = (task.withIntegrations ?? []).length > 0 && Boolean(studio.integrations);
    const ints = wantsInts && !task.allowWeb ? studio.integrations.promptFor({ agentSlug: profile.slug, integrations: task.withIntegrations }) : null;
    const intsNote = wantsInts && task.allowWeb ? '[Données DSers/17TRACK/imports/Shopify Admin NON fournies : cette tâche lit le web, ce qui interdit de leur donner accès. N\'en invente aucune.]' : '';
    // Provenance : un résultat ou un message issu de données DSers/17TRACK/imports/Shopify Admin n'est transmis qu'à une tâche qui a la MÊME demande, l'accès accordé,
    // et ne lit pas le web ; sinon seul un avis est donné (les données ne se propagent pas par les rapports).
    const mayRead = (need = []) => need.length === 0 || (!task.allowWeb && need.every((i) => (task.withIntegrations ?? []).includes(i) && (ints?.used ?? []).includes(i)));
    const depsSafe = deps.map((d) => (mayRead(d.integrations) ? d : { ...d, title: 'tâche issue de données DSers/17TRACK/imports/Shopify Admin', report: NOT_SHARED, sources: [], resultId: null }));
    const recentSafe = recent.map((m) => (!mayRead(m.integrations) ? { ...m, body: NOT_SHARED } : m));
    const canDelegate = !task.automationKey && task.depth < LIMITS.maxDepth && task.kind !== 'consolidation';
    // Une exécution qui lit le web ne reçoit pas la mémoire : une page piégée ne doit pas pouvoir la lui faire exfiltrer.
    const memoryText = web.length ? '' : scrubContacts(memoryFor(participants(thread), { missionId: task.missionId, query: `${mission?.title ?? ''} ${task.instruction}` }));
    const peers = canDelegate ? roster().filter((a) => a.id !== task.assigneeId && mayDelegate(profile, a.slug)) : [];
    return {
      web, included, provided: [...(task.withCatalog ? (catalog?.sourceUrls ?? []) : []), ...(ints?.provided ?? [])],
      system: taskSystemPrompt(fichePrompt(profile), { name: me.name, role: me.role, department: me.department, web: web.length > 0, canDelegate, catalog: task.withCatalog, integrations: wantsInts }),
      // Nettoyer les textes libres séparément : seuls les blocs réellement projetés conservent leurs identifiants typés.
      prompt: scrubContacts(taskPrompt({ task, requester, deps: depsSafe, thread: recentSafe, memoryText, catalogText: task.withCatalog ? catalogPrompt(catalog) : '', integrationsText: '', roster: peers, web: web.length > 0, canDelegate, mission })) + (ints?.text || intsNote ? `\n\n${ints?.text || intsNote}` : '')
    };
  }

  // Délégations demandées par l'agent : chacune est contrôlée côté serveur ; les refus sont expliqués, jamais silencieux.
  function applyDelegations(task, parsed, run) {
    const out = { created: [], reused: [], rejected: [] };
    if (task.automationKey) { if (parsed.delegate.length || parsed.consolidate) out.rejected.push('Délégations désactivées pour Automation.'); return out; }
    const by = { type: 'agent', agentId: task.assigneeId, runId: run.id };
    const profile = profileOf(task.assigneeId), canDelegate = task.depth < LIMITS.maxDepth && task.kind !== 'consolidation';
    const ask = parsed.delegate;
    if (ask.length && !canDelegate) { out.rejected.push(`Délégation impossible : profondeur maximale (${LIMITS.maxDepth}) atteinte ou tâche de consolidation.`); return out; }
    const everyone = roster();
    for (const d of ask.slice(0, LIMITS.maxPerRun)) {
      const target = resolveAgent(d.to, everyone);
      if (!target) { out.rejected.push(`« ${d.to} » : agent inconnu ou ambigu.`); continue; }
      if (!mayDelegate(profile, target.slug)) { out.rejected.push(`${target.name} : non autorisé par la fiche de ${comm.nameOf(task.assigneeId)} (champ « collaborates »).`); continue; }
      const hasWeb = webToolsOf(profileOf(target.id)).length > 0;
      // Données DSers/17TRACK/imports/Shopify Admin : jamais déléguées à un agent sans accès ni vers une tâche qui lit le web (l'instruction écrite par l'agent pourrait en contenir).
      if ((task.withIntegrations ?? []).length) {
        const missing = task.withIntegrations.filter((i) => !studio.integrations?.store.hasGrant(i, target.slug));
        if (missing.length || (task.allowWeb && hasWeb)) { out.rejected.push(`${target.name} : délégation refusée — la demande découle de données DSers/17TRACK/imports/Shopify Admin (${missing.length ? `${target.name} n'a pas reçu l'accès` : 'tâche avec recherche web'}).`); continue; }
      }
      try {
        const r = comm.createTask({ assigneeId: target.id, instruction: d.task, parentTaskId: task.id, allowWeb: task.allowWeb && hasWeb, requiresSources: task.allowWeb && hasWeb, withCatalog: task.withCatalog, withIntegrations: task.withIntegrations, dueAt: task.dueAt }, by);
        (r.created ? out.created : out.reused).push(r.task);
      } catch (e) { out.rejected.push(`${target.name} : ${e.message}`); }
    }
    if (ask.length > LIMITS.maxPerRun) out.rejected.push(`${ask.length - LIMITS.maxPerRun} demande(s) au-delà de ${LIMITS.maxPerRun} par exécution : ignorée(s).`);
    const awaited = [...out.created, ...out.reused];
    if (parsed.consolidate && awaited.length) {
      try { const r = comm.createTask({ assigneeId: task.assigneeId, kind: 'consolidation', instruction: parsed.consolidate, parentTaskId: task.id, withCatalog: task.withCatalog, withIntegrations: task.withIntegrations, dependsOn: awaited.map((t) => t.id), dueAt: task.dueAt }, by); out.consolidation = r.task; }
      catch (e) { out.rejected.push(`Consolidation : ${e.message}`); }
    } else if (parsed.consolidate && !awaited.length) out.rejected.push('Consolidation demandée sans aucune tâche à attendre : ignorée.');
    return out;
  }

  async function execute(task, key) {
    const agentId = task.assigneeId, profile = profileOf(agentId);
    let run = null;
    const heartbeat = task.automationKey ? setInterval(() => { try { comm.renewAutomation(task.id); } catch {} }, 25000) : null; heartbeat?.unref?.();
    try {
      if (!profile) { comm.setTaskState(task.id, 'blocked', 'Fiche de l’agent introuvable dans .claude/agents.'); return; }
      // Une tâche DÉLÉGUÉE par un agent à partir de données DSers/17TRACK/imports/Shopify Admin ne s'exécute que chez un agent qui a lui-même reçu l'accès et ne lit pas le web.
      if ((task.withIntegrations ?? []).length && task.requestedBy !== 'user') {
        const missing = task.withIntegrations.filter((i) => !studio.integrations?.store.hasGrant(i, profile.slug)), web = task.allowWeb && webToolsOf(profile).length > 0;
        if (missing.length || web) { comm.setTaskState(task.id, 'blocked', web ? 'Demande issue de données DSers/17TRACK/imports/Shopify Admin : refusée pour une tâche qui lit le web. Le propriétaire doit la relancer sans web.' : `Demande issue de données DSers/17TRACK/imports/Shopify Admin : ${profile.displayName ?? profile.slug} n'a pas reçu l'accès (${missing.join(', ')}). Accordez-le dans l'Integration Center ou reformulez.`); return; }
      }
      if (task.automationKey && !comm.automationAllowed(task)) { comm.setTaskState(task.id, 'blocked', 'Automatisation suspendue, permission ou source modifiée.'); return; }
      if (task.withCatalog && !task.automationKey) await studio.shop?.ensureFresh(); // relevé en lecture seule, daté ; ne lève jamais
      const built = buildTask(task);
      if (task.automationKey && !comm.automationAllowed(task)) { comm.setTaskState(task.id, 'blocked', 'Autorisation retirée avant lancement.'); return; }
      run = comm.startRun({ agentId, kind: 'task', taskId: task.id, threadId: task.threadId, model: profile.model, web: built.web.length > 0 });
      active.set(key, { agentId, runId: run.id, taskId: task.id, threadId: task.threadId, kind: 'task', startedAt: run.startedAt });
      setActivity(agentId, 'working', `Tâche : ${short(task.instruction, 100)}`);
      const inbox = comm.pendingFor(agentId, task.threadId).filter((id) => built.included.has(id));
      for (const id of inbox) comm.markDelivery(id, agentId, 'received');
      const seen = observeTools(); seen.state.provided = built.provided;
      let text;
      try { text = await runner({ model: profile.model, system: built.system, prompt: built.prompt, tools: built.web, onEvent: seen.feed, timeoutMs: built.web.length ? LIMITS.webTimeoutMs : LIMITS.taskTimeoutMs }); }
      catch (e) { return fail(task, run, e, inbox, seen.state); }
      const ended = comm.endRun(run.id, { state: 'done', costUsd: seen.state.cost, usage: seen.state.usage });
      succeed(task, ended, text, seen.state, inbox);
    } catch (e) {
      if (run) fail(task, run, e);
      else { try { comm.setTaskState(task.id, 'failed', `Impossible de préparer l’exécution : ${short(e.message, 200)}`); } catch { /* déjà dans un autre état */ } }
    } finally { clearInterval(heartbeat); active.delete(key); }
  }

  function fail(task, run, error, inbox = [], observed = null) {
    const message = String(error?.message ?? error);
    comm.endRun(run.id, { state: 'error', error: message, costUsd: observed?.cost ?? null, usage: observed?.usage ?? null }); // un coût déjà rapporté avant l'erreur est conservé
    for (const id of inbox) { try { comm.markDelivery(id, task.assigneeId, 'error', message); } catch { /* distribution déjà traitée */ } }
    if (task.automationKey) { studio.automation.pauseAi(true); const ar = studio.automation.forTask(task.id); if (ar) studio.automation.finish(ar.id, 'uncertain', 'Appel IA interrompu ou indisponible ; décision humaine requise dans Comms.'); }
    const retry = !task.automationKey && TRANSIENT.test(message) && task.attempts < task.maxAttempts;
    if (retry) comm.setTaskState(task.id, 'queued', `Nouvel essai après : ${short(message, 160)}`, { extra: { notBefore: new Date(Date.now() + LIMITS.backoffMs).toISOString() } });
    else comm.setTaskState(task.id, TRANSIENT.test(message) ? 'failed' : 'blocked', short(message, 300));
    try { comm.postMessage(task.threadId, { kind: 'system', body: `${comm.nameOf(task.assigneeId)} n'a pas pu terminer : ${short(message, 300)}${retry ? ' Un nouvel essai est prévu.' : ''}`, taskId: task.id }, { type: 'system' }); } catch { /* fil clos */ }
    setActivity(task.assigneeId, retry ? 'idle' : 'blocked', short(message, 120));
  }

  function succeed(task, run, text, observed, inbox = []) {
    const agentId = task.assigneeId, by = { type: 'agent', agentId, runId: run.id };
    const parsed = parseAgentOutput(text);
    if (parsed.status === 'blocked') {
      const why = parsed.blocker || 'Bloquée sans explication.';
      comm.postMessage(task.threadId, { kind: 'blocker', to: asker(task), body: `${comm.nameOf(agentId)} signale un blocage : ${why}`, taskId: task.id }, by);
      comm.setTaskState(task.id, 'blocked', short(why, 300));
      for (const id of inbox) comm.markDelivery(id, agentId, 'processed', 'Blocage signalé');
      setActivity(agentId, 'blocked', short(why, 120));
      return;
    }
    const deps = task.dependsOn.map((id) => { const d = comm.task(id), r = comm.resultOf(id); return { agentName: comm.nameOf(d.assigneeId), title: d.title, verified: Boolean(r?.verified), resultId: r?.id ?? null }; });
    const verdict = evaluateResult({ task, parsed, observed, deps });
    if (!parsed.report.trim()) { comm.setTaskState(task.id, 'failed', 'Réponse sans résultat exploitable.'); setActivity(agentId, 'blocked', 'Réponse vide'); return; }
    const result = comm.recordResult(task.id, { agentId, runId: run.id, summary: parsed.summary, body: parsed.report, sources: verdict.sources, observed: { fetched: observed.fetched, searched: observed.searched, found: observed.found.slice(0, 40), provided: observed.provided ?? [] }, verified: verdict.verified, level: verdict.level, verification: verdict.verification });
    const delegations = applyDelegations(task, parsed, run);
    comm.setTaskState(task.id, verdict.verified ? 'done' : 'review', verdict.verified ? verdict.verification : `À vérifier : ${verdict.verification}`);
    const head = parsed.summary ? `${parsed.summary}\n\n` : '';
    const note = verdict.verified ? '' : `\n\n(Résultat à vérifier par le propriétaire : ${verdict.verification})`;
    comm.postMessage(task.threadId, { kind: 'result', to: asker(task), body: `${head}${short(parsed.report, LIMITS.body - 2000)}${note}`, refs: [{ type: 'result', id: result.id, label: `Résultat de ${comm.nameOf(agentId)}` }], taskId: task.id }, by);
    const lines = [];
    if (delegations.created.length) lines.push(`Demandes créées : ${delegations.created.map((t) => `${comm.nameOf(t.assigneeId)}${t.state === 'pending_approval' ? ' (à valider)' : ''}`).join(', ')}.`);
    if (delegations.reused.length) lines.push(`Demandes déjà existantes ou résultats réutilisés : ${delegations.reused.map((t) => comm.nameOf(t.assigneeId)).join(', ')}.`);
    if (delegations.rejected.length) lines.push(`Demandes refusées : ${delegations.rejected.join(' ')}`);
    if (lines.length) comm.postMessage(task.threadId, { kind: 'system', body: lines.join('\n'), taskId: task.id }, { type: 'system' });
    if (parsed.memory.length && !(task.withIntegrations ?? []).length && studio.memory) { try { const r = studio.memory.propose(agentId, parsed.memory, { missionId: task.missionId }); if (r.created?.length) comm.postMessage(task.threadId, { kind: 'proposal', to: [], body: `${comm.nameOf(agentId)} propose ${r.created.length} souvenir(s) à valider dans le Memory Center (rien n'est enregistré avant votre accord).`, taskId: task.id }, by); } catch { /* proposition refusée : sans effet sur la tâche */ } }
    for (const id of inbox) comm.markDelivery(id, agentId, 'processed');
    setActivity(agentId, 'idle', `Tâche ${verdict.verified ? 'terminée' : 'à vérifier'}`);
  }

  function launch(task) {
    const key = `task:${task.id}`;
    active.set(key, { agentId: task.assigneeId, runId: null, taskId: task.id, threadId: task.threadId, kind: 'task', startedAt: new Date().toISOString() });
    const p = execute(task, key).catch(() => {}).finally(() => { inflight.delete(p); pump(); });
    inflight.add(p);
  }
  function pump() {
    if (pumping || !canRun()) return;
    pumping = true;
    try {
      while (active.size < maxActive) {
        // Un agent sans moteur disponible est traité comme occupé : sa tâche reste en file, sans essai consommé.
        const busy = busyAgents(); for (const a of roster()) if (!agentReady(a.id)) busy.add(a.id);
        const c = comm.claimNext({ busy });
        lastPump = { at: new Date().toISOString(), quota: Boolean(c.quota) };
        if (c.quota || !c.task) break;
        launch(c.task);
      }
    } finally { pumping = false; }
  }

  // --- réponse d'un agent dans un fil (demandée par le propriétaire) --------------------------------------------------------------------------------------------------
  // Les contrôles sont synchrones (erreur HTTP claire) ; l'exécution, elle, se poursuit en arrière-plan.
  function replyInThread(threadId, agentId) {
    const t = comm.thread(threadId), a = comm.realAgent(agentId);
    if (!t.members.includes(agentId)) throw bad('Seul un participant du fil peut y répondre.', 403);
    const profile = profileOf(agentId) ?? (() => { throw bad(`${a.name} n'a pas de fiche chargée : il ne peut pas répondre.`, 403); })();
    if (busyAgents().has(agentId)) throw bad(`${a.name} est déjà au travail.`, 409);
    if (active.size >= maxActive) throw bad(`${maxActive} agents travaillent déjà : réessayez dans un instant.`, 429);
    const over = comm.budgetExceeded(t.missionId); if (over) throw bad(over, 409); // les réponses d'un fil de mission comptent dans son budget
    if (comm.quotaExceeded()) throw bad(`Quota quotidien de ${LIMITS.maxRunsPerDay} exécutions atteint : réessayez demain.`, 429);
    const msgs = comm.visibleMessages(threadId, agentId, 30); // seulement ce qui a été adressé à cet agent
    if (!msgs.length) throw bad('Écrivez d’abord un message dans le fil.');
    if (msgs.at(-1).senderAgentId === agentId) throw bad(`${a.name} vient déjà de répondre.`, 409);
    const run = comm.startRun({ agentId, kind: 'reply', threadId, model: profile.model, web: false });
    const key = `reply:${threadId}:${agentId}`;
    active.set(key, { agentId, runId: run.id, taskId: null, threadId, kind: 'reply', startedAt: run.startedAt });
    setActivity(agentId, 'working', `Répond dans « ${short(t.title, 60)} »`);
    const msgsSafe = msgs.map((m) => (m.taskId && (comm.task(m.taskId)?.withIntegrations ?? []).length ? { ...m, body: NOT_SHARED } : m)); // une réponse libre n'a aucune intégration : rien de ce qui en provient ne lui est transmis
    const shownIds = new Set(msgs.map((m) => m.id)), inbox = comm.pendingFor(agentId, threadId).filter((id) => shownIds.has(id));
    for (const id of inbox) comm.markDelivery(id, agentId, 'received');
    const seen = observeTools();
    const p = (async () => {
      try {
        const memoryText = scrubContacts(memoryFor(participants(t), { missionId: t.missionId, query: msgsSafe.slice(-3).map((m) => m.body).join(' ') }));
        const prompt = replyPrompt({ agentName: a.name, title: privateMission(t.missionId) ? 'Sous-mission issue des intégrations' : t.title, memoryText, thread: msgsSafe.map((m) => ({ sender: m.senderType === 'user' ? 'user' : 'agent', who: m.senderAgentId ? comm.nameOf(m.senderAgentId) : 'Propriétaire', at: m.createdAt, body: m.body })) });
        const text = await runner({ model: profile.model, system: systemPrompt(profile, studio.getInstructions(agentId)), prompt: scrubContacts(prompt), tools: [], onEvent: seen.feed, timeoutMs: LIMITS.plainTimeoutMs });
        const ended = comm.endRun(run.id, { state: 'done', costUsd: seen.state.cost, usage: seen.state.usage });
        comm.postMessage(threadId, { kind: 'message', body: short(String(text).trim(), LIMITS.body), replyTo: msgs.at(-1)?.id ?? null }, { type: 'agent', agentId, runId: ended.id });
        for (const id of inbox) comm.markDelivery(id, agentId, 'processed');
        setActivity(agentId, 'idle', 'Réponse envoyée');
      } catch (e) {
        comm.endRun(run.id, { state: 'error', error: e.message, costUsd: seen.state.cost, usage: seen.state.usage });
        for (const id of inbox) { try { comm.markDelivery(id, agentId, 'error', e.message); } catch { /* déjà traité */ } }
        try { comm.postMessage(threadId, { kind: 'system', body: `${a.name} n'a pas pu répondre : ${short(e.message, 300)}` }, { type: 'system' }); } catch { /* fil clos */ }
        setActivity(agentId, 'blocked', short(e.message, 120));
      } finally { active.delete(key); }
    })().finally(() => { inflight.delete(p); pump(); });
    inflight.add(p);
    return { started: true, runId: run.id, agentId, threadId };
  }

  return {
    pump, replyInThread, profileOf, webToolsOf,
    // Résout quand plus rien ne tourne (tests, arrêt propre).
    async idle() { while (inflight.size) await Promise.allSettled([...inflight]); },
    activity: () => ({ active: [...active.values()].map((a) => ({ ...a })), maxActive, lastPump, runs: comm.activeRuns() }),
    start() { comm.recover(); if (pumpEveryMs > 0 && !timer) { timer = setInterval(() => { try { pump(); } catch { /* prochain tour */ } }, pumpEveryMs); timer.unref?.(); } pump(); return this; },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
