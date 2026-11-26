// Starts one Claude worker, only when an operator runs this command. It uses this machine's own Claude login.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runWorkerLoop, runWorkerOnce } from '../src/worker-client.js';

const usage = `Archipel worker (sends real Claude requests on this machine's own subscription)
  node tools/worker.mjs --server https://archipel.example --token-file /private/worker-token --models sonnet,opus [--once]
Plain HTTP is accepted only for a loopback address (SSH tunnel or local rehearsal). Stop with Ctrl+C.`;

try {
  const { values } = parseArgs({ options: { server: { type: 'string' }, 'token-file': { type: 'string' }, models: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log(usage);
  else {
    if (!values.server || !values['token-file'] || !values.models) throw new Error(usage);
    const options = { baseUrl: values.server, token: readFileSync(values['token-file'], 'utf8').trim(), models: values.models.split(',').map(m => m.trim()).filter(Boolean) };
    if (values.once) {
      const job = await runWorkerOnce(options);
      console.log(JSON.stringify(job ? { id: job.id, status: job.status } : { job: null }));
    } else {
      const stop = new AbortController();
      // The current request finishes and reports before the loop exits.
      process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
      console.log('Worker started.');
      await runWorkerLoop({ ...options, signal: stop.signal, log: message => console.log(message) });
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
