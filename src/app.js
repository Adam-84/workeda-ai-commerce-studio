import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectorState, MAX_PRELOADED } from './agent-files.js';
import { runClaude as realClaude, systemPrompt, conversationPrompt, missionsPrompt, teamPrompt, planRequestPrompt, parsePlan, memoryPrompt, memoryProposalPrompt, parseMemoryProposals } from './claude-reply.js';
import { createOrchestrator } from './comm-run.js';

// Détection réelle d'un binaire dans le PATH (« détecté » ne veut pas dire « connecté »).
export const cliPresent = (command, run = execFileSync) => {
  try { run(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }); return true; } catch { return false; }
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };
const send = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
const MAX_BODY = 1e6;
const body = async (req) => {
  const chunks = []; let bytes = 0;
  const limit = req.url?.split('?')[0] === '/api/integrations/manual_import/preview' ? 4_000_000 : MAX_BODY;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Object.assign(new Error('Corps de requête trop volumineux.'), { status: 413 }); chunks.push(chunk); }
  if (!bytes) return {};
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw Object.assign(new Error('Corps JSON invalide.'), { status: 400 }); }
};

const DETECT_TTL_MS = 10_000;

// Les routes qui écrivent dans skills/ ou dans les fiches ne répondent qu'à cette machine : un Skill est du texte que
// les agents lisent comme une consigne, il ne doit pas pouvoir être modifié par une autre page web ou un autre poste.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SKILL_PATH = /^\/api\/(?:skills(?:\/|$)|agents\/[^/]+\/skills)/;
// La mémoire est lue par les agents comme une référence : seule cette machine peut l'écrire, valider ou supprimer.
// Y compris les anciennes notes de mission (« /memory »), que les agents relisent aussi.
const MEMORY_PATH = /^\/api\/(?:memory(?:\/|$)|missions\/[^/]+\/(?:memory-proposals$|memory(?:\/|$)))/;
// Communication entre agents : lancer une tâche fait travailler un agent (Claude Code) et écrire dans les fils lus par les autres.
// Tout est réservé à cette machine, lectures comprises (les fils contiennent le travail de l'entreprise).
const COMM_PATH = /^\/api\/(?:comm|shop|integrations)(?:\/|$)/; // le catalogue Shopify aussi : lectures et relevés réservés à cette machine
// Lecture : la mémoire contient le savoir de l'entreprise — réservée à cette machine (même contrôle, sans l'origine).
function assertLocalWrite(req, { checkOrigin = true } = {}) {
  const deny = (why) => Object.assign(new Error(`${checkOrigin ? 'Modification' : 'Lecture'} refusée : ${why}.`), { status: 403 });
  if (!LOOPBACK.has(req.socket.remoteAddress)) throw deny('connexion non locale');
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { throw deny('en-tête Host invalide'); }
  if (!LOCAL_HOSTS.has(host.hostname)) throw deny('nom d’hôte non local');
  if (!checkOrigin) return;
  const { origin } = req.headers; // absent pour un appel sans navigateur ; présent et différent pour une autre page web
  if (origin !== undefined) {
    let from = null;
    try { from = new URL(origin).host; } catch { /* « null » ou illisible : refusé ci-dessous */ }
    if (from !== host.host) throw deny('requête issue d’une autre origine');
  }
}

export function createApp({ studio, publicDir, skills, detect: rawDetect = cliPresent, runClaude = realClaude, agentFiles: { profiles = [], warnings = [] } = {}, pumpEveryMs = 0 }) {
  // La détection lance un processus synchrone : on garde le résultat quelques secondes.
  const seen = new Map();
  const detect = (command) => {
    const hit = seen.get(command);
    if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit.value;
    const value = rawDetect(command);
    seen.set(command, { value, at: Date.now() });
    return value;
  };
  const root = resolve(publicDir), realRoot = realpathSync(root);
  // Seules les fiches reliées à un agent de la base sont exposées.
  const linked = () => { const ids = new Map(studio.listAgentFiles().map((l) => [l.slug, l.agentId])); return { ids, list: profiles.filter((p) => ids.has(p.slug)) }; };
  const routes = {
    'GET /api/health': () => ({ node: process.version, connectors: { shopifyCli: detect('shopify'), claudeCode: detect('claude'), codexCli: detect('codex'), clink: detect('clink') }, mode: 'local-only', agentFiles: { loaded: linked().list.length, warnings } }),
    'GET /api/agent-profiles': () => {
      const { ids, list } = linked();
      return list.map((p) => ({
        agentId: ids.get(p.slug), slug: p.slug, displayName: p.displayName, model: p.model, tools: p.tools,
        connectors: p.connectors.map((id) => ({ id, state: connectorState(id, detect) })),
        collaboratesAll: p.collaboratesAll,
        collaborates: p.collaborates.map((slug) => ({ slug, agentId: ids.get(slug) ?? null })),
        sections: p.sections
      }));
    },
    'GET /api/departments': () => studio.listDepartments(),
    'GET /api/agents': () => studio.listAgents(),
    'GET /api/missions': () => studio.listMissions(),
    'GET /api/appearances': () => studio.listAppearances(),
    'GET /api/island-styles': () => studio.listIslandStyles(),
    'GET /api/messages': (_, q) => studio.listRecentMessages({ missionId: q.get('missionId'), limit: q.get('limit') ?? 200 }),
    'GET /api/events': (_, q) => { if (!q.get('agentId')) throw new Error('agentId est obligatoire.'); return studio.listEvents(q.get('agentId')); },
    'POST /api/departments': (data) => studio.createDepartment(data),
    'POST /api/agents': (data) => studio.hireAgent(data),
    'POST /api/missions': (data) => studio.createMission(data),
    'POST /api/messages': (data) => studio.sendMessage(data),
    // Un client HTTP ne peut déclarer qu'un statut manuel : les sources externes (claude, codex, shopify)
    // exigeront un connecteur serveur capable de prouver l'événement.
    'POST /api/activity': (data) => {
      if (data.source !== 'manual') throw Object.assign(new Error('Source externe refusée : seul un connecteur serveur vérifié peut l’enregistrer.'), { status: 403 });
      return studio.recordActivity({ ...data, verified: true });
    }
  };
  if (skills) Object.assign(routes, {
    'GET /api/skills': () => studio.listSkills(),
    'GET /api/skills/categories': () => studio.listSkillCategories(),
    'GET /api/skills/sources': () => studio.listSkillSources(),
    'GET /api/skills/stats': () => ({ ...studio.skillStats(), maxPreloaded: MAX_PRELOADED }),
    'GET /api/skills/health': () => skills.health(),
    'GET /api/skills/recommend': (_, q) => skills.recommend({ agentId: q.get('agentId'), text: q.get('text') }),
    'POST /api/skills': (data) => skills.create(data),
    'POST /api/skills/import': (data) => skills.importSkill(data),
    'POST /api/skills/sync': () => skills.sync()
  });
  const memory = studio.memory;
  if (memory) Object.assign(routes, {
    'GET /api/memory': (_, q) => memory.list({
      level: q.get('level') || undefined, kind: q.get('kind') || undefined, nature: q.get('nature') || undefined, state: q.get('state') || undefined,
      owner: q.get('owner') || undefined, department: q.get('department') || undefined, missionId: q.get('missionId') || undefined,
      tag: q.get('tag') || undefined, q: q.get('q') || undefined, visibleTo: q.get('visibleTo') || undefined,
      includeExpired: q.get('expired') !== '0', limit: q.get('limit') ?? 200
    }),
    'GET /api/memory/stats': () => memory.stats(),
    'GET /api/memory/status': () => memory.status(),
    'GET /api/memory/check': () => memory.check(),
    'GET /api/memory/owners': () => memory.owners(),
    // Aperçu de ce qu'un agent recevrait : n'enregistre aucun usage.
    'GET /api/memory/context': (_, q) => {
      if (!q.get('agentId')) fail(400, 'agentId est obligatoire.');
      return memory.contextFor(q.get('agentId'), { missionId: q.get('missionId') || null, query: q.get('q') ?? '', touch: false });
    },
    'POST /api/memory': (data) => memory.create(data),
    'POST /api/memory/import': () => memory.importJournal()
  });
  const paramRoutes = [
    ...(memory ? [
      ['GET', /^\/api\/memory\/([^/]+)$/, (m) => memory.get(decodeURIComponent(m[1]))],
      ['GET', /^\/api\/memory\/([^/]+)\/history$/, (m) => memory.history(decodeURIComponent(m[1]))],
      ['PUT', /^\/api\/memory\/([^/]+)$/, (m, data) => memory.update(decodeURIComponent(m[1]), data)],
      ['POST', /^\/api\/memory\/([^/]+)\/state$/, (m, data) => memory.setState(decodeURIComponent(m[1]), data?.to, { note: data?.note ?? '', patch: data?.patch ?? null })]
    ] : []),
    ...(skills ? [
      ['GET', /^\/api\/skills\/([^/]+)$/, (m) => skills.detail(decodeURIComponent(m[1]))],
      ['GET', /^\/api\/skills\/([^/]+)\/versions\/([0-9a-f]{64})$/, (m) => studio.getSkillVersion(decodeURIComponent(m[1]), m[2])],
      ['PUT', /^\/api\/skills\/([^/]+)$/, (m, data) => skills.update(decodeURIComponent(m[1]), data)],
      ['POST', /^\/api\/skills\/([^/]+)\/archive$/, (m) => skills.setArchived(decodeURIComponent(m[1]), true)],
      ['POST', /^\/api\/skills\/([^/]+)\/unarchive$/, (m) => skills.setArchived(decodeURIComponent(m[1]), false)],
      ['POST', /^\/api\/skills\/([^/]+)\/use$/, (m, data) => studio.declareSkillUse({ skill: decodeURIComponent(m[1]), agentId: data.agentId, note: data.note })],
      ['GET', /^\/api\/agents\/([^/]+)\/skills$/, (m) => skills.forAgent(decodeURIComponent(m[1]))],
      ['POST', /^\/api\/agents\/([^/]+)\/skills$/, (m, data) => skills.assign(decodeURIComponent(m[1]), data.skill)],
      ['DELETE', /^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/, (m) => skills.unassign(decodeURIComponent(m[1]), decodeURIComponent(m[2]))]
    ] : []),
    ['GET', /^\/api\/agents\/([^/]+)\/conversation$/, (m, _, q) => studio.listConversation(decodeURIComponent(m[1]), q.get('before'))],
    ['POST', /^\/api\/agents\/([^/]+)\/conversation$/, (m, data) => studio.sendUserMessage(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/missions\/([^/]+)$/, (m, data) => studio.updateMission(decodeURIComponent(m[1]), data)],
    ['GET', /^\/api\/missions\/([^/]+)\/memory$/, (m) => studio.listMemory(decodeURIComponent(m[1]))],
    ['POST', /^\/api\/missions\/([^/]+)\/memory$/, (m, data) => studio.addMemory(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/missions\/([^/]+)\/memory\/([^/]+)$/, (m, data) => studio.updateMemory(decodeURIComponent(m[1]), decodeURIComponent(m[2]), data)],
    ['GET', /^\/api\/missions\/([^/]+)\/plans$/, (m) => studio.listPlans(decodeURIComponent(m[1]))],
    ['PUT', /^\/api\/missions\/([^/]+)\/plan$/, (m, data) => studio.savePlan(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/missions\/([^/]+)\/plans\/([^/]+)\/steps\/([^/]+)$/, (m, data) => studio.setStepState(decodeURIComponent(m[1]), decodeURIComponent(m[2]), decodeURIComponent(m[3]), data?.state)],
    ['POST', /^\/api\/missions\/([^/]+)\/plans\/([^/]+)\/decision$/, (m, data) => studio.decidePlan(decodeURIComponent(m[1]), decodeURIComponent(m[2]), data)],
    ['GET', /^\/api\/missions\/([^/]+)\/discussion$/, (m) => studio.listDiscussion(decodeURIComponent(m[1]))],
    ['POST', /^\/api\/missions\/([^/]+)\/discussion$/, (m, data) => studio.postDiscussion(decodeURIComponent(m[1]), data)],
    ['GET', /^\/api\/agents\/([^/]+)\/instructions$/, (m) => studio.getInstructions(decodeURIComponent(m[1]))],
    ['PUT', /^\/api\/agents\/([^/]+)\/instructions$/, (m, data) => studio.setInstructions(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/agents\/([^/]+)\/appearance$/, (m, data) => studio.setAppearance(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/agents\/([^/]+)\/appearance$/, (m) => studio.clearAppearance(decodeURIComponent(m[1]))],
    ['PUT', /^\/api\/departments\/([^/]+)\/style$/, (m, data) => studio.setIslandStyle(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/departments\/([^/]+)\/style$/, (m) => studio.clearIslandStyle(decodeURIComponent(m[1]))]
  ];
  const comm = studio.comm;
  // L'orchestrateur ne démarre rien tout seul ici : seules les routes ci-dessous (ou server.js) le sollicitent.
  let orch = null;
  if (comm) {
    const id = (m, i = 1) => decodeURIComponent(m[i]);
    const delegationInput = (d = {}) => Object.fromEntries(['assigneeId', 'instruction', 'title', 'missionId', 'parentTaskId', 'dependsOn', 'dueAt', 'allowWeb', 'requiresSources', 'requiresApproval', 'priority', 'forceFresh', 'withCatalog', 'withIntegrations', 'budgetUsd'].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
    Object.assign(routes, {
      'GET /api/comm/status': () => ({ ...comm.status(), maxActive: orch.activity().maxActive, engines: { claudeCode: detect('claude'), codexCli: detect('codex') } }),
      'GET /api/comm/check': () => comm.check(),
      'GET /api/comm/threads': (_, q) => comm.listThreads({ agentId: q.get('agentId') || null, kind: q.get('kind') || null, missionId: q.get('missionId') || null }),
      'GET /api/comm/tasks': (_, q) => comm.listTasks({ missionId: q.get('missionId') || null, state: q.get('state') || null, agentId: q.get('agentId') || null, rootTaskId: q.get('rootTaskId') || null }),
      'GET /api/comm/notifications': () => comm.notifications(),
      'GET /api/comm/activity': () => ({ ...orch.activity(), notifications: comm.notifications().length }),
      'GET /api/comm/usage': () => comm.usage(),
      'GET /api/comm/runs': (_, q) => comm.recentRuns(q.get('limit') ?? 50),
      // Échanges entre agents au format des anciens messages : les faisceaux de la carte les reconnaissent tels quels.
      'GET /api/comm/exchanges': (_, q) => comm.exchanges(q.get('limit') ?? 200),
      'POST /api/comm/threads': (d) => comm.createThread(d ?? {}),
      // Le propriétaire délègue : la tâche est mise en file et démarrera si un agent est libre. Aucune IA n'est lancée pour un simple message.
      'POST /api/comm/delegations': (d) => { const r = comm.createTask(delegationInput(d), { type: 'user' }); orch.pump(); return r; },
      'POST /api/comm/notifications/seen': () => comm.markSeen(),
      'POST /api/comm/import': () => comm.importJournal(),
      'POST /api/comm/pump': () => { orch.pump(); return orch.activity(); }
    });
    paramRoutes.push(
      ['GET', /^\/api\/comm\/threads\/([^/]+)$/, (m) => comm.thread(id(m))],
      ['GET', /^\/api\/comm\/threads\/([^/]+)\/messages$/, (m, _, q) => comm.listMessages(id(m), q.get('before'), q.get('limit') ?? 50)],
      // Un client HTTP ne peut écrire qu'en son nom propre (propriétaire) : jamais au nom d'un agent.
      ['POST', /^\/api\/comm\/threads\/([^/]+)\/messages$/, (m, d) => comm.postMessage(id(m), { kind: ['message', 'decision'].includes(d?.kind) ? d.kind : 'message', body: d?.body, refs: d?.refs }, { type: 'user' })],
      ['POST', /^\/api\/comm\/threads\/([^/]+)\/reply$/, (m, d) => orch.replyInThread(id(m), d?.agentId)],
      ['GET', /^\/api\/comm\/tasks\/([^/]+)$/, (m) => { const task = comm.task(id(m)); return { task, results: comm.results(task.id), dependsOn: task.dependsOn.map((t) => comm.task(t)), children: comm.listTasks({ rootTaskId: task.rootTaskId }).filter((t) => t.parentTaskId === task.id) }; }],
      ['POST', /^\/api\/comm\/tasks\/([^/]+)\/(approve|cancel|retry|verify|adopt|budget)$/, (m, d) => {
        const action = m[2], tid = id(m);
        const out = action === 'approve' ? comm.approveTask(tid) : action === 'cancel' ? comm.cancelTask(tid, typeof d?.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, 200) : undefined) : action === 'retry' ? comm.retryTask(tid) : action === 'adopt' ? comm.adoptTask(tid) : action === 'budget' ? comm.setBudget(tid, d?.usd) : comm.verifyTask(tid, typeof d?.note === 'string' ? d.note.slice(0, 300) : '');
        orch.pump();
        return out;
      }]
    );
  }
  // Integration Center (DSers, 17TRACK) : LECTURE SEULE. Aucune route n'écrit chez DSers, 17TRACK ou Shopify ; aucun secret n'est jamais renvoyé.
  if (studio.integrations) {
    const ints = studio.integrations, known = (m) => { const i = decodeURIComponent(m[1]); if (!['dsers', 'track17', 'manual_import', 'shopify_admin'].includes(i)) fail(404, 'Intégration inconnue.'); return i; };
    const agentsList = () => studio.listAgentFiles().map((f) => ({ slug: f.slug, name: f.name ?? f.slug }));
    Object.assign(routes, { 'GET /api/integrations': () => ({ ...ints.status(), cards: ints.cards(), agents: agentsList() }),
      'GET /api/integrations/manual_import/template': () => ({ csv: ints.csvTemplate(), filename: 'archipel-import.csv' }),
      'POST /api/integrations/manual_import/preview': (d) => ints.previewImport(d?.text, { format: d?.format ?? 'archipel' }),
      'POST /api/integrations/manual_import/commit': (d) => ints.commitImport(d),
      'POST /api/integrations/shopify_admin/configure': (d) => studio.shop.configureAdmin(d),
      'POST /api/integrations/shopify_admin/test': () => studio.shop.testAdmin(),
      'POST /api/integrations/shopify_admin/sync': (d) => studio.shop.refreshAdmin({ force: d?.force === true }) });
    paramRoutes.push(
      ['GET', /^\/api\/integrations\/([^\/]+)$/, (m) => ints.card(known(m))],
      ['POST', /^\/api\/integrations\/([^\/]+)\/connect$/, async (m, d) => { const i = known(m); if (d?.confirm !== true) fail(400, 'Confirmation explicite requise avant toute connexion à un compte.'); if (i === 'dsers' && ints.card(i).settings.plan === 'basic') return ints.beginAuth(i); ints.guardReal(); return ints.beginAuth(i); }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/key$/, (m, d) => { const i = known(m); if (d?.confirm !== true) fail(400, 'Confirmation explicite requise.'); return { ...ints.setKey(i, d?.key), card: ints.card(i) }; }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/test$/, async (m) => { const i = known(m); try { await ints.test(i); } catch (e) { if (e.kind === 'real_network_disabled') throw Object.assign(e, { status: 403 }); } return ints.card(i); }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/sync$/, async (m, d) => { const i = known(m); const r = await ints.sync(i, { force: d?.force === true }); return { result: r, card: ints.card(i) }; }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/settings$/, (m, d) => { const i = known(m); if (d?.dailyCap !== undefined) ints.setDailyCap(i, d.dailyCap); if (d?.shipCountry !== undefined || d?.plan !== undefined) ints.setSettings(i, { shipCountry: d?.shipCountry, plan: d?.plan }); return ints.card(i); }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/grants$/, (m, d) => { const i = known(m); ints.grant(i, String(d?.agent ?? '')); return ints.card(i); }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/grants\/([^\/]+)\/revoke$/, (m) => { const i = known(m); ints.revokeGrant(i, decodeURIComponent(m[2])); return ints.card(i); }],
      ['POST', /^\/api\/integrations\/([^\/]+)\/revoke$/, (m, d) => { const i = known(m); const r = ints.revoke(i, { purge: d?.purge === true }); return { ...r, card: ints.card(i) }; }]
    );
  }
  // Catalogue Shopify : LECTURE SEULE. Aucune route n'écrit dans la boutique ; le seul effet est un relevé daté dans la base locale.
  if (studio.shop) Object.assign(routes, {
    'GET /api/shop/status': () => studio.shop.status(),
    'GET /api/shop/catalog': () => studio.shop.latest() ?? { snapshot: null, note: 'Aucun relevé réussi pour le moment.' },
    'POST /api/shop/refresh': async () => { const r = await studio.shop.refresh(); return { ...r, status: studio.shop.status() }; }
  });
  // Réponse IA diffusée en NDJSON : {type:'text'} au fil de l'eau, puis {type:'done', message} ou {type:'error', error}.
  const replying = new Set();
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const profileOf = (agentId) => { const { ids, list } = linked(); return list.find((p) => ids.get(p.slug) === agentId) ?? fail(403, 'Cet agent n’a pas de fiche dans .claude/agents : il ne peut pas répondre.'); };
  const namer = () => { const names = new Map(studio.listAgents().map((a) => [a.id, a.name])); return (id) => names.get(id) ?? 'Agent'; };
  // Lance Claude et diffuse sa réponse ; save(text) l'enregistre même si le panneau a été fermé. lock : une réponse à la fois par clé.
  // La consigne système = fiche + consignes de l'utilisateur pour cet agent ; les options de claude (aucun outil) ne changent jamais.
  async function stream(res, lock, busy, profile, agentId, prompt, save) {
    if (replying.has(lock)) fail(409, busy);
    replying.add(lock);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const line = (data) => { if (!res.writableEnded) res.write(JSON.stringify(data) + '\n'); };
    try { line({ type: 'done', message: save(await runClaude({ model: profile.model, system: systemPrompt(profile, studio.getInstructions(agentId)), prompt, onText: (t) => line({ type: 'text', text: t }) })) }); }
    catch (error) { line({ type: 'error', error: error.message }); }
    finally { replying.delete(lock); res.end(); }
  }
  // Mémoire Archipel pour un agent : seulement du souvenir actif, autorisé et pertinent, dans un budget borné.
  // Une panne de mémoire ne doit jamais empêcher un agent de répondre.
  const memoryFor = (agentId, { missionId = null, query = '' } = {}) => {
    if (!memory) return '';
    try { return memoryPrompt(memory.contextFor(agentId, { missionId, query: String(query).slice(0, 1500) })); } catch { return ''; }
  };
  async function reply(agentId, res) {
    const profile = profileOf(agentId);
    if (replying.has(agentId)) fail(409, `${profile.displayName} répond déjà à un message.`);
    const items = studio.listConversation(agentId).items.reverse(); // ponytail: contexte = 50 derniers messages, résumé si les échanges s'allongent
    if (items.at(-1)?.senderType !== 'user') fail(400, 'Aucun message en attente de réponse.');
    const nameOf = namer(), context = missionsPrompt(studio.listMissions(), agentId, nameOf, (id) => studio.listMemory(id), (id) => studio.currentPlan(id));
    const recalled = memoryFor(agentId, { query: items.filter((m) => m.senderType === 'user').slice(-3).map((m) => m.body).join('\n') });
    await stream(res, agentId, `${profile.displayName} répond déjà à un message.`, profile, agentId, `${recalled}${context}\n\n${conversationPrompt(items, nameOf, profile.displayName)}`, (text) => studio.saveAgentReply(agentId, text, 'claude'));
  }
  // Fil d'équipe : seul un membre désigné (responsable ou collaborateur) parle, une réponse à la fois par mission.
  // Appel explicite : le responsable propose (ou révise) un plan, enregistré comme nouvelle version non validée.
  async function proposePlan(missionId, input, res) {
    const mission = studio.getMission(missionId) ?? fail(404, 'Mission introuvable.');
    if (!mission.assignedTo) fail(400, 'Désignez d’abord un responsable : c’est lui qui propose le plan.');
    const profile = profileOf(mission.assignedTo);
    const revision = typeof input?.revision === 'string' ? input.revision.trim() : '';
    if (revision.length > 2000) fail(400, 'Les indications : 2000 caractères au maximum.');
    if (revision && !studio.currentPlan(missionId)) fail(400, 'Aucun plan à réviser : proposez d’abord un plan.');
    const members = [mission.assignedTo, ...mission.collaborators], nameOf = namer();
    const context = missionsPrompt([mission], mission.assignedTo, nameOf, (id) => studio.listMemory(id), (id) => studio.currentPlan(id));
    const recalled = memoryFor(members, { missionId, query: `${mission.title} ${mission.objective ?? ''} ${revision}` }); // le plan est lu par toute l'équipe
    await stream(res, `mission:${missionId}`, 'Un agent travaille déjà sur cette mission.', profile, mission.assignedTo,
      `${recalled}${context}\n\n${planRequestPrompt(mission, studio.listDiscussion(missionId).slice(-50), nameOf, members, revision)}`,
      (text) => studio.savePlan(missionId, parsePlan(text, studio.listAgents()), { origin: 'ai', authorAgentId: mission.assignedTo, revisionNote: revision }));
  }
  async function teamReply(missionId, agentId, res) {
    const mission = studio.getMission(missionId) ?? fail(404, 'Mission introuvable.');
    const members = [mission.assignedTo, ...mission.collaborators].filter(Boolean);
    if (!members.includes(agentId)) fail(403, 'Seuls le responsable et les collaborateurs de la mission prennent la parole dans ce fil.');
    const profile = profileOf(agentId);
    const items = studio.listDiscussion(missionId).slice(-50); // ponytail: 50 derniers messages du fil
    if (!items.length) fail(400, 'Écrivez d’abord un message dans le fil.');
    if (items.at(-1).agentId === agentId) fail(400, `${profile.displayName} vient déjà de répondre.`);
    const nameOf = namer(), context = missionsPrompt([mission], agentId, nameOf, (id) => studio.listMemory(id), (id) => studio.currentPlan(id));
    // Le fil est lu par tous ses membres : seul le souvenir que TOUS peuvent lire entre dans la réponse (rien de privé ne fuite).
    const recalled = memoryFor(members, { missionId, query: `${mission.title} ${mission.objective ?? ''} ${items.slice(-3).map((m) => m.body).join(' ')}` });
    await stream(res, `mission:${missionId}`, 'Un agent répond déjà dans ce fil.', profile, agentId, `${recalled}${context}\n\n${teamPrompt(mission, items, nameOf, profile.displayName, members)}`, (text) => studio.saveDiscussionReply(missionId, agentId, text, 'claude'));
  }
  // Fin de mission : l'agent (responsable ou collaborateur) PROPOSE des souvenirs, enregistrés « en attente » ; le propriétaire valide.
  async function proposeMemory(missionId, input, res) {
    if (!memory) fail(404, 'La mémoire n’est pas disponible.');
    const mission = studio.getMission(missionId) ?? fail(404, 'Mission introuvable.');
    const members = [mission.assignedTo, ...mission.collaborators].filter(Boolean);
    const agentId = typeof input?.agentId === 'string' && input.agentId ? input.agentId : mission.assignedTo;
    if (!agentId || !members.includes(agentId)) fail(403, 'Seuls le responsable et les collaborateurs de la mission proposent des souvenirs.');
    const profile = profileOf(agentId), nameOf = namer();
    const notes = studio.listMemory(missionId).filter((n) => !n.archivedAt).slice(0, 20);
    const recalled = memoryFor(agentId, { missionId, query: `${mission.title} ${mission.objective ?? ''}` });
    await stream(res, `mission:${missionId}`, 'Un agent travaille déjà sur cette mission.', profile, agentId,
      `${recalled}${memoryProposalPrompt(mission, studio.listDiscussion(missionId).slice(-50), nameOf, notes, studio.currentPlan(missionId), profile.displayName)}`,
      (text) => memory.propose(agentId, parseMemoryProposals(text), { missionId }));
  }
  if (comm) orch = createOrchestrator({ studio, profiles: () => profiles, runner: runClaude, memoryFor, pumpEveryMs });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${url.pathname}`;
      const replyMatch = req.method === 'POST' && url.pathname.match(/^\/api\/agents\/([^/]+)\/reply$/);
      if (replyMatch) return await reply(decodeURIComponent(replyMatch[1]), res);
      const teamMatch = req.method === 'POST' && url.pathname.match(/^\/api\/missions\/([^/]+)\/discussion\/reply\/([^/]+)$/);
      if (teamMatch) return await teamReply(decodeURIComponent(teamMatch[1]), decodeURIComponent(teamMatch[2]), res);
      const planMatch = req.method === 'POST' && url.pathname.match(/^\/api\/missions\/([^/]+)\/plan\/propose$/);
      if (planMatch) return await proposePlan(decodeURIComponent(planMatch[1]), await body(req), res);
      if (studio.integrations && req.method === 'GET' && url.pathname === '/api/integrations/dsers/callback') {
        assertLocalWrite(req, { checkOrigin: false });
        let msg = 'Connexion DSers réussie en lecture seule. Vous pouvez fermer cet onglet et revenir à Archipel.', status = 200;
        try { if (url.searchParams.get('error')) throw new Error('Connexion refusée côté DSers.'); await studio.integrations.completeAuth({ code: url.searchParams.get('code'), state: url.searchParams.get('state') }); } catch (e) { msg = 'Connexion non terminée : ' + String(e.message).slice(0, 200); status = 400; }
        const esc = (t) => t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer' });
        return res.end('<!doctype html><meta charset="utf-8"><title>Archipel</title><body style="font:16px system-ui;padding:2rem;background:#0b1626;color:#e8eef7"><p>' + esc(msg) + '</p></body>');
      }
      const hasBody = req.method === 'POST' || req.method === 'PUT';
      if (MEMORY_PATH.test(url.pathname) || COMM_PATH.test(url.pathname)) assertLocalWrite(req, { checkOrigin: req.method !== 'GET' });
      if (req.method === 'POST' && url.pathname === '/api/messages') assertLocalWrite(req); // enregistrement manuel d'un échange : jamais depuis une autre page web
      const memMatch = req.method === 'POST' && url.pathname.match(/^\/api\/missions\/([^/]+)\/memory-proposals$/);
      if (memMatch) return await proposeMemory(decodeURIComponent(memMatch[1]), await body(req), res);
      if (skills && req.method !== 'GET' && SKILL_PATH.test(url.pathname)) assertLocalWrite(req);
      if (routes[key]) return send(res, 200, await routes[key](hasBody ? await body(req) : undefined, url.searchParams));
      for (const [method, re, fn] of paramRoutes) { const m = req.method === method && url.pathname.match(re); if (m) return send(res, 200, await fn(m, hasBody ? await body(req) : undefined, url.searchParams)); }
      if (req.method !== 'GET') { req.resume(); return send(res, 404, { error: 'Introuvable' }); } // le corps d'une route inconnue est vidé : la connexion reste saine
      const file = resolve(join(root, key === 'GET /' ? 'index.html' : decodeURIComponent(url.pathname)));
      if (req.method !== 'GET' || !file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Introuvable' });
      const real = realpathSync(file); // un lien symbolique ou une jonction ne doit pas sortir de public/
      if (!real.startsWith(realRoot + sep)) return send(res, 404, { error: 'Introuvable' });
      res.writeHead(200, { 'content-type': TYPES[extname(real).toLowerCase()] || 'application/octet-stream' });
      res.end(await readFile(real));
    } catch (error) { req.resume(); send(res, error.status ?? 400, { error: error.message }); } // corps non lu (refus avant lecture) : vidé
  });
  server.orchestrator = orch; // server.js le démarre (reprise après arrêt, passage régulier) ; les tests le pilotent à la main
  server.on('close', () => orch?.stop());
  return server;
}
