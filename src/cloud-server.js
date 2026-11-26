import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio } from './studio.js';
import { createApp } from './app.js';
import { loadAgentFiles } from './agent-files.js';
import { createSkillManager } from './skills-manager.js';
import { createCloudAuth } from './cloud-auth.js';
import { createWorkerBroker } from './worker-broker.js';
import { backupDatabase } from './database-transfer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const error = (message, status = 503) => Object.assign(new Error(message), { status });
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const readJson = async (req, limit = 300000) => {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw error('JSON requis.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw error('Requête trop volumineuse.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('JSON invalide.', 400); }
};

export async function createCloudRuntime({ dataDir, passwordHash, origin, port = 0, host = '127.0.0.1', env = {}, backupEveryMs = 86400000, maxJobMs = 300000 } = {}) {
  if (!dataDir) throw new Error('Répertoire persistant explicite requis.');
  // Validate credentials and remote origin before opening a database or socket.
  createCloudAuth({ passwordHash, origin: origin ?? 'http://127.0.0.1' });
  dataDir = resolve(dataDir); await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, 'workeda.db'), controlPath = join(dataDir, 'control.db');
  const loaded = loadAgentFiles(join(root, '.claude', 'agents'));
  const models = [...new Set(loaded.profiles.map(p => p.model))];
  const control = new DatabaseSync(controlPath); control.exec('PRAGMA busy_timeout=5000');
  const broker = createWorkerBroker(control, { models });
  broker.cancelQueued();
  control.exec('CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const readState = key => control.prepare('SELECT value FROM runtime_state WHERE key=?').get(key)?.value;
  const writeState = (key, value) => control.prepare('INSERT INTO runtime_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  const liveWorkers = model => broker.status().workers.filter(w => !w.revoked && !w.blocked && w.lastSeenAt && Date.now() - w.lastSeenAt < 60000 && (!model || w.models.includes(model)));
  let stopped = false, halted = readState('halted') === 'true', auth, app, backupBusy = false, lastBackup = null, backupError = false;
  const backupsDir = join(dataDir, 'backups');
  for (const name of (await readdir(backupsDir).catch(() => [])).sort().reverse()) {
    // Le dernier manifeste complet fait foi ; un dossier sans manifeste lisible est une sauvegarde interrompue.
    try { lastBackup = JSON.parse(await readFile(join(backupsDir, name, 'manifest.json'), 'utf8')); break; } catch { /* suivant */ }
  }
  const studio = createStudio(dbPath, { env, memoryJournalDir: join(dataDir, 'memory-journal'), commJournalDir: join(dataDir, 'comm-journal'),
    aiAvailable: slug => !halted && liveWorkers(loaded.profiles.find(p => p.slug === slug)?.model).length > 0 });
  studio.syncAgentFiles(loaded.profiles);
  // No import from Git or from another machine during central startup.
  const skills = createSkillManager({ root, studio, profiles: loaded.profiles }); skills.startup();
  // Interrompue par l'arrêt précédent : l'inférence a pu avoir lieu, aucune reprise automatique.
  const interrupted = 'Résultat incertain après redémarrage du serveur : vérifiez avant de relancer.';
  for (const run of studio.comm.activeRuns()) studio.comm.endRun(run.id, { state: 'error', error: interrupted });
  for (const task of studio.comm.listTasks({ state: 'running' })) studio.comm.setTaskState(task.id, 'blocked', interrupted);
  const pending = new Set();
  async function runRemote(options) {
    if (stopped || halted) throw error('Exécution suspendue.');
    if (options.tools?.length) throw error('Le worker distant autorise uniquement les réponses sans outils.');
    if (!liveWorkers(options.model).length) throw error('Aucun worker autorisé disponible pour ce modèle ; aucune bascule fournisseur.');
    const timeoutMs = Math.min(options.timeoutMs ?? 180000, maxJobMs, 300000);
    const job = broker.enqueue({ key: randomUUID(), payload: { provider: 'claude', model: options.model, system: options.system ?? '', prompt: options.prompt ?? '', tools: [], timeoutMs } });
    const work = (async () => {
      let deadline = Date.now() + timeoutMs; // attente en file ; une fois le travail pris, l'échéance du courtier prend le relais
      while (!stopped && !halted && !options.signal?.aborted) {
        const current = broker.job(job.id);
        if (current.status === 'running') deadline = current.deadlineAt + 1000;
        if (current.status === 'done') {
          const result = current.result;
          options.onEvent?.({ type: 'result', total_cost_usd: result.costUsd ?? undefined, usage: result.usage ?? undefined });
          options.onText?.(result.output); return result.output;
        }
        if (['failed', 'uncertain', 'cancelled'].includes(current.status)) throw error('Mission worker interrompue ; résultat à vérifier, sans relance automatique.');
        if (Date.now() >= deadline) break;
        await delay(100);
      }
      broker.cancel(job.id);
      throw error('Attente worker interrompue ; vérifiez le résultat avant toute reprise.');
    })();
    pending.add(work); try { return await work; } finally { pending.delete(work); }
  }
  async function snapshot() {
    if (backupBusy || stopped) return; backupBusy = true;
    try {
      const folder = join(backupsDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6));
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const db = await backupDatabase(dbPath, join(folder, 'workeda.db'));
      const workers = await backupDatabase(controlPath, join(folder, 'control.db'));
      const manifest = { at: new Date().toISOString(), database: db, control: workers };
      await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 }); lastBackup = manifest; backupError = false;
    } catch { backupError = true; } finally { backupBusy = false; }
  }
  const status = () => ({ mode: 'central', server: 'online', halted, database: 'sqlite-single-server',
    workers: broker.status().workers.map(({ id, name, models, lastSeenAt, revoked, blocked }) => ({ id, name, models, lastSeenAt, revoked, blocked, online: Boolean(!revoked && lastSeenAt && Date.now() - lastSeenAt < 60000) })),
    providers: { claude: { state: liveWorkers().length ? 'worker_connected' : 'waiting_worker', authentication: 'not_verified_by_server', quota: null }, codex: { state: 'disabled', reason: 'Isolation non démontrée ; autorisation requise.' }, gemini: { state: 'not_configured' } },
    agents: studio.listAgents().length, missions: studio.listMissions().filter(m => !['done','cancelled'].includes(m.state)).length,
    automations: studio.automation.list().filter(r => r.enabled).length,
    // Décisions attendues du propriétaire uniquement : délégations à valider, résultats à vérifier, souvenirs en attente.
    approvals: studio.comm.notifications().filter(n => ['approval', 'review'].includes(n.type)).length + studio.memory.list({ state: 'pending', limit: 500 }).length,
    integrations: studio.integrations.status().integrations,
    usage: studio.comm.usage(), backup: { lastSuccessfulAt: lastBackup?.at ?? null, error: backupError, scope: 'databases-only; secrets and mutable Skills require separate protected backup' },
    freshness: { measuredAt: new Date().toISOString(), catalog: studio.shop.latest?.()?.fetchedAt ?? null },
    notifications: studio.comm.notifications(), quotas: 'unknown' });
  // Seuls fichiers servis sans session : la page de connexion et ce qu'exige l'installation. Aucun ne contient de donnée.
  const types = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' };
  const publicFiles = new Set(['/login.html', '/login.css', '/login.js', '/pwa.js', '/sw.js', '/offline.html', '/manifest.webmanifest', ...(await readdir(join(root, 'public', 'icons'))).map(name => `/icons/${name}`)]);
  const server = createServer(async (req, res) => {
    if (!auth || !app || stopped) return json(res, 503, { error: 'Service indisponible.' });
    auth.headers(res);
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      if (path.startsWith('/worker/')) {
        if (req.method !== 'POST') throw error('Méthode refusée.', 405);
        const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
        const worker = token && broker.authenticate(token); if (!worker) throw error('Worker non autorisé.', 401);
        // Un rapport peut atteindre un million de caractères (borne du courtier), soit plusieurs octets chacun.
        const body = await readJson(req, path.endsWith('/complete') ? 6_000_000 : 300000);
        if (path === '/worker/heartbeat') return json(res, 200, broker.heartbeat(worker.id, body));
        if (path === '/worker/claim') return json(res, 200, { job: halted ? null : broker.claim(worker.id) });
        const match = path.match(/^\/worker\/jobs\/([a-f0-9-]+)\/complete$/);
        if (match) return json(res, 200, broker.complete(worker.id, match[1], body.leaseToken, body.result));
        throw error('Introuvable.', 404);
      }
      if (await auth.handle(req, res)) return;
      if (publicFiles.has(path) && req.method === 'GET') {
        // La page hors ligne porte son style en ligne et ne charge rien d'autre.
        const policy = path === '/offline.html' ? "default-src 'none'; style-src 'unsafe-inline'" : "default-src 'self'";
        res.writeHead(200, { 'content-type': types[extname(path)], 'content-security-policy': `${policy}; frame-ancestors 'none'; base-uri 'none'` });
        return res.end(await readFile(join(root, 'public', path.slice(1))));
      }
      try { auth.authorize(req); }
      catch (e) { if (e.status === 401 && path === '/') { res.writeHead(303, { location: '/login.html' }); return res.end(); } throw e; }
      if (path === '/api/operations' && req.method === 'GET') return json(res, 200, status());
      if (path === '/api/operations/stop' && req.method === 'POST') {
        const input = await readJson(req); if (typeof input.halted !== 'boolean') throw error('État requis.', 400);
        if (input.halted !== halted) {
          if (input.halted) { writeState('automationPaused', studio.automation.status().paused); studio.automation.pause(true); }
          // La reprise rend la suspension des calendriers telle que le propriétaire l'avait laissée.
          else studio.automation.pause(readState('automationPaused') === 'true');
          halted = input.halted; writeState('halted', halted);
        }
        if (halted) broker.cancelAll(); else app.orchestrator.pump();
        return json(res, 200, status());
      }
      if (path === '/api/operations/backup' && req.method === 'POST') { await readJson(req); await snapshot(); return json(res, backupError ? 503 : 200, status().backup); }
      app.emit('request', req, res);
    } catch (e) { req.resume(); json(res, e.status ?? e.statusCode ?? 500, { error: (e.status ?? e.statusCode) ? e.message : 'Opération indisponible.' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  auth = createCloudAuth({ passwordHash, origin: origin ?? `http://127.0.0.1:${server.address().port}` });
  app = createApp({ studio, skills, publicDir: join(root, 'public'), detect: () => false, agentFiles: loaded, runClaude: runRemote,
    authorizeRequest: auth.authorize, canRun: () => !halted, pumpEveryMs: 5000,
    agentReady: agentId => liveWorkers(loaded.profiles.find(p => p.slug === studio.comm.slugOf(agentId))?.model).length > 0 });
  app.orchestrator.start(); app.automationRunner.start();
  // Contrôle d'échéance plutôt qu'un délai depuis le démarrage : des redémarrages fréquents ne repoussent plus la sauvegarde.
  const overdue = () => !lastBackup || Date.now() - Date.parse(lastBackup.at) >= backupEveryMs;
  if (overdue()) await snapshot();
  const backupTimer = setInterval(() => { if (overdue()) snapshot(); }, Math.min(backupEveryMs, 3600000)); backupTimer.unref();
  const maintenance = setInterval(() => broker.expire(), 5000); maintenance.unref();
  return { server, app, studio, broker, origin: auth.origin, snapshot, status,
    async close() { stopped = true; clearInterval(backupTimer); clearInterval(maintenance); app.orchestrator.stop(); app.automationRunner.stop(); broker.cancelAll(); await Promise.allSettled([...pending]); await app.automationRunner.idle(); await app.orchestrator.idle(); await new Promise(r => server.close(r)); while (backupBusy) await delay(25); studio.close(); control.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.ARCHIPEL_ORIGIN || !process.env.ARCHIPEL_PASSWORD_HASH_FILE) throw new Error('ARCHIPEL_ORIGIN et ARCHIPEL_PASSWORD_HASH_FILE requis.');
    const passwordHash = (await readFile(process.env.ARCHIPEL_PASSWORD_HASH_FILE, 'utf8')).trim();
    const runtime = await createCloudRuntime({ dataDir: process.env.ARCHIPEL_DATA_DIR ?? 'data/cloud', passwordHash, origin: process.env.ARCHIPEL_ORIGIN, port: Number(process.env.PORT ?? 4319), host: process.env.ARCHIPEL_BIND ?? '127.0.0.1', env: process.env });
    console.log(`Archipel central prêt : ${runtime.origin}`);
    let closing = false; const close = async () => { if (closing) return; closing = true; await runtime.close(); process.exit(0); };
    process.on('SIGTERM', close); process.on('SIGINT', close);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
