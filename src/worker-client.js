import { setTimeout as delay } from 'node:timers/promises';
import { runClaude } from './claude-reply.js';
import { validateWorkerPayload } from './worker-broker.js';

export async function runWorkerOnce({ baseUrl, token, models, runner = runClaude }) {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) throw new Error('Workers require HTTPS, except loopback HTTP demos.');
  if (typeof token !== 'string' || !token || token.length > 200) throw new Error('Worker token required.');
  async function post(path, body = {}) {
    const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(error => {
      if (String(error.cause?.message).includes('redirect')) throw new Error('Worker server redirect refused.');
      throw error;
    });
    if (!response.ok) throw Object.assign(new Error(`Worker server rejected request (${response.status}).`), { status: response.status });
    return response.json();
  }
  await post('/worker/heartbeat');
  const claimResponse = await post('/worker/claim');
  const job = claimResponse?.job === undefined ? claimResponse : claimResponse.job;
  if (!job) return null;
  if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(job.id) || typeof job.leaseToken !== 'string') throw new Error('Invalid worker claim.');
  let timer, pendingHeartbeat = null, heartbeatError = null, accounting = { usage: null, costUsd: null }, result;
  try {
    if (job.type !== 'claude.text') throw new Error('Unsupported job type.');
    const payload = validateWorkerPayload(job.payload, models);
    const interval = Math.max(10, Math.min(10000, Number(job.heartbeatIntervalMs) || 5000));
    timer = setInterval(() => {
      if (pendingHeartbeat || heartbeatError) return;
      pendingHeartbeat = post('/worker/heartbeat', { jobId: job.id, leaseToken: job.leaseToken }).catch(error => { heartbeatError = error; }).finally(() => { pendingHeartbeat = null; });
    }, interval);
    const output = await runner({ model: payload.model, system: payload.system, prompt: payload.prompt, tools: [], timeoutMs: payload.timeoutMs, onEvent: event => {
      if (event?.type === 'result') accounting = { usage: event.usage ?? null, costUsd: event.total_cost_usd ?? null };
    } });
    result = { status: 'done', output, ...accounting };
  } catch (error) { result = { status: 'failed', error: String(error.message || error).slice(0, 2000), ...accounting }; }
  finally { clearInterval(timer); if (pendingHeartbeat) await pendingHeartbeat; }
  // Never run again when delivery or execution is uncertain. The server owns fencing.
  if (heartbeatError) throw heartbeatError;
  return post(`/worker/jobs/${encodeURIComponent(job.id)}/complete`, { leaseToken: job.leaseToken, result });
}

/** Explicit polling loop. It stops on a rejected identity; other failures wait longer and retry the poll, never a job. */
export async function runWorkerLoop({ idleMs = 5000, signal, log = () => {}, ...options }) {
  const pause = ms => delay(ms, undefined, { signal }).catch(() => {});
  while (!signal?.aborted) {
    try {
      const done = await runWorkerOnce(options);
      if (done) log(`Job ${done.id ?? ''} reported: ${done.status}.`);
      else await pause(idleMs);
    } catch (error) {
      if (error.status === 401) throw error;
      log(error.message);
      await pause(Math.min(idleMs * 4, 30000));
    }
  }
}
