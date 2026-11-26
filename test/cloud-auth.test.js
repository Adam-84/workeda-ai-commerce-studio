import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCloudAuth, hashPassword } from '../src/cloud-auth.js';

test('owner sessions protect data, enforce origin, expire, revoke and throttle login', async () => {
  let now = 1000, auth;
  const server = createServer(async (req, res) => {
    try { if (await auth.handle(req, res)) return; auth.authorize(req); res.end('private'); }
    catch (e) { res.writeHead(e.status ?? 500); res.end('denied'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  auth = createCloudAuth({ passwordHash: await hashPassword('test-only-password-long'), origin, now: () => now, sessionTtlMs: 10000 });
  const call = async (path, data, cookie, from = origin) => {
    const res = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { origin: from, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = { status: res.status, cookie: res.headers.get('set-cookie'), cache: res.headers.get('cache-control'), text: await res.text() }; return result;
  };
  try {
    assert.equal((await call('/api/private')).status, 401);
    assert.equal((await call('/auth/login', { password: 'wrong' })).status, 401);
    assert.equal((await call('/auth/login', { password: 'test-only-password-long' }, null, 'https://evil.invalid')).status, 403);
    const login = await call('/auth/login', { password: 'test-only-password-long' });
    assert.equal(login.status, 200); assert.equal(login.cache, 'no-store'); assert.match(login.cookie, /HttpOnly/); assert.match(login.cookie, /SameSite=Strict/);
    const cookie = login.cookie.split(';')[0];
    assert.equal((await call('/api/private', undefined, cookie)).status, 200);
    assert.equal((await call('/api/private', {}, cookie, 'https://evil.invalid')).status, 403);
    now += 10001; assert.equal((await call('/api/private', undefined, cookie)).status, 401);
    const next = (await call('/auth/login', { password: 'test-only-password-long' })).cookie.split(';')[0];
    await call('/auth/revoke', {}, next);
    assert.equal((await call('/api/private', undefined, next)).status, 401);
    const last = (await call('/auth/login', { password: 'test-only-password-long' })).cookie.split(';')[0];
    await call('/auth/logout', {}, last);
    assert.equal((await call('/api/private', undefined, last)).status, 401);
    let throttled = false;
    for (let i = 0; i < 12; i++) if ((await call('/auth/login', { password: 'wrong' })).status === 429) throttled = true;
    assert.ok(throttled);
  } finally { await new Promise(r => server.close(r)); }
});

test('cloud auth refuses insecure remote origin and malformed password configuration', async () => {
  const passwordHash = await hashPassword('test-only-password-long');
  assert.throws(() => createCloudAuth({ passwordHash, origin: 'http://archipel.example' }));
  assert.throws(() => createCloudAuth({ passwordHash: 'plaintext', origin: 'https://archipel.example' }));
  assert.throws(() => createCloudAuth({ passwordHash, origin: 'https://user:password@archipel.example' }));
});
