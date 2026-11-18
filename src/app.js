import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectorState, MAX_PRELOADED } from './agent-files.js';

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

// Les routes qui écrivent dans skills/ ou dans les fiches ne répondent qu'à cette machine : un Skill est du texte que
// les agents lisent comme une consigne, il ne doit pas pouvoir être modifié par une autre page web ou un autre poste.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SKILL_PATH = /^\/api\/(?:skills(?:\/|$)|agents\/[^/]+\/skills)/;
function assertLocalWrite(req) {
  const deny = (why) => Object.assign(new Error(`Modification refusée : ${why}.`), { status: 403 });
  if (!LOOPBACK.has(req.socket.remoteAddress)) throw deny('connexion non locale');
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { throw deny('en-tête Host invalide'); }
  if (!LOCAL_HOSTS.has(host.hostname)) throw deny('nom d’hôte non local');
  const { origin } = req.headers; // absent pour un appel sans navigateur ; présent et différent pour une autre page web
  if (origin !== undefined) {
    let from = null;
    try { from = new URL(origin).host; } catch { /* « null » ou illisible : refusé ci-dessous */ }
    if (from !== host.host) throw deny('requête issue d’une autre origine');
  }
}

export function createApp({ studio, publicDir, skills, detect: rawDetect = cliPresent, agentFiles: { profiles = [], warnings = [] } = {} }) {
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
  const paramRoutes = [
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
    ['PUT', /^\/api\/agents\/([^/]+)\/appearance$/, (m, data) => studio.setAppearance(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/agents\/([^/]+)\/appearance$/, (m) => studio.clearAppearance(decodeURIComponent(m[1]))],
    ['PUT', /^\/api\/departments\/([^/]+)\/style$/, (m, data) => studio.setIslandStyle(decodeURIComponent(m[1]), data)],
    ['DELETE', /^\/api\/departments\/([^/]+)\/style$/, (m) => studio.clearIslandStyle(decodeURIComponent(m[1]))]
  ];
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${url.pathname}`;
      const hasBody = req.method === 'POST' || req.method === 'PUT';
      if (skills && req.method !== 'GET' && SKILL_PATH.test(url.pathname)) assertLocalWrite(req);
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
