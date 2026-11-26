import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const deny = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) throw new Error('Utilisez un mot de passe de 16 à 1024 caractères.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt, 64)).toString('hex')}`;
}

export function createCloudAuth({ passwordHash, origin, now = Date.now, sessionTtlMs = 12 * 3600000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw new Error('ARCHIPEL_ORIGIN requis.'); }
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('HTTPS requis, sauf recette sur loopback.');
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash ?? '')) throw new Error('Empreinte de mot de passe scrypt requise.');
  if (!(sessionTtlMs > 0 && sessionTtlMs <= 12 * 3600000)) throw new Error('Expiration de session invalide.');
  const [, salt, expected] = passwordHash.split('$');
  const sessions = new Map(), attempts = new Map(); let totalAttempts = [], verifying = 0;
  const secure = base.protocol === 'https:';
  const cookieName = secure ? '__Host-archipel' : 'archipel_session';
  const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const tokenOf = req => (req.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  const headers = res => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
  };
  const checkRequest = (req, checkOrigin = true) => {
    if (req.headers.host !== base.host) throw deny(403, 'Hôte refusé.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw deny(403, 'Requête intersite refusée.');
    if (checkOrigin && !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== base.origin) throw deny(403, 'Origine refusée.');
  };
  const authorize = (req, { checkOrigin = true } = {}) => {
    checkRequest(req, checkOrigin);
    const key = digest(tokenOf(req)), session = sessions.get(key), at = now();
    if (!session || at >= session.expires || at - session.seen >= 30 * 60000) { sessions.delete(key); throw deny(401, 'Connexion requise.'); }
    session.seen = at; return { expiresAt: new Date(session.expires).toISOString() };
  };
  const json = (res, status, value) => { headers(res); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const read = async req => {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw deny(415, 'JSON requis.');
    let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) throw deny(413, 'Requête trop volumineuse.'); }
    try { return JSON.parse(text); } catch { throw deny(400, 'JSON invalide.'); }
  };
  return {
    authorize, headers, origin: base.origin,
    async handle(req, res) {
      const path = req.url.split('?')[0];
      if (!path.startsWith('/auth/')) return false;
      headers(res);
      try {
        checkRequest(req);
        if (path === '/auth/login' && req.method === 'POST') {
          const at = now(), ip = req.socket.remoteAddress;
          for (const [key, values] of attempts) { const live = values.filter(t => t > at - 900000); if (live.length) attempts.set(key, live); else attempts.delete(key); }
          totalAttempts = totalAttempts.filter(t => t > at - 900000);
          const failures = attempts.get(ip) ?? [];
          if (failures.length >= 5 || totalAttempts.length >= 30 || verifying >= 2 || attempts.size >= 1000) throw deny(429, 'Trop de tentatives. Réessayez plus tard.');
          // Reserve before asynchronous password derivation, preventing concurrent bypass.
          failures.push(at); attempts.set(ip, failures); totalAttempts.push(at);
          const input = await read(req);
          if (typeof input?.password !== 'string' || input.password.length > 1024) throw deny(401, 'Identifiants incorrects.');
          verifying++;
          let actual; try { actual = await derive(input.password, salt, 64); } finally { verifying--; }
          if (!timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw deny(401, 'Identifiants incorrects.');
          attempts.delete(ip);
          for (const [key, session] of sessions) if (session.expires <= at) sessions.delete(key);
          if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
          const token = randomBytes(32).toString('base64url');
          sessions.set(digest(token), { expires: at + sessionTtlMs, seen: at });
          res.setHeader('set-cookie', cookie(token, Math.floor(sessionTtlMs / 1000)));
          json(res, 200, { authenticated: true }); return true;
        }
        const session = authorize(req);
        if (path === '/auth/session' && req.method === 'GET') json(res, 200, { authenticated: true, ...session });
        else if (['/auth/logout', '/auth/revoke'].includes(path) && req.method === 'POST') {
          if (path === '/auth/revoke') sessions.clear(); else sessions.delete(digest(tokenOf(req)));
          res.setHeader('set-cookie', cookie('', 0)); json(res, 200, { authenticated: false });
        } else json(res, 404, { error: 'Introuvable.' });
      } catch (e) { req.resume(); json(res, e.status ?? 500, { error: e.status ? e.message : 'Authentification indisponible.' }); }
      return true;
    }
  };
}
