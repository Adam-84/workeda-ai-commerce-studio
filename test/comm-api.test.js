// API de communication : réservée à cette machine, jamais au nom d'un agent, délégation de bout en bout, runner Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { claudeArgs, isolationFlags, resetIsolationCache, runClaude } from '../src/claude-reply.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
async function withApp(runner, fn) {
  const studio = createStudio(':memory:');
  studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: runner, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  try { await fn({ studio, ids, call, orch: server.orchestrator }); } finally { await new Promise((r) => server.close(r)); studio.close(); }
}
const noRunner = async () => { throw new Error('aucun appel attendu'); };

test('API communication : cette machine seulement, lectures comprises', () => withApp(noRunner, async ({ call }) => {
  assert.equal((await call('GET', '/api/comm/threads')).status, 200);
  assert.equal((await call('GET', '/api/comm/threads', undefined, { host: 'evil.example' })).status, 403, 'rebond DNS refusé');
  assert.equal((await call('POST', '/api/comm/threads', { kind: 'group', members: [] }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/comm/delegations', { assigneeId: 'x', instruction: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/messages', { fromAgentId: 'a', toAgentId: 'b', body: 'x' }, { origin: 'https://evil.example' })).status, 403, 'l’ancienne route d’échanges est gardée aussi');
}));

test('un client ne peut écrire qu’en son propre nom : jamais au nom d’un agent', () => withApp(noRunner, async ({ call, ids, studio }) => {
  const t = (await call('POST', '/api/comm/threads', { kind: 'group', title: 'Trio', members: [ids.alexander, ids.sophia, ids.noah] })).body;
  const sent = await call('POST', `/api/comm/threads/${t.id}/messages`, { body: 'Bonjour', kind: 'result', senderAgentId: ids.sophia, senderType: 'agent', runId: 'x', fromAgentId: ids.noah });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.senderType, 'user'); assert.equal(sent.body.senderAgentId, null); assert.equal(sent.body.kind, 'message'); assert.equal(sent.body.runId, null);
  assert.equal(sent.body.deliveries.length, 3);
  assert.equal((await call('POST', `/api/comm/threads/${t.id}/messages`, { body: 'mot de passe : correctcheval' })).status, 400);
  assert.equal((await call('GET', `/api/comm/threads/${t.id}/messages`)).body.items.length, 1);
  assert.equal(studio.comm.listTasks().length, 0);
}));

test('délégation de bout en bout par l’API, puis validation et vérification par le propriétaire', () => {
  const seen = [];
  const runner = async (o) => {
    seen.push(o.tools);
    if (/^Tu es Alexander/.test(o.system)) return JSON.stringify({ report: 'Je délègue à Noah.', delegate: [{ to: 'Noah', task: 'Relever les prix des supports d’écran' }] });
    return JSON.stringify({ report: 'Prix relevés.', sources: [{ label: 'Boutique', url: 'https://example.org/p' }] }); // aucune consultation réelle
  };
  return withApp(runner, async ({ call, ids, orch, studio }) => {
    const made = (await call('POST', '/api/comm/delegations', { assigneeId: ids.alexander, instruction: 'Étudier les supports d’écran', title: 'Supports', allowWeb: true, requiresSources: false })).body;
    assert.equal(made.created, true); assert.equal(made.task.state, 'queued');
    await orch.idle();
    const tasks = (await call('GET', `/api/comm/tasks?rootTaskId=${made.task.id}`)).body;
    assert.equal(tasks.length, 2);
    const noah = tasks.find((t) => t.assigneeId === ids.noah);
    assert.equal(noah.state, 'pending_approval', 'l’agent propose, le propriétaire valide');
    assert.equal((await call('GET', '/api/comm/notifications')).body.find((n) => n.type === 'approval').taskId, noah.id);
    assert.equal((await call('POST', `/api/comm/tasks/${noah.id}/approve`, {})).body.state, 'queued');
    await orch.idle();
    const detail = (await call('GET', `/api/comm/tasks/${noah.id}`)).body;
    assert.equal(detail.task.state, 'review', 'aucune source confirmée par des consultations réelles : jamais « terminée »');
    assert.equal(detail.results[0].verified, false);
    assert.equal((await call('POST', `/api/comm/tasks/${noah.id}/verify`, { note: 'relu' })).body.state, 'done');
    assert.equal((await call('POST', `/api/comm/tasks/${noah.id}/cancel`, {})).status, 409, 'une tâche terminée ne s’annule pas');
    assert.deepEqual(seen, [[], ['WebSearch', 'WebFetch']]);
    assert.equal((await call('GET', '/api/comm/check')).body.ok, true);
    assert.equal((await call('GET', '/api/comm/usage')).body.total.runs, 2);
    assert.ok((await call('GET', '/api/comm/exchanges')).body.some((e) => e.from_agent_id === ids.noah || e.to_agent_id === ids.noah), 'échanges réels disponibles pour la carte');
    assert.equal(studio.listAgents().find((a) => a.id === ids.noah).status, 'idle');
    const act = (await call('GET', '/api/comm/activity')).body;
    assert.equal(act.active.length, 0); assert.equal(act.maxActive, 2);
  });
});

test('réponse dans un fil par l’API : contrôles immédiats, exécution en arrière-plan', () => withApp(async () => { await new Promise((r) => setTimeout(r, 120)); return 'Bien reçu, je m’en occupe.'; }, async ({ call, ids, orch }) => {
  const t = (await call('POST', '/api/comm/threads', { kind: 'direct', members: [ids.noah] })).body;
  assert.equal((await call('POST', `/api/comm/threads/${t.id}/reply`, { agentId: ids.noah })).status, 400, 'aucun message à traiter');
  await call('POST', `/api/comm/threads/${t.id}/messages`, { body: 'Noah, tu peux surveiller ?' });
  assert.equal((await call('POST', `/api/comm/threads/${t.id}/reply`, { agentId: ids.sophia })).status, 403);
  const started = await call('POST', `/api/comm/threads/${t.id}/reply`, { agentId: ids.noah });
  assert.equal(started.status, 200); assert.equal(started.body.started, true);
  assert.equal((await call('GET', '/api/comm/activity')).body.active.length, 1, 'agent réellement actif');
  await orch.idle();
  const msgs = (await call('GET', `/api/comm/threads/${t.id}/messages`)).body.items;
  assert.equal(msgs.at(-1).senderAgentId, ids.noah); assert.ok(msgs.at(-1).runId);
}));

test('agent indisponible : refus clair, rien d’enregistré', () => withApp(noRunner, async ({ call, ids, studio }) => {
  studio.updateAgent(ids.noah, { enabled: false });
  const r = await call('POST', '/api/comm/delegations', { assigneeId: ids.noah, instruction: 'Veille' });
  assert.equal(r.status, 409); assert.match(r.body.error, /indisponible|désactivé/);
  assert.equal((await call('POST', '/api/comm/threads', { kind: 'group', members: [ids.noah, ids.sophia] })).status, 409);
  assert.equal(studio.comm.listTasks().length, 0);
}));

// --- runner Claude Code ---------------------------------------------------------------------------------------------------------------------
test('runner : aucun outil par défaut ; seuls WebSearch / WebFetch peuvent être donnés, en lecture seule', () => {
  const none = claudeArgs('sonnet', 'fiche');
  assert.equal(none[none.indexOf('--tools') + 1], ''); assert.ok(!none.includes('--allowedTools'));
  const web = claudeArgs('sonnet', 'fiche', { tools: ['WebSearch', 'WebFetch'] });
  assert.equal(web[web.indexOf('--tools') + 1], 'WebSearch,WebFetch'); assert.equal(web[web.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.ok(web.includes('--strict-mcp-config') && web.includes('--disable-slash-commands') && web.includes('--no-session-persistence'));
});

test('runner : isolation adaptée à la version de Claude Code (--safe-mode absent des versions installées ici)', () => {
  resetIsolationCache();
  assert.deepEqual(isolationFlags(() => 'Options:\n  --tools <tools...>\n  --setting-sources <sources>'), ['--setting-sources', '']);
  resetIsolationCache();
  assert.deepEqual(isolationFlags(() => 'Options:\n  --safe-mode   Minimal mode'), ['--safe-mode']);
  resetIsolationCache();
  assert.deepEqual(isolationFlags(() => { throw new Error('ENOENT'); }), ['--safe-mode'], 'rien appris : comportement d’origine');
  resetIsolationCache();
  const args = claudeArgs('sonnet', 's', { isolation: ['--setting-sources', ''] });
  assert.ok(!args.includes('--safe-mode')); assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});

test('runner : les événements stream-json sont transmis à l’observateur (outils réellement appelés)', async () => {
  const events = [];
  const child = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough(); c.kill = () => {};
    c.stdin.on('finish', () => {
      c.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'WebFetch', input: { url: 'https://example.com' } }] } })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fait', total_cost_usd: 0.01 })}\n`);
      c.stdout.end(); setImmediate(() => c.emit('close', 0));
    });
    return c;
  };
  const text = await runClaude({ model: 'sonnet', system: 's', prompt: 'p', tools: ['WebFetch'], onEvent: (e) => events.push(e.type), spawn: child });
  assert.equal(text, 'Fait'); assert.deepEqual(events, ['assistant', 'result']);
});
