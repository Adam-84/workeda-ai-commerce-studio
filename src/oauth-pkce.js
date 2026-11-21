// src/oauth-pkce.js — OAuth 2.1 + PKCE (client public, sans secret) pour DSers, LECTURE SEULE :
//   - seules les portées de lecture de DSERS_READ_SCOPES peuvent être demandées (une portée d'écriture ou inconnue → refus avant tout réseau) ;
//   - les points d'accès OAuth doivent rester sur l'hôte de DSers (HTTPS) ;
//   - le mot de passe DSers ne passe jamais ici : la connexion se fait dans votre navigateur ;
//   - ce module ne déclenche AUCUNE connexion à lui seul : tout passe par un fetch injecté (réseau réel désactivé par défaut).
import { createHash, randomBytes } from 'node:crypto';
import { DSERS_READ_SCOPES } from './integrations-core.js';
import { IntegrationError } from './mcp-client.js';

export const DSERS_ORIGIN = 'https://ai.dsers.com';
export const METADATA_URL = `${DSERS_ORIGIN}/.well-known/oauth-authorization-server`;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function assertReadScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) throw new IntegrationError('forbidden', 'Aucune portée demandée.');
  const refused = scopes.filter((s) => !DSERS_READ_SCOPES.includes(s));
  if (refused.length) throw new IntegrationError('forbidden', `Portée(s) refusée(s) (lecture seule exigée, liste fixe) : ${refused.slice(0, 5).join(', ')}.`);
  return [...new Set(scopes)];
}
export function assertDsersEndpoint(url, label) {
  let u; try { u = new URL(url); } catch { throw new IntegrationError('protocol', `${label} : adresse invalide.`); }
  if (u.protocol !== 'https:' || u.origin !== DSERS_ORIGIN) throw new IntegrationError('protocol', `${label} : hôte non autorisé.`);
  return u.href;
}
export function createPkce() {
  const verifier = b64u(randomBytes(48)), challenge = b64u(createHash('sha256').update(verifier).digest()), state = b64u(randomBytes(24));
  return { verifier, challenge, state };
}
export function buildAuthorizationUrl({ metadata, clientId, redirectUri, scopes, challenge, state }) {
  const endpoint = assertDsersEndpoint(metadata.authorization_endpoint, 'Autorisation');
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new IntegrationError('protocol', 'DSers n’annonce pas PKCE S256 : refusé.');
  const u = new URL(endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: assertReadScopes(scopes).join(' '), code_challenge: challenge, code_challenge_method: 'S256', state })) u.searchParams.set(k, v);
  return u.href;
}
export function assertLoopbackRedirect(uri) {
  let u; try { u = new URL(uri); } catch { throw new IntegrationError('protocol', 'Adresse de retour invalide.'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new IntegrationError('protocol', 'L’adresse de retour doit être locale (127.0.0.1).');
  return u.href;
}

async function postJson(fetchImpl, url, body, label, { form = false } = {}) {
  let res;
  try { res = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }); }
  catch (e) { if (e instanceof IntegrationError) throw e; throw new IntegrationError('network', `${label} : service injoignable.`); }
  if (res.status >= 300 && res.status < 400) throw new IntegrationError('protocol', `${label} : redirection refusée.`);
  let j = {}; try { j = JSON.parse(await res.text()) ?? {}; } catch { /* corps non JSON */ }
  if (res.status >= 400) throw new IntegrationError(res.status === 401 || j.error === 'invalid_grant' ? 'auth' : 'http', `${label} : refusé (${String(j.error ?? res.status).slice(0, 60)}).`);
  return j;
}
export async function fetchMetadata(fetchImpl) {
  let res; try { res = await fetchImpl(METADATA_URL, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } }); } catch (e) { if (e instanceof IntegrationError) throw e; throw new IntegrationError('network', 'Métadonnées OAuth injoignables.'); }
  if (res.status !== 200) throw new IntegrationError('http', `Métadonnées OAuth : réponse ${res.status}.`);
  const j = JSON.parse(await res.text());
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) assertDsersEndpoint(j[k], k);
  return j;
}
export async function registerClient({ fetchImpl, metadata, redirectUri }) {
  const j = await postJson(fetchImpl, assertDsersEndpoint(metadata.registration_endpoint, 'Enregistrement'), { client_name: 'Archipel (lecture seule)', redirect_uris: [assertLoopbackRedirect(redirectUri)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: DSERS_READ_SCOPES.join(' ') }, 'Enregistrement du client');
  if (!j.client_id) throw new IntegrationError('protocol', 'Enregistrement du client : identifiant manquant.');
  return { clientId: String(j.client_id) };
}
// Les portées ACCORDÉES doivent rester des lectures : si DSers en accorde une autre, on REFUSE et on jette les jetons.
export function grantedScopes(tokenResponse, requested) {
  const granted = typeof tokenResponse.scope === 'string' && tokenResponse.scope.trim() ? tokenResponse.scope.trim().split(/\s+/) : requested;
  const extra = granted.filter((s) => !DSERS_READ_SCOPES.includes(s));
  if (extra.length) throw new IntegrationError('forbidden', `DSers a accordé des portées hors lecture seule (${extra.slice(0, 4).join(', ')}) : connexion refusée et jetons supprimés.`);
  return granted;
}
const shape = (j, requested, now) => {
  if (!j.access_token) throw new IntegrationError('protocol', 'Réponse de jeton sans accès.');
  return { access: String(j.access_token), refresh: j.refresh_token ? String(j.refresh_token) : null, expiresAt: now + Math.max(60, Number(j.expires_in) || 3600) * 1000, scopes: grantedScopes(j, requested) };
};
export async function exchangeCode({ fetchImpl, metadata, clientId, redirectUri, code, verifier, scopes, now = Date.now() }) {
  const j = await postJson(fetchImpl, assertDsersEndpoint(metadata.token_endpoint, 'Jeton'), { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }, 'Échange du code', { form: true });
  return shape(j, scopes, now);
}
export async function refreshTokens({ fetchImpl, metadata, clientId, refresh, scopes, now = Date.now() }) {
  const j = await postJson(fetchImpl, assertDsersEndpoint(metadata.token_endpoint, 'Jeton'), { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }, 'Renouvellement du jeton', { form: true });
  const t = shape(j, scopes, now);
  return { ...t, refresh: t.refresh ?? refresh };
}
// États en attente (mémoire du processus, usage unique, 10 minutes) : un « state » inconnu ou rejoué est refusé.
export function createFlowStore({ ttlMs = 600_000, now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    put(state, data) { for (const [k, v] of m) if (now() - v.at > ttlMs) m.delete(k); m.set(state, { ...data, at: now() }); },
    take(state) { const v = m.get(state); m.delete(state); return v && now() - v.at <= ttlMs ? v : null; },
    size: () => m.size
  };
}
