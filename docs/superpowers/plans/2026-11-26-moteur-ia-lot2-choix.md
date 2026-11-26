# Moteur IA, lot 2 : choix par agent ou mission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Choisir Opus, Sonnet ou Haiku par agent ou par mission, sans modifier les fiches et sans jamais changer de moteur à l'insu du propriétaire.

**Architecture:** Un catalogue fermé et une résolution pure dans `src/engines.js` ; un magasin `src/studio-engines.js` (choix, résolution, état). Le moteur est figé sur chaque tâche à sa création. La file évalue la disponibilité par tâche et laisse en file, avec le motif, ce qui ne peut pas partir.

**Tech Stack:** Node 24, `node:sqlite`, `node:test`, aucune dépendance, aucune étape de build.

**Conception :** `docs/superpowers/specs/2026-11-26-choix-moteur-ia-design.md`. **Prérequis :** lot 1 terminé et commité.

## Global Constraints

- Aucune IA réelle appelée : runners simulés uniquement. Aucune API payante, aucun compte.
- Tests sur `:memory:` ou dossier temporaire. Ne jamais ouvrir `data/workeda.db`.
- Codex reste désactivé : aucun runner, refus serveur de tout choix `codex`.
- Jamais de repli vers un autre fournisseur ou modèle.
- Les 11 fiches `.claude/agents/` ne sont pas modifiées. Aucune écriture Shopify. Aucun secret dans Git.
- Aucune fusion dans `main`, aucun push sans demande du propriétaire.
- Textes visibles en français, style du code existant.
- Les blocs « remplacer » citent le code après le lot 1. Les lire dans le fichier avant d'éditer.

## Fichiers

| Fichier | Rôle dans ce lot |
| --- | --- |
| `src/engines.js` | Catalogue, validation, résolution |
| `src/studio-engines.js` (créé) | Choix par agent et mission, résolution, disponibilité |
| `src/studio.js` | Branchement du magasin |
| `src/studio-comm.js` | Migration 6, moteur figé, empreinte, attente motivée, changement manuel |
| `src/comm-core.js` | Empreinte par moteur |
| `src/comm-run.js`, `src/app.js` | Moteur résolu, routes |
| `src/cloud-server.js` | Disponibilité des workers par modèle |
| `public/engine-view.js` (créé) et écrans | Sélecteurs et libellés |
| `test/engine-choice.test.js` (créé) | Tests du lot |

---

### Task 1: Catalogue et résolution

**Files:**
- Modify: `src/engines.js`
- Create: `test/engine-choice.test.js`

**Interfaces:**
- Produces: `CATALOG`, `engineId(e)`, `catalogReason(e) → string`, `parseEngine(input) → {provider, model}|null` (lève une erreur `status` 400), `resolveEngine({mission, agent, fiche}) → {provider, model, source}|null`.

- [ ] **Step 1: Créer la branche** — `git switch -c feat/engine-choice` (depuis la branche du lot 1).

- [ ] **Step 2: Écrire les tests** — `test/engine-choice.test.js` :

```js
// Lot 2 : choix du moteur par agent ou mission, moteur figé, aucun repli. Runners simulés, bases temporaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogReason, parseEngine, resolveEngine } from '../src/engines.js';

const claude = (model) => ({ provider: 'claude', model });

test('catalogue fermé : Codex désactivé, modèle ou fournisseur inconnu refusé', () => {
  assert.equal(catalogReason(claude('haiku')), '');
  assert.match(catalogReason({ provider: 'codex', model: 'x' }), /Codex.*Désactivé/);
  assert.match(catalogReason(claude('autre')), /Modèle inconnu/);
  assert.match(catalogReason({ provider: 'ailleurs', model: 'x' }), /Fournisseur inconnu/);
  assert.equal(parseEngine(null), null);
  assert.deepEqual(parseEngine({ provider: 'claude', model: 'opus', command: 'x' }), claude('opus'));
  for (const bad of [undefined, 'opus', {}, { provider: 'codex', model: 'x' }, claude('autre')]) assert.throws(() => parseEngine(bad), { status: 400 });
});

test('priorité : mission, puis agent, puis fiche', () => {
  const all = { mission: claude('haiku'), agent: claude('opus'), fiche: claude('sonnet') };
  assert.deepEqual(resolveEngine(all), { ...claude('haiku'), source: 'mission' });
  assert.deepEqual(resolveEngine({ ...all, mission: null }), { ...claude('opus'), source: 'agent' });
  assert.deepEqual(resolveEngine({ fiche: claude('sonnet') }), { ...claude('sonnet'), source: 'fiche' });
  assert.equal(resolveEngine({}), null);
});
```

- [ ] **Step 3: Vérifier l'échec** — Run: `node --test --test-timeout=30000 test/engine-choice.test.js`.

- [ ] **Step 4: Ajouter à `src/engines.js`**

```js
export const CATALOG = Object.freeze([
  { provider: 'claude', label: 'Claude', models: FAMILIES, state: 'available', reason: '' },
  { provider: 'codex', label: 'Codex', models: [], state: 'disabled', reason: 'Désactivé : isolation non démontrée, autorisation requise, aucun runner.' },
  { provider: 'gemini', label: 'Gemini', models: [], state: 'not_configured', reason: 'Non configuré.' }
]);
export const engineId = (e) => (e ? `${e.provider}:${e.model}` : 'inconnu');
// Pourquoi le catalogue refuse ce moteur ; chaîne vide s'il est permis.
export function catalogReason(e) {
  if (!e) return '';
  const p = CATALOG.find((x) => x.provider === e.provider);
  if (!p) return `Fournisseur inconnu « ${e.provider} » : la demande attend.`;
  if (p.state !== 'available') return `${p.label} — ${p.reason}`;
  return p.models.includes(e.model) ? '' : `Modèle inconnu « ${e.model} » pour ${p.label} : la demande attend.`;
}
const refuse = (message) => Object.assign(new Error(message), { status: 400 });
// Choix saisi par le propriétaire : null efface le choix ; tout le reste doit être au catalogue.
export function parseEngine(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || !isProviderId(input.provider) || !isModelId(input.model)) throw refuse('Moteur invalide.');
  const why = catalogReason(input); if (why) throw refuse(`Moteur refusé. ${why}`);
  return { provider: input.provider, model: input.model };
}
export function resolveEngine({ mission = null, agent = null, fiche = null } = {}) {
  for (const [source, e] of [['mission', mission], ['agent', agent], ['fiche', fiche]]) if (e) return { provider: e.provider, model: e.model, source };
  return null;
}
```

- [ ] **Step 5: Vérifier le succès**, puis commit :

```bash
git add src/engines.js test/engine-choice.test.js
git commit -m "feat: add the closed engine catalogue and resolution order"
```

---

### Task 2: Magasin des choix et migration 6

**Files:**
- Create: `src/studio-engines.js`
- Modify: `src/studio.js`, `src/studio-comm.js` (migration seule), `test/engine-choice.test.js`

**Interfaces:**
- Produces `studio.engines` : `learn(profiles)`, `choice(scope, ref)`, `rootMissionOf(missionId)`, `resolve(agentId, missionId = null, missionOverride)`, `ofTask(task)`, `keySuffix(engine, agentId)`, `setAgentChoice(agentId, input)`, `setMissionChoice(missionId, input)`, `adoptMissionChoice(missionId, engine)`, `missionEngine(missionId)`, `missionChoices()`, `reason(engine)`, `catalog(reasonOf)`.

- [ ] **Step 1: Ajouter les tests** (compléter les imports) :

```js
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}, file = ':memory:') {
  const studio = createStudio(file, options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, engines: studio.engines, ids };
}

test('magasin : mission, agent, fiche ; refus côté serveur', () => {
  const { studio, engines, ids } = setup();
  assert.deepEqual(engines.resolve(ids.lucas), { ...claude('sonnet'), source: 'fiche' });
  engines.setAgentChoice(ids.lucas, claude('opus'));
  assert.deepEqual(engines.resolve(ids.lucas), { ...claude('opus'), source: 'agent' });
  const m = studio.createMission({ title: 'Mission', assignedTo: ids.lucas });
  engines.setMissionChoice(m.id, claude('haiku'));
  assert.deepEqual(engines.resolve(ids.lucas, m.id), { ...claude('haiku'), source: 'mission' });
  engines.setMissionChoice(m.id, null);
  assert.equal(engines.resolve(ids.lucas, m.id).source, 'agent');
  assert.throws(() => engines.setAgentChoice(ids.lucas, { provider: 'codex', model: 'x' }), /Codex/);
  assert.throws(() => engines.setMissionChoice('absente', claude('opus')), { status: 404 });
  const hired = studio.hireAgent({ name: 'Sans fiche', role: 'Test', departmentId: studio.listDepartments()[0].id });
  assert.throws(() => engines.setAgentChoice(hired.id, claude('opus')), { status: 409 });
});
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: Migration** — dans `src/studio-comm.js`, après la version 5 :

```js
, {
  version: 6,
  name: 'choix du moteur par agent, mission et tâche',
  up: `CREATE TABLE IF NOT EXISTS engine_choices (scope TEXT NOT NULL, ref TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope, ref));
    ALTER TABLE comm_tasks ADD COLUMN provider TEXT; ALTER TABLE comm_tasks ADD COLUMN model TEXT; ALTER TABLE comm_tasks ADD COLUMN engine_source TEXT;`,
  down: `ALTER TABLE comm_tasks DROP COLUMN engine_source; ALTER TABLE comm_tasks DROP COLUMN model; ALTER TABLE comm_tasks DROP COLUMN provider; DROP TABLE IF EXISTS engine_choices;`
}
```

- [ ] **Step 4: Créer `src/studio-engines.js`**

```js
// src/studio-engines.js — choix du moteur par agent ou mission, résolution et disponibilité.
// Les tables sont créées par les migrations de la communication. Les choix restent sur cet ordinateur.
import { CATALOG, DEFAULT_PROVIDER, catalogReason, engineId, parseEngine, resolveEngine } from './engines.js';

const refuse = (message, status) => Object.assign(new Error(message), { status });

export function createEngineStore(db, { clock = () => new Date().toISOString(), emit = () => null } = {}) {
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const fiches = new Map(); // slug → modèle de la fiche, appris à chaque synchronisation des fiches
  const learn = (profiles) => { for (const p of profiles) fiches.set(p.slug, p.model); };
  const slugOf = (agentId) => get('SELECT slug FROM agent_files WHERE agent_id = ?', agentId ?? '')?.slug ?? null;
  const fiche = (agentId) => { const model = fiches.get(slugOf(agentId)); return model ? { provider: DEFAULT_PROVIDER, model } : null; };
  // Le choix d'une mission est rattaché à la mission racine : les sous-missions d'une délégation le partagent.
  const rootMissionOf = (missionId) => (missionId ? get('SELECT r.mission_id AS m FROM comm_tasks t JOIN comm_tasks r ON r.id = t.root_task_id WHERE t.mission_id = ? ORDER BY t.depth, t.created_at LIMIT 1', missionId)?.m ?? missionId : null);
  const choice = (scope, ref) => { const r = ref ? get('SELECT provider, model FROM engine_choices WHERE scope = ? AND ref = ?', scope, ref) : null; return r ? { provider: r.provider, model: r.model } : null; };
  const put = (scope, ref, engine) => {
    if (!engine) run('DELETE FROM engine_choices WHERE scope = ? AND ref = ?', scope, ref);
    else run('INSERT INTO engine_choices (scope, ref, provider, model, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, ref) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at', scope, ref, engine.provider, engine.model, clock());
    return choice(scope, ref);
  };
  const resolve = (agentId, missionId = null, missionOverride) => resolveEngine({
    mission: missionOverride !== undefined ? missionOverride : choice('mission', rootMissionOf(missionId)),
    agent: choice('agent', agentId), fiche: fiche(agentId)
  });
  // Moteur figé sur la tâche ; une tâche antérieure à la migration garde le modèle de la fiche.
  const ofTask = (task) => {
    if (task.provider) return { provider: task.provider, model: task.model, source: task.engineSource ?? 'task' };
    const own = fiche(task.assigneeId); return own ? { ...own, source: 'fiche' } : null;
  };
  // Part du moteur dans l'empreinte d'une demande : vide pour le modèle de la fiche, les empreintes existantes restent valables.
  const keySuffix = (engine, agentId) => (engine && engineId(engine) !== engineId(fiche(agentId)) ? engineId(engine) : '');
  const setAgentChoice = (agentId, input) => {
    if (!slugOf(agentId)) throw refuse('Cet agent n’a pas de fiche : aucun moteur à choisir.', 409);
    const saved = put('agent', agentId, parseEngine(input));
    emit(agentId, 'agent.engine.updated', saved ? `Moteur choisi : ${engineId(saved)}.` : 'Moteur de la fiche rétabli.', 'manual', true);
    return saved;
  };
  const missionEngine = (missionId) => { const root = rootMissionOf(missionId); return { missionId, rootMissionId: root, choice: choice('mission', root) }; };
  const setMissionChoice = (missionId, input) => {
    if (!get('SELECT 1 AS ok FROM missions WHERE id = ?', missionId)) throw refuse('Mission introuvable.', 404);
    put('mission', rootMissionOf(missionId), parseEngine(input));
    return missionEngine(missionId);
  };
  // Choix de mission reçu par le journal : il ne remplace jamais un choix fait ici.
  const adoptMissionChoice = (missionId, engine) => { if (engine && !catalogReason(engine) && !choice('mission', missionId)) put('mission', missionId, engine); };
  const reason = (engine) => catalogReason(engine);
  const catalog = (reasonOf = reason) => CATALOG.map((p) => ({ provider: p.provider, label: p.label, state: p.state, reason: p.reason, models: p.models.map((model) => ({ model, reason: reasonOf({ provider: p.provider, model }) })) }));
  return {
    learn, choice, rootMissionOf, resolve, ofTask, keySuffix, setAgentChoice, setMissionChoice, adoptMissionChoice, missionEngine, reason, catalog,
    missionChoices: () => all("SELECT ref, provider, model FROM engine_choices WHERE scope = 'mission'").map((r) => ({ missionId: r.ref, provider: r.provider, model: r.model }))
  };
}
```

- [ ] **Step 5: Brancher dans `src/studio.js`**

Import :

```js
import { createEngineStore } from './studio-engines.js';
```

Première ligne de `syncAgentFiles(profiles) {` :

```js
      api.engines.learn(profiles);
```

Avant `api.comm = createCommStore(…)`, ajouter `api.engines = createEngineStore(db, { clock: options.clock, emit });`, puis ajouter `engines: api.engines, ` aux options de `createCommStore`.

Dans `createAutomationStore(…)`, remplacer `aiAvailable: options.aiAvailable,` par :

```js
aiAvailable: options.aiAvailable ?? ((slug) => !api.engines.reason(api.engines.resolve(api.comm.agentOfSlug(slug)))),
```

- [ ] **Step 6: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-choice.test.js test/comm-store.test.js test/studio.test.js` ; Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/studio-engines.js src/studio.js src/studio-comm.js test/engine-choice.test.js
git commit -m "feat: store engine choices per agent and mission"
```

---

### Task 3: Moteur figé sur les tâches

**Files:**
- Modify: `src/comm-core.js` (`fingerprint`), `src/studio-comm.js`, `test/engine-choice.test.js`

**Interfaces:**
- Consumes: `studio.engines` (Task 2), `parseEngine`, `engineId`, `isProviderId`, `isModelId`.
- Produces: `createCommStore(db, {engines})` ; tâches avec `provider`, `model`, `engineSource` ; `createTask({... , engine})` (propriétaire seul) ; `claimNext({busy, blocked})` ; `setTaskEngine(id, input)`.

- [ ] **Step 1: Ajouter les tests** (imports : `mkdtempSync, rmSync, readFileSync, writeFileSync` de `node:fs`, `tmpdir`, `join`, `parseAgentOutput`) :

```js
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentOutput } from '../src/comm-core.js';

const asAgent = (comm, agentId, taskId) => ({ type: 'agent', agentId, runId: comm.startRun({ agentId, kind: 'task', taskId }).id });

test('moteur figé à la création : changer le choix ensuite ne touche pas la tâche', () => {
  const { comm, engines, ids } = setup();
  engines.setAgentChoice(ids.lucas, claude('opus'));
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  engines.setAgentChoice(ids.lucas, claude('haiku'));
  assert.deepEqual([comm.task(t.id).model, comm.task(t.id).engineSource], ['opus', 'agent']);
});

test('mission : les sous-tâches héritent ; un agent ne choisit jamais', () => {
  const { comm, ids } = setup();
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Coordonner', engine: claude('haiku') }).task;
  assert.equal(root.engineSource, 'mission');
  const child = comm.createTask({ assigneeId: ids.noah, instruction: 'Veille', parentTaskId: root.id, engine: claude('opus') }, asAgent(comm, ids.alexander, root.id)).task;
  assert.deepEqual([child.model, child.engineSource], ['haiku', 'mission']);
  const free = comm.createTask({ assigneeId: ids.alexander, instruction: 'Autre demande' }).task;
  const other = comm.createTask({ assigneeId: ids.noah, instruction: 'Autre veille', parentTaskId: free.id, engine: claude('opus') }, asAgent(comm, ids.alexander, free.id)).task;
  assert.deepEqual([other.model, other.engineSource], ['sonnet', 'fiche']);
  const parsed = parseAgentOutput(JSON.stringify({ report: 'ok', delegate: [{ to: 'Noah', task: 'x', engine: claude('opus') }] }));
  assert.equal('engine' in parsed.delegate[0], false);
});

test('doublons : deux moteurs font deux demandes', () => {
  const { comm, ids } = setup();
  const ask = (extra) => comm.createTask({ assigneeId: ids.lucas, instruction: 'Même demande', ...extra });
  assert.equal(ask({}).created, true);
  assert.equal(ask({ engine: claude('opus') }).created, true);
  assert.equal(ask({ engine: claude('opus') }).reused, 'open');
  assert.equal(ask({ engine: claude('sonnet') }).reused, 'open', 'le modèle de la fiche garde l’empreinte d’origine');
});

test('automatisation : un résultat d’un autre moteur n’est pas réutilisé', () => {
  const { comm, engines, ids } = setup();
  comm.setAutomationGate(() => true);
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Contrôle', cacheKey: 'k' }, { type: 'automation', runId: 'r1' }).task;
  const run = comm.startRun({ agentId: ids.lucas, kind: 'task', taskId: t.id }); comm.endRun(run.id, { state: 'done' });
  comm.setTaskState(t.id, 'running');
  comm.recordResult(t.id, { agentId: ids.lucas, runId: run.id, body: 'ok', verified: true, level: 'run', verification: 'simulé' });
  comm.setTaskState(t.id, 'done');
  assert.ok(comm.reusableAutomation('lucas', 'k', 3_600_000));
  engines.setAgentChoice(ids.lucas, claude('opus'));
  assert.equal(comm.reusableAutomation('lucas', 'k', 3_600_000), null);
  assert.throws(() => comm.setTaskEngine(t.id, claude('haiku')), /automatisation/);
});

test('moteur indisponible : la tâche attend avec le motif, sans essai consommé', () => {
  const { comm, ids } = setup();
  const t = comm.createTask({ assigneeId: ids.ryan, instruction: 'Code' }).task;
  assert.equal(comm.claimNext({ blocked: () => 'Opus indisponible' }).task, null);
  const waiting = comm.task(t.id);
  assert.deepEqual([waiting.state, waiting.attempts, waiting.stateNote], ['queued', 0, 'Opus indisponible']);
  assert.equal(comm.claimNext({ blocked: () => '' }).task.id, t.id);
});

test('changement manuel : seulement sur une tâche non partie, tracé dans le fil', () => {
  const { comm, ids } = setup();
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit' }).task;
  const changed = comm.setTaskEngine(t.id, claude('opus'));
  assert.deepEqual([changed.model, changed.engineSource], ['opus', 'task']);
  assert.ok(comm.listMessages(t.threadId, null, 100).items.some((m) => /Moteur changé/.test(m.body)));
  assert.equal(comm.setTaskEngine(t.id, null).engineSource, 'fiche');
  comm.setTaskState(t.id, 'running');
  assert.throws(() => comm.setTaskEngine(t.id, claude('opus')), /ne se change que/);
});

test('journal : le moteur voyage ; absent il est conservé, inconnu il est gardé tel quel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot2-'));
  try {
    const a = setup({ commJournalDir: dir, device: 'pc-a' }), b = setup({ commJournalDir: dir, device: 'pc-b' });
    const t = a.comm.createTask({ assigneeId: a.ids.lucas, instruction: 'Audit', engine: claude('opus') }).task;
    b.comm.importJournal();
    assert.deepEqual([b.comm.task(t.id).model, b.comm.task(t.id).engineSource], ['opus', 'mission']);
    assert.equal(b.engines.resolve(b.ids.lucas, t.missionId).model, 'opus');
    const last = readFileSync(join(dir, 'pc-a.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'task').at(-1);
    const send = (n, data) => { writeFileSync(join(dir, `pc-z${n}.jsonl`), `${JSON.stringify({ ...last, eid: `z-${n}`, device: 'pc-z', at: new Date(Date.now() + n * 1000).toISOString(), rev: 90 + n, data })}\n`); b.comm.importJournal(); };
    const old = { ...last.data }; delete old.provider; delete old.model; delete old.engineSource;
    send(1, old);
    assert.equal(b.comm.task(t.id).model, 'opus');
    send(2, { ...last.data, provider: 'codex', model: 'x' });
    assert.equal(b.comm.task(t.id).provider, 'codex');
    assert.match(b.engines.reason(b.engines.ofTask(b.comm.task(t.id))), /Codex/);
    a.studio.close(); b.studio.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: `src/comm-core.js`** — remplacer la définition de `fingerprint` par :

```js
export const fingerprint = (assigneeRef, instruction, web = false, catalog = false, integrations = [], engine = '') => createHash('sha1').update(`${assigneeRef}\n${web ? 'web' : 'noweb'}\n${catalog ? 'cat' : 'nocat'}${integrations.length ? `\nint:${[...integrations].sort().join(',')}` : ''}${engine ? `\nengine:${engine}` : ''}\n${flat(instruction)}`).digest('hex').slice(0, 16);
```

- [ ] **Step 4: `src/studio-comm.js`**

Compléter l'import de `./engines.js` avec `engineId, parseEngine`. Ajouter `engines = null, ` aux options de `createCommStore`.

Dans `mapTask` et dans `portable.task`, insérer après `withIntegrations: parseJsonList(t.with_integrations), ` :

```js
provider: t.provider ?? null, model: t.model ?? null, engineSource: t.engine_source ?? null, 
```

Avant `createTaskRaw`, ajouter :

```js
  const automationKeyOf = (slug, cacheKey, suffix) => `automation:${slug}:${cacheKey}${suffix ? `:${suffix}` : ''}`;
```

Dans `createTaskRaw`, remplacer la ligne `const key = automated ? … : fingerprint(…);` par :

```js
    // Moteur résolu maintenant et figé sur la tâche. Seul le propriétaire en choisit un, sur une demande racine.
    const explicit = by.type === 'user' && !parent && input.engine !== undefined ? parseEngine(input.engine) : undefined;
    const engine = engines?.resolve(assignee.id, parent ? parent.missionId : input.missionId ?? null, explicit) ?? null;
    const suffix = engines?.keySuffix(engine, assignee.id) ?? '';
    const key = automated ? automationKeyOf(assignee.slug, input.cacheKey, suffix) : fingerprint(assignee.slug, instruction, allowWeb, withCatalog, withIntegrations, suffix);
```

Dans la même fonction, à l'intérieur du bloc `tx(() => { … })`, après la ligne `run('UPDATE comm_tasks SET with_catalog = ?, …')` :

```js
      run('UPDATE comm_tasks SET provider = ?, model = ?, engine_source = ? WHERE id = ?', engine?.provider ?? null, engine?.model ?? null, engine?.source ?? null, id);
      if (explicit !== undefined && (explicit || input.missionId)) engines?.setMissionChoice(missionId, explicit);
```

Après `adoptTask`, ajouter :

```js
  const ENGINE_EDITABLE = ['pending_approval', 'queued', 'blocked', 'failed', 'expired', 'review'];
  // Seul le propriétaire change le moteur d'une tâche, explicitement. null revient au choix par défaut (mission, agent, fiche).
  const setTaskEngine = (id, input) => {
    const t = task(id);
    if (!engines) throw bad('Choix du moteur indisponible.', 409);
    if (t.automationKey) throw bad('Le moteur d’une tâche issue d’une automatisation ne se change pas à la main.', 409);
    if (!ENGINE_EDITABLE.includes(t.state)) throw bad('Le moteur ne se change que sur une tâche à valider, en file, bloquée, en échec, expirée ou à vérifier.', 409);
    const chosen = parseEngine(input);
    const next = chosen ? { ...chosen, source: 'task' } : engines.resolve(t.assigneeId, t.missionId);
    const before = engines.ofTask(t);
    const key = fingerprint(slugOf(t.assigneeId), t.instruction, t.allowWeb, t.withCatalog, t.withIntegrations, engines.keySuffix(next, t.assigneeId));
    run('UPDATE comm_tasks SET provider = ?, model = ?, engine_source = ?, dedupe_key = ?, state_note = ?, updated_at = ? WHERE id = ?', next?.provider ?? null, next?.model ?? null, next?.source ?? null, key, t.state === 'queued' ? '' : t.stateNote, now(), id);
    journal('task', id);
    postMessage(t.threadId, { kind: 'system', body: `Moteur changé par le propriétaire : ${engineId(before)} → ${engineId(next)}.`, taskId: id }, { type: 'system' });
    return task(id);
  };
```

Avant `claimNextRaw`, ajouter :

```js
  // Une tâche qui attend son moteur reste en file : seul le motif change, aucun essai n'est consommé.
  const noteWaiting = (t, why) => {
    const note = short(why, 500); if (t.stateNote === note) return;
    run('UPDATE comm_tasks SET state_note = ?, updated_at = ? WHERE id = ?', note, now(), t.id);
    journal('task', t.id);
  };
```

Signature : `const claimNextRaw = ({ busy = new Set(), blocked = () => '' } = {}) => {`. Après `if (busy.has(t.assigneeId)) continue;` :

```js
      const why = blocked(t);
      if (why) { noteWaiting(t, why); continue; }
```

Dans `APPLY.task(d)`, après la ligne `if (Object.hasOwn(d, 'budgetUsd')) …` :

```js
      // Champs de la migration 6. Un moteur inconnu ici est conservé : la tâche attendra, rien n'est substitué.
      if (Object.hasOwn(d, 'provider')) {
        const none = d.provider == null && d.model == null;
        if (!none && (!isProviderId(d.provider) || !isModelId(d.model))) throw new Error('moteur invalide');
        const source = ['mission', 'agent', 'fiche', 'task'].includes(d.engineSource) ? d.engineSource : null;
        run('UPDATE comm_tasks SET provider = ?, model = ?, engine_source = ? WHERE id = ?', d.provider ?? null, d.model ?? null, source, d.id);
        if (!none && source === 'mission' && !d.parentTaskId) engines?.adoptMissionChoice(d.missionId, { provider: d.provider, model: d.model });
      }
```

Dans l'objet rendu : remplacer le corps de `reusableAutomation` par :

```js
    reusableAutomation: (slug, cacheKey, freshnessMs) => {
      const agentId = agentOfSlug(slug), suffix = engines?.keySuffix(engines.resolve(agentId), agentId) ?? '';
      const row = get("SELECT t.* FROM comm_tasks t JOIN comm_results r ON r.task_id=t.id WHERE t.dedupe_key=? AND t.state='done' AND r.verified=1 AND t.finished_at>=? ORDER BY t.finished_at DESC LIMIT 1", automationKeyOf(slug, cacheKey, suffix), new Date(Date.parse(now()) - Math.min(LIMITS.reuseMs, freshnessMs)).toISOString());
      return row ? mapTask(row) : null;
    },
```

et ajouter `setTaskEngine, ` à la liste exportée, à côté de `adoptTask`.

- [ ] **Step 5: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-choice.test.js test/comm-store.test.js test/comm-run.test.js test/comm-review.test.js test/shop-integration.test.js test/shop-review.test.js test/automation-run.test.js test/automation-recovery.test.js` ; Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/comm-core.js src/studio-comm.js test/engine-choice.test.js
git commit -m "feat: freeze the engine on each task"
```

---

### Task 4: Lanceur, appels immédiats et routes

**Files:**
- Modify: `src/comm-run.js`, `src/app.js`, `test/engine-choice.test.js`

**Interfaces:**
- Produces: `createOrchestrator({engineReason})` et `createApp({engineReason})` (remplacent `agentReady`) ; routes `GET /api/engines`, `PUT /api/agents/:id/engine`, `GET|PUT /api/missions/:id/engine`, `POST /api/comm/tasks/:id/engine`.

- [ ] **Step 1: Ajouter les tests** :

```js
import { createOrchestrator } from '../src/comm-run.js';
import { createApp } from '../src/app.js';

test('lanceur : le moteur figé est celui appelé ; indisponible, rien ne part', async () => {
  const { studio, comm, ids } = setup(); const models = []; let down = true;
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner: async (o) => { models.push(o.model); return JSON.stringify({ report: 'ok' }); }, engineReason: (e) => (down && e?.model === 'opus' ? 'Opus indisponible' : '') });
  const opus = comm.createTask({ assigneeId: ids.ryan, instruction: 'Code' }).task;
  const haiku = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit', engine: claude('haiku') }).task;
  orch.pump(); await orch.idle();
  assert.deepEqual(models, ['haiku']);
  assert.equal(comm.task(opus.id).state, 'queued'); assert.equal(comm.task(opus.id).attempts, 0);
  assert.equal(comm.runsOfTask(haiku.id)[0].model, 'haiku');
  down = false; orch.pump(); await orch.idle();
  assert.deepEqual(models, ['haiku', 'opus']);
});

async function withApp(options, fn) {
  const { studio, comm, engines, ids } = setup(); const models = [];
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async (o) => { models.push(o.model); return 'ok'; }, agentFiles: { profiles }, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, data, headers = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text.trim().split('\n').at(-1)) : null }; };
  try { await fn({ studio, comm, engines, ids, models, call, orch: server.orchestrator }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); studio.close(); }
}

test('API : choisir, refuser, appliquer à la discussion, à la mission et à la tâche', () => withApp({}, async ({ studio, ids, models, call, orch }) => {
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, { engine: claude('opus') })).status, 200);
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, { engine: { provider: 'codex', model: 'x' } })).status, 400);
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, {})).status, 400);
  assert.equal((await call('PUT', `/api/agents/${ids.lucas}/engine`, { engine: null }, { origin: 'https://evil.invalid' })).status, 403);
  await call('POST', `/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
  await call('POST', `/api/agents/${ids.lucas}/reply`, {});
  assert.equal(models.at(-1), 'opus');
  const m = studio.createMission({ title: 'Mission', assignedTo: ids.lucas });
  assert.equal((await call('PUT', `/api/missions/${m.id}/engine`, { engine: claude('haiku') })).body.choice.model, 'haiku');
  await call('POST', `/api/missions/${m.id}/discussion`, { body: 'Un point ?' });
  await call('POST', `/api/missions/${m.id}/discussion/reply/${ids.lucas}`, {});
  assert.equal(models.at(-1), 'haiku');
  const made = await call('POST', '/api/comm/delegations', { assigneeId: ids.noah, instruction: 'Veille', engine: claude('opus'), requiresApproval: false });
  assert.equal(made.body.task.model, 'opus');
  await orch.idle();
  const view = (await call('GET', '/api/engines')).body;
  assert.equal(view.catalog.find((p) => p.provider === 'codex').state, 'disabled');
  assert.equal(view.agents.find((a) => a.slug === 'lucas').effective.source, 'agent');
}));

test('API : un appel immédiat sur un moteur indisponible est refusé clairement', () => withApp({ engineReason: () => 'Moteur indisponible.' }, async ({ ids, models, call }) => {
  await call('POST', `/api/agents/${ids.lucas}/conversation`, { body: 'Bonjour' });
  const r = await call('POST', `/api/agents/${ids.lucas}/reply`, {});
  assert.equal(r.status, 409); assert.equal(r.body.error, 'Moteur indisponible.'); assert.equal(models.length, 0);
  const made = await call('POST', '/api/comm/delegations', { assigneeId: ids.lucas, instruction: 'Audit' });
  assert.equal((await call('POST', `/api/comm/tasks/${made.body.task.id}/engine`, {})).status, 400);
  assert.equal((await call('POST', `/api/comm/tasks/${made.body.task.id}/engine`, { engine: claude('haiku') })).body.model, 'haiku');
}));
```

- [ ] **Step 2: Vérifier l'échec**.

- [ ] **Step 3: `src/comm-run.js`**

Dans la signature de `createOrchestrator`, remplacer `agentReady = () => true` par `engineReason = (engine) => studio.engines?.reason(engine) ?? ''`.

Après `const profileOf = …` :

```js
  const ficheEngine = (agentId) => { const p = profileOf(agentId); return p ? { provider: 'claude', model: p.model, source: 'fiche' } : null; };
  const taskEngine = (task) => studio.engines?.ofTask(task) ?? ficheEngine(task.assigneeId);
  const agentEngine = (agentId, missionId) => studio.engines?.resolve(agentId, missionId) ?? ficheEngine(agentId);
```

Dans `execute` : après la garde `if (!profile)`, ajouter `const engine = taskEngine(task);` ; dans `comm.startRun`, remplacer `model: profile.model` par `model: engine.model, provider: engine.provider` ; dans l'appel `runner`, `model: engine.model`.

Dans `pump`, remplacer les deux lignes (commentaire, `const busy = …`, `const c = comm.claimNext({ busy });`) par :

```js
        // Un moteur indisponible laisse la tâche en file avec son motif, sans essai consommé ni repli.
        const c = comm.claimNext({ busy: busyAgents(), blocked: (t) => engineReason(taskEngine(t)) });
```

Dans `replyInThread`, avant `const run = comm.startRun(…)` :

```js
    const engine = agentEngine(agentId, t.missionId), unavailable = engineReason(engine);
    if (unavailable) throw bad(unavailable, 409);
```

puis `model: engine.model, provider: engine.provider` dans `startRun`, `model: engine.model` dans `runner`, et `checkModel(engine.model, seen.state.models)`.

- [ ] **Step 4: `src/app.js`**

Signature de `createApp` : remplacer `agentReady = () => true` par `engineReason = (engine) => studio.engines?.reason(engine) ?? ''`, et dans `createOrchestrator({ … })` remplacer `agentReady` par `engineReason`.

Remplacer `openRun` et le début de `stream` :

```js
  function openRun(agentId, kind, engine) {
    try { return comm?.startRun({ agentId, kind, model: engine.model, provider: engine.provider }) ?? null; } catch { return null; }
  }
```

```js
  async function stream(res, lock, busy, profile, agentId, kind, missionId, prompt, save) {
    if (replying.has(lock)) fail(409, busy);
    const engine = studio.engines?.resolve(agentId, missionId) ?? { provider: 'claude', model: profile.model };
    const unavailable = engineReason(engine); if (unavailable) fail(409, unavailable);
    replying.add(lock);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const line = (data) => { if (!res.writableEnded) res.write(JSON.stringify(data) + '\n'); };
    const seen = observeTools(), run = openRun(agentId, kind, engine);
    try {
      const text = await runClaude({ model: engine.model, system: systemPrompt(profile, studio.getInstructions(agentId)), prompt, onText: (t) => line({ type: 'text', text: t }), onEvent: seen.feed });
      closeRun(run, seen.state);
      const check = checkModel(engine.model, seen.state.models);
      line({ type: 'done', message: save(text), ...(check.status === 'mismatch' ? { warning: mismatchText(check) } : {}) });
    } catch (error) { closeRun(run, seen.state, error); line({ type: 'error', error: error.message }); }
    finally { replying.delete(lock); res.end(); }
  }
```

Dans les quatre appels, ajouter l'argument de mission juste après le type : `'chat', null,` ; `'plan', missionId,` ; `'team', missionId,` ; `'memory', missionId,`.

Dans `delegationInput`, ajouter `'engine'` à la liste. Remplacer la route des actions de tâche : motif `(approve|cancel|retry|verify|adopt|budget|engine)`, et au début de son corps :

```js
        if (action === 'engine' && !(d && 'engine' in d)) fail(400, 'Moteur requis (null pour revenir au choix par défaut).');
```

en ajoutant avant la branche finale `comm.verifyTask` la branche `action === 'engine' ? comm.setTaskEngine(tid, d.engine) : `.

Dans la route `GET /api/automations`, remplacer `({ ...d, availability: readAutomationSources(studio, d).missing })` par :

```js
({ ...d, availability: readAutomationSources(studio, d).missing, engine: studio.engines?.resolve(studio.comm?.agentOfSlug(d.agentSlug)) ?? null })
```

Après le bloc `if (comm) { … }` (avant celui des intégrations), ajouter :

```js
  // Moteur IA : choix du propriétaire seulement. Un agent n'a aucune route ni aucun champ pour en changer.
  if (studio.engines) {
    const engines = studio.engines;
    const describe = () => {
      const { ids, list } = linked();
      return {
        catalog: engines.catalog(engineReason),
        agents: list.map((p) => { const agentId = ids.get(p.slug), effective = engines.resolve(agentId); return { agentId, slug: p.slug, name: p.displayName, fiche: { provider: 'claude', model: p.model }, choice: engines.choice('agent', agentId), effective, unavailable: engineReason(effective) }; }),
        missions: engines.missionChoices()
      };
    };
    const required = (d) => { if (!(d && 'engine' in d)) fail(400, 'Moteur requis (null pour revenir au choix par défaut).'); return d.engine; };
    routes['GET /api/engines'] = describe;
    paramRoutes.push(
      ['PUT', /^\/api\/agents\/([^/]+)\/engine$/, (m, d) => { engines.setAgentChoice(decodeURIComponent(m[1]), required(d)); orch?.pump(); return describe(); }],
      ['GET', /^\/api\/missions\/([^/]+)\/engine$/, (m) => engines.missionEngine(decodeURIComponent(m[1]))],
      ['PUT', /^\/api\/missions\/([^/]+)\/engine$/, (m, d) => engines.setMissionChoice(decodeURIComponent(m[1]), required(d))]
    );
  }
```

- [ ] **Step 5: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-choice.test.js test/engine-accounting.test.js test/comm-run.test.js test/comm-api.test.js test/automation-api.test.js test/local-boundary.test.js` ; Expected: PASS.

Pas de commit ici : le serveur central passe encore `agentReady`, désormais ignoré. La Task 5 le corrige et les deux sont commitées ensemble.

---

### Task 5: Serveur central

**Files:**
- Modify: `src/cloud-server.js`, `test/engine-choice.test.js`

- [ ] **Step 1: Ajouter le test** (imports `createCloudRuntime`, `hashPassword`, `runWorkerOnce`) :

```js
import { createCloudRuntime } from '../src/cloud-server.js';
import { hashPassword } from '../src/cloud-auth.js';
import { runWorkerOnce } from '../src/worker-client.js';

test('central : sans worker pour le modèle choisi la tâche attend ; un worker adapté la prend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-lot2-c-'));
  const runtime = await createCloudRuntime({ dataDir: dir, passwordHash: await hashPassword('test-only-password-long'), port: 0, env: {} });
  try {
    const { comm, engines } = runtime.studio;
    const lucas = runtime.studio.listAgentFiles().find((f) => f.slug === 'lucas').agentId;
    runtime.broker.heartbeat(runtime.broker.enroll({ name: 'sonnet', models: ['sonnet'] }).id);
    engines.setAgentChoice(lucas, claude('haiku'));
    const t = comm.createTask({ assigneeId: lucas, instruction: 'Résumer' }).task;
    runtime.app.orchestrator.pump();
    assert.equal(comm.task(t.id).state, 'queued'); assert.match(comm.task(t.id).stateNote, /haiku/);
    const h = runtime.broker.enroll({ name: 'haiku', models: ['haiku'] }); runtime.broker.heartbeat(h.id);
    runtime.app.orchestrator.pump();
    await runWorkerOnce({ baseUrl: runtime.origin, token: h.token, models: ['haiku'], runner: async (o) => { assert.equal(o.model, 'haiku'); return JSON.stringify({ report: 'ok' }); } });
    await runtime.app.orchestrator.idle();
    assert.equal(comm.task(t.id).state, 'done');
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Vérifier l'échec** (Expected: FAIL ; le courtier central refuse encore `haiku`).

- [ ] **Step 3: `src/cloud-server.js`**

Import `import { FAMILIES } from './engines.js';`. Remplacer `const models = …` par :

```js
  const models = [...new Set([...loaded.profiles.map(p => p.model), ...FAMILIES])];
```

Après `const liveWorkers = …` :

```js
  // Motif d'attente d'un moteur : refus du catalogue, ou aucun worker connecté qui l'offre. Jamais de remplacement.
  const engineReason = engine => {
    if (!engine) return '';
    return studio.engines.reason(engine) || (liveWorkers(engine.model).length ? '' : `Aucun worker disponible n’offre le modèle « ${engine.model} » : la demande attend, sans bascule.`);
  };
```

Dans `createStudio`, remplacer l'option `aiAvailable` par :

```js
    aiAvailable: slug => !halted && !engineReason(studio.engines.resolve(studio.comm.agentOfSlug(slug))) });
```

Dans `createApp`, remplacer la ligne `agentReady: …` par `engineReason });`.

- [ ] **Step 4: Vérifier** — Run: `node --test --test-timeout=30000 test/engine-choice.test.js test/cloud-runtime.test.js test/cloud-operations.test.js test/worker-broker.test.js` ; Expected: PASS.

- [ ] **Step 5: Commit** (Tasks 4 et 5)

```bash
git add src/comm-run.js src/app.js src/cloud-server.js test/engine-choice.test.js
git commit -m "feat: run the chosen engine locally and on central workers"
```

---

### Task 6: Interface

**Files:**
- Create: `public/engine-view.js`
- Modify: `public/app.js`, `public/missions.js`, `public/comm-ui.js`, `public/automation-ui.js`, `test/engine-choice.test.js`

**Interfaces:**
- Produces: `SOURCES`, `engineLabel(e)`, `engineValue(e)`, `engineFromValue(v)`, `engineOptions(catalog, defaultLabel)`, `optionNodes(h, catalog, current, defaultLabel)`, `affectedAutomations(rules, slug)`.

- [ ] **Step 1: Ajouter le test** :

```js
import { engineLabel, engineFromValue, engineOptions, affectedAutomations } from '../public/engine-view.js';

test('écran : libellés, options et automatisations concernées', () => {
  assert.equal(engineLabel(claude('opus')), 'Claude Opus');
  assert.equal(engineLabel(null), 'Moteur inconnu');
  assert.deepEqual(engineFromValue('claude:haiku'), claude('haiku')); assert.equal(engineFromValue(''), null);
  const options = engineOptions([{ provider: 'claude', label: 'Claude', state: 'available', models: [{ model: 'opus', reason: 'x' }] }, { provider: 'codex', label: 'Codex', state: 'disabled', reason: 'Désactivé.', models: [] }], 'Fiche');
  assert.deepEqual(options.map((o) => [o.value, o.disabled]), [['', false], ['claude:opus', false], ['codex:', true]]);
  assert.match(options[1].label, /indisponible/);
  assert.deepEqual(affectedAutomations([{ name: 'A', enabled: true, allowAi: true, agentSlug: 'lucas' }, { name: 'B', enabled: false, allowAi: true, agentSlug: 'lucas' }], 'lucas'), ['A']);
});
```

- [ ] **Step 2: Créer `public/engine-view.js`**

```js
// public/engine-view.js — libellés et options du moteur IA (fonctions pures, testées dans Node).
export const SOURCES = { mission: 'choix de la mission', agent: 'choix de l’agent', fiche: 'fiche', task: 'choisi pour cette tâche' };
export const PROVIDERS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const MODELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
export const engineLabel = (e) => (e?.provider && e?.model ? `${PROVIDERS[e.provider] ?? e.provider} ${MODELS[e.model] ?? e.model}` : 'Moteur inconnu');
export const engineValue = (e) => (e ? `${e.provider}:${e.model}` : '');
export function engineFromValue(value) { if (!value) return null; const i = value.indexOf(':'); return { provider: value.slice(0, i), model: value.slice(i + 1) }; }
export function engineOptions(catalog = [], defaultLabel = 'Choix par défaut') {
  const out = [{ value: '', label: defaultLabel, disabled: false }];
  for (const p of catalog) {
    if (p.state !== 'available') { out.push({ value: `${p.provider}:`, label: `${p.label} — ${p.reason}`, disabled: true }); continue; }
    for (const m of p.models) out.push({ value: `${p.provider}:${m.model}`, label: `${engineLabel({ provider: p.provider, model: m.model })}${m.reason ? ' — indisponible pour le moment' : ''}`, disabled: false });
  }
  return out;
}
export const optionNodes = (h, catalog, current, defaultLabel) => engineOptions(catalog, defaultLabel).map((o) => h('option', { value: o.value, disabled: o.disabled, selected: o.value === engineValue(current) }, o.label));
export const affectedAutomations = (rules = [], slug) => rules.filter((r) => r.enabled && r.allowAi && r.agentSlug === slug).map((r) => r.name);
```

- [ ] **Step 3: Fiche d'agent, `public/app.js`**

Import : `import { SOURCES, engineLabel, engineFromValue, optionNodes, affectedAutomations } from './engine-view.js';`

Avant `profileBlock` :

```js
// Moteur de l'agent : le fichier de la fiche ne change pas, le choix est enregistré dans le Studio.
function engineBlock(p) {
  const box = h('div', { class: 'engine-block' }, h('span', { class: 'chip accent' }, `Modèle ${modelLabel(p.model)}`));
  const err = h('p', { class: 'err', role: 'alert' });
  async function load() {
    const data = await get('/api/engines'), me = data.agents.find((a) => a.agentId === p.agentId);
    if (!me) return;
    const select = h('select', { 'aria-label': `Moteur IA de ${p.displayName}` }, optionNodes(h, data.catalog, me.choice, `Fiche (${engineLabel(me.fiche)})`));
    select.addEventListener('change', async () => {
      err.textContent = '';
      try {
        const names = affectedAutomations((await get('/api/automations')).rules, p.slug);
        if (names.length && !confirm(`Ces automatisations actives utiliseront ce moteur : ${names.join(', ')}. Continuer ?`)) return await load();
        await send('PUT', `/api/agents/${encodeURIComponent(p.agentId)}/engine`, { engine: engineFromValue(select.value) });
        announce('Moteur enregistré'); await load();
      } catch (x) { err.textContent = x.message; }
    });
    box.replaceChildren(...[h('span', { class: 'chip accent' }, `Moteur ${engineLabel(me.effective)} · ${SOURCES[me.effective.source]}`),
      h('label', {}, 'Moteur IA', select), me.unavailable ? h('p', { class: 'err' }, me.unavailable) : null,
      h('p', { class: 'note' }, 'Vaut pour les prochaines demandes. Les tâches déjà créées gardent leur moteur. Un choix de mission passe avant celui-ci.'), err].filter(Boolean));
  }
  load().catch((x) => { err.textContent = x.message; box.append(err); });
  return box;
}
```

Dans `profileBlock`, remplacer ``h('span', { class: 'chip accent' }, `Modèle ${modelLabel(p.model)}`),`` par `engineBlock(p),`.

- [ ] **Step 4: Mission, `public/missions.js`**

Import : `import { engineFromValue, optionNodes } from './engine-view.js';`

Avant `memoryBlock` :

```js
  // Moteur de la mission : vaut pour ses prochaines tâches, son fil d'équipe, son plan et ses souvenirs.
  function engineBlock(m) {
    const box = h('section', { class: 'mission-engine', 'aria-label': 'Moteur IA de la mission' }, h('h4', {}, 'Moteur IA'), h('p', { class: 'note' }, 'Chargement…'));
    const url = `/api/missions/${encodeURIComponent(m.id)}/engine`, err = h('p', { class: 'err', role: 'alert' });
    const load = async () => {
      const [data, mine] = await Promise.all([get('/api/engines'), get(url)]);
      const select = h('select', { 'aria-label': 'Moteur IA de cette mission' }, optionNodes(h, data.catalog, mine.choice, 'Chaque agent garde le sien'));
      select.addEventListener('change', async () => { err.textContent = ''; try { await send('PUT', url, { engine: engineFromValue(select.value) }); announce('Moteur de la mission enregistré'); await load(); } catch (x) { err.textContent = x.message; } });
      box.replaceChildren(h('h4', {}, 'Moteur IA'), select, h('p', { class: 'note' }, 'Les tâches déjà créées gardent leur moteur.'), err);
    };
    load().catch((x) => box.replaceChildren(h('h4', {}, 'Moteur IA'), h('p', { class: 'err' }, x.message)));
    return box;
  }
```

Dans `sheet`, ajouter `engineBlock(m),` après `block('Collaborateurs', …),`.

- [ ] **Step 5: Comms, `public/comm-ui.js`**

Import : `import { SOURCES, engineLabel, engineFromValue, optionNodes } from './engine-view.js';`

Dans `delegateForm`, après la déclaration `const web = …` :

```js
    const engine = h('select', { name: 'engine', 'aria-label': 'Moteur IA' }, optionNodes(h, [], null, 'Chaque agent garde le sien'));
    get('/api/engines').then((d) => engine.replaceChildren(...optionNodes(h, d.catalog, null, 'Chaque agent garde le sien'))).catch(() => {});
```

Dans `body`, ajouter `...(engine.value ? { engine: engineFromValue(engine.value) } : {})`. Avant le label du budget :

```js
      h('label', {}, 'Moteur IA de la mission', engine, h('span', { class: 'note' }, 'Un choix ici vaut pour toute la demande, délégations comprises.')),
```

Dans `taskRow`, après `chip(nameOf(t.assigneeId)), ` ajouter `t.model && chip(engineLabel(t)), `.

Avant `budgetForm` :

```js
  const CHANGEABLE = ['pending_approval', 'queued', 'blocked', 'failed', 'expired', 'review'];
  function engineForm(t) {
    const line = h('p', { class: 'note' }, `Moteur : ${t.model ? engineLabel(t) : 'celui de la fiche'}${t.engineSource ? ` (${SOURCES[t.engineSource]})` : ''}`);
    if (t.automationKey || !CHANGEABLE.includes(t.state)) return line;
    const err = errBox(), select = h('select', { 'aria-label': 'Moteur de la tâche' }), apply = h('button', { type: 'submit', disabled: true }, 'Changer le moteur');
    get('/api/engines').then((d) => { select.replaceChildren(...optionNodes(h, d.catalog, t.engineSource === 'task' ? t : null, 'Choix par défaut')); apply.disabled = false; }).catch((x) => fail(err, x));
    return h('form', { class: 'memory-form', onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; try { await send('POST', `/api/comm/tasks/${enc(t.id)}/engine`, { engine: engineFromValue(select.value) }); announce('Moteur de la tâche changé'); ui.pollComm?.(); await loadTasks(); } catch (x) { fail(err, x); } } },
      line, h('label', {}, 'Nouveau moteur', select), apply, err);
  }
```

Dans `detail`, avant `d.task.budgetUsd != null && budgetForm(d.task),` ajouter `engineForm(d.task),`.

- [ ] **Step 6: Automatisations, `public/automation-ui.js`** — import `import { engineLabel } from './engine-view.js';` et, dans la ligne de règle, après `${r.allowAi ? 'Analyse IA demandée' : 'Sans IA'}` ajouter ``${r.allowAi ? ` · ${r.engine ? engineLabel(r.engine) : 'moteur inconnu'}` : ''}``.

- [ ] **Step 7: Vérifier dans le navigateur, sur une base temporaire.** Écrire hors du dépôt (scratchpad) `preview-temp.mjs`, en remplaçant `<WORKTREE>` par le chemin absolu du dépôt de travail :

```js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'archipel-preview-'));
Object.assign(process.env, { WORKEDA_DB: join(dir, 'workeda.db'), WORKEDA_MEMORY_JOURNAL: join(dir, 'memory'), WORKEDA_COMM_JOURNAL: join(dir, 'comm'), PORT: '4398' });
await import(pathToFileURL(join('<WORKTREE>', 'src', 'server.js')));
```

Le lancer avec `preview_start` (entrée de `.claude/launch.json` non commitée : `runtimeExecutable` `node`, `runtimeArgs` le chemin du script, `port` 4398). Contrôler à 375, 800 et 1366 px : sélecteur sur la fiche d'agent, la mission, la délégation et la tâche ; Codex grisé ; aucune erreur console. Ne cliquer aucun bouton qui lance une réponse d'agent et n'enregistrer aucune délégation (elle partirait vers un vrai Claude). Supprimer l'entrée de `launch.json` ensuite.

- [ ] **Step 8: Vérifier** — Run: `node --test --test-timeout=30000` ; Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add public test/engine-choice.test.js
git commit -m "feat: choose the engine from agent, mission and task screens"
```

---

### Task 7: Documentation et contrôle

**Files:**
- Modify: `docs/WORKERS.md`, `docs/LIVRAISON.md`

- [ ] **Step 1: `docs/WORKERS.md`** — remplacer la phrase « The central server accepts jobs only for the models named in the agent files. » par :

```markdown
The central server accepts jobs for the closed Claude catalogue (`opus`, `sonnet`,
`haiku`). Each worker still serves only the models of its own enrollment: serving
a newly chosen model needs a new enrollment. Without a connected worker for the
chosen model the mission waits; no other model or provider replaces it.
```

- [ ] **Step 2: `docs/LIVRAISON.md`** — remplacer la ligne « Choix du moteur par agent ou mission, quotas et coûts séparés par fournisseur » par :

```markdown
| Choix du moteur par agent ou mission (Claude : opus, sonnet, haiku) | Oui, branche `feat/engine-choice` | Tests à runners **simulés** | Non | Non : non fusionné ; accès du compte à chaque modèle non vérifié ; Codex désactivé |
```

- [ ] **Step 3: Contrôle complet** — `node --test --test-timeout=30000` (0 échec, noter le nombre), `node src/skills-cli.js check`, `git diff --stat main -- .claude/agents data` (vide).

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe the engine choice"
```

## Non vérifié par ce lot

Aucun appel réel : l'accès du compte à `opus` ou `haiku` n'est pas prouvé. Choisir `opus` consomme le quota de l'abonnement plus vite.
