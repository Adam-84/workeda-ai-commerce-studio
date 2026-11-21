// Correctifs D1 à D4 issus de la mission de validation réelle de la phase 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { LIMITS, parseAgentOutput, evaluateResult, taskPrompt } from '../src/comm-core.js';
import { catalogPrompt } from '../src/shop-readonly.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const J = JSON.stringify;
const connector = { mode: 'public', domain: 'workeda.com', hasToken: false, misconfigured: false, async fetchCatalog() { return { mode: 'public', domain: 'workeda.com', collections: [], products: [], errors: [], sourceUrls: [], ok: false, partial: true }; } };
function setup(script) {
  const studio = createStudio(':memory:', { shopConnector: connector });
  studio.syncAgentFiles(profiles);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const calls = [];
  const runner = async (o) => { const name = /^Tu es ([^,]+),/.exec(o.system)?.[1]; calls.push({ name, ...o }); const s = script[name]; if (typeof s === 'function') return s(o, calls); return s; };
  return { studio, comm: studio.comm, ids, calls, orch: createOrchestrator({ studio, profiles: () => profiles, runner }) };
}

test('D1. un rapport trop long est tronqué AVEC un marqueur, signalé, et n’est jamais « terminé »', async () => {
  const p = parseAgentOutput(J({ report: 'x'.repeat(LIMITS.result + 5000) }));
  assert.equal(p.truncated, true); assert.ok(p.report.length <= LIMITS.result); assert.match(p.report, /RAPPORT TRONQUÉ PAR LE STUDIO : \d+ caractères produits/);
  assert.equal(parseAgentOutput(J({ report: 'court' })).truncated, false);
  assert.equal(parseAgentOutput('y'.repeat(LIMITS.result + 1)).truncated, true, 'même en texte libre');
  const v = evaluateResult({ task: { kind: 'work', requiresSources: false }, parsed: p, observed: {} });
  assert.equal(v.verified, false); assert.match(v.verification, /tronqué par le Studio .* la fin manque/);
  // de bout en bout : la tâche passe « à vérifier », jamais « terminée »
  const { comm, ids, orch } = setup({ Lucas: () => J({ report: 'z'.repeat(LIMITS.result + 100) }) });
  const t = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit très long' }).task;
  orch.pump(); await orch.idle();
  assert.equal(comm.task(t.id).state, 'review'); assert.match(comm.task(t.id).stateNote, /tronqué/);
  assert.match(comm.resultOf(t.id).body, /RAPPORT TRONQUÉ/);
  assert.ok(comm.listMessages(t.threadId).items.some((m) => m.kind === 'result' && /à vérifier/.test(m.body)));
  // la consigne annonce la limite à l'agent
  assert.match(taskPrompt({ task: { instruction: 'x', depth: 0, title: 't' }, requester: { type: 'user' }, mission: { title: 't' } }), /au plus 20 000 caractères/);
});

test('D2. une tâche sans web a 10 minutes ; une simple réponse de fil garde 3 minutes', async () => {
  assert.equal(LIMITS.taskTimeoutMs, 600_000); assert.equal(LIMITS.plainTimeoutMs, 180_000);
  const { comm, ids, orch, calls } = setup({ Lucas: () => J({ report: 'ok' }), Noah: 'Bien reçu.' });
  comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit complet' });
  orch.pump(); await orch.idle();
  assert.equal(calls[0].timeoutMs, LIMITS.taskTimeoutMs);
  const th = comm.createThread({ kind: 'direct', members: [ids.noah] });
  comm.postMessage(th.id, { body: 'Bonjour' });
  orch.replyInThread(th.id, ids.noah); await orch.idle();
  assert.equal(calls.at(-1).timeoutMs, LIMITS.plainTimeoutMs);
});

test('D3. une exécution interrompue sans coût rapporté compte une estimation prudente dans le budget', async () => {
  const was = LIMITS.backoffMs; LIMITS.backoffMs = 0;
  try {
    const { comm, ids, orch } = setup({ Lucas: () => { throw new Error('Claude n’a pas répondu à temps (3 minutes). Réessayez.'); } });
    const root = comm.createTask({ assigneeId: ids.lucas, instruction: 'Audit', budgetUsd: 0.3 }).task;
    orch.pump(); await orch.idle();
    const t = comm.task(root.id);
    assert.equal(comm.getRun(comm.recentRuns(1)[0].id).costUsd, null, 'le coût réel est inconnu');
    assert.equal(t.unreportedRuns, 2, 'deux tentatives interrompues');
    assert.equal(t.spentUsd, 2 * LIMITS.unreportedRunUsd, 'comptées à l’estimation, jamais à 0');
    assert.equal(t.state, 'failed');
    // un coût rapporté n'est pas doublé par l'estimation
    const r = comm.startRun({ agentId: ids.lucas, kind: 'task', taskId: root.id }); comm.endRun(r.id, { state: 'error', error: 'panne', costUsd: 0.1 });
    assert.equal(comm.task(root.id).unreportedRuns, 2); assert.equal(comm.task(root.id).spentUsd, 0.6);
  } finally { LIMITS.backoffMs = was; }
});

test('D4. toutes les étiquettes utiles sont listées ; le surplus est annoncé, jamais caché', () => {
  const snap = (tags) => ({ domain: 'workeda.com', fetchedAt: '2026-11-21T10:00:00.000Z', mode: 'public', collections: [], errors: [], products: [{ title: 'P', handle: 'p', type: '', tags, priceMin: 1, priceMax: 1, currency: null, available: true, images: 1, descChars: 10 }] });
  const five = catalogPrompt(snap(['a', 'b', 'c', 'd', 'e']));
  assert.match(five, /5 tag\(s\): a, b, c, d, e \|/, 'les 5 étiquettes sont listées (plus de « 5 » annoncés pour 4 affichés)');
  assert.match(catalogPrompt(snap(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])), /8 tag\(s\): a, b, c, d, e, f \(\+2 autres\)/);
  assert.match(catalogPrompt(snap([])), /0 tag\(s\) \|/);
});
