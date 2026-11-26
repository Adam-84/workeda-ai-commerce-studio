# Moteur IA, lot 1 : comptes fiables — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toute exécution IA est enregistrée avec son fournisseur et le modèle constaté, et une donnée absente n'est jamais affichée ni comptée comme zéro.

**Architecture:** Un module pur `src/engines.js` compare le modèle demandé et le modèle constaté. Une migration ajoute deux colonnes à `comm_runs`. Les quatre appels hors tâches (`stream()` dans `src/app.js`) deviennent des exécutions locales, non synchronisées. Les workers renvoient les modèles constatés.

**Tech Stack:** Node 24, `node:sqlite`, `node:test`, aucune dépendance, aucune étape de build.

**Conception :** `docs/superpowers/specs/2026-11-26-choix-moteur-ia-design.md`. Lots suivants : `…-lot2-choix.md`, `…-lot3-quota.md`.

## Global Constraints

- Aucune IA réelle appelée : runners simulés uniquement. Aucune API payante, aucun compte.
- Tests sur `:memory:` ou dossier temporaire. Ne jamais ouvrir `data/workeda.db`, ne jamais lancer `npm start` depuis le dossier principal.
- Aucun secret dans Git. Aucune écriture Shopify. Les 11 fiches `.claude/agents/` ne sont pas modifiées.
- Aucune fusion dans `main`, aucun push sans demande du propriétaire.
- Textes visibles en français, style du code existant (lignes longues, commentaires français sobres).
- Avant chaque commit final de lot : `node --test --test-timeout=30000` et `node src/skills-cli.js check`.
- Les blocs « remplacer » citent le code de `main` (`4da42c9`). Les lire dans le fichier avant d'éditer.

## Fichiers

| Fichier | Rôle dans ce lot |
| --- | --- |
| `src/engines.js` (créé) | Règles pures : identifiants, modèle d'un événement, comparaison |
| `src/comm-core.js` | Types d'exécution, modèles constatés, jetons absents à `null` |
| `src/studio-comm.js` | Migration 5, exécutions, usage, budget, journal |
| `src/comm-run.js` | Modèle constaté sur les tâches et réponses |
| `src/app.js` | Les quatre appels immédiats enregistrés |
| `src/worker-broker.js`, `src/worker-client.js`, `src/cloud-server.js` | Modèles constatés en mode central |
| `public/comm-view.js`, `comm-ui.js`, `conversation.js`, `missions.js`, `plan.js` | Affichage |
| `test/engine-accounting.test.js` (créé) | Tests du lot |

---

### Task 1: Modèle constaté

**Files:**
- Create: `src/engines.js`, `test/engine-accounting.test.js`
- Modify: `src/comm-core.js` (`observeTools`)

**Interfaces:**
- Produces: `DEFAULT_PROVIDER`, `FAMILIES`, `isModelId(v)`, `isProviderId(v)`, `modelOfEvent(event) → string|null`, `familyOf(model) → string|null`, `checkModel(requested, observed[]) → {status:'unknown'|'match'|'mismatch', requested, observed}`, `mismatchText(check) → string`. `observeTools().state.models: string[]`.

- [ ] **Step 1: Créer la branche**

```bash
git switch -c feat/engine-accounting
```

- [ ] **Step 2: Écrire les tests qui échouent** — créer `test/engine-accounting.test.js` :

```js
// Lot 1 : toutes les exécutions comptées, donnée absente jamais zéro, modèle constaté. Runners simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeTools } from '../src/comm-core.js';
import { checkModel } from '../src/engines.js';

test('modèle constaté : identique, absent ou différent', () => {
  assert.equal(checkModel('sonnet', ['claude-sonnet-5-5-20260101']).status, 'match');
  assert.equal(checkModel('sonnet', []).status, 'unknown');
  assert.equal(checkModel('sonnet', ['claude-haiku-5-5']).status, 'mismatch');
  assert.equal(checkModel('sonnet', ['claude-sonnet-5-5', 'claude-haiku-5-5']).status, 'mismatch');
});

test('observation : seules les réponses principales nomment un modèle ; un jeton absent reste inconnu', () => {
  const seen = observeTools();
  seen.feed({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } });
  seen.feed({ type: 'assistant', parent_tool_use_id: 't1', message: { model: 'claude-haiku-5-5', content: [] } });
  seen.feed({ type: 'assistant', message: { model: '<synthetic>', content: [] } });
  seen.feed({ type: 'result', usage: { input_tokens: 3 } });
  assert.deepEqual(seen.state.models, ['claude-sonnet-5-5']);
  assert.deepEqual(seen.state.usage, { input: 3, output: null });
  assert.equal(seen.state.cost, null);
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `node --test --test-timeout=30000 test/engine-accounting.test.js`
Expected: FAIL, `Cannot find module '…/src/engines.js'`.

- [ ] **Step 4: Créer `src/engines.js`**

```js
// src/engines.js — règles pures sur les moteurs IA (aucun accès base, réseau ou processus).
export const DEFAULT_PROVIDER = 'claude';
export const FAMILIES = ['opus', 'sonnet', 'haiku'];
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:\[\]-]{0,99}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const isModelId = (v) => typeof v === 'string' && MODEL_ID.test(v);
export const isProviderId = (v) => typeof v === 'string' && PROVIDER_ID.test(v);
// Modèle d'une réponse principale ; les sous-appels et les messages fabriqués par Claude Code (« <synthetic> ») ne comptent pas.
export const modelOfEvent = (e) => (e?.type === 'assistant' && !e.parent_tool_use_id && isModelId(e.message?.model) ? e.message.model : null);
export const familyOf = (model) => { const words = String(model ?? '').toLowerCase().split(/[^a-z]+/); return FAMILIES.find((f) => words.includes(f)) ?? null; };
export function checkModel(requested, observed = []) {
  const list = [...new Set((observed ?? []).filter(isModelId))];
  if (!requested || !list.length) return { status: 'unknown', requested: requested ?? null, observed: list };
  const want = familyOf(requested);
  const same = list.every((m) => (want ? familyOf(m) === want : m === requested));
  return { status: same ? 'match' : 'mismatch', requested, observed: list };
}
export const mismatchText = (c) => `Modèle différent du demandé : « ${c.requested} » demandé, « ${c.observed.join(', ')} » constaté.`;
```

- [ ] **Step 5: Modifier `observeTools` dans `src/comm-core.js`**

Ajouter l'import en tête, après les imports existants :

```js
import { modelOfEvent } from './engines.js';
```

Remplacer `const state = { fetched: [], searched: [], found: [], cost: null, usage: null, turns: 0 };` par :

```js
  const state = { fetched: [], searched: [], found: [], models: [], cost: null, usage: null, turns: 0 };
```

Au début de `feed(event) {`, ajouter :

```js
      if (state.models.length < 8) add(state.models, modelOfEvent(event));
```

Dans la ligne `if (event?.type === 'result') { … }`, remplacer `{ input: event.usage.input_tokens ?? 0, output: event.usage.output_tokens ?? 0 }` par :

```js
{ input: event.usage.input_tokens ?? null, output: event.usage.output_tokens ?? null }
```

- [ ] **Step 6: Vérifier le succès**

Run: `node --test --test-timeout=30000 test/engine-accounting.test.js test/comm-store.test.js test/comm-run.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engines.js src/comm-core.js test/engine-accounting.test.js
git commit -m "feat: observe which model actually answered"
```

---

### Task 2: Exécutions avec fournisseur ; appels immédiats locaux

**Files:**
- Modify: `src/comm-core.js`, `src/studio-comm.js`, `test/comm-store.test.js`, `test/engine-accounting.test.js`

**Interfaces:**
- Consumes: `DEFAULT_PROVIDER`, `isModelId`, `isProviderId`, `checkModel` (Task 1).
- Produces: `COUNTED_RUN_KINDS`, `LOCAL_RUN_KINDS` (comm-core) ; `startRun({agentId, kind, taskId, threadId, model, provider, web})` ; `endRun(id, {state, error, costUsd, usage, models})` ; les exécutions exposent `provider`, `observedModels`, `modelStatus`.

- [ ] **Step 1: Ajouter les tests** à `test/engine-accounting.test.js`. Remplacer le bloc d'imports par :

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { observeTools, LIMITS } from '../src/comm-core.js';
import { COMM_SCHEMA_VERSION } from '../src/studio-comm.js';
import { checkModel } from '../src/engines.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}, file = ':memory:') {
  const studio = createStudio(file, options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, ids };
}
```

Puis ajouter à la fin :

```js
test('exécution : fournisseur et modèle constaté enregistrés', () => {
  const { comm, ids } = setup();
  const r = comm.startRun({ agentId: ids.noah, kind: 'task', model: 'sonnet' });
  const done = comm.endRun(r.id, { state: 'done', models: ['claude-haiku-5-5', '<x>'] });
  assert.equal(done.provider, 'claude');
  assert.deepEqual(done.observedModels, ['claude-haiku-5-5']);
  assert.equal(done.modelStatus, 'mismatch');
});

test('appels immédiats : comptés, hors limite quotidienne, absents du journal git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot1-'));
  try {
    const { comm, ids, studio } = setup({ commJournalDir: dir, device: 'pc-a' });
    for (const kind of ['chat', 'team', 'plan', 'memory']) { const r = comm.startRun({ agentId: ids.noah, kind, model: 'sonnet' }); comm.endRun(r.id, { state: 'done', costUsd: 0.01 }); }
    assert.equal(comm.usage().today.runs, 4);
    assert.equal(comm.usage().quota.remaining, LIMITS.maxRunsPerDay);
    const journal = existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('') : '';
    assert.doesNotMatch(journal, /"kind":"(chat|team|plan|memory)"/);
    studio.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration : les anciennes exécutions sont rattachées à Claude, le retour arrière fonctionne', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot1-')), file = join(dir, 'db.sqlite');
  try {
    const a = setup({ device: 'pc-a' }, file);
    a.comm.rollback(4); a.studio.close();
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO comm_runs (id, agent_id, kind, state, device, started_at) VALUES ('ancienne', ?, 'task', 'done', 'pc-a', ?)").run(a.ids.lucas, new Date().toISOString());
    raw.close();
    const b = createStudio(file, { device: 'pc-a' });
    assert.equal(b.comm.schemaVersion(), COMM_SCHEMA_VERSION);
    assert.equal(b.comm.getRun('ancienne').provider, 'claude');
    assert.equal(b.comm.rollback(4).to, 4);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `node --test --test-timeout=30000 test/engine-accounting.test.js`
Expected: FAIL (`done.provider` vaut `undefined`).

- [ ] **Step 3: `src/comm-core.js`** — après `export const WEB_TOOLS = …`, ajouter :

```js
export const COUNTED_RUN_KINDS = ['task', 'reply'];              // limite interne quotidienne
export const LOCAL_RUN_KINDS = ['chat', 'team', 'plan', 'memory']; // appels immédiats : comptés dans l'usage, jamais synchronisés
```

- [ ] **Step 4: `src/studio-comm.js`, imports et migration**

Ajouter `COUNTED_RUN_KINDS, LOCAL_RUN_KINDS` à la liste importée de `./comm-core.js`, puis :

```js
import { DEFAULT_PROVIDER, isModelId, isProviderId, checkModel } from './engines.js';
```

Après l'objet de la version 4 dans `COMM_MIGRATIONS`, ajouter :

```js
, {
  version: 5,
  name: 'fournisseur et modèle constaté par exécution',
  // Seul Claude a jamais été branché : les exécutions antérieures lui sont rattachées.
  up: `ALTER TABLE comm_runs ADD COLUMN provider TEXT; ALTER TABLE comm_runs ADD COLUMN observed_models TEXT NOT NULL DEFAULT '[]'; UPDATE comm_runs SET provider = 'claude' WHERE provider IS NULL;`,
  down: `ALTER TABLE comm_runs DROP COLUMN observed_models; ALTER TABLE comm_runs DROP COLUMN provider;`
}
```

- [ ] **Step 5: `src/studio-comm.js`, portable, journal, exécutions**

Dans `portable.run`, remplacer `model: r.model, web: Boolean(r.web)` par :

```js
model: r.model, provider: r.provider, observedModels: parseJsonList(r.observed_models), web: Boolean(r.web)
```

Première ligne de la fonction `journal` :

```js
    // Un appel immédiat reste sur cet ordinateur, comme la discussion qui l'a provoqué.
    if (kind === 'run' && LOCAL_RUN_KINDS.includes(get('SELECT kind FROM comm_runs WHERE id = ?', key)?.kind)) return;
```

Remplacer `startRun`, `getRun` et `endRun` par :

```js
  const startRun = ({ agentId, kind, taskId = null, threadId = null, model = null, provider = DEFAULT_PROVIDER, web = false }) => {
    // Un appel immédiat n'exigeait pas un agent actif : l'enregistrer n'ajoute aucune condition.
    if (!LOCAL_RUN_KINDS.includes(kind)) realAgent(agentId);
    const id = randomUUID();
    run("INSERT INTO comm_runs (id, agent_id, kind, task_id, thread_id, model, provider, web, state, device, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)", id, agentId, kind, taskId, threadId, model, provider, Number(web), device, now());
    journal('run', id);
    return getRun(id);
  };
  const mapRun = (r) => { const observedModels = parseJsonList(r.observed_models); return { id: r.id, agentId: r.agent_id, kind: r.kind, taskId: r.task_id, threadId: r.thread_id, model: r.model, provider: r.provider ?? null, observedModels, modelStatus: checkModel(r.model, observedModels).status, web: Boolean(r.web), state: r.state, error: r.error, costUsd: r.cost_usd, inputTokens: r.input_tokens, outputTokens: r.output_tokens, durationMs: r.duration_ms, device: r.device, startedAt: r.started_at, finishedAt: r.finished_at }; };
  const getRun = (id) => { const r = get('SELECT * FROM comm_runs WHERE id = ?', id); return r ? mapRun(r) : null; };
  const endRun = (id, { state = 'done', error = null, costUsd = null, usage = null, models = [] } = {}) => {
    const r = getRun(id); if (!r) throw notFound('Exécution');
    if (r.state !== 'running') return r;
    const finished = now();
    run('UPDATE comm_runs SET state = ?, error = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, duration_ms = ?, observed_models = ?, finished_at = ? WHERE id = ?', state === 'done' ? 'done' : 'error', error ? short(String(error), 500) : null, costUsd, usage?.input ?? null, usage?.output ?? null, Math.max(0, Date.parse(finished) - Date.parse(r.startedAt)), JSON.stringify((models ?? []).filter(isModelId).slice(0, 8)), finished, id);
    journal('run', id);
    return getRun(id);
  };
```

- [ ] **Step 6: `src/studio-comm.js`, limite quotidienne et import**

Remplacer `const runsToday = …` par :

```js
  const runsToday = () => get(`SELECT COUNT(*) AS n FROM comm_runs WHERE device = ? AND started_at >= ? AND kind IN (${COUNTED_RUN_KINDS.map(() => '?').join(',')})`, device, `${now().slice(0, 10)}T00:00:00.000Z`, ...COUNTED_RUN_KINDS).n;
```

Dans `APPLY.run(d) {`, ajouter en première ligne :

```js
      if (LOCAL_RUN_KINDS.includes(d.kind)) throw new Error('exécution locale : jamais importée');
      if (d.provider != null && !isProviderId(d.provider)) throw new Error('fournisseur invalide');
```

et après l'instruction `run('INSERT INTO comm_runs …')` existante :

```js
      // Champs de la migration 5 : un champ absent (journal plus ancien) n'efface rien.
      run("UPDATE comm_runs SET provider = COALESCE(?, provider, 'claude') WHERE id = ?", d.provider ?? null, d.id);
      if (Array.isArray(d.observedModels)) run('UPDATE comm_runs SET observed_models = ? WHERE id = ?', JSON.stringify(d.observedModels.filter(isModelId).slice(0, 8)), d.id);
```

- [ ] **Step 7: `test/comm-store.test.js`** — ajouter `import { COMM_SCHEMA_VERSION } from '../src/studio-comm.js';` et remplacer les deux `assert.equal(<x>.comm.schemaVersion(), 4);` (tests de persistance et de retour arrière) par `assert.equal(<x>.comm.schemaVersion(), COMM_SCHEMA_VERSION);`.

- [ ] **Step 8: Vérifier le succès**

Run: `node --test --test-timeout=30000 test/engine-accounting.test.js test/comm-store.test.js test/comm-run.test.js test/shop-integration.test.js test/shop-review.test.js test/comm-cli.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/comm-core.js src/studio-comm.js test/engine-accounting.test.js test/comm-store.test.js
git commit -m "feat: record provider and observed model on every run"
```

---

### Task 3: Inconnu n'est jamais zéro

**Files:**
- Modify: `src/studio-comm.js` (`usage`, `spentOf`, `unreportedOf`), `src/comm-core.js` (commentaire), `test/engine-accounting.test.js`

**Interfaces:**
- Produces: `usage() → { today: Sum, total: Sum, quota, note, byEngine: [{provider, model, today: Sum, total: Sum}], byAgent: [{agentId, ...Sum}] }` avec `Sum = {runs, runsWithCost, costUsd|null, runsWithTokens, inputTokens|null, outputTokens|null}`.

- [ ] **Step 1: Ajouter les tests**

```js
test('usage : sans donnée rapportée, null et jamais 0 ; détail par moteur et par agent', () => {
  const { comm, ids } = setup();
  const a = comm.startRun({ agentId: ids.noah, kind: 'task', model: 'sonnet' }); comm.endRun(a.id, { state: 'done' });
  let u = comm.usage();
  assert.equal(u.today.costUsd, null); assert.equal(u.today.inputTokens, null); assert.equal(u.total.costUsd, null); assert.equal(u.byAgent[0].costUsd, null);
  const b = comm.startRun({ agentId: ids.noah, kind: 'task', model: 'opus' }); comm.endRun(b.id, { state: 'done', costUsd: 0.5, usage: { input: 10, output: 5 } });
  u = comm.usage();
  assert.equal(u.today.costUsd, 0.5); assert.equal(u.today.runs, 2); assert.equal(u.today.runsWithCost, 1);
  assert.deepEqual(u.byEngine.map((e) => [e.provider, e.model, e.total.costUsd]), [['claude', 'opus', 0.5], ['claude', 'sonnet', null]]);
});

test('budget : une exécution réussie sans coût rapporté compte l’estimation, jamais 0', () => {
  const { comm, ids } = setup();
  const root = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit', budgetUsd: 1 }).task;
  const r = comm.startRun({ agentId: ids.lucas, kind: 'task', taskId: root.id });
  assert.equal(comm.spentOf(root.id), 0, 'une exécution en cours n’est pas encore comptée');
  comm.endRun(r.id, { state: 'done' });
  assert.equal(comm.spentOf(root.id), LIMITS.unreportedRunUsd);
  assert.equal(comm.task(root.id).unreportedRuns, 1);
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `node --test --test-timeout=30000 test/engine-accounting.test.js` ; Expected: FAIL (`0 !== null`).

- [ ] **Step 3: Remplacer `spentOf` et `unreportedOf`** (avec leurs commentaires) par :

```js
  // Exécutions d'une demande racine : ses tâches ET les réponses données dans le fil de sa mission.
  const OF_ROOT = "(r.task_id IN (SELECT id FROM comm_tasks WHERE root_task_id = ?) OR (r.kind = 'reply' AND r.thread_id IN (SELECT id FROM comm_threads WHERE mission_id = ?)))";
  const missionOfRoot = (rootId) => get('SELECT mission_id FROM comm_tasks WHERE id = ?', rootId)?.mission_id ?? '';
  // Terminée sans coût rapporté (réussie ou non) : le coût réel est inconnu, on compte une estimation prudente, jamais 0.
  const unreportedOf = (rootId) => get(`SELECT COUNT(*) AS n FROM comm_runs r WHERE r.state != 'running' AND r.cost_usd IS NULL AND ${OF_ROOT}`, rootId, missionOfRoot(rootId)).n;
  const spentOf = (rootId) => {
    const reported = get(`SELECT COALESCE(SUM(r.cost_usd), 0) AS c FROM comm_runs r WHERE ${OF_ROOT}`, rootId, missionOfRoot(rootId)).c;
    return Math.round((reported + unreportedOf(rootId) * LIMITS.unreportedRunUsd) * 1e4) / 1e4;
  };
```

- [ ] **Step 4: Remplacer `usage`** par :

```js
  const usage = () => {
    const today = `${now().slice(0, 10)}T00:00:00.000Z`;
    // SUM sans aucune valeur rend NULL : une donnée absente reste absente, jamais 0.
    const COLUMNS = 'COUNT(*) AS runs, COUNT(cost_usd) AS costed, SUM(cost_usd) AS cost, COUNT(input_tokens) AS tokened, SUM(input_tokens) AS inT, SUM(output_tokens) AS outT';
    const shape = (r) => ({ runs: r?.runs ?? 0, runsWithCost: r?.costed ?? 0, costUsd: r?.cost ?? null, runsWithTokens: r?.tokened ?? 0, inputTokens: r?.inT ?? null, outputTokens: r?.outT ?? null });
    const sum = (where, ...a) => shape(get(`SELECT ${COLUMNS} FROM comm_runs WHERE ${where}`, ...a));
    const todays = new Map(all(`SELECT provider, model, ${COLUMNS} FROM comm_runs WHERE started_at >= ? GROUP BY provider, model`, today).map((r) => [`${r.provider}|${r.model}`, shape(r)]));
    return {
      today: sum('started_at >= ?', today), total: sum('1 = 1'),
      quota: { runsPerDay: LIMITS.maxRunsPerDay, remaining: Math.max(0, LIMITS.maxRunsPerDay - runsToday()) },
      note: 'Coût et jetons tels que rapportés par Claude Code ; abonnement existant, aucune API payante.',
      byEngine: all(`SELECT provider, model, ${COLUMNS} FROM comm_runs GROUP BY provider, model ORDER BY provider, model`).map((r) => ({ provider: r.provider, model: r.model, today: todays.get(`${r.provider}|${r.model}`) ?? shape(null), total: shape(r) })),
      byAgent: all(`SELECT agent_id, ${COLUMNS} FROM comm_runs GROUP BY agent_id ORDER BY runs DESC`).map((r) => ({ agentId: r.agent_id, ...shape(r) }))
    };
  };
```

- [ ] **Step 5: `src/comm-core.js`** — remplacer le commentaire de `unreportedRunUsd` par `// une exécution terminée SANS coût rapporté compte pour cette somme dans le budget (estimation, affichée comme telle)`.

- [ ] **Step 6: Vérifier toute la suite**

Run: `node --test --test-timeout=30000`
Expected: PASS. Si un test échoue avec « Budget de la mission atteint » parce que son runner simulé ne rapporte aucun coût, passer `budgetUsd: 100` à sa demande racine : le test ne portait pas sur le budget.

- [ ] **Step 7: Commit**

```bash
git add src/studio-comm.js src/comm-core.js test
git commit -m "fix: never show or budget an unreported cost as zero"
```

---

### Task 4: Tâches et réponses : modèle différent « à vérifier »

**Files:**
- Modify: `src/comm-run.js`, `test/engine-accounting.test.js`

**Interfaces:**
- Consumes: `checkModel`, `mismatchText`, `observeTools().state.models`.

- [ ] **Step 1: Ajouter les tests** (import `import { createOrchestrator } from '../src/comm-run.js';`) :

```js
// Runner simulé : mêmes événements stream-json que Claude Code.
const claude = (text, { model, cost } = {}) => async (o) => {
  if (model) o.onEvent?.({ type: 'assistant', message: { model, content: [] } });
  if (cost !== undefined) o.onEvent?.({ type: 'result', total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 5 } });
  return text;
};

test('tâche : un autre modèle que celui demandé passe « à vérifier » ; absent ne dégrade rien', async () => {
  for (const [model, state] of [['claude-sonnet-5-5', 'done'], [undefined, 'done'], ['claude-haiku-5-5', 'review']]) {
    const { studio, comm, ids } = setup();
    const orch = createOrchestrator({ studio, profiles: () => profiles, runner: claude(JSON.stringify({ report: 'ok' }), { model, cost: 0.01 }) });
    const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Résumer' }).task;
    orch.pump(); await orch.idle();
    assert.equal(comm.task(t.id).state, state, String(model));
    if (state === 'review') assert.match(comm.resultOf(t.id).verification, /Modèle différent/);
  }
});

test('réponse dans un fil : avertissement visible si le modèle diffère', async () => {
  const { studio, comm, ids } = setup();
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: claude('Bien reçu.', { model: 'claude-haiku-5-5' }) });
  const th = comm.createThread({ kind: 'direct', members: [ids.noah] });
  comm.postMessage(th.id, { body: 'Bonjour' });
  orch.replyInThread(th.id, ids.noah); await orch.idle();
  assert.ok(comm.listMessages(th.id).items.some((m) => m.senderType === 'system' && /Modèle différent/.test(m.body)));
});
```

- [ ] **Step 2: Vérifier l'échec** — Expected: FAIL (`done !== review`).

- [ ] **Step 3: Modifier `src/comm-run.js`**

Import :

```js
import { checkModel, mismatchText } from './engines.js';
```

Dans `execute`, remplacer `comm.endRun(run.id, { state: 'done', costUsd: seen.state.cost, usage: seen.state.usage })` par :

```js
comm.endRun(run.id, { state: 'done', costUsd: seen.state.cost, usage: seen.state.usage, models: seen.state.models })
```

Dans `fail`, remplacer la ligne `comm.endRun(…)` par :

```js
    comm.endRun(run.id, { state: 'error', error: message, costUsd: observed?.cost ?? null, usage: observed?.usage ?? null, models: observed?.models ?? [] }); // un coût déjà rapporté avant l'erreur est conservé
```

Dans `succeed`, remplacer `const verdict = evaluateResult({ task, parsed, observed, deps });` par :

```js
    const judged = evaluateResult({ task, parsed, observed, deps });
    // Le propriétaire a approuvé un moteur précis : la réponse d'un autre modèle n'est jamais « vérifiée » d'office.
    const check = checkModel(run.model, observed.models);
    const verdict = check.status === 'mismatch' ? { ...judged, verified: false, level: 'none', verification: `${mismatchText(check)} ${judged.verification}` } : judged;
```

Dans `replyInThread`, ajouter `models: seen.state.models` aux deux appels `comm.endRun`, puis après le `comm.postMessage` de la réponse :

```js
        const check = checkModel(profile.model, seen.state.models);
        if (check.status === 'mismatch') comm.postMessage(threadId, { kind: 'system', body: `${a.name} : ${mismatchText(check)}` }, { type: 'system' });
```

- [ ] **Step 4: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-accounting.test.js test/comm-run.test.js test/comm-review.test.js` ; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/comm-run.js test/engine-accounting.test.js
git commit -m "feat: hold a result for review when another model answered"
```

---

### Task 5: Les quatre appels immédiats

**Files:**
- Modify: `src/app.js` (`stream`, `reply`, `proposePlan`, `teamReply`, `proposeMemory`), `test/engine-accounting.test.js`

**Interfaces:**
- Produces: la ligne NDJSON `{type:'done', message, warning?: string}`.

- [ ] **Step 1: Ajouter les tests** (import `import { createApp } from '../src/app.js';`) :

```js
async function withApp(runner, fn) {
  const { studio, comm, ids } = setup();
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: runner, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, data) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) }); return { status: r.status, lines: (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)) }; };
  try { await fn({ studio, comm, ids, post }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); studio.close(); }
}
const answers = async (o) => {
  o.onEvent?.({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [] } });
  o.onEvent?.({ type: 'result', total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } });
  if (/PROPOSITION de plan/.test(o.prompt)) return JSON.stringify({ steps: [{ action: 'Lire', agent: 'Lucas' }] });
  if (/PROPOSE ce qui mérite/.test(o.prompt)) return JSON.stringify({ proposals: [] });
  return 'Réponse simulée.';
};

test('discussion, fil d’équipe, plan et souvenirs : chacun laisse une exécution', () => withApp(answers, async ({ studio, comm, ids, post }) => {
  await post(`/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
  const chat = await post(`/api/agents/${ids.lucas}/reply`);
  assert.equal(chat.lines.at(-1).type, 'done'); assert.match(chat.lines.at(-1).warning, /Modèle différent/);
  const mission = studio.createMission({ title: 'Mission', assignedTo: ids.lucas });
  await post(`/api/missions/${mission.id}/discussion`, { body: 'Un point ?' });
  await post(`/api/missions/${mission.id}/discussion/reply/${ids.lucas}`);
  await post(`/api/missions/${mission.id}/plan/propose`);
  await post(`/api/missions/${mission.id}/memory-proposals`);
  const runs = comm.recentRuns(10);
  assert.deepEqual(runs.map((r) => r.kind).sort(), ['chat', 'memory', 'plan', 'team']);
  assert.ok(runs.every((r) => r.costUsd === 0.02 && r.provider === 'claude' && r.state !== 'running'));
  assert.equal(comm.usage().quota.remaining, LIMITS.maxRunsPerDay);
}));

test('une trace impossible à écrire n’empêche pas la réponse', () => withApp(answers, async ({ comm, ids, post }) => {
  comm.startRun = () => { throw new Error('disque plein'); };
  await post(`/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
  assert.equal((await post(`/api/agents/${ids.lucas}/reply`)).lines.at(-1).type, 'done');
}));
```

- [ ] **Step 2: Vérifier l'échec** — Expected: FAIL (`warning` absent, aucune exécution).

- [ ] **Step 3: Modifier `src/app.js`**

Imports :

```js
import { observeTools } from './comm-core.js';
import { checkModel, mismatchText } from './engines.js';
```

Remplacer la fonction `stream` (son commentaire compris) par :

```js
  // Chaque appel immédiat laisse une exécution locale ; un échec d'écriture n'empêche jamais la réponse.
  function openRun(agentId, kind, model) {
    try { return comm?.startRun({ agentId, kind, model }) ?? null; } catch { return null; }
  }
  function closeRun(run, seen, error = null) {
    if (!run) return;
    try { comm.endRun(run.id, { state: error ? 'error' : 'done', error: error?.message ?? null, costUsd: seen.cost, usage: seen.usage, models: seen.models }); } catch { /* la trace manquera ; la réponse reste */ }
  }
  // Lance Claude et diffuse sa réponse ; save(text) l'enregistre même si le panneau a été fermé. lock : une réponse à la fois par clé.
  // La consigne système = fiche + consignes de l'utilisateur pour cet agent ; les options de claude (aucun outil) ne changent jamais.
  async function stream(res, lock, busy, profile, agentId, kind, prompt, save) {
    if (replying.has(lock)) fail(409, busy);
    replying.add(lock);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const line = (data) => { if (!res.writableEnded) res.write(JSON.stringify(data) + '\n'); };
    const seen = observeTools(), run = openRun(agentId, kind, profile.model);
    try {
      const text = await runClaude({ model: profile.model, system: systemPrompt(profile, studio.getInstructions(agentId)), prompt, onText: (t) => line({ type: 'text', text: t }), onEvent: seen.feed });
      closeRun(run, seen.state);
      const check = checkModel(profile.model, seen.state.models);
      line({ type: 'done', message: save(text), ...(check.status === 'mismatch' ? { warning: mismatchText(check) } : {}) });
    } catch (error) { closeRun(run, seen.state, error); line({ type: 'error', error: error.message }); }
    finally { replying.delete(lock); res.end(); }
  }
```

Mettre à jour les quatre appels en insérant le type avant le prompt :

```js
    await stream(res, agentId, `${profile.displayName} répond déjà à un message.`, profile, agentId, 'chat', `${recalled}${context}\n\n${conversationPrompt(items, nameOf, profile.displayName)}`, (text) => studio.saveAgentReply(agentId, text, 'claude'));
```

`proposePlan` : `await stream(res, \`mission:${missionId}\`, 'Un agent travaille déjà sur cette mission.', profile, mission.assignedTo, 'plan',` (le reste inchangé).
`teamReply` : `await stream(res, \`mission:${missionId}\`, 'Un agent répond déjà dans ce fil.', profile, agentId, 'team',` (le reste inchangé).
`proposeMemory` : `await stream(res, \`mission:${missionId}\`, 'Un agent travaille déjà sur cette mission.', profile, agentId, 'memory',` (le reste inchangé).

- [ ] **Step 4: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-accounting.test.js test/comm-api.test.js test/conversation-api.test.js test/missions.test.js test/plan.test.js test/memory-api.test.js` ; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js test/engine-accounting.test.js
git commit -m "feat: account for direct chat, team, plan and memory calls"
```

---

### Task 6: Mode central

**Files:**
- Modify: `src/worker-broker.js` (`resultValue`), `src/worker-client.js`, `src/cloud-server.js` (`runRemote`), `test/engine-accounting.test.js`

**Interfaces:**
- Produces: champ facultatif `models: string[]` (8 au plus) dans le rapport d'un worker.

- [ ] **Step 1: Ajouter les tests** (imports : `createWorkerBroker`, `runWorkerOnce`, `createCloudRuntime`, `hashPassword`) :

```js
import { createWorkerBroker } from '../src/worker-broker.js';
import { runWorkerOnce } from '../src/worker-client.js';
import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';

test('courtier : modèles constatés bornés ; un ancien worker reste « inconnu »', () => {
  const db = new DatabaseSync(':memory:'), broker = createWorkerBroker(db, { models: ['sonnet'] });
  const w = broker.enroll({ name: 'w', models: ['sonnet'] });
  let n = 0;
  const complete = (result) => { broker.enqueue({ key: `k${n += 1}`, payload: { provider: 'claude', model: 'sonnet', system: '', prompt: 'q', tools: [], timeoutMs: 5000 } }); const j = broker.claim(w.id); return broker.complete(w.id, j.id, j.leaseToken, result); };
  assert.deepEqual(complete({ status: 'done', output: 'x', models: ['claude-sonnet-5-5'] }).result.models, ['claude-sonnet-5-5']);
  assert.equal(complete({ status: 'done', output: 'x' }).result.models, undefined);
  assert.throws(() => complete({ status: 'done', output: 'x', models: ['<script>'] }), /observed models/);
  db.close();
});

test('central : modèle constaté et coût remontent du worker, même en échec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot1-c-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), port: 0, env: {} });
  try {
    const w = runtime.broker.enroll({ name: 'sim', models: ['sonnet'] }); runtime.broker.heartbeat(w.id);
    const lucas = runtime.studio.listAgentFiles().find((f) => f.slug === 'lucas').agentId;
    const t = runtime.studio.comm.createTask({ assigneeId: lucas, instruction: 'Résumer' }).task;
    runtime.app.orchestrator.pump();
    await runWorkerOnce({ baseUrl: runtime.origin, token: w.token, models: ['sonnet'], runner: async (o) => {
      o.onEvent({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } });
      o.onEvent({ type: 'result', total_cost_usd: 0.03, usage: { input_tokens: 4, output_tokens: 2 } });
      throw new Error('panne simulée');
    } });
    await runtime.app.orchestrator.idle();
    const [run] = runtime.studio.comm.runsOfTask(t.id);
    assert.deepEqual(run.observedModels, ['claude-sonnet-5-5']); assert.equal(run.costUsd, 0.03);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Vérifier l'échec** — Expected: FAIL.

- [ ] **Step 3: `src/worker-broker.js`** — import `import { isModelId } from './engines.js';`. Dans `resultValue`, remplacer la ligne `return { status: result.status, … };` par :

```js
  const models = result.models ?? null;
  if (models !== null && (!Array.isArray(models) || models.length > 8 || !models.every((m) => isModelId(m)))) throw fault('INVALID_RESULT', 'Invalid observed models.');
  return { status: result.status, output: result.status === 'done' ? result.output : null, error: result.status === 'failed' ? (result.error || 'Worker execution failed.') : null, usage, costUsd, ...(models?.length ? { models: [...new Set(models)] } : {}) };
```

- [ ] **Step 4: `src/worker-client.js`** — import `import { modelOfEvent } from './engines.js';`. Après la déclaration `let timer, …`, ajouter :

```js
  const observed = new Set();
  const report = () => ({ ...accounting, ...(observed.size ? { models: [...observed] } : {}) });
```

Remplacer le rappel `onEvent` et les deux affectations de `result` par :

```js
      const output = await runner({ model: payload.model, system: payload.system, prompt: payload.prompt, tools: [], timeoutMs: payload.timeoutMs, onEvent: event => {
        const model = modelOfEvent(event);
        if (model && observed.size < 8) observed.add(model);
        if (event?.type === 'result') accounting = { usage: event.usage ?? null, costUsd: event.total_cost_usd ?? null };
      } });
      result = { status: 'done', output, ...report() };
    } catch (error) { result = { status: 'failed', error: String(error.message || error).slice(0, 2000), ...report() }; }
```

- [ ] **Step 5: `src/cloud-server.js`** — dans `runRemote`, avant `const work = …`, ajouter :

```js
    // Rejoue côté serveur ce que le worker a observé : modèles et comptes, en succès comme en échec.
    const replay = (result) => {
      for (const model of result?.models ?? []) options.onEvent?.({ type: 'assistant', message: { model, content: [] } });
      options.onEvent?.({ type: 'result', total_cost_usd: result?.costUsd ?? undefined, usage: result?.usage ?? undefined });
    };
```

et remplacer les deux blocs `if (current.status === 'done') …` et `if (current.status === 'failed') …` par :

```js
        if (current.status === 'done') {
          replay(current.result);
          options.onText?.(current.result.output); return current.result.output;
        }
        if (current.status === 'failed') { replay(current.result); throw Object.assign(error(workerFailure(current.result?.error)), { noRetry: true }); }
```

- [ ] **Step 6: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-accounting.test.js test/worker-broker.test.js test/cloud-runtime.test.js test/cloud-operations.test.js` ; Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker-broker.js src/worker-client.js src/cloud-server.js test/engine-accounting.test.js
git commit -m "feat: report observed models from workers"
```

---

### Task 7: Interface

**Files:**
- Modify: `public/comm-view.js`, `public/comm-ui.js`, `public/conversation.js`, `public/missions.js`, `public/plan.js`, `test/comm-view.test.js`

**Interfaces:**
- Produces: `costText(sum)`, `tokensText(sum)`, `costLine(usage)`, `engineLine(row)`, `runLine(run, nameOf)`.

- [ ] **Step 1: Mettre à jour `test/comm-view.test.js`** — ajouter `costText, engineLine` à l'import, et remplacer les trois lignes `const usage = …` / `assert.match(costLine…)` par :

```js
  const usage = { today: { runs: 3, runsWithCost: 3, costUsd: 0.42 }, quota: { remaining: 57, runsPerDay: 60 }, total: { runs: 9 } };
  assert.match(costLine(usage), /3 exécutions aujourd’hui \(reste 57 sur 60\) · 0,42 \$ rapportés/);
  assert.match(costLine({ ...usage, today: { runs: 1, runsWithCost: 0, costUsd: null } }), /coût inconnu/);
  assert.equal(costText({ runs: 3, runsWithCost: 2, costUsd: 0.5 }), '0,50 $ rapportés (2 sur 3 exécutions)');
  assert.equal(costText({ runs: 0 }), 'aucune exécution');
  assert.match(engineLine({ provider: 'claude', model: 'opus', today: { runs: 0 }, total: { runs: 2, runsWithCost: 0, costUsd: null } }), /claude · opus .*coût inconnu/);
  assert.match(runLine({ agentId: 's', kind: 'chat', state: 'done', model: 'sonnet', modelStatus: 'mismatch', observedModels: ['claude-haiku-5-5'] }, nameOf), /discussion directe .*claude-haiku-5-5 constaté au lieu de sonnet/);
```

- [ ] **Step 2: Vérifier l'échec** — Run: `node --test --test-timeout=30000 test/comm-view.test.js`.

- [ ] **Step 3: `public/comm-view.js`** — remplacer `costLine` et `runLine` (commentaire compris) par :

```js
const dollars = (v) => `${v.toFixed(2).replace('.', ',')} $`;
const partial = (n, runs) => (n < runs ? ` (${n} sur ${runs} exécutions)` : '');
// Coût d'un groupe d'exécutions : inconnu et partiel sont dits, jamais remplacés par zéro.
export function costText(s) {
  if (!s?.runs) return 'aucune exécution';
  if (!s.runsWithCost || s.costUsd == null) return 'coût inconnu';
  return `${dollars(s.costUsd)} rapportés${partial(s.runsWithCost, s.runs)}`;
}
export const tokensText = (s) => (!s?.runsWithTokens || s.inputTokens == null || s.outputTokens == null ? 'jetons inconnus' : `${s.inputTokens + s.outputTokens} jetons rapportés${partial(s.runsWithTokens, s.runs)}`);
export const costLine = (u) => `${u.today.runs} exécution${u.today.runs > 1 ? 's' : ''} aujourd’hui (reste ${u.quota.remaining} sur ${u.quota.runsPerDay}) · ${costText(u.today)} · ${u.total.runs} au total`;
export const engineLine = (e) => `${e.provider ?? 'fournisseur inconnu'} · ${e.model ?? 'modèle inconnu'} — aujourd’hui : ${e.today.runs} exécution(s), ${costText(e.today)}, ${tokensText(e.today)} · au total : ${e.total.runs} exécution(s), ${costText(e.total)}`;
```

(`paintCommButtons` et `activeText` restent entre les deux.) Puis :

```js
const RUN_KINDS = { reply: 'réponse dans un fil', chat: 'discussion directe', team: 'fil d’équipe', plan: 'proposition de plan', memory: 'proposition de souvenirs' };
// Une exécution réelle, en une ligne.
export function runLine(r, nameOf) {
  const state = { running: 'en cours', done: 'terminée', error: 'en erreur' }[r.state] ?? r.state;
  const dur = r.durationMs != null ? ` · ${Math.round(r.durationMs / 1000)} s` : '';
  const what = r.kind === 'task' ? `tâche « ${r.taskTitle ?? '?'} »` : RUN_KINDS[r.kind] ?? r.kind;
  const model = !r.model ? '' : r.modelStatus === 'mismatch' ? ` · ⚠ ${r.observedModels.join(', ')} constaté au lieu de ${r.model}` : ` · ${r.model}${r.modelStatus === 'unknown' && r.state === 'done' ? ' (modèle constaté inconnu)' : ''}`;
  return `${nameOf(r.agentId)} · ${what} · ${state}${dur}${r.web ? ' · web en lecture seule' : ''}${model}${r.error ? ` — ${r.error}` : ''}`;
}
```

- [ ] **Step 4: `public/comm-ui.js`**
  - Ajouter `engineLine` à l'import depuis `./comm-view.js`.
  - Après `h('h3', {}, 'Coûts et quotas'), h('p', {}, costLine(usage)),` ajouter : `usage.byEngine.length > 0 && h('ul', {}, usage.byEngine.map((e) => h('li', {}, engineLine(e)))),`
  - Dans `budgetForm`, remplacer `exécution(s) interrompue(s) sans coût rapporté comptée(s) à 0,25 $ chacune : estimation prudente` par `exécution(s) sans coût rapporté comptée(s) à 0,25 $ chacune : estimation, pas un coût constaté`.
  - Dans `taskRow`, remplacer ``chip(`Budget ${(t.spentUsd ?? 0).toFixed(2)} / ${t.budgetUsd.toFixed(2)} $`)`` par ``chip(`Budget ${(t.spentUsd ?? 0).toFixed(2)} / ${t.budgetUsd.toFixed(2)} $${t.unreportedRuns ? ' (dont estimation)' : ''}`)``.

- [ ] **Step 5: Avertissements**
  - `public/conversation.js`, `askReply` : `let final = null, warning = '';` ; la branche `done` devient `else if (event.type === 'done') { final = event.message; warning = event.warning ?? ''; }` ; la ligne de succès devient `reply.busy = false; reply.text = ''; reply.error = warning; notify(final); announce(warning || \`Réponse de ${agent.name} reçue.\`);`
  - `public/missions.js`, `teamBlock` : avant `for (const id of speakers.filter(…))`, `const warnings = [];` ; la branche `done` devient `else if (ev.type === 'done') { done = true; if (ev.warning) warnings.push(\`${name} : ${ev.warning}\`); }` ; le message final devient `status.textContent = [who.length ? 'Réponses enregistrées dans le fil.' : 'Message enregistré dans le fil.', ...warnings].join(' ');`
  - `public/plan.js`, `propose` : `let chars = 0, done = false, warning = '';` ; la branche `done` devient `else if (ev.type === 'done') { done = true; warning = ev.warning ?? ''; }` ; terminer le message de `ok(…)` par `${warning ? \` ${warning}\` : ''}`.

- [ ] **Step 6: Vérifier** — Run: `node --test --test-timeout=30000` ; Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public test/comm-view.test.js
git commit -m "feat: show costs per engine and flag a different model"
```

---

### Task 8: Documentation et contrôle

**Files:**
- Modify: `docs/WORKERS.md`, `docs/LIVRAISON.md`

- [ ] **Step 1: `docs/WORKERS.md`** — dans la liste du protocole, après la phrase sur `usage`/`costUsd`, ajouter :

```markdown
A report may also carry `models`, up to eight model names observed in the answer.
An older server ignores the field; with an older worker the observed model stays
unknown.
```

- [ ] **Step 2: `docs/LIVRAISON.md`** — sous la ligne « Choix du moteur par agent ou mission… », ajouter :

```markdown
| Comptes IA : toutes les exécutions, modèle constaté, coût inconnu distinct de zéro | Oui, branche `feat/engine-accounting` | Tests à runners **simulés** | Non | Non : non fusionné, aucun appel réel |
```

- [ ] **Step 3: Contrôle complet**

Run: `node --test --test-timeout=30000`
Expected: 0 échec ; noter le nombre exact de tests.
Run: `node src/skills-cli.js check`
Expected: succès, aucune copie périmée.
Run: `git diff --stat main -- .claude/agents data`
Expected: aucune sortie.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe the AI accounting lot"
```

## Non vérifié par ce lot

Aucun appel réel à Claude : la présence de `message.model` dans le flux et du coût rapporté repose sur le format documenté et simulé. À confirmer sur la première exécution réelle autorisée.
