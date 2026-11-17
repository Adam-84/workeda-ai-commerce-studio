import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { SECTIONS } from '../src/agent-files.js';

const sections = Object.fromEntries(SECTIONS.map(([t, k]) => [k, `Texte ${t}`]));
const P = (slug, over = {}) => ({ slug, description: 'd', tools: ['Read'], model: 'sonnet', displayName: slug[0].toUpperCase() + slug.slice(1), role: 'r', department: 'Direction', collaboratesAll: false, collaborates: [], connectors: [], sections, ...over });
const PROFILES = [
  P('ryan', { department: 'Création', model: 'opus', tools: ['Read', 'Bash'], connectors: ['shopify-cli', 'codex-cli', 'shopify-admin', 'web', 'playwright', 'dsers'], collaborates: ['chloe', 'harper'] }),
  P('chloe', { department: 'Création' }),
  P('alexander', { collaboratesAll: true }),
  P('zoe', { department: 'Inconnu' })
];
const BROKEN = { file: 'cassee.md', reason: 'clé obligatoire manquante : role' };

async function withApp(fn, { agentFiles = true, detect = (c) => c === 'shopify' } = {}) {
  const studio = createStudio(':memory:');
  const options = { studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect };
  if (agentFiles) { const sync = studio.syncAgentFiles(PROFILES); options.agentFiles = { profiles: PROFILES, warnings: [BROKEN, ...sync.warnings] }; }
  const server = createApp(options);
  await new Promise((r) => server.listen(0, r));
  const call = async (path) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json();
  const idOf = (name) => studio.listAgents().find((a) => a.name === name)?.id;
  try { await fn({ call, idOf }); } finally { server.close(); studio.close(); }
}

test('lists only the profiles linked to an agent', () => withApp(async ({ call, idOf }) => {
  const list = await call('/api/agent-profiles');
  assert.deepEqual(list.map((p) => p.slug).sort(), ['alexander', 'chloe', 'ryan']);
  const ryan = list.find((p) => p.slug === 'ryan');
  assert.equal(ryan.agentId, idOf('Ryan'));
  assert.equal(ryan.displayName, 'Ryan');
  assert.equal(ryan.model, 'opus');
  assert.deepEqual(ryan.tools, ['Read', 'Bash']);
  assert.equal(ryan.sections.metier, 'Texte Métier');
  assert.equal(ryan.sections.livrable, 'Texte Livrable');
}));

test('connector states come from detection, never from a claim', () => withApp(async ({ call }) => {
  const ryan = (await call('/api/agent-profiles')).find((p) => p.slug === 'ryan');
  assert.deepEqual(ryan.connectors, [
    { id: 'shopify-cli', state: 'detected' }, { id: 'codex-cli', state: 'missing' }, { id: 'shopify-admin', state: 'not_connected' },
    { id: 'web', state: 'claude_code_only' }, { id: 'playwright', state: 'not_connected' }, { id: 'dsers', state: 'not_connected' }
  ]);
}));

test('collaborators carry an agent id, or null when absent from the team', () => withApp(async ({ call, idOf }) => {
  const list = await call('/api/agent-profiles');
  const ryan = list.find((p) => p.slug === 'ryan'), alexander = list.find((p) => p.slug === 'alexander');
  assert.equal(ryan.collaboratesAll, false);
  assert.deepEqual(ryan.collaborates, [{ slug: 'chloe', agentId: idOf('Chloe') }, { slug: 'harper', agentId: null }]);
  assert.equal(alexander.collaboratesAll, true);
  assert.deepEqual(alexander.collaborates, []);
}));

test('health reports loaded profiles and warnings', () => withApp(async ({ call }) => {
  const { agentFiles } = await call('/api/health');
  assert.deepEqual(agentFiles, { loaded: 3, warnings: [BROKEN, { file: 'zoe.md', reason: 'département inconnu : Inconnu' }] });
}));

test('without agent files the routes stay empty', () => withApp(async ({ call }) => {
  assert.deepEqual(await call('/api/agent-profiles'), []);
  assert.deepEqual((await call('/api/health')).agentFiles, { loaded: 0, warnings: [] });
}, { agentFiles: false }));

test('CLI detection is cached across health and profile calls', () => {
  const counts = {};
  const detect = (c) => { counts[c] = (counts[c] ?? 0) + 1; return c === 'shopify'; };
  return withApp(async ({ call }) => {
    await call('/api/health'); await call('/api/agent-profiles');
    await call('/api/health'); await call('/api/agent-profiles');
    for (const c of ['shopify', 'claude', 'codex', 'clink']) assert.equal(counts[c], 1, c);
  }, { detect });
});
