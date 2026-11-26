import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';

// HTTP is the owner boundary: earlier tests cover selected subsystems only.
// A guard moved below streaming handlers must fail here before any paid runner call.
test('all local API routes reject foreign origins and rebinding hosts before data or AI access', async () => {
  const studio = createStudio(':memory:', { env: {}, shopConnector: null });
  const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
  studio.syncAgentFiles(profiles);
  let calls = 0;
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false,
    agentFiles: { profiles }, runClaude: async () => { calls++; return 'Réponse simulée'; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = studio.listAgents()[0];
  studio.sendUserMessage(agent.id, { body: 'Bonjour' });
  try {
    const positive = await fetch(`${base}/api/agents/${agent.id}/reply`, { method: 'POST', headers: { origin: base } });
    await positive.text();
    assert.equal(positive.status, 200);
    assert.equal(calls, 1, 'positive control reaches the actual runner boundary');
    for (const [path, method, data] of [
      ['/api/missions', 'POST', { title: 'Interdit' }],
      [`/api/agents/${agent.id}/reply`, 'POST', {}],
      [`/api/agents/${agent.id}/instructions`, 'PUT', { objective: 'Interdit' }],
    ]) {
      const response = await fetch(base + path, { method, headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify(data) });
      await response.text();
      assert.equal(response.status, 403, path);
    }
    for (const path of ['/api/missions', '/api/agents', `/api/agents/${agent.id}/conversation`]) {
      // Native HTTP preserves Host; this Node fetch implementation rewrites it.
      const status = await new Promise((resolve, reject) => {
        const req = request(base + path, { headers: { host: 'rebind.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403, path);
    }
    assert.equal(calls, 1);
    assert.equal(studio.listMissions().length, 0);
    assert.equal((await fetch(base + '/api/missions')).headers.get('cache-control'), 'no-store');
  } finally { await new Promise(r => server.close(r)); studio.close(); }
});
