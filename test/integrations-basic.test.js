import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../src/studio.js';
import { createSecretStore, testProtector } from '../src/secret-store.js';
import { createSimDsers } from './helpers/sim-servers.js';

const basicError = (e) => e.kind === 'plan_restriction' && e.message === 'Indisponible — abonnement Basic';
test('Basic par défaut : tous les points d’entrée DSers refusent avant réseau et création de secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-basic-'));
  const secrets = createSecretStore({ dir, protector: testProtector() });
  let fetches = 0;
  const studio = createStudio(':memory:', { secrets, env: {}, integrationsFetch: async () => { fetches += 1; throw new Error('interdit'); } });
  t.after(() => studio.close());
  const svc = studio.integrations, connector = svc.dsers;
  for (const operation of [() => svc.beginAuth('dsers'), () => svc.completeAuth({ code: 'factice', state: 'factice' }), () => svc.test('dsers'), () => svc.sync('dsers'), () => connector.beginAuth(), () => connector.completeAuth({ code: 'factice', state: 'factice' }), () => connector.accessToken(), () => connector.test(), () => connector.sync(), () => connector.call('list_stores')]) await assert.rejects(operation, basicError);
  assert.equal(fetches, 0);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(svc.store.quota('dsers').used, 0);
  assert.equal(svc.card('dsers').stateLabel, 'Indisponible — abonnement Basic');
});

test('passage à Basic pendant OAuth : réponse ignorée sans créer de secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-basic-'));
  const secrets = createSecretStore({ dir, protector: testProtector() });
  const sim = createSimDsers();
  let release, entered;
  const held = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  const studio = createStudio(':memory:', { secrets, env: { ARCHIPEL_ALLOW_REAL_NETWORK: '1' }, integrationsFetch: async (u, i) => { entered(); await held; return sim.fetch(u, i); }, redirectUri: 'http://127.0.0.1:4318/api/integrations/dsers/callback' });
  t.after(() => studio.close());
  const svc = studio.integrations;
  svc.store.patch('dsers', { settings: { plan: 'advanced' } });
  const pending = svc.beginAuth('dsers');
  await started;
  svc.store.patch('dsers', { settings: { plan: 'basic' } });
  release();
  await assert.rejects(() => pending, basicError);
  assert.equal(sim.state.http.length, 1);
  assert.deepEqual(readdirSync(dir), []);
});

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
test('Basic via API locale : OAuth, callback, test et synchronisation restent sans réseau', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-basic-api-'));
  let fetches = 0;
  const studio = createStudio(':memory:', { secrets: createSecretStore({ dir, protector: testProtector() }), env: {}, integrationsFetch: async () => { fetches += 1; throw new Error('interdit'); } });
  const app = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), agentFiles: { profiles: [], warnings: [] } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise((r) => app.close(r)); studio.close(); });
  const request = (method, path) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.address().port, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end(method === 'POST' ? JSON.stringify({ confirm: true }) : undefined);
  });
  for (const [method, path] of [['POST', '/api/integrations/dsers/connect'], ['GET', '/api/integrations/dsers/callback?code=factice&state=factice'], ['POST', '/api/integrations/dsers/test'], ['POST', '/api/integrations/dsers/sync']]) {
    const response = await request(method, path);
    if (/connect|callback/.test(path)) assert.ok(response.status >= 400, path);
    assert.match(response.body, /Indisponible — abonnement Basic/, path);
  }
  assert.equal(fetches, 0);
  assert.deepEqual(readdirSync(dir), []);
});
