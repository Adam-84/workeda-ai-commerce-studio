import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Local to this installation; never exported with rules or the SQLite backup.
export function automationIdentity(filename) {
  if (filename === ':memory:') return null;
  const path = join(dirname(filename), 'automation-executor.local.json');
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ machine: hostname(), token: randomUUID() }), { flag: 'wx', mode: 0o600 });
  try { const v = JSON.parse(readFileSync(path, 'utf8')); return v.machine === hostname() && /^[a-f0-9-]{36}$/.test(v.token) ? v.token : null; } catch { return null; }
}
