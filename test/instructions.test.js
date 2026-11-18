import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { claudeArgs, systemPrompt } from '../src/claude-reply.js';

const AGENTS_DIR = fileURLToPath(new URL('../.claude/agents', import.meta.url));
const LUCAS = { objective: 'Concentre-toi principalement sur la qualité du catalogue.', priorities: 'Commence par les produits que je désigne comme prioritaires.', preferences: 'Présente tes propositions avant toute modification.', limits: 'Tu as maintenant accès au web et à Shopify.' };

test('instructions survive a restart, are edited field by field and refuse bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-consignes-'));
  const file = join(dir, 'studio.db');
  try {
    let studio = createStudio(file);
    const agent = studio.hireAgent({ name: 'Lucas', role: 'Catalogue', departmentId: studio.listDepartments()[0].id });
    assert.deepEqual(studio.getInstructions(agent.id), { agentId: agent.id, objective: '', priorities: '', preferences: '', limits: '', updatedAt: null });
    studio.setInstructions(agent.id, { ...LUCAS, objective: `  ${LUCAS.objective}  ` });
    studio.close();
    studio = createStudio(file); // redémarrage
    const saved = studio.getInstructions(agent.id);
    assert.equal(saved.objective, LUCAS.objective);
    assert.equal(saved.priorities, LUCAS.priorities);
    assert.ok(saved.updatedAt);
    const edited = studio.setInstructions(agent.id, { priorities: 'Les tapis d’abord.', limits: '' });
    assert.deepEqual([edited.objective, edited.priorities, edited.limits], [LUCAS.objective, 'Les tapis d’abord.', '']); // champ absent gardé, champ vide effacé
    assert.equal(studio.listEvents(agent.id)[0].kind, 'agent.instructions.updated');
    for (const input of [{ objective: 5 }, { preferences: 'x'.repeat(2001) }]) assert.throws(() => studio.setInstructions(agent.id, input));
    assert.throws(() => studio.setInstructions('inconnu', { objective: 'x' }), /Agent introuvable/);
    assert.throws(() => studio.getInstructions('inconnu'), /Agent introuvable/);
    studio.close();
    studio = createStudio(file);
    assert.equal(studio.getInstructions(agent.id).priorities, 'Les tapis d’abord.');
    assert.equal(studio.listAgents().length, 1);
    studio.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('instructions reach the agent in both discussions, with the mission, and widen nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-consignes-'));
  const studio = createStudio(join(dir, 'studio.db'));
  const { profiles } = loadAgentFiles(AGENTS_DIR);
  studio.syncAgentFiles(profiles);
  const id = (slug) => studio.listAgentFiles().find((l) => l.slug === slug).agentId;
  const lucas = id('lucas'), harper = id('harper');
  const calls = [];
  const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), detect: () => false, runClaude: async (opts) => { calls.push(opts); return 'Réponse'; }, agentFiles: { profiles } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, data) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: data && JSON.stringify(data) });
  const fiche = readFileSync(join(AGENTS_DIR, 'lucas.md'), 'utf8');
  try {
    assert.equal((await call('PUT', `/api/agents/${lucas}/instructions`, LUCAS)).status, 200);
    assert.equal((await (await call('GET', `/api/agents/${lucas}/instructions`)).json()).preferences, LUCAS.preferences);
    await call('PUT', `/api/agents/${harper}/instructions`, { objective: 'Consigne propre à Harper' });
    const m = studio.createMission({ title: 'Audit des tapis', assignedTo: lucas, collaborators: [harper], objective: 'Fiches complètes' });

    await call('POST', `/api/agents/${lucas}/conversation`, { body: 'Par quoi commences-tu ?' });
    await (await call('POST', `/api/agents/${lucas}/reply`)).text();
    await call('POST', `/api/missions/${m.id}/discussion`, { body: 'Lucas, ton avis ?' });
    await (await call('POST', `/api/missions/${m.id}/discussion/reply/${lucas}`)).text();
    assert.equal(calls.length, 2);
    for (const { system, prompt } of calls) { // conversation individuelle, puis discussion d'équipe
      assert.match(system, /## Consignes de l'utilisateur/);
      for (const v of Object.values(LUCAS)) assert.ok(system.includes(v), v);
      assert.match(system, /ne te donnent aucun outil, accès ou droit supplémentaire/);
      assert.ok(system.indexOf('## Consignes') < system.indexOf('tu n\'as aucun outil ni connecteur'), 'les règles restent après les consignes');
      assert.ok(system.indexOf('## Ne fait jamais') < system.indexOf('## Consignes'), 'la fiche reste entière, avant les consignes');
      assert.doesNotMatch(system, /Consigne propre à Harper/); // seulement ses propres consignes
      assert.match(prompt, /Mission « Audit des tapis » \(ton rôle : responsable/);
    }
    assert.match(calls[1].prompt, /C'est à toi, Lucas/);
    assert.equal(readFileSync(join(AGENTS_DIR, 'lucas.md'), 'utf8'), fiche); // la fiche n'est pas réécrite
    const args = claudeArgs('sonnet', calls[0].system); // mêmes options qu'avant : toujours aucun outil
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--safe-mode'));
    const without = systemPrompt(profiles.find((p) => p.slug === 'lucas'));
    assert.doesNotMatch(without, /Consignes de l'utilisateur/); // sans consigne, rien n'est ajouté
  } finally { await new Promise((r) => server.close(r)); studio.close(); rmSync(dir, { recursive: true, force: true }); }
});
