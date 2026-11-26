# Moteur IA, lot 3 : quota observé — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lire le quota que Claude Code transmet, faire attendre un moteur refusé jusqu'à sa remise à zéro, et ne rien lancer de plus après une dépense supplémentaire sans confirmation.

**Architecture:** `rate_limit_event` est lu par des fonctions pures de `src/engines.js`, enregistré par source (cet ordinateur ou un worker) dans `provider_signals`, puis ajouté au motif d'indisponibilité du lot 2. Les workers renvoient le signal ; le courtier ne leur donne plus un modèle refusé.

**Tech Stack:** Node 24, `node:sqlite`, `node:test`, aucune dépendance, aucune étape de build.

**Conception :** `docs/superpowers/specs/2026-11-26-choix-moteur-ia-design.md`. **Prérequis :** lots 1 et 2 terminés et commités.

## Global Constraints

- Aucune IA réelle appelée : événements simulés uniquement. Aucune API payante, aucun compte.
- Tests sur `:memory:` ou dossier temporaire. Ne jamais ouvrir `data/workeda.db`.
- Un quota absent ou périmé s'affiche « Inconnu », jamais 0 ; sans signal, rien n'est bloqué.
- Jamais de repli vers un autre fournisseur ou modèle.
- Aucune écriture Shopify, aucun secret dans Git, les 11 fiches inchangées.
- Aucune fusion dans `main`, aucun push sans demande du propriétaire.
- Textes visibles en français, style du code existant.
- Les blocs « remplacer » citent le code après le lot 2. Les lire dans le fichier avant d'éditer.

## Hypothèse à vérifier

La forme de l'événement a été lue dans Claude Code 2.1.101 (`status`, `resetsAt` en secondes, `rateLimitType`, `utilization`, `isUsingOverage`), jamais observée sur une exécution réelle. `utilization` est traité comme une fraction (le code compare à des seuils comme 0,9). À confirmer sur le premier événement réel autorisé ; un écart ne doit produire que « Inconnu ».

## Fichiers

| Fichier | Rôle dans ce lot |
| --- | --- |
| `src/engines.js` | Lecture et jugement d'un signal |
| `src/comm-core.js` | Signaux observés |
| `src/studio-comm.js` | Migration 7, enregistrement à la fin d'une exécution |
| `src/studio-engines.js` | Stockage, motif d'attente, reprise confirmée |
| `src/comm-run.js`, `src/app.js` | Tâche remise en file, route de reprise |
| `src/worker-broker.js`, `src/worker-client.js`, `src/cloud-server.js` | Signal des workers |
| `public/engine-view.js`, `dashboard-view.js`, `hq-ui.js`, `comm-ui.js` | Affichage |
| `test/engine-quota.test.js` (créé) | Tests du lot |

---

### Task 1: Lire et juger un signal

**Files:**
- Modify: `src/engines.js`, `src/comm-core.js`
- Create: `test/engine-quota.test.js`

**Interfaces:**
- Produces: `QUOTA_WINDOWS`, `cleanSignal(raw) → {status, window, utilization, resetsAt, overage}|null`, `quotaOfEvent(event) → signal avec source|null`, `signalStale(s, now)`, `signalReason(s, engine, now) → string` ; `observeTools().state.quota: signal[]`.

- [ ] **Step 1: Créer la branche** — `git switch -c feat/engine-quota` (depuis la branche du lot 2).

- [ ] **Step 2: Écrire les tests** — `test/engine-quota.test.js` :

```js
// Lot 3 : quota observé. Événements simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaOfEvent, signalReason } from '../src/engines.js';
import { observeTools } from '../src/comm-core.js';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const later = '2026-11-27T14:00:00.000Z', past = '2026-11-27T08:00:00.000Z';
const event = (info, extra = {}) => ({ type: 'rate_limit_event', rate_limit_info: info, ...extra });
const opus = { provider: 'claude', model: 'opus' }, sonnet = { provider: 'claude', model: 'sonnet' };
const signal = (extra = {}) => ({ status: 'allowed', window: 'five_hour', utilization: null, resetsAt: later, overage: false, ...extra });

test('événement : champs bornés, absents laissés inconnus, inconnu ignoré', () => {
  assert.deepEqual(quotaOfEvent(event({ status: 'rejected', resetsAt: Date.parse(later) / 1000, rateLimitType: 'seven_day_opus' })), { status: 'rejected', window: 'seven_day_opus', utilization: null, resetsAt: later, overage: false, source: 'local' });
  assert.equal(quotaOfEvent(event({ status: 'allowed' })).resetsAt, null);
  assert.equal(quotaOfEvent(event({ status: 'allowed', rateLimitType: 'nouvelle' })).window, 'unknown');
  assert.equal(quotaOfEvent(event({ status: 'autre' })), null);
  assert.equal(quotaOfEvent({ type: 'result' }), null);
  assert.equal(quotaOfEvent(event({ status: 'allowed' }, { archipel_source: 'worker-1' })).source, 'worker-1');
  const seen = observeTools();
  seen.feed(event({ status: 'allowed', rateLimitType: 'five_hour' })); seen.feed(event({ status: 'rejected', rateLimitType: 'five_hour' }));
  assert.deepEqual(seen.state.quota.map((q) => q.status), ['rejected']);
});

test('jugement : refus daté, fenêtre par modèle, relevé périmé, confirmations', () => {
  assert.match(signalReason(signal({ status: 'rejected' }), sonnet, NOW), /reprise après/);
  assert.equal(signalReason(signal({ status: 'rejected', window: 'seven_day_opus' }), sonnet, NOW), '');
  assert.match(signalReason(signal({ status: 'rejected', window: 'seven_day_opus' }), opus, NOW), /Limite/);
  assert.equal(signalReason(signal({ status: 'rejected', resetsAt: past }), sonnet, NOW), '');
  const open = signal({ status: 'rejected', resetsAt: null });
  assert.match(signalReason(open, sonnet, NOW), /confirmez/);
  assert.equal(signalReason({ ...open, confirmedUntil: later }, sonnet, NOW), '');
  assert.match(signalReason({ ...signal({ status: 'rejected' }), confirmedUntil: later }, sonnet, NOW), /reprise après/);
  assert.match(signalReason(signal({ overage: true }), sonnet, NOW), /Dépense supplémentaire/);
  assert.equal(signalReason({ ...signal({ overage: true }), confirmedUntil: later }, sonnet, NOW), '');
  assert.equal(signalReason(signal(), sonnet, NOW), '');
});
```

- [ ] **Step 3: Vérifier l'échec**.

- [ ] **Step 4: Ajouter à `src/engines.js`**

```js
export const QUOTA_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'];
const QUOTA_STATES = ['allowed', 'allowed_warning', 'rejected'];
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
// Signal de quota borné : tout champ absent ou illisible reste inconnu (null).
export function cleanSignal(raw) {
  if (!raw || !QUOTA_STATES.includes(raw.status)) return null;
  const at = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : NaN;
  return {
    status: raw.status, window: QUOTA_WINDOWS.includes(raw.window) ? raw.window : 'unknown',
    utilization: Number.isFinite(raw.utilization) && raw.utilization >= 0 && raw.utilization <= 100 ? raw.utilization : null,
    resetsAt: Number.isFinite(at) ? new Date(at).toISOString() : null, overage: raw.overage === true
  };
}
// Événement « rate_limit_event » de Claude Code. « archipel_source » n'est posé que par le serveur central.
export function quotaOfEvent(event) {
  const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (!info) return null;
  const seconds = info.resetsAt;
  const signal = cleanSignal({ status: info.status, window: info.rateLimitType, utilization: info.utilization, resetsAt: Number.isFinite(seconds) && seconds > 0 && seconds < 1e11 ? new Date(seconds * 1000).toISOString() : null, overage: info.isUsingOverage === true });
  return signal && { ...signal, source: SOURCE_ID.test(event.archipel_source ?? '') ? event.archipel_source : 'local' };
}
export const signalStale = (s, now = Date.now()) => Boolean(s.resetsAt && Date.parse(s.resetsAt) <= now);
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
// Pourquoi ce signal fait attendre ce moteur ; chaîne vide s'il ne bloque pas.
export function signalReason(s, engine, now = Date.now()) {
  if (s.window === 'seven_day_opus' && engine?.model !== 'opus') return '';
  if (s.window === 'seven_day_sonnet' && engine?.model !== 'sonnet') return '';
  if (signalStale(s, now)) return '';
  const confirmed = Boolean(s.confirmedUntil && Date.parse(s.confirmedUntil) > now);
  if (s.status === 'rejected') {
    if (s.resetsAt) return `Limite Claude atteinte : reprise après le ${when(s.resetsAt)}.`;
    return confirmed ? '' : 'Limite Claude atteinte sans date de remise à zéro : confirmez la reprise.';
  }
  return s.overage && !confirmed ? 'Dépense supplémentaire signalée par Claude : confirmez avant de relancer.' : '';
}
```

- [ ] **Step 5: `src/comm-core.js`** — import `import { modelOfEvent, quotaOfEvent } from './engines.js';` (remplace l'import du lot 1). Ajouter `quota: [], ` à `state` dans `observeTools`, et au début de `feed` :

```js
      const signal = quotaOfEvent(event); // dernier signal par fenêtre et par source
      if (signal) state.quota = [...state.quota.filter((q) => q.window !== signal.window || q.source !== signal.source), signal].slice(-8);
```

- [ ] **Step 6: Vérifier le succès**, puis commit :

```bash
git add src/engines.js src/comm-core.js test/engine-quota.test.js
git commit -m "feat: read the quota signal sent by Claude Code"
```

---

### Task 2: Stocker, bloquer, confirmer

**Files:**
- Modify: `src/studio-comm.js`, `src/studio-engines.js`, `test/engine-quota.test.js`

**Interfaces:**
- Produces: `endRun(id, {…, quota})` ; `engines.recordSignals(provider, signals)`, `engines.signals()`, `engines.quotaReason(engine, source = 'local')`, `engines.reason(engine, source = 'local')`, `engines.resume(provider, source)`.

- [ ] **Step 1: Ajouter les tests** :

```js
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}) {
  const studio = createStudio(':memory:', options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, engines: studio.engines, ids };
}

test('stockage : aucun signal ne bloque rien ; refus enregistré à la fin d’une exécution', () => {
  const { comm, engines, ids } = setup({ clock: () => new Date(NOW).toISOString() });
  assert.deepEqual(engines.signals(), []); assert.equal(engines.reason(sonnet), '');
  const r = comm.startRun({ agentId: ids.lucas, kind: 'task', model: 'sonnet' });
  comm.endRun(r.id, { state: 'error', error: 'limite', quota: [{ ...signal({ status: 'rejected' }), source: 'local' }] });
  assert.match(engines.reason(sonnet), /reprise après/);
  assert.equal(engines.reason(sonnet, 'autre-source'), '');
  assert.equal(engines.signals()[0].resumable, false);
  assert.throws(() => engines.resume('claude', 'local'), { status: 409 });
});

test('dépassement : confirmation conservée jusqu’à la remise à zéro ; un nouveau refus rebloque', () => {
  const { engines } = setup({ clock: () => new Date(NOW).toISOString() });
  const over = [{ ...signal({ overage: true }), source: 'local' }];
  engines.recordSignals('claude', over);
  assert.match(engines.reason(opus), /Dépense/);
  engines.resume('claude', 'local');
  engines.recordSignals('claude', over);
  assert.equal(engines.reason(opus), '');
  assert.equal(engines.signals()[0].confirmedUntil, later);
  const open = [{ ...signal({ status: 'rejected', window: 'seven_day', resetsAt: null }), source: 'local' }];
  engines.recordSignals('claude', open); engines.resume('claude', 'local');
  assert.equal(engines.reason(opus), '');
  engines.recordSignals('claude', open);
  assert.match(engines.reason(opus), /confirmez/);
  engines.recordSignals('claude', [{ ...signal({ window: 'seven_day', resetsAt: null }), source: 'local' }]);
  assert.equal(engines.reason(opus), '');
});
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: `src/studio-comm.js`** — migration après la version 6 :

```js
, {
  version: 7,
  name: 'quota observé chez le fournisseur',
  up: `CREATE TABLE IF NOT EXISTS provider_signals (provider TEXT NOT NULL, source TEXT NOT NULL, rate_window TEXT NOT NULL, status TEXT NOT NULL, utilization REAL, resets_at TEXT, overage INTEGER NOT NULL DEFAULT 0, observed_at TEXT NOT NULL, confirmed_until TEXT, PRIMARY KEY (provider, source, rate_window));`,
  down: `DROP TABLE IF EXISTS provider_signals;`
}
```

Dans `endRun`, ajouter `quota = []` aux paramètres et, après `journal('run', id);` :

```js
    if (quota?.length) { try { engines?.recordSignals(r.provider ?? DEFAULT_PROVIDER, quota); } catch { /* relevé perdu : le quota reste inconnu */ } }
```

- [ ] **Step 4: `src/studio-engines.js`** — compléter l'import avec `cleanSignal, signalReason, signalStale`. Remplacer `const reason = (engine) => catalogReason(engine);` par :

```js
  const mapSignal = (r) => ({ provider: r.provider, source: r.source, window: r.rate_window, status: r.status, utilization: r.utilization, resetsAt: r.resets_at, overage: Boolean(r.overage), observedAt: r.observed_at, confirmedUntil: r.confirmed_until });
  const recordSignals = (provider, list = []) => {
    for (const raw of list) {
      const s = cleanSignal(raw); if (!s) continue;
      const source = raw.source ?? 'local';
      run(`INSERT INTO provider_signals (provider, source, rate_window, status, utilization, resets_at, overage, observed_at, confirmed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(provider, source, rate_window) DO UPDATE SET status = excluded.status, utilization = excluded.utilization, resets_at = excluded.resets_at, overage = excluded.overage, observed_at = excluded.observed_at,
        confirmed_until = CASE WHEN excluded.status = 'rejected' OR provider_signals.resets_at IS NOT excluded.resets_at THEN NULL ELSE provider_signals.confirmed_until END`,
      provider, source, s.window, s.status, s.utilization, s.resetsAt, Number(s.overage), clock());
      // Plus de dépense supplémentaire en cours : les anciens relevés de dépassement de cette source ne valent plus.
      if (!s.overage) run('UPDATE provider_signals SET overage = 0 WHERE provider = ? AND source = ?', provider, source);
    }
  };
  const quotaReason = (engine, source = 'local') => {
    if (!engine) return '';
    const now = Date.parse(clock());
    for (const r of all('SELECT * FROM provider_signals WHERE provider = ? AND source = ? ORDER BY rate_window', engine.provider, source)) { const why = signalReason(mapSignal(r), engine, now); if (why) return why; }
    return '';
  };
  const signals = () => {
    const now = Date.parse(clock());
    return all('SELECT * FROM provider_signals ORDER BY provider, source, rate_window').map((r) => {
      const s = mapSignal(r), blocking = signalReason(s, { provider: s.provider, model: s.window === 'seven_day_sonnet' ? 'sonnet' : 'opus' }, now);
      // Un refus daté se lève seul à sa remise à zéro : il n'y a rien à confirmer.
      return { ...s, stale: signalStale(s, now), blocking, resumable: Boolean(blocking) && (s.status !== 'rejected' || !s.resetsAt) };
    });
  };
  const resume = (provider, source) => {
    const endOfDay = `${clock().slice(0, 10)}T23:59:59.999Z`;
    const targets = signals().filter((s) => s.provider === provider && s.source === source && s.resumable);
    if (!targets.length) throw refuse('Rien à confirmer : une limite datée se lève seule à sa remise à zéro.', 409);
    for (const s of targets) run('UPDATE provider_signals SET confirmed_until = ? WHERE provider = ? AND source = ? AND rate_window = ?', s.status === 'rejected' ? endOfDay : s.resetsAt ?? endOfDay, provider, source, s.window);
    emit(null, 'engine.resume.confirmed', `Reprise confirmée par le propriétaire (${provider}, ${source}).`, 'manual', true);
    return signals();
  };
  const reason = (engine, source = 'local') => catalogReason(engine) || quotaReason(engine, source);
```

Dans `catalog`, remplacer le défaut `reasonOf = reason` par `reasonOf = (e) => reason(e)`. Ajouter `recordSignals, signals, quotaReason, resume, ` à l'objet rendu.

- [ ] **Step 5: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-quota.test.js test/engine-choice.test.js test/engine-accounting.test.js test/comm-store.test.js` ; Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/studio-comm.js src/studio-engines.js test/engine-quota.test.js
git commit -m "feat: store quota signals and hold a refused engine"
```

---

### Task 3: Lanceur, appels immédiats, reprise

**Files:**
- Modify: `src/comm-run.js`, `src/app.js`, `test/engine-quota.test.js`

**Interfaces:**
- Produces: route `POST /api/engines/claude/resume` `{source, confirm: true}` ; `GET /api/engines` ajoute `signals`.

- [ ] **Step 1: Ajouter les tests** :

```js
import { createOrchestrator } from '../src/comm-run.js';
import { createApp } from '../src/app.js';

// Les tests du lanceur utilisent l'horloge réelle : la remise à zéro est dans une heure.
const soon = () => Math.floor(Date.now() / 1000) + 3600;

test('refus : la tâche retourne en file, essai rendu, et rien ne repart avant la remise à zéro', async () => {
  const { studio, comm, ids } = setup(); let calls = 0;
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: async (o) => { calls += 1; o.onEvent(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() })); throw new Error('Limite d’utilisation de Claude atteinte. Réessayez plus tard.'); } });
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  orch.pump(); await orch.idle(); orch.pump(); await orch.idle();
  const after = comm.task(t.id);
  assert.deepEqual([after.state, after.attempts, calls], ['queued', 0, 1]);
  assert.match(after.stateNote, /Limite Claude/);
});

test('dépassement : la tâche en cours se termine, la suivante attend la confirmation', async () => {
  const { studio, comm, engines, ids } = setup(); let calls = 0;
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: async (o) => { calls += 1; o.onEvent(event({ status: 'allowed', rateLimitType: 'overage', resetsAt: soon(), isUsingOverage: true })); return JSON.stringify({ report: 'ok' }); } });
  const a = comm.createTask({ assigneeId: ids.lucas, instruction: 'Un' }).task;
  orch.pump(); await orch.idle();
  const b = comm.createTask({ assigneeId: ids.noah, instruction: 'Deux' }).task;
  orch.pump(); await orch.idle();
  assert.deepEqual([comm.task(a.id).state, comm.task(b.id).state, calls], ['done', 'queued', 1]);
  engines.resume('claude', 'local'); orch.pump(); await orch.idle();
  assert.equal(comm.task(b.id).state, 'done');
});

test('API : discussion refusée pendant le blocage, reprise seulement confirmée', async () => {
  const { studio, ids } = setup();
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async () => 'ok', agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, data) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: r.status, body: JSON.parse((await r.text()).trim().split('\n').at(-1)) }; };
  try {
    studio.engines.recordSignals('claude', [{ status: 'rejected', window: 'five_hour', resetsAt: null, overage: false, source: 'local' }]);
    await call('POST', `/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
    assert.equal((await call('POST', `/api/agents/${ids.lucas}/reply`, {})).status, 409);
    assert.equal((await call('GET', '/api/engines')).body.signals[0].resumable, true);
    assert.equal((await call('POST', '/api/engines/claude/resume', { source: 'local' })).status, 400);
    assert.equal((await call('POST', '/api/engines/claude/resume', { source: 'local', confirm: true })).status, 200);
    assert.equal((await call('POST', `/api/agents/${ids.lucas}/reply`, {})).body.type, 'done');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); studio.close(); }
});
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: `src/comm-run.js`** — compléter l'import avec `signalReason`. Ajouter `quota: seen.state.quota` aux appels `comm.endRun` de `execute` et de `replyInThread` (succès et erreur) ; dans `fail`, ajouter `quota: observed?.quota ?? []` à `comm.endRun`.

Dans `fail`, après la ligne `if (task.automationKey) { studio.automation.pauseAi(true); … }` :

```js
    // Refus du fournisseur : la tâche n'a pas échoué, elle attend la remise à zéro ; l'essai est rendu, rien ne bascule.
    const refusal = (observed?.quota ?? []).filter((s) => s.status === 'rejected').map((s) => signalReason(s, taskEngine(task))).find(Boolean);
    if (refusal && !task.automationKey) {
      comm.setTaskState(task.id, 'queued', refusal, { extra: { attempts: task.attempts - 1 } });
      try { comm.postMessage(task.threadId, { kind: 'system', body: `${comm.nameOf(task.assigneeId)} attend : ${refusal}`, taskId: task.id }, { type: 'system' }); } catch { /* fil clos */ }
      setActivity(task.assigneeId, 'waiting', short(refusal, 120));
      return;
    }
```

- [ ] **Step 4: `src/app.js`** — dans `closeRun`, ajouter `quota: seen.quota` à `comm.endRun`. Dans `describe`, ajouter `signals: engines.signals(),`. Ajouter à `paramRoutes.push(…)` du bloc moteur :

```js
      ['POST', /^\/api\/engines\/(claude)\/resume$/, (m, d) => { if (d?.confirm !== true) fail(400, 'Confirmation explicite requise.'); engines.resume(m[1], String(d.source ?? 'local')); orch?.pump(); return describe(); }]
```

- [ ] **Step 5: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-quota.test.js test/engine-choice.test.js test/comm-run.test.js test/automation-recovery.test.js` ; Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/comm-run.js src/app.js test/engine-quota.test.js
git commit -m "feat: requeue a refused task and require confirmation to resume"
```

---

### Task 4: Workers

**Files:**
- Modify: `src/worker-broker.js`, `src/worker-client.js`, `src/cloud-server.js`, `test/engine-quota.test.js`

**Interfaces:**
- Produces: champ facultatif `quota: signal[]` (8 au plus) dans le rapport ; `broker.claim(workerId, {allow(model)})`.

- [ ] **Step 1: Ajouter les tests** :

```js
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerBroker } from '../src/worker-broker.js';
import { runWorkerOnce } from '../src/worker-client.js';
import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';

test('courtier : signal borné ; un modèle refusé n’est plus attribué à ce worker', () => {
  const db = new DatabaseSync(':memory:'), broker = createWorkerBroker(db, { models: ['sonnet'] });
  const w = broker.enroll({ name: 'w', models: ['sonnet'] });
  const add = (key) => broker.enqueue({ key, payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'q', tools: [], timeoutMs: 5000 } });
  add('a');
  assert.equal(broker.claim(w.id, { allow: () => false }), null);
  const job = broker.claim(w.id);
  assert.throws(() => broker.complete(w.id, job.id, job.leaseToken, { status: 'done', output: 'x', quota: [{ status: 'x' }] }), /quota/);
  const done = broker.complete(w.id, job.id, job.leaseToken, { status: 'done', output: 'x', quota: [{ status: 'allowed', window: 'five_hour', source: 'usurpée', extra: 1 }] });
  assert.deepEqual(done.result.quota, [{ status: 'allowed', window: 'five_hour', utilization: null, resetsAt: null, overage: false }]);
  db.close();
});

test('central : un worker refusé est mis de côté, un autre prend la tâche', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot3-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), port: 0, env: {} });
  try {
    const { comm, engines } = runtime.studio;
    const [a, b] = ['a', 'b'].map((name) => runtime.broker.enroll({ name, models: ['sonnet'] }));
    runtime.broker.heartbeat(a.id); runtime.broker.heartbeat(b.id);
    const lucas = runtime.studio.listAgentFiles().find((f) => f.slug === 'lucas').agentId;
    const t = comm.createTask({ assigneeId: lucas, instruction: 'Résumer' }).task;
    runtime.app.orchestrator.pump();
    const options = (w, runner) => ({ baseUrl: runtime.origin, token: w.token, models: ['sonnet'], runner });
    await runWorkerOnce(options(a, async (o) => { o.onEvent(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() })); throw new Error('limite simulée'); }));
    for (let i = 0; i < 100 && !runtime.broker.status().jobs.queued; i += 1) await delay(50);
    assert.equal(await runWorkerOnce(options(a, async () => 'jamais')), null);
    assert.match(engines.quotaReason(sonnet, a.id), /Limite/);
    await runWorkerOnce(options(b, async () => JSON.stringify({ report: 'ok' })));
    await runtime.app.orchestrator.idle();
    assert.equal(comm.task(t.id).state, 'done');
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: `src/worker-broker.js`** — compléter l'import avec `cleanSignal`. Dans `resultValue`, avant le `return` :

```js
  const quota = result.quota ?? null;
  if (quota !== null && (!Array.isArray(quota) || quota.length > 8 || !quota.every((q) => cleanSignal(q)))) throw fault('INVALID_RESULT', 'Invalid quota signal.');
```

et ajouter à l'objet rendu `...(quota?.length ? { quota: quota.map((q) => cleanSignal(q)) } : {})`.

Remplacer `claim(id) {` par `claim(id, { allow = () => true } = {}) {` et, dans la recherche du travail, `allowed.includes(JSON.parse(r.payload).model)` par :

```js
.find(r => { const model = JSON.parse(r.payload).model; return allowed.includes(model) && allow(model); })
```

(c'est-à-dire le prédicat passé à `.find`, remplacé en entier).

- [ ] **Step 4: `src/worker-client.js`** — compléter l'import avec `quotaOfEvent`. Remplacer les déclarations `observed` / `report` par :

```js
  const observed = new Set(), signals = new Map();
  const report = () => ({ ...accounting, ...(observed.size ? { models: [...observed] } : {}), ...(signals.size ? { quota: [...signals.values()].slice(0, 8) } : {}) });
```

et ajouter dans le rappel `onEvent` :

```js
        const quota = quotaOfEvent(event);
        if (quota) { const { source, ...signal } = quota; signals.set(signal.window, signal); }
```

- [ ] **Step 5: `src/cloud-server.js`**

Remplacer `engineReason` par :

```js
  const usableWorkers = model => liveWorkers(model).filter(w => !studio.engines.quotaReason({ provider: 'claude', model }, w.id));
  // Motif d'attente d'un moteur : catalogue, aucun worker, ou tous les workers refusés par le fournisseur. Jamais de remplacement.
  const engineReason = engine => {
    if (!engine) return '';
    const off = studio.engines.reason(engine); if (off) return off;
    const live = liveWorkers(engine.model);
    if (!live.length) return `Aucun worker disponible n’offre le modèle « ${engine.model} » : la demande attend, sans bascule.`;
    const held = live.map(w => studio.engines.quotaReason(engine, w.id));
    return held.every(Boolean) ? held[0] : '';
  };
```

Dans `runRemote`, remplacer `if (!liveWorkers(options.model).length)` par `if (!usableWorkers(options.model).length)`. Remplacer `replay` et ses deux appels :

```js
    const replay = (result, source) => {
      for (const model of result?.models ?? []) options.onEvent?.({ type: 'assistant', message: { model, content: [] } });
      for (const q of result?.quota ?? []) options.onEvent?.({ type: 'rate_limit_event', archipel_source: source, rate_limit_info: { status: q.status, rateLimitType: q.window, utilization: q.utilization ?? undefined, resetsAt: q.resetsAt ? Date.parse(q.resetsAt) / 1000 : undefined, isUsingOverage: q.overage } });
      options.onEvent?.({ type: 'result', total_cost_usd: result?.costUsd ?? undefined, usage: result?.usage ?? undefined });
    };
```

avec `replay(current.result, current.workerId)` en succès comme en échec. Dans la route `/worker/claim`, remplacer `broker.claim(worker.id)` par :

```js
broker.claim(worker.id, { allow: model => !studio.engines.quotaReason({ provider: 'claude', model }, worker.id) })
```

- [ ] **Step 6: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-quota.test.js test/engine-choice.test.js test/engine-accounting.test.js test/worker-broker.test.js test/cloud-runtime.test.js test/cloud-operations.test.js` ; Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker-broker.js src/worker-client.js src/cloud-server.js test/engine-quota.test.js
git commit -m "feat: carry quota signals from workers"
```

---

### Task 5: Interface

**Files:**
- Modify: `public/engine-view.js`, `public/dashboard-view.js`, `public/hq-ui.js`, `public/comm-ui.js`, `test/engine-quota.test.js`

**Interfaces:**
- Produces: `sourceName(source)`, `signalLine(signal)` ; `buildDashboard({engines, …})`.

- [ ] **Step 1: Ajouter les tests** :

```js
import { signalLine } from '../public/engine-view.js';
import { buildDashboard } from '../public/dashboard-view.js';

test('écran : inconnu sans relevé ou relevé périmé, jamais zéro', () => {
  const base = { provider: 'claude', source: 'local', window: 'five_hour', status: 'allowed', utilization: null, resetsAt: later, overage: false, observedAt: past, stale: false, blocking: '' };
  assert.match(signalLine(base), /Claude · cet ordinateur · fenêtre de 5 h : autorisé · consommation inconnue/);
  assert.match(signalLine({ ...base, utilization: 0.82 }), /82 % utilisés/);
  assert.match(signalLine({ ...base, stale: true }), /Inconnu \(relevé du .* périmé\)/);
  const quotas = (engines) => buildDashboard({ engines }).find((c) => c.id === 'quotas');
  assert.equal(quotas(null).value, 'Inconnu');
  assert.equal(quotas({ signals: [{ ...base, stale: true }] }).value, 'Inconnu');
  assert.equal(quotas({ signals: [base] }).value, 'Claude autorisé');
  assert.equal(quotas({ signals: [{ ...base, blocking: 'x' }] }).value, 'Claude en attente');
  assert.equal(quotas({ signals: [{ ...base, status: 'allowed_warning' }] }).tone, 'warn');
});
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: Ajouter à `public/engine-view.js`**

```js
const WINDOWS = { five_hour: 'fenêtre de 5 h', seven_day: 'semaine', seven_day_opus: 'semaine Opus', seven_day_sonnet: 'semaine Sonnet', overage: 'dépense supplémentaire', unknown: 'fenêtre non précisée' };
const QUOTA = { allowed: 'autorisé', allowed_warning: 'proche de la limite', rejected: 'refusé' };
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
export const sourceName = (source) => (source === 'local' ? 'cet ordinateur' : `worker ${source.slice(0, 8)}`);
export function signalLine(s) {
  const head = `${PROVIDERS[s.provider] ?? s.provider} · ${sourceName(s.source)} · ${WINDOWS[s.window] ?? s.window}`;
  if (s.stale) return `${head} : Inconnu (relevé du ${when(s.observedAt)} périmé)`;
  const used = s.utilization == null ? 'consommation inconnue' : `${Math.round(s.utilization * 100)} % utilisés`;
  return `${head} : ${QUOTA[s.status] ?? s.status}${s.overage ? ', dépense supplémentaire en cours' : ''} · ${used} · ${s.resetsAt ? `remise à zéro ${when(s.resetsAt)}` : 'remise à zéro inconnue'} · relevé du ${when(s.observedAt)}`;
}
```

- [ ] **Step 4: `public/dashboard-view.js`** — import `import { signalLine } from './engine-view.js';`, ajouter `engines` aux paramètres de `buildDashboard`, et remplacer la ligne `cards.push(card('quotas', …));` par :

```js
  const current = (engines?.signals ?? []).filter((s) => !s.stale);
  if (!current.length) cards.push(card('quotas', 'Quotas fournisseurs', 'Inconnu', `Les abonnements ne communiquent pas leur solde à Archipel.${limit}`, 'unknown'));
  else {
    const held = current.some((s) => s.blocking), near = current.some((s) => s.status === 'allowed_warning');
    cards.push(card('quotas', 'Quotas fournisseurs', held ? 'Claude en attente' : near ? 'Claude proche de la limite' : 'Claude autorisé', `${current.map(signalLine).join(' ; ')}.${limit}`, held || near ? 'warn' : 'ok', 'comm'));
  }
```

- [ ] **Step 5: `public/hq-ui.js`** — dans `load`, ajouter `engines` à la liste déstructurée entre `localHealth` et `operations`, `'/api/engines'` à la fin du tableau des chemins, et `engines` à l'objet passé à `buildDashboard`.

- [ ] **Step 6: `public/comm-ui.js`** — ajouter `signalLine` à l'import de `./engine-view.js`. Dans `loadActivity`, ajouter `engines` à la liste déstructurée et `get('/api/engines').catch(() => null)` à la fin du `Promise.all`. Après la liste par moteur de « Coûts et quotas » :

```js
        h('h3', {}, 'Quota observé chez le fournisseur'),
        engines?.signals?.length ? h('ul', {}, engines.signals.map((s) => h('li', {}, signalLine(s), s.blocking && h('p', { class: 'err' }, s.blocking),
          s.resumable && confirmBtn('Reprendre…', 'Confirmer la reprise', async () => { await send('POST', '/api/engines/claude/resume', { source: s.source, confirm: true }); announce('Reprise confirmée'); await loadActivity('Reprise confirmée.'); }))))
          : h('p', { class: 'note' }, engines ? 'Inconnu : Claude Code n’a transmis aucun relevé.' : 'Indisponible.'),
```

- [ ] **Step 7: Vérifier dans le navigateur** sur base temporaire (même lanceur qu'au lot 2, Task 6) à 375, 800 et 1366 px : section « Quota observé » à « Inconnu », carte « Quotas fournisseurs » à « Inconnu », aucune erreur console. Ne lancer aucun agent.

- [ ] **Step 8: Vérifier** — Run: `node --test --test-timeout=30000` ; Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add public test/engine-quota.test.js
git commit -m "feat: show the observed quota and confirm a resume"
```

---

### Task 6: Documentation et contrôle

**Files:**
- Modify: `docs/WORKERS.md`, `docs/LIVRAISON.md`

- [ ] **Step 1: `docs/WORKERS.md`** — remplacer « Quota is reported as unknown. » par :

```markdown
Quota is unknown until Claude Code sends a `rate_limit_event`. A report may carry
`quota`, up to eight bounded signals; the server stores them per worker. A refused
model is no longer assigned to that worker until the announced reset, and a
reported overage waits for the owner's confirmation. An overage is only known after
the call that reports it.
```

- [ ] **Step 2: `docs/LIVRAISON.md`** — ajouter sous les lignes des lots 1 et 2 :

```markdown
| Quota observé chez Claude, attente après refus, confirmation après dépense supplémentaire | Oui, branche `feat/engine-quota` | Événements **simulés** | Non | Non : événement réel jamais observé |
```

- [ ] **Step 3: Contrôle complet** — `node --test --test-timeout=30000` (0 échec, noter le nombre), `node src/skills-cli.js check`, `git diff --stat main -- .claude/agents data` (vide).

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe the observed quota"
```

## Non vérifié par ce lot

Aucun événement réel de quota n'a été observé. La première exécution réelle autorisée doit confirmer la forme de l'événement et l'unité de `utilization`. Un dépassement n'est connu qu'après l'appel qui le signale.
