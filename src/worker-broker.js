import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isModelId } from './engines.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, allowEmpty = false) => typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
function fault(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode, status: statusCode }); }
function modelList(models, code = 'INVALID_WORKER') {
  if (!Array.isArray(models) || models.length > 32 || models.some(m => !text(m, 100) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(m))) throw fault(code, 'Invalid model allowlist.');
  return [...new Set(models)];
}

// The worker applies this same contract against its own independently configured allowlist.
export function validateWorkerPayload(payload, models) {
  const fields = ['provider', 'model', 'system', 'prompt', 'tools', 'timeoutMs'];
  if (!plain(payload) || Object.keys(payload).some(k => !fields.includes(k)) || payload.provider !== 'claude' || !modelList(models, 'INVALID_JOB').includes(payload.model) ||
      !text(payload.system, 100000, true) || !text(payload.prompt, 200000) || !Array.isArray(payload.tools) || payload.tools.length !== 0 ||
      !Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 1 || payload.timeoutMs > 300000) {
    throw fault('INVALID_JOB', 'Only bounded claude.text jobs with an allowlisted model and no tools are accepted.');
  }
  return { provider: 'claude', model: payload.model, system: payload.system, prompt: payload.prompt, tools: [], timeoutMs: payload.timeoutMs };
}

function resultValue(result) {
  if (!plain(result) || !['done', 'failed'].includes(result.status) || (result.status === 'done' && !text(result.output, 1000000, true)) ||
      (result.error !== undefined && !text(result.error, 2000, true))) throw fault('INVALID_RESULT', 'Invalid bounded job result.');
  let usage = null;
  if (result.usage != null) {
    if (!plain(result.usage)) throw fault('INVALID_RESULT', 'Invalid usage.');
    usage = {};
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      if (result.usage[key] === undefined) continue;
      if (!Number.isSafeInteger(result.usage[key]) || result.usage[key] < 0) throw fault('INVALID_RESULT', 'Invalid token count.');
      usage[key] = result.usage[key];
    }
  }
  const costUsd = result.costUsd ?? null;
  if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) throw fault('INVALID_RESULT', 'Invalid cost.');
  const models = result.models ?? null;
  if (models !== null && (!Array.isArray(models) || models.length > 8 || !models.every((m) => isModelId(m)))) throw fault('INVALID_RESULT', 'Invalid observed models.');
  return { status: result.status, output: result.status === 'done' ? result.output : null, error: result.status === 'failed' ? (result.error || 'Worker execution failed.') : null, usage, costUsd, ...(models?.length ? { models: [...new Set(models)] } : {}) };
}

export function createWorkerBroker(db, { now = Date.now, models = [], leaseMs = 30000 } = {}) {
  models = modelList(models);
  if (!Number.isInteger(leaseMs) || leaseMs < 30 || leaseMs > 60000) throw new Error('leaseMs must be between 30 and 60000.');
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, models TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS worker_jobs (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL CHECK(type='claude.text'), payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','uncertain','cancelled')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, worker_id TEXT REFERENCES workers(id),
      lease_hash TEXT, lease_expires_at INTEGER, deadline_at INTEGER, result TEXT);
    CREATE INDEX IF NOT EXISTS worker_jobs_queue ON worker_jobs(status,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS worker_one_running ON worker_jobs(worker_id) WHERE status='running';`);
  if (!db.prepare('PRAGMA table_info(worker_jobs)').all().some(c => c.name === 'released_at')) db.exec('ALTER TABLE worker_jobs ADD COLUMN released_at INTEGER');
  const tx = (fn) => {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const workerValue = r => r && ({ id: r.id, name: r.name, models: JSON.parse(r.models), createdAt: r.created_at, lastSeenAt: r.last_seen_at, revoked: r.revoked_at !== null, revokedAt: r.revoked_at });
  const jobValue = r => r && ({ id: r.id, key: r.idempotency_key, type: r.type, payload: JSON.parse(r.payload), status: r.status, workerId: r.worker_id, createdAt: r.created_at, updatedAt: r.updated_at, leaseExpiresAt: r.lease_expires_at, deadlineAt: r.deadline_at, result: r.result ? JSON.parse(r.result) : null });
  const readWorker = id => db.prepare('SELECT * FROM workers WHERE id=?').get(id);
  const readJob = id => db.prepare('SELECT * FROM worker_jobs WHERE id=?').get(id);
  function requireWorker(id) {
    const w = typeof id === 'string' && readWorker(id);
    if (!w || w.revoked_at !== null) throw fault('WORKER_REVOKED', 'Worker identity is missing or revoked.', 401);
    return w;
  }
  function expire() {
    return Number(db.prepare("UPDATE worker_jobs SET status='uncertain', updated_at=?, lease_hash=NULL WHERE status='running' AND (lease_expires_at<=? OR deadline_at<=?)").run(now(), now(), now()).changes);
  }
  function requireLease(workerId, jobId, leaseToken) {
    const j = typeof jobId === 'string' && readJob(jobId);
    if (!j || j.status !== 'running' || j.lease_expires_at <= now() || j.deadline_at <= now() || j.worker_id !== workerId || typeof leaseToken !== 'string' || leaseToken.length > 200 || j.lease_hash !== hash(leaseToken)) throw fault('STALE_LEASE', 'Lease is expired, revoked or does not belong to this worker.', 409);
    return j;
  }
  // Une identité tenue par un résultat incertain ne reçoit plus rien : la dire disponible bloquerait les missions.
  const held = () => new Set(db.prepare("SELECT DISTINCT worker_id AS id FROM worker_jobs WHERE status='uncertain' AND released_at IS NULL AND worker_id IS NOT NULL").all().map(r => r.id));
  return {
    enroll({ name, models: requested } = {}) {
      const chosen = modelList(requested);
      if (!text(name, 100) || chosen.length === 0 || chosen.some(m => !models.includes(m))) throw fault('INVALID_WORKER', 'A name and configured model allowlist are required.');
      const id = randomUUID(), token = secret();
      db.prepare('INSERT INTO workers(id,name,models,token_hash,created_at) VALUES(?,?,?,?,?)').run(id, name.trim(), JSON.stringify(chosen), hash(token), now());
      return { ...workerValue(readWorker(id)), token };
    },
    revoke(id) {
      return tx(() => {
        const w = readWorker(id); if (!w) throw fault('WORKER_NOT_FOUND', 'Worker not found.', 404);
        db.prepare('UPDATE workers SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now(), id);
        db.prepare("UPDATE worker_jobs SET status='uncertain',updated_at=?,lease_hash=NULL WHERE worker_id=? AND status='running'").run(now(), id);
        return workerValue(readWorker(id));
      });
    },
    isBlocked(id) { expire(); return held().has(id); },
    // Décision de l'opérateur, une fois l'ancien processus arrêté : le travail reste « incertain », seule l'identité est libérée.
    release(id) {
      expire();
      return tx(() => {
        if (!readWorker(id)) throw fault('WORKER_NOT_FOUND', 'Worker not found.', 404);
        const released = Number(db.prepare("UPDATE worker_jobs SET released_at=? WHERE worker_id=? AND status='uncertain' AND released_at IS NULL").run(now(), id).changes);
        return { ...workerValue(readWorker(id)), blocked: false, released };
      });
    },
    authenticate(token) {
      if (!text(token, 200)) return null;
      return workerValue(db.prepare('SELECT * FROM workers WHERE token_hash=? AND revoked_at IS NULL').get(hash(token))) || null;
    },
    heartbeat(id, { jobId, leaseToken } = {}) {
      expire();
      return tx(() => {
        requireWorker(id);
        if (jobId !== undefined || leaseToken !== undefined) {
          const j = requireLease(id, jobId, leaseToken);
          db.prepare('UPDATE worker_jobs SET lease_expires_at=?,updated_at=? WHERE id=?').run(Math.min(now() + leaseMs, j.deadline_at), now(), jobId);
        }
        db.prepare('UPDATE workers SET last_seen_at=? WHERE id=?').run(now(), id);
        return workerValue(readWorker(id));
      });
    },
    claim(id) {
      expire();
      return tx(() => {
        const w = requireWorker(id);
        // An uncertain run may still be executing: this identity cannot start more work.
        if (db.prepare("SELECT id FROM worker_jobs WHERE worker_id=? AND (status='running' OR (status='uncertain' AND released_at IS NULL)) LIMIT 1").get(id)) return null;
        const allowed = JSON.parse(w.models).filter(m => models.includes(m));
        const j = db.prepare("SELECT * FROM worker_jobs WHERE status='queued' ORDER BY created_at,id").all().find(r => allowed.includes(JSON.parse(r.payload).model));
        if (!j) return null;
        validateWorkerPayload(JSON.parse(j.payload), allowed);
        const token = secret(), deadline = now() + JSON.parse(j.payload).timeoutMs;
        db.prepare("UPDATE worker_jobs SET status='running',worker_id=?,lease_hash=?,lease_expires_at=?,deadline_at=?,updated_at=? WHERE id=? AND status='queued'")
          .run(id, hash(token), Math.min(now() + leaseMs, deadline), deadline, now(), j.id);
        db.prepare('UPDATE workers SET last_seen_at=? WHERE id=?').run(now(), id);
        return { ...jobValue(readJob(j.id)), leaseToken: token, heartbeatIntervalMs: Math.max(10, Math.floor(leaseMs / 3)) };
      });
    },
    complete(workerId, jobId, leaseToken, result) {
      expire();
      return tx(() => {
        requireWorker(workerId); requireLease(workerId, jobId, leaseToken); const value = resultValue(result);
        db.prepare('UPDATE worker_jobs SET status=?,result=?,lease_hash=NULL,updated_at=? WHERE id=?').run(value.status, JSON.stringify(value), now(), jobId);
        return jobValue(readJob(jobId));
      });
    },
    enqueue({ key, payload } = {}) {
      if (!text(key, 200)) throw fault('INVALID_JOB', 'A bounded idempotency key is required.');
      const validated = validateWorkerPayload(payload, models);
      return tx(() => {
        const existing = db.prepare('SELECT * FROM worker_jobs WHERE idempotency_key=?').get(key);
        if (existing) return jobValue(existing);
        const id = randomUUID();
        db.prepare("INSERT INTO worker_jobs(id,idempotency_key,type,payload,status,created_at,updated_at) VALUES(?,?,'claude.text',?,'queued',?,?)").run(id, key, JSON.stringify(validated), now(), now());
        return jobValue(readJob(id));
      });
    },
    cancel(id) {
      return tx(() => {
        if (!readJob(id)) throw fault('JOB_NOT_FOUND', 'Job not found.', 404);
        db.prepare("UPDATE worker_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'uncertain' END,lease_hash=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')").run(now(), id);
        return jobValue(readJob(id));
      });
    },
    // Au démarrage du serveur : plus personne n'attend ces travaux, les exécuter produirait une inférence fantôme.
    cancelQueued() {
      return Number(db.prepare("UPDATE worker_jobs SET status='cancelled',updated_at=? WHERE status='queued'").run(now()).changes);
    },
    cancelAll() {
      return Number(db.prepare("UPDATE worker_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'uncertain' END,lease_hash=NULL,updated_at=? WHERE status IN ('queued','running')").run(now()).changes);
    },
    job(id) { expire(); return jobValue(readJob(id)) || null; },
    status() {
      expire(); const jobs = Object.fromEntries(['queued', 'running', 'done', 'failed', 'uncertain', 'cancelled'].map(k => [k, 0]));
      for (const r of db.prepare('SELECT status,COUNT(*) AS count FROM worker_jobs GROUP BY status').all()) jobs[r.status] = r.count;
      const blocked = held();
      const workers = db.prepare('SELECT * FROM workers ORDER BY created_at,id').all().map(r => ({ ...workerValue(r), blocked: blocked.has(r.id) }));
      return { workers, jobs, quotas: 'unknown', models: [...models] };
    },
    expire,
  };
}
