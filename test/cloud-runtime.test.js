import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';

test('two authenticated devices share data; no-worker missions stay queued while deterministic automation runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-cloud-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), port: 0, env: {} });
  const request = async (path, data, cookie, origin = runtime.origin) => {
    const response = await fetch(runtime.origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual' });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json().catch(() => null) };
  };
  try {
    assert.equal((await request('/api/agents')).status, 401);
    assert.equal((await fetch(runtime.origin + '/', { redirect: 'manual' })).status, 303);
    const a = (await request('/auth/login', { password: 'test-only-password-long' })).cookie;
    const b = (await request('/auth/login', { password: 'test-only-password-long' })).cookie;
    assert.notEqual(a, b);
    const agents = (await request('/api/agents', undefined, a)).body;
    assert.equal(agents.length, 11);
    assert.equal((await request('/api/missions', { title: 'Mission centrale fictive' }, a)).status, 200);
    assert.equal((await request('/api/missions', undefined, b)).body[0].title, 'Mission centrale fictive');
    assert.equal((await request('/api/missions', { title: 'CSRF' }, a, 'https://evil.invalid')).status, 403);
    const task = await request('/api/comm/delegations', { assigneeId: agents[0].id, instruction: 'Résumer les informations disponibles' }, a);
    assert.equal(task.status, 200);
    assert.equal(runtime.studio.comm.listTasks()[0].state, 'queued');
    assert.equal(runtime.studio.comm.activeRuns().length, 0);
    runtime.studio.automation.designate({ confirm: true });
    const d = runtime.studio.automation.save({ name: 'Déterministe', agentSlug: 'olivia', objective: 'Contrôler les missions', sources: ['missions'], trigger: { kind: 'time', schedule: { kind: 'daily', time: '09:00' } } });
    runtime.studio.automation.manual(d.id, { confirm: true }); await runtime.app.automationRunner.tick();
    assert.equal(runtime.studio.automation.history()[0].state, 'done');
    const ai = runtime.studio.automation.save({ ...d, id: undefined, name: 'IA en attente', allowAi: true });
    runtime.studio.automation.manual(ai.id, { confirm: true, ai: true }); await runtime.app.automationRunner.tick();
    assert.equal(runtime.studio.automation.history()[0].state, 'waiting_ai');
    assert.equal(runtime.studio.automation.history()[0].ai_reserved, 0);
    assert.equal((await request('/api/operations', undefined, b)).body.providers.codex.state, 'disabled');
    assert.equal((await request('/worker/claim', {}, a)).status, 401);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
