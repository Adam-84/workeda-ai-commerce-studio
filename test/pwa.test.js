// Progressive Web App : ce qui est installable, ce qui est mis en cache, ce qui est servi sans session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createCloudRuntime } from '../src/cloud-server.js';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/cloud-auth.js';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url));
const manifest = () => JSON.parse(read('manifest.webmanifest'));
const ORIGIN = 'https://archipel.test';

// Exécute sw.js avec un navigateur simulé : événements, cache et réseau observables.
function serviceWorker({ network }) {
  const handlers = {}, stores = new Map(), calls = [];
  const store = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const key = (request) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  const caches = {
    open: async (name) => ({ addAll: async (paths) => { for (const p of paths) store(name).set(key(p), `copie ${key(p)}`); }, put: async (request, value) => store(name).set(key(request), value) }),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (request) => { for (const s of stores.values()) if (s.has(key(request))) return s.get(key(request)); return undefined; }
  };
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, location: new URL(ORIGIN), skipWaiting: () => calls.push('skipWaiting'), clients: { claim: async () => calls.push('claim') } };
  vm.runInNewContext(read('sw.js').toString(), { self, caches, URL, fetch: async (request) => { calls.push(`fetch ${key(request)}`); return network(request); } });
  const dispatch = async (type, event = {}) => { let waited; handlers[type]?.({ ...event, waitUntil: (p) => { waited = p; } }); await waited; };
  const request = async (path, { method = 'GET', mode = 'cors', origin = ORIGIN } = {}) => {
    let response; handlers.fetch({ request: { url: origin + path, method, mode }, respondWith: (p) => { response = p; } });
    return response === undefined ? undefined : { value: await response };
  };
  return { handlers, stores, store, calls, dispatch, request };
}

test('the service worker caches only the fixed public files', async () => {
  const sw = serviceWorker({ network: async () => 'réseau' });
  await sw.dispatch('install');
  const cached = [...sw.stores.values()].flatMap((s) => [...s.keys()]).sort();
  assert.ok(cached.includes('/offline.html'));
  assert.ok(cached.every((p) => p === '/offline.html' || p === '/manifest.webmanifest' || p.startsWith('/icons/')), cached.join(', '));
});

test('the service worker never answers for private routes, writes or other origins', async () => {
  const sw = serviceWorker({ network: async () => 'réseau' });
  await sw.dispatch('install');
  for (const path of ['/api/agents', '/auth/session', '/worker/claim', '/app.js', '/style.css']) assert.equal(await sw.request(path), undefined, path);
  assert.equal(await sw.request('/offline.html', { method: 'POST' }), undefined);
  assert.equal(await sw.request('/icons/icon-192.png', { origin: 'https://autre.test' }), undefined);
  assert.equal(await sw.request('/api/missions', { mode: 'navigate' }), undefined);
});

test('navigation uses the network and falls back to the offline page without caching it', async () => {
  let online = true;
  const sw = serviceWorker({ network: async () => { if (!online) throw new TypeError('hors ligne'); return 'page en ligne'; } });
  await sw.dispatch('install');
  const before = JSON.stringify([...sw.stores.values()].map((s) => [...s]));
  assert.equal((await sw.request('/', { mode: 'navigate' })).value, 'page en ligne');
  assert.equal(JSON.stringify([...sw.stores.values()].map((s) => [...s])), before);
  online = false;
  assert.equal((await sw.request('/', { mode: 'navigate' })).value, 'copie /offline.html');
});

test('an update waits for the owner and then replaces older caches', async () => {
  const sw = serviceWorker({ network: async () => 'réseau' });
  sw.store('archipel-public-ancien').set('/offline.html', 'périmé');
  sw.store('autre-application').set('/x', 'intact');
  await sw.dispatch('install');
  assert.ok(!sw.calls.includes('skipWaiting'));
  sw.handlers.message({ data: 'update' });
  assert.ok(sw.calls.includes('skipWaiting'));
  await sw.dispatch('activate');
  assert.ok(!sw.stores.has('archipel-public-ancien'));
  assert.ok(sw.stores.has('autre-application'));
});

test('the manifest is installable and every icon has the declared PNG size', () => {
  const m = manifest();
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  for (const size of ['192x192', '512x512']) assert.ok(m.icons.some((i) => i.sizes === size && i.purpose !== 'maskable'), size);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of [...m.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const png = read(icon.src.slice(1));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
});

test('both pages declare the manifest and a mobile viewport', () => {
  for (const page of ['index.html', 'login.html']) {
    const html = read(page).toString();
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, page);
    assert.match(html, /rel="apple-touch-icon"/, page);
    assert.match(html, /viewport-fit=cover/, page);
  }
});

test('the offline page loads nothing and says the data is not shown', () => {
  const html = read('offline.html').toString();
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+stylesheet|https?:\/\//);
  assert.match(html, /Hors connexion/);
});

test('the central server publishes only the public installation files without a session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-pwa-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), env: {} });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = (path) => fetch(runtime.origin + path, { redirect: 'manual' });
  const open = ['/manifest.webmanifest', '/sw.js', '/offline.html', '/pwa.js', ...readdirSync(new URL('../public/icons', import.meta.url)).map((f) => `/icons/${f}`)];
  for (const path of open) assert.equal((await get(path)).status, 200, path);
  assert.match((await get('/manifest.webmanifest')).headers.get('content-type'), /manifest\+json/);
  for (const path of ['/app.js', '/style.css', '/index.html', '/hq-ui.js', '/api/agents', '/icons/../app.js', '/icons/%2e%2e/app.js', '/icons/absent.png']) assert.notEqual((await get(path)).status, 200, path);
});

test('the local server serves the manifest with its media type', async (t) => {
  const studio = createStudio(':memory:');
  const server = createApp({ studio, publicDir: join(import.meta.dirname, '..', 'public'), detect: () => false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(() => { studio.close(); r(); })));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/manifest.webmanifest`);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
});
