import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

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

export function createApp({ studio, publicDir, detect = cliPresent }) {
  const root = resolve(publicDir), realRoot = realpathSync(root);
  const routes = {
    'GET /api/health': () => ({ node: process.version, connectors: { shopifyCli: detect('shopify'), claudeCode: detect('claude'), codexCli: detect('codex'), clink: detect('clink') }, mode: 'local-only' }),
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
      if (routes[key]) return send(res, 200, await routes[key](hasBody ? await body(req) : undefined, url.searchParams));
      for (const [method, re, fn] of paramRoutes) { const m = req.method === method && url.pathname.match(re); if (m) return send(res, 200, await fn(m, hasBody ? await body(req) : undefined)); }
      const file = resolve(join(root, key === 'GET /' ? 'index.html' : decodeURIComponent(url.pathname)));
      if (req.method !== 'GET' || !file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Introuvable' });
      const real = realpathSync(file); // un lien symbolique ou une jonction ne doit pas sortir de public/
      if (!real.startsWith(realRoot + sep)) return send(res, 404, { error: 'Introuvable' });
      res.writeHead(200, { 'content-type': TYPES[extname(real).toLowerCase()] || 'application/octet-stream' });
      res.end(await readFile(real));
    } catch (error) { send(res, error.status ?? 400, { error: error.message }); }
  });
}
