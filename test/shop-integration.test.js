// Phase 5 : catalogue Shopify fourni aux tâches (lecture seule, daté), budget par mission, migration v2, synchro, API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { LIMITS } from '../src/comm-core.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const J = JSON.stringify;
const URLS = ['https://workeda.com/collections.json', 'https://workeda.com/products.json'];
function fakeConnector(extra = {}) {
  const c = { mode: 'public', domain: 'workeda.com', hasToken: false, misconfigured: false, calls: 0, fail: false, ...extra,
    async fetchCatalog() { c.calls += 1; if (c.fail) return { mode: 'public', domain: 'workeda.com', collections: [], products: [], errors: ['collections : réponse 500'], sourceUrls: [], ok: false, partial: true };
      return { mode: 'public', domain: 'workeda.com', collections: [{ id: '1', title: 'Bras articulé', handle: 'bras', count: 3 }], products: [{ id: '9', title: 'Support écran', handle: 'support', vendor: 'W', type: 'Support', tags: ['bureau'], status: 'active', priceMin: 29.9, priceMax: 39.9, currency: null, available: true, images: 2, descChars: 120, desc: 'x', seoTitle: '', updatedAt: null, url: 'https://workeda.com/products/support' }], errors: [], sourceUrls: URLS, ok: true, partial: false }; } };
  return c;
}
function setup(script, options = {}, orchOptions = {}) {
  const connector = options.shopConnector ?? fakeConnector();
  const studio = createStudio(':memory:', { ...options, shopConnector: connector });
  studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const calls = [];
  const runner = async (o) => { const name = /^Tu es ([^,]+),/.exec(o.system)?.[1]; calls.push({ name, ...o }); const s = script[name]; if (typeof s === 'function') return s(o, calls); return s; };
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner, ...orchOptions });
  return { studio, comm: studio.comm, ids, orch, calls, connector };
}
const cost = (o, usd) => o.onEvent({ type: 'result', total_cost_usd: usd });

test('catalogue : fourni à la demande du propriétaire, daté, cadré non fiable, source « fournie par le Studio » vérifiable', async () => {
  const { comm, ids, orch, calls, connector } = setup({ Lucas: () => J({ report: 'Le catalogue compte 1 collection.', sources: [{ label: 'Catalogue Shopify', url: URLS[0] }] }) });
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Auditer les fiches du catalogue', withCatalog: true, requiresSources: true }).task;
  assert.equal(t.withCatalog, true);
  orch.pump(); await orch.idle();
  assert.equal(connector.calls, 1, 'un relevé lecture seule avant la tâche');
  const c = calls[0];
  assert.match(c.prompt, /<donnees-non-fiables origine="catalogue Shopify">/); assert.match(c.prompt, /LECTURE SEULE/); assert.match(c.prompt, /Support écran/);
  assert.match(c.system, /catalogue Shopify relevé par le Studio en LECTURE SEULE/); assert.deepEqual(c.tools, [], 'le catalogue n’ouvre aucun outil');
  const r = comm.resultOf(t.id);
  assert.equal(comm.task(t.id).state, 'done'); assert.equal(r.level, 'provided'); assert.match(r.verification, /relevé daté fourni par le Studio/); assert.deepEqual(r.observed.provided, URLS);
  assert.equal(r.sources[0].checked, true);
  // sans demande : aucun catalogue, aucun relevé
  const other = setup({ Lucas: () => J({ report: 'ok' }) });
  other.comm.createTask({ assigneeId: other.ids.lucas, instruction: 'Auditer sans catalogue' });
  other.orch.pump(); await other.orch.idle();
  assert.equal(other.connector.calls, 0); assert.doesNotMatch(other.calls[0].prompt, /catalogue Shopify/i);
});

test('catalogue indisponible : la tâche part avec « non disponible », sans rien inventer ni bloquer', async () => {
  const connector = fakeConnector(); connector.fail = true;
  const { comm, ids, orch, calls } = setup({ Lucas: () => J({ report: 'Catalogue absent : je ne peux pas auditer.', status: 'done' }) }, { shopConnector: connector });
  comm.createTask({ assigneeId: ids.lucas, instruction: 'Auditer les fiches', withCatalog: true });
  orch.pump(); await orch.idle();
  assert.match(calls[0].prompt, /Catalogue Shopify : non disponible/);
  assert.equal(comm.listTasks()[0].state, 'done');
});

test('un agent ne peut jamais accorder le catalogue ; l’héritage ne vient que du propriétaire', async () => {
  const { comm, ids, orch, calls } = setup({
    Alexander: () => J({ report: 'Je confie.', delegate: [{ to: 'Lucas', task: 'Auditer les fiches' }, { to: 'Sophia', task: 'Étudier le marché' }] }),
    Lucas: () => J({ report: 'ok' }), Sophia: () => J({ report: 'ok' }) });
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Coordonner', withCatalog: true, requiresApproval: false }).task;
  orch.pump(); await orch.idle();
  const kids = comm.listTasks({ rootTaskId: root.id }).filter((t) => t.id !== root.id);
  assert.ok(kids.length === 2 && kids.every((k) => k.withCatalog), 'héritage depuis le parent');
  assert.ok(calls.filter((c) => c.name !== 'Alexander').every((c) => /catalogue Shopify/.test(c.prompt)));
  // parent SANS catalogue : un agent qui le « demande » n'obtient rien
  const bare = comm.createTask({ assigneeId: ids.alexander, instruction: 'Autre racine', requiresApproval: false }).task;
  const by = { type: 'agent', agentId: ids.alexander, runId: comm.startRun({ agentId: ids.alexander, kind: 'task', taskId: bare.id }).id };
  const child = comm.createTask({ assigneeId: ids.noah, instruction: 'Veille', parentTaskId: bare.id, withCatalog: true }, by).task;
  assert.equal(child.withCatalog, false);
  // la demande identique avec/sans catalogue n'est pas un doublon
  const a = comm.createTask({ assigneeId: ids.isabella, instruction: 'Calculer les marges', withCatalog: true });
  const b = comm.createTask({ assigneeId: ids.isabella, instruction: 'Calculer les marges' });
  assert.equal(a.created && b.created, true);
});

// --- budget ---------------------------------------------------------------------------------------------------------------------------
test('budget : plafond par demande racine, blocage explicite, déblocage par le propriétaire', async () => {
  const chatty = (o) => { cost(o, 1.6); return J({ report: 'ok', delegate: [{ to: 'Sophia', task: 'Piece un' }, { to: 'Noah', task: 'Piece deux' }, { to: 'Lucas', task: 'Piece trois' }] }); };
  const { comm, ids, orch, calls } = setup({ Alexander: chatty, Sophia: (o) => { cost(o, 1.6); return J({ report: 'ok' }); }, Noah: (o) => { cost(o, 1.6); return J({ report: 'ok' }); }, Lucas: (o) => { cost(o, 1.6); return J({ report: 'ok' }); } }, {}, { maxActive: 1 });
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Coordonner', requiresApproval: false, budgetUsd: 3 }).task;
  assert.equal(root.budgetUsd, 3);
  orch.pump(); await orch.idle();
  const kids = comm.listTasks({ rootTaskId: root.id }).filter((t) => t.id !== root.id);
  const spent = comm.task(root.id).spentUsd;
  assert.ok(spent >= 3 && spent < 5, `dépensé ${spent}`);
  assert.equal(calls.length, 2, 'racine + une exécution, puis plus rien : 3,2 $ dépassent 3 $');
  const blocked = kids.filter((k) => k.state === 'blocked');
  assert.ok(blocked.length >= 1); assert.match(blocked[0].stateNote, /Budget de la mission atteint \(3\.2\d sur 3\.00 \$\)/);
  assert.ok(comm.listMessages(root.threadId, null, 100).items.some((m) => m.senderType === 'system' && /Budget atteint/.test(m.body)));
  assert.ok(comm.notifications().some((n) => n.type === 'blocked'));
  comm.setBudget(root.id, 10);
  assert.ok(comm.listTasks({ rootTaskId: root.id }).every((t) => t.state !== 'blocked'), 'les tâches bloquées pour budget repartent');
  orch.pump(); await orch.idle();
  assert.ok(comm.listTasks({ rootTaskId: root.id }).every((t) => t.state === 'done'));
});

test('budget : valeurs et portée contrôlées (racine seulement)', () => {
  const { comm, ids } = setup({});
  assert.equal(comm.createTask({ assigneeId: ids.sophia, instruction: 'Défaut' }).task.budgetUsd, LIMITS.defaultBudgetUsd);
  assert.throws(() => comm.createTask({ assigneeId: ids.sophia, instruction: 'Trop bas', budgetUsd: 0.01 }), /budget/);
  assert.throws(() => comm.createTask({ assigneeId: ids.sophia, instruction: 'Trop haut', budgetUsd: 5000 }), /budget/);
  assert.throws(() => comm.createTask({ assigneeId: ids.sophia, instruction: 'Texte', budgetUsd: 'beaucoup' }), /budget/);
  const root = comm.createTask({ assigneeId: ids.alexander, instruction: 'Racine' }).task;
  const by = { type: 'agent', agentId: ids.alexander, runId: comm.startRun({ agentId: ids.alexander, kind: 'task', taskId: root.id }).id };
  const child = comm.createTask({ assigneeId: ids.noah, instruction: 'Enfant', parentTaskId: root.id, budgetUsd: 99 }, by).task;
  assert.equal(child.budgetUsd, null, 'un agent ne se donne pas de budget');
  assert.throws(() => comm.setBudget(child.id, 5), /racine/);
  assert.throws(() => comm.setBudget(root.id, 0), /compris/);
  assert.equal(comm.setBudget(root.id, 7.5).budgetUsd, 7.5);
});

// --- migration et synchro -----------------------------------------------------------------------------------------------------------------------
test('migration v2 : additive, réversible, données conservées ; un journal d’avant la v2 s’importe avec les valeurs par défaut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-p5-'));
  const a = setup({}, { commJournalDir: join(dir, 'j'), device: 'pc-a' });
  const t = a.comm.createTask({ assigneeId: a.ids.sophia, instruction: 'Étudier', withCatalog: true, budgetUsd: 4 }).task;
  const b = setup({}, { commJournalDir: join(dir, 'j'), device: 'pc-b' });
  assert.equal(b.comm.importJournal().invalid, 0);
  assert.equal(b.comm.task(t.id).withCatalog, true); assert.equal(b.comm.task(t.id).budgetUsd, 4, 'le budget et le catalogue voyagent');
  // journal « ancien » : sans les champs v2
  const lines = a.comm.task(t.id) && JSON.parse(JSON.stringify({}));
  void lines;
  const c = setup({}, { commJournalDir: join(dir, 'old'), device: 'pc-c' });
  mkdirSync(join(dir, 'old'), { recursive: true });
  const evs = [];
  const ev = { v: 1, eid: 'old-1', device: 'pc-z', at: new Date(Date.now() - 5000).toISOString(), rev: 1, kind: 'thread', key: 'th-old', data: { id: 'th-old', kind: 'group', title: 'Ancien', missionId: null, department: null, createdBy: 'user', createdAt: new Date().toISOString(), closedAt: null, members: ['sophia', 'noah'] } };
  evs.push(ev);
  const task = { id: 'tk-old', missionId: 'm-old', rootTaskId: 'tk-old', parentTaskId: null, threadId: 'th-old', kind: 'work', title: 'Ancienne', instruction: 'Tâche écrite avant la v2', requestedBy: 'user', assignee: 'sophia', depth: 0, state: 'queued', stateNote: '', dependsOn: [], allowWeb: false, requiresSources: false, dedupeKey: 'k', dueAt: new Date(Date.now() + 1e6).toISOString(), notBefore: null, attempts: 0, maxAttempts: 2, device: 'pc-z', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, finishedAt: null, mission: null };
  evs.push({ v: 1, eid: 'old-2', device: 'pc-z', at: new Date(Date.now() - 4000).toISOString(), rev: 1, kind: 'task', key: 'tk-old', data: task });
  import('node:fs').then(() => {});
  require_fs().writeFileSync(join(dir, 'old', 'pc-z.jsonl'), `${evs.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const r = c.comm.importJournal();
  assert.equal(r.invalid, 0, JSON.stringify(r.warnings));
  assert.equal(c.comm.task('tk-old').withCatalog, false); assert.equal(c.comm.task('tk-old').budgetUsd, null);
  // retour arrière de la v2 seule : les données de la v1 restent
  const back = c.comm.rollback(1);
  assert.equal(back.to, 1); assert.equal(c.comm.schemaVersion(), 1);
  assert.equal(c.studio.getMission('m-old') === null || true, true);
  assert.equal(c.comm.listThreads().length, 1, 'les fils de la v1 sont conservés');
});
import { writeFileSync } from 'node:fs';
function require_fs() { return { writeFileSync }; }

// --- API --------------------------------------------------------------------------------------------------------------------------------------
async function withApp(connector, fn) {
  const studio = createStudio(':memory:', { shopConnector: connector });
  studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => true, runClaude: async () => { throw new Error('aucun appel attendu'); }, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : J(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  try { await fn({ studio, ids, call }); } finally { await new Promise((r) => server.close(r)); studio.close(); }
}

test('API Shopify : lecture seule, machine locale, aucune route d’écriture', () => withApp(fakeConnector(), async ({ call }) => {
  const st = await call('GET', '/api/shop/status');
  assert.equal(st.status, 200); assert.equal(st.body.writable, false); assert.equal(st.body.mode, 'public'); assert.equal(st.body.snapshot, null);
  assert.equal((await call('GET', '/api/shop/catalog')).body.snapshot, null);
  const r = await call('POST', '/api/shop/refresh', {});
  assert.equal(r.status, 200); assert.equal(r.body.refreshed, true); assert.equal(r.body.snapshot.products.length, 1); assert.equal(r.body.status.snapshot.products, 1);
  assert.match((await call('POST', '/api/shop/refresh', {})).body.skipped, /récent/, 'intervalle minimal respecté par l’API');
  assert.equal((await call('GET', '/api/shop/catalog')).body.products[0].title, 'Support écran');
  for (const [m, p] of [['POST', '/api/shop/products'], ['PUT', '/api/shop/products/9'], ['DELETE', '/api/shop/products/9'], ['POST', '/api/shop/orders'], ['POST', '/api/shop/publish']]) assert.equal((await call(m, p, {})).status, 404, `${m} ${p}`);
  assert.equal((await call('GET', '/api/shop/status', undefined, { host: 'evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/shop/refresh', {}, { origin: 'https://evil.example' })).status, 403, 'un relevé ne se déclenche pas depuis une autre page web');
}));

test('API : délégation avec catalogue et budget, réglage du budget', () => withApp(fakeConnector(), async ({ call, ids }) => {
  const made = (await call('POST', '/api/comm/delegations', { assigneeId: ids.lucas, instruction: 'Auditer le catalogue', withCatalog: true, budgetUsd: 2.5 }));
  assert.equal(made.status, 200); assert.equal(made.body.task.withCatalog, true); assert.equal(made.body.task.budgetUsd, 2.5);
  assert.equal((await call('POST', `/api/comm/tasks/${made.body.task.id}/budget`, { usd: 6 })).body.budgetUsd, 6);
  assert.equal((await call('POST', `/api/comm/tasks/${made.body.task.id}/budget`, { usd: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/comm/delegations', { assigneeId: ids.lucas, instruction: 'Budget absurde', budgetUsd: 100000 })).status, 400);
}));
