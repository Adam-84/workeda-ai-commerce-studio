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
