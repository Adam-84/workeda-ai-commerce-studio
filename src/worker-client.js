import { setTimeout as delay } from 'node:timers/promises';
import { runClaude } from './claude-reply.js';
import { validateWorkerPayload } from './worker-broker.js';
import { mergeSignal, modelOfEvent, quotaOfEvent } from './engines.js';

const BLOCKED = 'Worker identity is blocked by an uncertain job. Check the earlier process has stopped, then run on the server: node tools/workers.mjs release --id WORKER_ID --process-stopped';
// A refusal is final; network failures, timeouts, 408, 429 and 5xx are worth another try.
const refused = error => Boolean(error.permanent) || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));

export async function runWorkerOnce({ baseUrl, token, models, runner = runClaude }) {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) throw new Error('Workers require HTTPS, except loopback HTTP demos.');
  if (typeof token !== 'string' || !token || token.length > 200) throw new Error('Worker token required.');
  async function post(path, body = {}) {
    const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(error => {
      if (String(error.cause?.message).includes('redirect')) throw Object.assign(new Error('Worker server redirect refused.'), { permanent: true });
      throw error;
    });
    if (!response.ok) throw Object.assign(new Error(`Worker server rejected request (${response.status}).`), { status: response.status });
    return response.json();
  }
  await post('/worker/heartbeat');
  const claimResponse = await post('/worker/claim');
  if (claimResponse?.blocked) throw Object.assign(new Error(BLOCKED), { code: 'WORKER_BLOCKED' });
  const job = claimResponse?.job === undefined ? claimResponse : claimResponse.job;
  if (!job) return null;
  if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(job.id) || typeof job.leaseToken !== 'string') throw new Error('Invalid worker claim.');
  const interval = Math.max(10, Math.min(10000, Number(job.heartbeatIntervalMs) || 5000));
  let timer, pendingHeartbeat = null, refusal = null, accounting = { usage: null, costUsd: null }, result, deliverUntil = Date.now() + 30000;
  const observed = new Set(), signals = new Map();
  const report = () => ({ ...accounting, ...(observed.size ? { models: [...observed] } : {}), ...(signals.size ? { quota: [...signals.values()].slice(0, 8) } : {}) });
  try {
    try {
      if (job.type !== 'claude.text') throw new Error('Unsupported job type.');
      const payload = validateWorkerPayload(job.payload, models);
      deliverUntil = Date.now() + payload.timeoutMs + 10000;
      // A lost heartbeat is retried at the next tick: only an explicit refusal ends the lease on this side.
      timer = setInterval(() => {
        if (pendingHeartbeat || refusal) return;
        pendingHeartbeat = post('/worker/heartbeat', { jobId: job.id, leaseToken: job.leaseToken }).catch(error => { if (refused(error)) refusal = error; }).finally(() => { pendingHeartbeat = null; });
      }, interval);
      const output = await runner({ model: payload.model, system: payload.system, prompt: payload.prompt, tools: [], timeoutMs: payload.timeoutMs, onEvent: event => {
        const model = modelOfEvent(event);
        if (model && observed.size < 8) observed.add(model);
        const quota = quotaOfEvent(event);
        if (quota) { const { source, ...signal } = quota; signals.set(signal.window, mergeSignal(signals.get(signal.window), signal)); }
        if (event?.type === 'result') accounting = { usage: event.usage ?? null, costUsd: event.total_cost_usd ?? null };
      } });
      result = { status: 'done', output, ...report() };
    } catch (error) { result = { status: 'failed', error: String(error.message || error).slice(0, 2000), ...report() }; }
    if (pendingHeartbeat) await pendingHeartbeat;
    // The job never runs twice; only the delivery of its report is retried. The server owns fencing.
    for (;;) {
      if (refusal) throw refusal;
      try { return await post(`/worker/jobs/${encodeURIComponent(job.id)}/complete`, { leaseToken: job.leaseToken, result }); }
      catch (error) { if (refused(error) || Date.now() >= deliverUntil) throw error; }
      await delay(interval);
    }
  } finally { clearInterval(timer); if (pendingHeartbeat) await pendingHeartbeat; }
}

/** Explicit polling loop. It stops on a rejected identity; other failures wait longer and retry the poll, never a job. */
export async function runWorkerLoop({ idleMs = 5000, signal, log = () => {}, ...options }) {
  const pause = ms => delay(ms, undefined, { signal }).catch(() => {});
  let announced = false;
  while (!signal?.aborted) {
    try {
      const done = await runWorkerOnce(options);
      announced = false;
      if (done) log(`Job ${done.id ?? ''} reported: ${done.status}.`);
      else await pause(idleMs);
    } catch (error) {
      if (error.status === 401) throw error;
      if (!(announced && error.code === 'WORKER_BLOCKED')) log(error.message);
      announced = error.code === 'WORKER_BLOCKED';
      await pause(Math.min(idleMs * 4, 30000));
    }
  }
}
