import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('the real server preloads the ten agents from .claude/agents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-start-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], { env: { ...process.env, PORT: '0', WORKEDA_DB: join(dir, 'essai.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.once('exit', r));
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; const m = out.match(/http:\/\/localhost:(\d+)/); if (m) resolve(Number(m[1])); });
      child.once('exit', (code) => reject(new Error(`serveur arrêté (code ${code}) : ${out}`)));
    });
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.deepEqual(health.agentFiles, { loaded: 10, warnings: [] });
    const agents = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
    assert.equal(agents.length, 10);
    const profiles = await (await fetch(`http://127.0.0.1:${port}/api/agent-profiles`)).json();
    assert.equal(profiles.length, 10);
  } finally {
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
