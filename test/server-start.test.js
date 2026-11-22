import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('the real server preloads the ten agents from .claude/agents', { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-start-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    cwd: root, timeout: 15_000, signal: t.signal,
    env: { ...process.env, PORT: '0', WORKEDA_DB: join(dir, 'essai.db') }, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const exited = new Promise((r) => child.once('exit', r));
  let out = '', err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk) => { out += chunk; const m = out.match(/http:\/\/localhost:(\d+)/); if (m) resolve(Number(m[1])); });
      child.once('exit', (code) => reject(new Error(`serveur arrêté (code ${code}) : stdout=${out} stderr=${err}`)));
    });
    const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) })).json();
    const health = await get('/api/health');
    assert.deepEqual(health.agentFiles, { loaded: 11, warnings: [] });
    assert.equal((await get('/api/agents')).length, 11);
    assert.equal((await get('/api/agent-profiles')).length, 11);
  } finally {
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
