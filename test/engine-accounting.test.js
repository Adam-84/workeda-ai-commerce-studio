// Lot 1 : toutes les exécutions comptées, donnée absente jamais zéro, modèle constaté. Runners simulés, bases temporaires.
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
import { createOrchestrator } from '../src/comm-run.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
function setup(options = {}, file = ':memory:') {
  const studio = createStudio(file, options); studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, comm: studio.comm, ids };
}

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
