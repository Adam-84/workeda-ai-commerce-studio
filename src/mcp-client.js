// src/mcp-client.js — client MCP minimal (JSON-RPC 2.0 sur HTTP « Streamable »), sans dépendance, LECTURE SEULE par construction :
//   - `callTool` vérifie la liste blanche AVANT toute requête (outil d'écriture, inconnu ou mal formé : refus sans réseau) ;
//   - un seul hôte, HTTPS, aucune redirection suivie, délai et taille bornés ;
//   - le jeton n'est jamais renvoyé dans une erreur (masqué).
// Le réseau réel est DÉSACTIVÉ par défaut : il faut ARCHIPEL_ALLOW_REAL_NETWORK=1 (accord explicite du propriétaire).
import { assertAllowed } from './integrations-core.js';
import { scrubSecrets } from './secret-store.js';

export const REAL_NETWORK_ENV = 'ARCHIPEL_ALLOW_REAL_NETWORK';
export const MCP_PROTOCOL_VERSION = '2025-11-25';

export class IntegrationError extends Error {
  constructor(kind, message, extra = {}) { super(scrubSecrets(message)); this.name = 'IntegrationError'; this.kind = kind; this.status = extra.status ?? ({ auth: 401, forbidden: 403, rate_limited: 429, plan_restriction: 402, real_network_disabled: 503 }[kind] ?? 502); Object.assign(this, { retryAfterSec: extra.retryAfterSec ?? null }); }
}
// Réseau réel : désactivé tant que le propriétaire ne l'a pas autorisé explicitement.
export function networkGate({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env[REAL_NETWORK_ENV] === '1') return fetchImpl;
  return async () => { throw new IntegrationError('real_network_disabled', `Connexion réelle désactivée : aucun compte n'est contacté tant que ${REAL_NETWORK_ENV}=1 n'est pas défini avec votre accord explicite.`); };
}
export const realNetworkAllowed = (env = process.env) => env[REAL_NETWORK_ENV] === '1';

const retryAfterOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 86_400) : null; };
async function readCapped(res, max) {
  if (res.body?.getReader) {
    const r = res.body.getReader(), chunks = []; let n = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; n += value.byteLength; if (n > max) { try { await r.cancel(); } catch { /* fermé */ } return null; } chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const t = await res.text(); return Buffer.byteLength(t) > max ? null : t;
}
// SSE : « data: {...} » séparés par une ligne vide ; on garde les messages JSON-RPC.
export function parseSse(text) {
  return String(text).split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')).filter(Boolean).map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
}
export function classifyRpcError(err) {
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.data ?? '')} ${err?.code ?? ''}`;
  if (/PLAN_RESTRICTION/i.test(text)) return new IntegrationError('plan_restriction', 'Votre plan DSers n’inclut pas la connexion MCP (plan Advanced, Pro ou Enterprise requis).');
  if (/RATE_LIMITED/i.test(text)) return new IntegrationError('rate_limited', 'Quota quotidien DSers atteint : réessayez après la réinitialisation.');
  if (/unauthor|invalid_token|expired/i.test(text)) return new IntegrationError('auth', 'Accès refusé ou expiré : reconnectez DSers.');
  return new IntegrationError('protocol', 'Erreur renvoyée par le serveur MCP (détail distant non conservé).'); // jamais de texte distant : il pourrait refléter un jeton
}

export function createMcpClient({ url, integration = 'dsers', fetchImpl, getToken, timeoutMs = 20_000, maxBytes = 2_000_000, beforeRpc = null, afterRpc = null, clientInfo = { name: 'archipel-readonly', version: '1.0.0' } }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('MCP : HTTPS exigé.');
  let session = null, nextId = 1;

  async function rpc(method, params, opts = {}) {
    await beforeRpc?.(method); // pause demandée par le service, plafond quotidien : AVANT chaque requête (pages comprises)
    const t0 = Date.now();
    try { const r = await rpcRaw(method, params, opts); afterRpc?.({ method, ok: true, ms: Date.now() - t0 }); return r; }
    catch (e) { afterRpc?.({ method, ok: false, ms: Date.now() - t0, error: e.message }); throw e; }
  }
  async function rpcRaw(method, params, { notification = false } = {}) {
    const token = await getToken();
    if (!token) throw new IntegrationError('auth', 'Non authentifié : connectez le service d’abord.');
    const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': MCP_PROTOCOL_VERSION, ...(session ? { 'mcp-session-id': session } : {}) } });
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      throw new IntegrationError(e?.name === 'TimeoutError' ? 'timeout' : 'network', e?.name === 'TimeoutError' ? 'Délai dépassé.' : 'Service injoignable.');
    }
    if (res.status >= 300 && res.status < 400) throw new IntegrationError('protocol', 'Redirection refusée.');
    const sid = res.headers?.get?.('mcp-session-id'); if (sid) session = sid;
    if (res.status === 401) throw new IntegrationError('auth', 'Accès refusé ou expiré : reconnectez DSers.');
    if (res.status === 429) throw new IntegrationError('rate_limited', 'Trop de requêtes ou quota atteint.', { retryAfterSec: retryAfterOf(res.headers?.get?.('retry-after')) });
    let text; try { text = await readCapped(res, maxBytes); } catch { throw new IntegrationError('network', 'Lecture interrompue.'); }
    if (text === null) throw new IntegrationError('protocol', 'Réponse trop volumineuse.');
    if (notification) return null;
    if (res.status === 403) {
      let j = {}; try { j = JSON.parse(text) ?? {}; } catch { /* corps non JSON */ }
      const e = classifyRpcError({ message: j.error_description ?? j.error ?? '', data: j });
      throw e.kind === 'protocol' ? new IntegrationError('forbidden', 'Accès refusé par le service.') : e; // PLAN_RESTRICTION / RATE_LIMITED gardent leur type
    }
    if (res.status >= 400) throw new IntegrationError('http', `Erreur HTTP ${res.status}.`);
    const ct = res.headers?.get?.('content-type') ?? '';
    const messages = /text\/event-stream/i.test(ct) ? parseSse(text) : (() => { try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch { return []; } })();
    const reply = messages.find((m) => m.id === body.id);
    if (!reply) throw new IntegrationError('protocol', 'Réponse MCP illisible.');
    if (reply.error) throw classifyRpcError(reply.error);
    return reply.result;
  }

  return {
    async initialize() {
      const r = await rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo });
      await rpc('notifications/initialized', {}, { notification: true });
      return { serverInfo: r?.serverInfo ?? null, protocolVersion: r?.protocolVersion ?? null };
    },
    async listTools() {
      const out = []; let cursor;
      for (let i = 0; i < 5; i += 1) { const r = await rpc('tools/list', cursor ? { cursor } : {}); out.push(...(r?.tools ?? []).map((t) => ({ name: String(t.name), description: String(t.description ?? '').slice(0, 300), readOnlyHint: t.annotations?.readOnlyHint ?? null }))); cursor = r?.nextCursor; if (!cursor) break; }
      return out;
    },
    // LA porte : liste blanche d'abord (aucun réseau pour un outil refusé), puis l'appel.
    async callTool(name, args = {}) {
      assertAllowed(integration, name);
      const r = await rpc('tools/call', { name, arguments: args });
      const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r?.isError) throw classifyRpcError({ message: text.slice(0, 300) || 'erreur d’outil' });
      if (r?.structuredContent) return r.structuredContent;
      try { return JSON.parse(text); } catch { return { text: text.slice(0, 4000) }; }
    },
    get sessionId() { return session; }
  };
}
