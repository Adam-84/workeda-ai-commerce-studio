import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { runClaude, claudeArgs, missionsPrompt, MAX_MISSIONS } from '../src/claude-reply.js';

// Faux processus pour vérifier la lecture du flux ; l'appel réel est vérifié séparément sur une base temporaire.
const fakeSpawn = (lines, code = 0) => (command, args) => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
  child.spawned = { command, args };
  let input = '';
  child.stdin.on('data', (d) => { input += d; });
  child.stdin.on('finish', () => { child.input = input; for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n'); child.stdout.end(); setImmediate(() => child.emit('close', code)); });
  fakeSpawn.last = child;
  return child;
};
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

test('claude runs without any tool, MCP server, hook or session file', () => {
  const args = claudeArgs('sonnet', 'fiche');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  for (const flag of ['-p', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--mcp-config'));
});

test('streamed text arrives piece by piece and the final result is returned', async () => {
  const pieces = [];
  const text = await runClaude({ model: 'sonnet', system: 's', prompt: 'bonjour', onText: (t) => pieces.push(t),
    spawn: fakeSpawn([{ type: 'system', subtype: 'init' }, delta('Bon'), delta('jour'), { type: 'result', subtype: 'success', is_error: false, result: 'Bonjour' }]) });
  assert.deepEqual(pieces, ['Bon', 'jour']);
  assert.equal(text, 'Bonjour');
  assert.equal(fakeSpawn.last.input, 'bonjour');
  assert.equal(fakeSpawn.last.spawned.command, 'claude');
});

test('failures become readable French errors', async () => {
  await assert.rejects(runClaude({ model: 'sonnet', system: 's', prompt: 'x', spawn: fakeSpawn([{ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }], 1) }), /pas connecté/);
  await assert.rejects(runClaude({ model: 'sonnet', system: 's', prompt: 'x', spawn: fakeSpawn([], 1) }), /n’a pas pu répondre/);
  const missing = () => { const c = fakeSpawn([])(); queueMicrotask(() => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))); return c; };
  await assert.rejects(runClaude({ model: 'sonnet', system: 's', prompt: 'x', spawn: missing }), /introuvable/);
});

async function withLucas(runner, fn) {
  const studio = createStudio(':memory:');
  const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
  studio.syncAgentFiles(profiles);
  const id = (slug) => studio.listAgentFiles().find((l) => l.slug === slug).agentId;
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false, runClaude: runner, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ studio, base, lucas: id('lucas'), olivia: id('olivia') }); }
  finally { await new Promise((r) => server.close(r)); studio.close(); }
}
const post = (url, data) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: data && JSON.stringify(data) });

test('reply route streams, saves the reply and passes the fiche and history', () => {
  let seen;
  const runner = async (opts) => { seen = opts; opts.onText('Bon'); opts.onText('jour'); return 'Bonjour'; };
  return withLucas(runner, async ({ studio, base, lucas, olivia }) => {
    const manual = studio.hireAgent({ name: 'Zoé', role: 'Recrutée à la main', departmentId: studio.listDepartments()[0].id });
    await post(`${base}/api/agents/${manual.id}/conversation`, { body: 'Bonjour' });
    assert.equal((await post(`${base}/api/agents/${manual.id}/reply`)).status, 403); // sans fiche, pas de réponse
    assert.equal((await post(`${base}/api/agents/${olivia}/reply`)).status, 400); // les autres agents répondent aussi ; ici rien à répondre
    assert.equal((await post(`${base}/api/agents/${lucas}/reply`)).status, 400); // rien à répondre
    await post(`${base}/api/agents/${lucas}/conversation`, { body: 'Audite la fiche du tapis' });
    const res = await post(`${base}/api/agents/${lucas}/reply`);
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Bon', 'jour']);
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.message.senderType, 'assistant');
    assert.match(seen.system, /Responsable catalogue Shopify/);
    assert.match(seen.system, /aucun outil/);
    assert.match(seen.prompt, /Audite la fiche du tapis/);
    assert.equal(seen.model, 'sonnet');
    const items = studio.listConversation(lucas).items;
    assert.deepEqual(items.map((m) => m.senderType), ['assistant', 'user']);
    assert.equal(items[0].body, 'Bonjour');
    assert.equal((await post(`${base}/api/agents/${lucas}/reply`)).status, 400); // déjà répondu
    const next = studio.listConversation(lucas, Buffer.from(JSON.stringify({ createdAt: items[0].created_at, id: items[0].id })).toString('base64url'));
    assert.equal(next.items.length, 1); // le curseur accepte les réponses
  });
});

test('a failed call keeps the user message and stores no reply', () => withLucas(async () => { throw new Error('Claude n’a pas pu répondre : panne'); }, async ({ studio, base, lucas }) => {
  await post(`${base}/api/agents/${lucas}/conversation`, { body: 'Bonjour' });
  const events = (await (await post(`${base}/api/agents/${lucas}/reply`)).text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events, [{ type: 'error', error: 'Claude n’a pas pu répondre : panne' }]);
  assert.deepEqual(studio.listConversation(lucas).items.map((m) => m.senderType), ['user']);
}));

test('every agent with a fiche answers with its own fiche, model, missions and memory', () => {
  let seen;
  const runner = async (opts) => { seen = opts; return 'Réponse'; };
  return withLucas(runner, async ({ studio, base, lucas, olivia }) => {
    const alexander = studio.listAgentFiles().find((l) => l.slug === 'alexander').agentId;
    const mine = studio.createMission({ title: 'Point hebdo', assignedTo: olivia, collaborators: [lucas], priority: 'high', objective: 'Lister les blocages', contextLinks: ['https://exemple.fr/note'], constraints: 'Lecture seule' });
    studio.addMemory(mine.id, { kind: 'decision', body: 'Le point se fait le lundi', sourceAgentId: lucas });
    const old = studio.addMemory(mine.id, { kind: 'fact', body: 'Note périmée' });
    studio.updateMemory(mine.id, old.id, { archived: true });
    studio.createMission({ title: 'Mission d’un autre', assignedTo: alexander });
    await post(`${base}/api/agents/${olivia}/conversation`, { body: 'Où en est le point hebdo ?' });
    const events = (await (await post(`${base}/api/agents/${olivia}/reply`)).text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.at(-1).type, 'done');
    assert.match(seen.system, /Coordinatrice des missions/);
    assert.match(seen.system, /ne peux pas contacter les autres agents/);
    assert.match(seen.prompt, /Mission « Point hebdo » \(ton rôle : responsable ; priorité haute/);
    assert.match(seen.prompt, /collaborateurs : Lucas/);
    assert.match(seen.prompt, /Liens de référence \(non consultés, tu ne peux pas les ouvrir\) :\n- https:\/\/exemple\.fr\/note/);
    assert.match(seen.prompt, /Décision \(source : Lucas\) : Le point se fait le lundi/);
    assert.doesNotMatch(seen.prompt, /Note périmée/); // archivée
    assert.doesNotMatch(seen.prompt, /Mission d’un autre/);
    assert.match(seen.prompt, /Où en est le point hebdo \?/);
    await post(`${base}/api/agents/${alexander}/conversation`, { body: 'Bonjour' });
    await (await post(`${base}/api/agents/${alexander}/reply`)).text();
    assert.equal(seen.model, 'opus'); // le modèle de sa fiche
    assert.match(seen.prompt, /Mission « Mission d’un autre » \(ton rôle : responsable/);
    assert.equal(studio.listConversation(olivia).items[0].body, 'Réponse');
  });
});

test('mission context says when nothing is assigned and keeps a bounded size', () => {
  assert.match(missionsPrompt([], 'a', () => 'X', () => []), /aucune mission/);
  const many = Array.from({ length: MAX_MISSIONS + 5 }, (_, i) => ({ id: `m${i}`, title: `M${i}`, assigned_to: 'a', collaborators: [], state: 'draft', priority: 'normal', contextLinks: [], requiresApproval: true }));
  const text = missionsPrompt(many, 'a', () => 'X', () => []);
  assert.equal(text.match(/Mission « /g).length, MAX_MISSIONS);
  assert.match(text, /Mémoire : aucune note\./);
});
