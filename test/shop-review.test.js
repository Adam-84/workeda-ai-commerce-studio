// Régressions de la revue indépendante (Codex), phase 5 : un test par défaut confirmé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { createShopConnector, SHOP_LIMITS } from '../src/shop-readonly.js';
import { createShopStore } from '../src/studio-shop.js';
import { LIMITS } from '../src/comm-core.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const J = JSON.stringify;
const connector = { mode: 'public', domain: 'workeda.com', hasToken: false, misconfigured: false, async fetchCatalog() { return { mode: 'public', domain: 'workeda.com', collections: [{ id: '1', title: 'C', handle: 'c', count: 1 }], products: [], errors: [], sourceUrls: ['https://workeda.com/collections.json'], ok: true, partial: false }; } };
function setup(script, options = {}) {
  const studio = createStudio(':memory:', { shopConnector: connector, ...options });
  studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const calls = [];
  const runner = async (o) => { const name = /^Tu es ([^,]+),/.exec(o.system)?.[1]; calls.push({ name, ...o }); const s = script[name]; return typeof s === 'function' ? s(o, calls) : s; };
  return { studio, comm: studio.comm, ids, calls, orch: createOrchestrator({ studio, profiles: () => profiles, runner }) };
}
const cost = (o, usd) => o.onEvent({ type: 'result', total_cost_usd: usd });

test('R1. un budget invalide ne laisse aucune tâche ni mission derrière lui', () => {
  const { comm, ids, studio } = setup({});
  const missions = studio.listMissions().length;
  assert.throws(() => comm.createTask({ assigneeId: ids.sophia, instruction: 'Budget nul', budgetUsd: 0 }), /budget/);
  assert.equal(comm.listTasks().length, 0); assert.equal(studio.listMissions().length, missions);
  assert.equal(comm.claimNext().task, null);
});

test('R2. un coût rapporté avant une erreur reste compté', async () => {
  const { comm, ids, orch } = setup({ Sophia: (o) => { cost(o, 2.4); throw new Error('Claude est momentanément surchargé.'); } });
  const root = comm.createTask({ assigneeId: ids.sophia, instruction: 'Étudier', budgetUsd: 5 }).task;
  orch.pump(); await orch.idle();
  assert.equal(comm.spentOf(root.id), 2.4); assert.equal(comm.usage().total.costUsd, 2.4);
});

test('R3. un événement d’un ancien PC (sans champs v2) ne supprime ni budget ni catalogue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-r3-'));
  const a = setup({}, { commJournalDir: join(dir, 'j'), device: 'pc-a' });
  const t = a.comm.createTask({ assigneeId: a.ids.sophia, instruction: 'Étudier', withCatalog: true, budgetUsd: 1 }).task;
  const b = setup({}, { commJournalDir: join(dir, 'j'), device: 'pc-b' });
  b.comm.importJournal();
  const data = { id: t.id, missionId: t.missionId, rootTaskId: t.rootTaskId, parentTaskId: null, threadId: t.threadId, kind: 'work', title: 't', instruction: 'Étudier', requestedBy: 'user', assignee: 'sophia', depth: 0, state: 'queued', stateNote: 'mis à jour par un ancien PC', dependsOn: [], allowWeb: false, requiresSources: false, dedupeKey: 'k', dueAt: t.dueAt, notBefore: null, attempts: 0, maxAttempts: 2, device: 'pc-z', createdAt: t.createdAt, updatedAt: new Date(Date.now() + 5000).toISOString(), startedAt: null, finishedAt: null, mission: null };
  mkdirSync(join(dir, 'j'), { recursive: true });
  writeFileSync(join(dir, 'j', 'pc-z.jsonl'), `${J({ v: 1, eid: 'r3-old', device: 'pc-z', at: new Date(Date.now() + 5000).toISOString(), rev: 99, kind: 'task', key: t.id, data })}\n`);
  const r = b.comm.importJournal();
  assert.equal(r.invalid, 0, J(r.warnings));
  assert.equal(b.comm.task(t.id).stateNote, 'mis à jour par un ancien PC');
  assert.equal(b.comm.task(t.id).budgetUsd, 1); assert.equal(b.comm.task(t.id).withCatalog, true);
});

test('R4. les réponses dans le fil d’une mission comptent dans son budget et sont refusées au-delà', async () => {
  const { comm, ids, orch } = setup({ Sophia: 'Bien reçu.' });
  const root = comm.createTask({ assigneeId: ids.sophia, instruction: 'Étudier', budgetUsd: 0.1 }).task;
  const run = comm.startRun({ agentId: ids.sophia, kind: 'reply', threadId: root.threadId });
  comm.endRun(run.id, { state: 'done', costUsd: 0.25 });
  assert.equal(comm.spentOf(root.id), 0.25);
  comm.postMessage(root.threadId, { body: 'Une question ?' });
  assert.throws(() => orch.replyInThread(root.threadId, ids.sophia), /Budget de la mission atteint/);
  comm.setBudget(root.id, 5);
  assert.equal(orch.replyInThread(root.threadId, ids.sophia).started, true); await orch.idle();
});

test('R5. augmenter le budget relance aussi les consolidations bloquées par dépendance', () => {
  const { comm, ids } = setup({});
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Racine', budgetUsd: 1, requiresApproval: false }).task;
  const by = { type: 'agent', agentId: ids.alexander, runId: comm.startRun({ agentId: ids.alexander, kind: 'task', taskId: root.id }).id };
  const dep = comm.createTask({ assigneeId: ids.noah, instruction: 'Veille', parentTaskId: root.id }, by).task;
  const cons = comm.createTask({ assigneeId: ids.alexander, kind: 'consolidation', instruction: 'Assembler', parentTaskId: root.id, dependsOn: [dep.id] }, by).task;
  const spend = comm.startRun({ agentId: ids.lucas, kind: 'task', taskId: root.id }); comm.endRun(spend.id, { state: 'done', costUsd: 1.5 });
  for (let i = 0; i < 3; i += 1) comm.claimNext({ busy: new Set([ids.alexander]) });
  assert.equal(comm.task(dep.id).state, 'blocked'); assert.equal(comm.task(cons.id).state, 'blocked');
  comm.setBudget(root.id, 10);
  assert.equal(comm.task(dep.id).state, 'queued'); assert.equal(comm.task(cons.id).state, 'queued', 'la consolidation repart avec sa dépendance');
});

test('R6. corps de réponse lu au fil de l’eau et abandonné au-delà de la taille maximale', async () => {
  let cancelled = false, pulled = 0;
  const body = { getReader: () => ({ read: async () => { pulled += 1; return { done: false, value: new Uint8Array(1_000_000) }; }, cancel: async () => { cancelled = true; } }) };
  const f = async () => ({ status: 200, headers: { get: () => null }, body, text: async () => { throw new Error('text() ne doit pas être appelé'); } });
  const r = await createShopConnector({ domain: 'workeda.com', token: null, adminDomain: null, fetchImpl: f }).fetchCatalog();
  assert.match(r.errors[0], /trop volumineuse/); assert.equal(cancelled, true); assert.ok(pulled <= 2 * (Math.ceil(SHOP_LIMITS.maxBytes / 1_000_000) + 1), `${pulled} blocs lus (2 requêtes, chacune abandonnée au-delà de la limite)`);
});

test('R7. un 429 arrête tout le relevé et Retry-After est respecté par le stockage', async () => {
  const urls = [];
  const f = async (u) => { urls.push(new URL(u).pathname); return { status: 429, headers: { get: (k) => (k === 'retry-after' ? '3600' : null) }, text: async () => 'limited' }; };
  const conn = createShopConnector({ domain: 'workeda.com', token: null, adminDomain: null, fetchImpl: f });
  let t = Date.parse('2026-11-21T10:00:00Z');
  const store = createShopStore(new DatabaseSync(':memory:'), { connector: conn, clock: () => new Date(t).toISOString() });
  const r = await store.refresh();
  assert.deepEqual(urls, ['/collections.json'], 'aucune requête produits après le 429'); assert.equal(r.ok, false);
  t += 10 * 60_000;
  assert.match((await store.refresh({ force: true })).skipped, /demande d'attendre/, 'Retry-After 1 h : même forcé, pas avant');
  t += 55 * 60_000;
  await store.refresh({ force: true }); assert.equal(urls.length, 2);
});

test('R8. la consolidation garde le catalogue autorisé par le propriétaire', async () => {
  const { comm, ids, orch, calls } = setup({
    Alexander: (o, c) => (c.filter((x) => x.name === 'Alexander').length === 1 ? J({ report: 'Je confie.', delegate: [{ to: 'Lucas', task: 'Auditer les fiches' }], consolidate: 'Assembler' }) : J({ report: 'Synthèse.' })),
    Lucas: () => J({ report: 'ok' }) });
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Coordonner', withCatalog: true, requiresApproval: false }).task;
  orch.pump(); await orch.idle();
  const cons = comm.listTasks({ rootTaskId: root.id }).find((t) => t.kind === 'consolidation');
  assert.equal(cons.withCatalog, true);
  assert.match(calls.filter((c) => c.name === 'Alexander').at(-1).prompt, /catalogue Shopify/);
  void LIMITS;
});
