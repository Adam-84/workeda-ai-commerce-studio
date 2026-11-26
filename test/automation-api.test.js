import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
test('local Automation API creates disabled rules and rejects foreign origins before mutation', async () => {
  const studio = createStudio(':memory:', { automationIdentity: 'api-test', shopConnector: null, env: {} }); studio.syncAgentFiles(profiles);
  const app = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false, agentFiles: { profiles }, runClaude: async () => { throw new Error('No real AI'); } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const call = async (path, body, headers = {}) => { const r = await fetch(url + '/api/automations' + path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...headers } }); return { status: r.status, body: await r.json() }; };
  try {
    const d = { name: 'Contrôle local', objective: 'Analyser', agentSlug: 'maxime', sources: ['shopify_apps'], trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } };
    assert.equal((await call('', d, { origin: 'https://evil.example' })).status, 403);
    const saved = await call('', d); assert.equal(saved.status, 200); assert.equal(saved.body.enabled, false);
    assert.equal((await call(`/${saved.body.id}/activate`, { confirm: true })).status, 409);
    await call('/executor', { confirm: true }); await call(`/${saved.body.id}/activate`, { confirm: true });
    const list = await call(''); assert.equal(list.body.rules.length, 1); assert.equal(list.body.templates.length, 10);
    await call('/pause', { paused: true }); assert.equal((await call(`/${saved.body.id}/run`, { confirm: true })).status, 409);
    const foreignHost = await new Promise((resolve, reject) => { const req = http.get(url + '/api/automations', { headers: { host: 'evil.example' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); });
    assert.equal(foreignHost, 403);
    assert.equal((await call('/preview', { schedule: { kind: 'daily', time: '09:00' } })).body.slots.length, 5);
  } finally { await new Promise((r) => app.close(r)); studio.close(); }
});
