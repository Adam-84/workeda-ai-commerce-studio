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
