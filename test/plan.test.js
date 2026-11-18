import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { parsePlan, planPrompt } from '../src/claude-reply.js';

const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'workeda-plan-')); return { dir, file: join(dir, 'studio.db') }; };

test('plan versions are frozen, decisions target one version, progress is declared by hand and survives a restart', () => {
  const { dir, file } = temp();
  try {
    let studio = createStudio(file);
    const departmentId = studio.listDepartments()[0].id;
    const [lucas, harper] = ['Lucas', 'Harper'].map((name) => studio.hireAgent({ name, role: 'Test', departmentId }));
    const m = studio.createMission({ title: 'Audit', assignedTo: lucas.id });
    assert.equal(studio.currentPlan(m.id), null);
    const v1 = studio.savePlan(m.id, { steps: [{ action: 'Lister les fiches', agentId: lucas.id }, { action: 'Relire', agentId: harper.id, expected: 'Liste relue' }], missing: 'Export du catalogue' });
    assert.deepEqual([v1.version, v1.status, v1.origin, v1.steps.map((s) => s.state)], [1, 'proposed', 'user', ['todo', 'todo']]);
    const validated = studio.decidePlan(m.id, v1.id, { decision: 'validated', note: 'OK' });
    assert.equal(validated.status, 'validated');
    const doing = studio.setStepState(m.id, v1.id, v1.steps[0].id, 'doing');
    assert.equal(doing.steps[0].state, 'doing'); assert.ok(doing.steps[0].stateUpdatedAt);
    assert.equal(doing.status, 'validated'); assert.equal(doing.version, 1); // l'avancement ne crée pas de version
    // Modifier un plan validé : nouvelle version à valider, réordonnée, responsable changé, une étape ajoutée ; v1 intacte.
    const [a, b] = doing.steps;
    const v2 = studio.savePlan(m.id, { steps: [{ ...b, agentId: lucas.id }, a, { action: 'Synthèse' }], missing: '' });
    assert.deepEqual([v2.version, v2.status], [2, 'proposed']);
    assert.deepEqual(v2.steps.map((s) => s.action), ['Relire', 'Lister les fiches', 'Synthèse']);
    assert.deepEqual(v2.steps.map((s) => s.state), ['todo', 'doing', 'todo']); // l'état suit l'étape
    assert.equal(v2.steps[1].id, a.id);
    assert.throws(() => studio.decidePlan(m.id, v1.id, { decision: 'validated' }), /plus la version courante/);
    assert.throws(() => studio.setStepState(m.id, v1.id, a.id, 'done'), /version courante/);
    const v3 = studio.savePlan(m.id, { steps: [v2.steps[0]] }); // étapes retirées
    assert.equal(v3.steps.length, 1);
    for (const input of [{ steps: [] }, { steps: [{ action: ' ' }] }, { steps: [{ action: 'x', state: 'finie' }] }, { steps: [{ action: 'x', agentId: 'inconnu' }] }, { steps: 'x' }])
      assert.throws(() => studio.savePlan(m.id, input));
    assert.throws(() => studio.setStepState(m.id, v3.id, v3.steps[0].id, 'presque'), /État invalide/);
    assert.throws(() => studio.decidePlan(m.id, v3.id, { decision: 'peut-être' }), /Décision invalide/);
    studio.decidePlan(m.id, v3.id, { decision: 'rejected', note: 'Trop court' });
    studio.close();
    studio = createStudio(file); // redémarrage
    const plans = studio.listPlans(m.id);
    assert.deepEqual(plans.map((p) => [p.version, p.status]), [[3, 'rejected'], [2, 'proposed'], [1, 'validated']]);
    assert.equal(plans[2].steps[0].state, 'doing');
    assert.equal(plans[2].decisions[0].note, 'OK');
    assert.equal(plans[0].decisions[0].note, 'Trop court');
    studio.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the plan text never passes a proposal off as a decision, and a model answer is read safely', () => {
  const names = (id) => ({ a: 'Lucas' })[id] ?? 'Agent';
  const plan = { version: 2, status: 'proposed', decisions: [], decidedAt: null, missing: '- Export', steps: [{ action: 'Lister', agentId: 'a', state: 'done', expected: 'Liste', prerequisites: '' }] };
  assert.match(planPrompt(plan, names), /version 2 — PROPOSITION NON VALIDÉE : ne la présente jamais comme une décision/);
  assert.match(planPrompt(plan, names), /1\. Lister — responsable : Lucas ; état : terminée ; résultat attendu : Liste/);
  assert.match(planPrompt(plan, names), /déclarés par l'utilisateur/);
  const ok = planPrompt({ ...plan, status: 'validated', decidedAt: '2026-11-18T10:00:00.000Z' }, names);
  assert.match(ok, /VALIDÉ par l'utilisateur .* ne lance aucune étape et n'accorde aucun outil ni accès/);
  assert.doesNotMatch(ok, /PROPOSITION/);
  assert.equal(planPrompt(null, names), 'Plan d’action : aucun plan pour le moment.');
  const agents = [{ id: 'a', name: 'Lucas' }];
  const parsed = parsePlan('Voici :\n{"steps":[{"action":"Lister","agent":"lucas","expected":"Liste"},{"action":"Payer","agent":"Inconnu"}],"missing":["Export"]}\nFin', agents);
  assert.deepEqual(parsed.steps.map((s) => s.agentId), ['a', null]);
  assert.match(parsed.missing, /- Export\n- Responsable « Inconnu » inconnu/);
  assert.throws(() => parsePlan('pas de json', agents), /pas lisible/);
  assert.throws(() => parsePlan('{"steps":[]}', agents), /aucune étape/);
});

test('the responsible agent proposes and revises on request; every agent then reads the current plan and its status', async () => {
  const { dir, file } = temp();
  const studio = createStudio(file);
  const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
  studio.syncAgentFiles(profiles);
  const id = (slug) => studio.listAgentFiles().find((l) => l.slug === slug).agentId;
  const lucas = id('lucas'), harper = id('harper');
  const calls = [];
  let answer = '{"steps":[{"action":"Lister les tapis","agent":"Lucas","expected":"Liste","prerequisites":"Export"},{"action":"Relire","agent":"Harper"}],"missing":["Export des fiches"]}';
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false, runClaude: async (o) => { calls.push(o); o.onText(answer.slice(0, 10)); return answer; }, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) });
  const events = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  try {
    const orphan = studio.createMission({ title: 'Sans responsable' });
    assert.equal((await post(`/api/missions/${orphan.id}/plan/propose`)).status, 400);
    const m = studio.createMission({ title: 'Audit tapis', assignedTo: lucas, collaborators: [harper], objective: 'Fiches complètes', constraints: 'Aucune modification sans accord' });
    assert.equal((await post(`/api/missions/${m.id}/plan/propose`, { revision: 'x' })).status, 400); // rien à réviser
    studio.addMemory(m.id, { kind: 'decision', body: 'Les tapis berbères d’abord' });
    studio.postDiscussion(m.id, { body: 'Pensez aux photos' });
    studio.setInstructions(lucas, { preferences: 'Présente tes propositions avant toute modification.' });
    const first = await events(await post(`/api/missions/${m.id}/plan/propose`));
    assert.equal(first.at(-1).type, 'done');
    const v1 = first.at(-1).message;
    assert.deepEqual([v1.version, v1.status, v1.origin, v1.authorAgentId, v1.steps.map((s) => s.agentId)], [1, 'proposed', 'ai', lucas, [lucas, harper]]);
    assert.match(v1.missing, /Export des fiches/);
    const ask = calls[0];
    for (const re of [/Objectif : Fiches complètes/, /Contraintes : Aucune modification sans accord/, /Les tapis berbères d’abord/, /Pensez aux photos/, /PROPOSITION de plan/, /choisi parmi : Lucas, Harper/]) assert.match(ask.prompt, re);
    assert.match(ask.system, /Présente tes propositions avant toute modification/); // consignes du responsable
    answer = '{"steps":[{"action":"Photos d’abord","agent":"Harper"}],"missing":[]}';
    const second = await events(await post(`/api/missions/${m.id}/plan/propose`, { revision: 'Commence par les photos' }));
    const v2 = second.at(-1).message;
    assert.deepEqual([v2.version, v2.revisionNote, v2.status], [2, 'Commence par les photos', 'proposed']);
    assert.match(calls[1].prompt, /révision du plan courant avec ces indications :\nCommence par les photos/);
    assert.match(calls[1].prompt, /Plan d'action, version 1 — PROPOSITION NON VALIDÉE/); // le responsable voit le plan à réviser
    answer = 'Pas de JSON ici';
    const broken = await events(await post(`/api/missions/${m.id}/plan/propose`));
    assert.equal(broken.at(-1).type, 'error');
    assert.equal(studio.listPlans(m.id).length, 2); // rien d'enregistré
    // Les agents reçoivent la version courante et son statut, en Discussion comme dans le fil d'équipe.
    answer = 'J’ai terminé l’étape 1.';
    await post(`/api/missions/${m.id}/discussion`, { body: 'Où en êtes-vous ?' });
    await (await post(`/api/missions/${m.id}/discussion/reply/${harper}`)).text();
    assert.match(calls.at(-1).prompt, /Plan d'action, version 2 — PROPOSITION NON VALIDÉE/);
    assert.equal(studio.currentPlan(m.id).steps[0].state, 'todo'); // une réponse d'agent ne déclare rien
    const decided = await (await post(`/api/missions/${m.id}/plans/${v2.id}/decision`, { decision: 'validated' })).json();
    assert.equal(decided.status, 'validated');
    await fetch(`${base}/api/missions/${m.id}/plans/${v2.id}/steps/${v2.steps[0].id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'blocked' }) });
    await post(`/api/agents/${lucas}/conversation`, { body: 'Le plan ?' });
    await (await post(`/api/agents/${lucas}/reply`)).text();
    assert.match(calls.at(-1).prompt, /version 2 — VALIDÉ par l'utilisateur .* n'accorde aucun outil ni accès/);
    assert.match(calls.at(-1).prompt, /Photos d’abord — responsable : Harper ; état : bloquée/);
    assert.equal((await fetch(`${base}/api/missions/${m.id}/plans`)).status, 200);
  } finally { await new Promise((r) => server.close(r)); studio.close(); rmSync(dir, { recursive: true, force: true }); }
});
