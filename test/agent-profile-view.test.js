import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorText, modelLabel, colleagues, ignoredText, helpLine, FULL_SECTIONS } from '../public/agent-profile.js';

test('connector states read in plain French', () => {
  assert.equal(connectorText({ id: 'shopify-cli', state: 'detected' }), 'Shopify CLI : détecté');
  assert.equal(connectorText({ id: 'codex-cli', state: 'missing' }), 'Codex CLI : non détecté');
  assert.equal(connectorText({ id: 'dsers', state: 'not_connected' }), 'DSers : non connecté');
  assert.equal(connectorText({ id: 'shopify-admin', state: 'not_connected' }), 'Shopify Admin : non connecté');
  assert.equal(connectorText({ id: 'playwright', state: 'not_connected' }), 'Playwright : non connecté');
  assert.equal(connectorText({ id: 'web', state: 'claude_code_only' }), 'Recherche web : dans Claude Code uniquement');
});

test('model labels', () => {
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('sonnet'), 'Sonnet');
  assert.equal(modelLabel('haiku'), 'Haiku');
});

test('colleagues use the current agent name, or plain text when absent', () => {
  const agents = [{ id: 'a1', name: 'Noé' }];
  const profile = { collaboratesAll: false, collaborates: [{ slug: 'noah', agentId: 'a1' }, { slug: 'harper', agentId: null }] };
  assert.deepEqual(colleagues(profile, agents), [{ label: 'Noé', agentId: 'a1' }, { label: 'Harper', agentId: null }]);
});

test('"tous" reads as the whole team', () => {
  assert.deepEqual(colleagues({ collaboratesAll: true, collaborates: [] }, []), [{ label: 'Toute l’équipe', agentId: null }]);
});

test('ignored files count for the top bar', () => {
  assert.equal(ignoredText(0), '');
  assert.equal(ignoredText(1), ' · 1 fiche ignorée');
  assert.equal(ignoredText(2), ' · 2 fiches ignorées');
});

test('help line names the agent', () => {
  assert.equal(helpLine('Sophia'), 'Dans Claude Code, demande : "Sophia, …"');
});

test('the full sheet lists the six other sections in order', () => {
  assert.deepEqual(FULL_SECTIONS.map(([, title]) => title), ['Ne fait jamais', 'Missions', 'Règles', 'Méthode', 'Relais', 'Réussite']);
});
