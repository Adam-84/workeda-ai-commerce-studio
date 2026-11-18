import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectorState } from './agent-files.js';
import { runClaude as realClaude, systemPrompt, conversationPrompt, missionsPrompt, teamPrompt } from './claude-reply.js';

// Détection réelle d'un binaire dans le PATH (« détecté » ne veut pas dire « connecté »).
export const cliPresent = (command, run = execFileSync) => {
  try { run(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }); return true; } catch { return false; }
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };
const send = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
const MAX_BODY = 1e6;
const body = async (req) => {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw Object.assign(new Error('Corps de requête trop volumineux.'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
};

const DETECT_TTL_MS = 10_000;

export function createApp({ studio, publicDir, detect: rawDetect = cliPresent, runClaude = realClaude, agentFiles: { profiles = [], warnings = [] } = {} }) {
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
  const paramRoutes = [
    ['GET', /^\/api\/agents\/([^/]+)\/conversation$/, (m, _, q) => studio.listConversation(decodeURIComponent(m[1]), q.get('before'))],
    ['POST', /^\/api\/agents\/([^/]+)\/conversation$/, (m, data) => studio.sendUserMessage(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/missions\/([^/]+)$/, (m, data) => studio.updateMission(decodeURIComponent(m[1]), data)],
    ['GET', /^\/api\/missions\/([^/]+)\/memory$/, (m) => studio.listMemory(decodeURIComponent(m[1]))],
    ['POST', /^\/api\/missions\/([^/]+)\/memory$/, (m, data) => studio.addMemory(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/missions\/([^/]+)\/memory\/([^/]+)$/, (m, data) => studio.updateMemory(decodeURIComponent(m[1]), decodeURIComponent(m[2]), data)],
    ['GET', /^\/api\/missions\/([^/]+)\/discussion$/, (m) => studio.listDiscussion(decodeURIComponent(m[1]))],
    ['POST', /^\/api\/missions\/([^/]+)\/discussion$/, (m, data) => studio.postDiscussion(decodeURIComponent(m[1]), data)],
    ['PUT', /^\/api\/agents\/([^/]+)\/appearance$/, (m, data) => studio.setAppearance(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/agents\/([^/]+)\/appearance$/, (m) => studio.clearAppearance(decodeURIComponent(m[1]))],
    ['PUT', /^\/api\/departments\/([^/]+)\/style$/, (m, data) => studio.setIslandStyle(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/departments\/([^/]+)\/style$/, (m) => studio.clearIslandStyle(decodeURIComponent(m[1]))]
  ];
  // Réponse IA diffusée en NDJSON : {type:'text'} au fil de l'eau, puis {type:'done', message} ou {type:'error', error}.
  const replying = new Set();
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const profileOf = (agentId) => { const { ids, list } = linked(); return list.find((p) => ids.get(p.slug) === agentId) ?? fail(403, 'Cet agent n’a pas de fiche dans .claude/agents : il ne peut pas répondre.'); };
  const namer = () => { const names = new Map(studio.listAgents().map((a) => [a.id, a.name])); return (id) => names.get(id) ?? 'Agent'; };
  // Lance Claude et diffuse sa réponse ; save(text) l'enregistre même si le panneau a été fermé. lock : une réponse à la fois par clé.
  async function stream(res, lock, busy, profile, prompt, save) {
    if (replying.has(lock)) fail(409, busy);
    replying.add(lock);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const line = (data) => { if (!res.writableEnded) res.write(JSON.stringify(data) + '\n'); };
    try { line({ type: 'done', message: save(await runClaude({ model: profile.model, system: systemPrompt(profile), prompt, onText: (t) => line({ type: 'text', text: t }) })) }); }
    catch (error) { line({ type: 'error', error: error.message }); }
    finally { replying.delete(lock); res.end(); }
  }
  async function reply(agentId, res) {
    const profile = profileOf(agentId);
    if (replying.has(agentId)) fail(409, `${profile.displayName} répond déjà à un message.`);
    const items = studio.listConversation(agentId).items.reverse(); // ponytail: contexte = 50 derniers messages, résumé si les échanges s'allongent
    if (items.at(-1)?.senderType !== 'user') fail(400, 'Aucun message en attente de réponse.');
    const nameOf = namer(), context = missionsPrompt(studio.listMissions(), agentId, nameOf, (id) => studio.listMemory(id));
    await stream(res, agentId, `${profile.displayName} répond déjà à un message.`, profile, `${context}\n\n${conversationPrompt(items, nameOf, profile.displayName)}`, (text) => studio.saveAgentReply(agentId, text, 'claude'));
  }
  // Fil d'équipe : seul un membre désigné (responsable ou collaborateur) parle, une réponse à la fois par mission.
  async function teamReply(missionId, agentId, res) {
    const mission = studio.getMission(missionId) ?? fail(404, 'Mission introuvable.');
    const members = [mission.assignedTo, ...mission.collaborators].filter(Boolean);
    if (!members.includes(agentId)) fail(403, 'Seuls le responsable et les collaborateurs de la mission prennent la parole dans ce fil.');
    const profile = profileOf(agentId);
    const items = studio.listDiscussion(missionId).slice(-50); // ponytail: 50 derniers messages du fil
    if (!items.length) fail(400, 'Écrivez d’abord un message dans le fil.');
    if (items.at(-1).agentId === agentId) fail(400, `${profile.displayName} vient déjà de répondre.`);
    const nameOf = namer(), context = missionsPrompt([mission], agentId, nameOf, (id) => studio.listMemory(id));
    await stream(res, `mission:${missionId}`, 'Un agent répond déjà dans ce fil.', profile, `${context}\n\n${teamPrompt(mission, items, nameOf, profile.displayName, members)}`, (text) => studio.saveDiscussionReply(missionId, agentId, text, 'claude'));
  }
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${url.pathname}`;
      const replyMatch = req.method === 'POST' && url.pathname.match(/^\/api\/agents\/([^/]+)\/reply$/);
      if (replyMatch) return await reply(decodeURIComponent(replyMatch[1]), res);
      const teamMatch = req.method === 'POST' && url.pathname.match(/^\/api\/missions\/([^/]+)\/discussion\/reply\/([^/]+)$/);
      if (teamMatch) return await teamReply(decodeURIComponent(teamMatch[1]), decodeURIComponent(teamMatch[2]), res);
      const hasBody = req.method === 'POST' || req.method === 'PUT';
      if (routes[key]) return send(res, 200, await routes[key](hasBody ? await body(req) : undefined, url.searchParams));
      for (const [method, re, fn] of paramRoutes) { const m = req.method === method && url.pathname.match(re); if (m) return send(res, 200, await fn(m, hasBody ? await body(req) : undefined, url.searchParams)); }
      const file = resolve(join(root, key === 'GET /' ? 'index.html' : decodeURIComponent(url.pathname)));
      if (req.method !== 'GET' || !file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Introuvable' });
      const real = realpathSync(file); // un lien symbolique ou une jonction ne doit pas sortir de public/
      if (!real.startsWith(realRoot + sep)) return send(res, 404, { error: 'Introuvable' });
      res.writeHead(200, { 'content-type': TYPES[extname(real).toLowerCase()] || 'application/octet-stream' });
      res.end(await readFile(real));
    } catch (error) { send(res, error.status ?? 400, { error: error.message }); }
  });
}
