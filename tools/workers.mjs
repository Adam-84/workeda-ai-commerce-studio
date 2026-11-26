import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createWorkerBroker } from '../src/worker-broker.js';

const usage = `Worker identities (operator-only; no AI invocation):
  node tools/workers.mjs status [--db /private/data/control.db]
  node tools/workers.mjs enroll --name laptop --models sonnet --token-file /private/worker-token [--db /private/data/control.db]
  node tools/workers.mjs enroll --name laptop --models sonnet --print-token [--db /private/data/control.db]
  node tools/workers.mjs revoke --id WORKER_ID [--db /private/data/control.db]
Configure the server allowlist through ARCHIPEL_WORKER_MODELS (comma separated).
Token files are created exclusively and never overwritten. Keep them outside source control.`;

let db;
try {
  const [command, ...args] = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--db', '--name', '--models', '--token-file', '--print-token', '--id'].includes(key) || options[key] !== undefined) throw new Error('Unknown or duplicated option.');
    if (key === '--print-token') options[key] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Value required for ${key}.`); options[key] = value; }
  }
  if (!['status', 'enroll', 'revoke'].includes(command)) throw new Error(usage);
  if (command === 'enroll' && Boolean(options['--token-file']) === Boolean(options['--print-token'])) throw new Error('Enrollment requires exactly one explicit token destination: --token-file or --print-token.');
  if (command === 'revoke' && !options['--id']) throw new Error('Worker id required.');
  const path = resolve(options['--db'] || process.env.ARCHIPEL_CONTROL_DB || 'data/control.db');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); db = new DatabaseSync(path);
  const models = (process.env.ARCHIPEL_WORKER_MODELS || '').split(',').map(v => v.trim()).filter(Boolean);
  const broker = createWorkerBroker(db, { models });
  if (command === 'status') process.stdout.write(`${JSON.stringify(broker.status(), null, 2)}\n`);
  if (command === 'revoke') process.stdout.write(`${JSON.stringify(broker.revoke(options['--id']), null, 2)}\n`);
  if (command === 'enroll') {
    const enrolled = broker.enroll({ name: options['--name'], models: (options['--models'] || '').split(',').map(v => v.trim()).filter(Boolean) });
    const { token, ...identity } = enrolled;
    try {
      if (options['--token-file']) {
        const tokenFile = resolve(options['--token-file']);
        writeFileSync(tokenFile, `${token}\n`, { flag: 'wx', mode: 0o600 });
        process.stdout.write(`${JSON.stringify({ ...identity, tokenFile }, null, 2)}\n`);
      } else process.stdout.write(`${JSON.stringify(enrolled, null, 2)}\n`);
    } catch (error) { broker.revoke(enrolled.id); throw error; }
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
finally { db?.close(); }
