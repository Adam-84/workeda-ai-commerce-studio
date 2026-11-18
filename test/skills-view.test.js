import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, originLabel, tokenLabel, budgetLabel, filterSkills, groupByCategory, assignCheck, unassignCheck, copiesText, findingText, compatText, nextPatch } from '../public/skills-view.js';

const skills = [
  { name: 'workeda-calcul-marge', title: 'Calcul de marge', description: 'Calculer une marge nette', category: 'finance', status: 'active', roles: ['prix'], agents: [{ id: 'a1' }], dependsOn: [] },
  { name: 'workeda-etude-marche', title: 'Étude de marché', description: 'Analyser une tendance', category: 'recherche', status: 'active', roles: ['veille'], agents: [], dependsOn: [] },
  { name: 'ancien', title: 'Ancien', description: 'x', category: 'finance', status: 'archived', roles: [], agents: [], dependsOn: [] }
];
const categories = [{ slug: 'recherche', name: 'Recherche' }, { slug: 'finance', name: 'Finance' }];

test('libellés : statut, origine, jetons annoncés comme estimation', () => {
  assert.equal(statusLabel('archived'), 'Archivé');
  assert.equal(statusLabel('inconnu'), 'inconnu');
  assert.equal(originLabel('workeda'), 'Workeda');
  assert.equal(tokenLabel(120), '≈ 120 jetons');
  assert.equal(tokenLabel(undefined), '≈ 0 jetons');
  assert.match(budgetLabel(2, 4, 900), /2 \/ 4 Skills préchargés · ≈ 900 jetons \(estimation\)/);
});

test('filtre : texte sans accent ni casse, catégorie, statut, agent', () => {
  assert.deepEqual(filterSkills(skills, { query: 'etude' }).map((s) => s.name), ['workeda-etude-marche']);
  assert.deepEqual(filterSkills(skills, { query: 'PRIX' }).map((s) => s.name), ['workeda-calcul-marge']);
  assert.deepEqual(filterSkills(skills, { status: 'archived' }).map((s) => s.name), ['ancien']);
  assert.equal(filterSkills(skills, { status: '' }).length, 3);
  assert.deepEqual(filterSkills(skills, { category: 'finance' }).map((s) => s.name), ['workeda-calcul-marge']);
  assert.deepEqual(filterSkills(skills, { agent: 'a1' }).map((s) => s.name), ['workeda-calcul-marge']);
  assert.deepEqual(filterSkills(skills, { query: 'zzz' }), []);
});

test('regroupement : ordre des catégories, groupes vides omis, catégorie inconnue conservée', () => {
  const g = groupByCategory(filterSkills(skills, { status: '' }), categories);
  assert.deepEqual(g.map((x) => x.slug), ['recherche', 'finance']);
  assert.equal(g[1].skills.length, 2);
  const odd = groupByCategory([{ ...skills[0], category: 'autre' }], categories);
  assert.deepEqual(odd.map((x) => x.name), ['autre']);
});

test('ajout : refusé si déjà là, limite atteinte ou dépendance absente', () => {
  const a = { name: 'a', dependsOn: [] }, b = { name: 'b', dependsOn: ['a'] };
  assert.equal(assignCheck(a, [a], 4).ok, false);
  assert.equal(assignCheck(a, [{ name: 'x' }, { name: 'y' }], 2).ok, false);
  const missing = assignCheck(b, [], 4);
  assert.equal(missing.ok, false); assert.deepEqual(missing.missing, ['a']);
  assert.equal(assignCheck(b, [a], 4).ok, true);
});

test('retrait : refusé tant qu’un autre Skill préchargé en dépend', () => {
  const a = { name: 'a', dependsOn: [] }, b = { name: 'b', dependsOn: ['a'] };
  const r = unassignCheck(a, [a, b]);
  assert.equal(r.ok, false); assert.deepEqual(r.blockers, ['b']);
  assert.equal(unassignCheck(b, [a, b]).ok, true);
});

test('copies : résultat d’écriture et état de contrôle', () => {
  assert.equal(copiesText(null), '');
  assert.match(copiesText({ written: ['x', 'y'], skipped: ['z'], conflict: [] }), /^2 copies écrites, 1 déjà à jour\.$/);
  assert.match(copiesText({ written: ['x'], skipped: [], conflict: ['d'] }), /1 copie écrite, 0 déjà à jour, 1 dossier non géré laissé intact\./);
  assert.equal(copiesText({ inSync: true, missing: [], outdated: [], conflict: [] }), 'Copies Claude Code et Codex à jour.');
  assert.equal(copiesText({ inSync: false, missing: ['a'], outdated: ['b', 'c'], conflict: [] }), 'Copies à régénérer : 1 absente(s), 2 périmée(s).');
});

test('alertes et compatibilité en français', () => {
  assert.equal(findingText({ severity: 'bloquant', message: 'curl | sh' }), 'Bloquant : curl | sh');
  assert.equal(findingText({ severity: 'attention', message: 'x' }), 'Attention : x');
  assert.equal(findingText({ severity: 'info', message: 'y' }), 'Info : y');
  assert.equal(compatText({ ok: true, issues: [] }), 'compatible');
  assert.equal(compatText({ ok: false, issues: ['a', 'b'] }), 'à corriger (a ; b)');
  assert.equal(compatText(undefined), 'à corriger (non vérifié)');
});

test('version suivante : patch incrémenté, valeur illisible ramenée à 1.0.1', () => {
  assert.equal(nextPatch('1.0.9'), '1.0.10');
  assert.equal(nextPatch('2.3.0'), '2.3.1');
  assert.equal(nextPatch('v1'), '1.0.1');
  assert.equal(nextPatch(undefined), '1.0.1');
});
