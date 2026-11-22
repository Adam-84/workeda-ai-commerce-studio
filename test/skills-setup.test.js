import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillLibrary } from '../src/skills.js';
import { loadAgentFiles, MAX_PRELOADED } from '../src/agent-files.js';
import { checkCopies, TARGETS } from '../src/skills-sync.js';
import { auditSetup } from '../src/skills-cli.js';

// Lecture seule sur le vrai dépôt : ces tests échouent si skills/, les fiches et les copies générées divergent.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const library = loadSkillLibrary(join(ROOT, 'skills'));
const { profiles, warnings } = loadAgentFiles(join(ROOT, '.claude', 'agents'));
const norm = (t) => t.replace(/\r\n?/g, '\n');

test('dépôt : la bibliothèque et les fiches se chargent sans avertissement', () => {
  assert.deepEqual(warnings, []);
  assert.deepEqual(library.warnings.filter((w) => !w.reason.startsWith('fichiers annexes')), []);
  assert.equal(profiles.length, 11);
  assert.ok(library.skills.length >= 10);
});

test('dépôt : la configuration est cohérente (aucun problème, Skills inconnus, bloquants ou dépendances manquantes)', () => {
  assert.deepEqual(auditSetup(library, profiles), []);
});

test('dépôt : aucun Skill ne contient de contenu bloquant ni de champ de permission', () => {
  for (const s of library.skills) {
    assert.deepEqual(s.findings.filter((f) => f.severity === 'bloquant'), [], s.name);
    assert.ok(s.compat.claude.ok && s.compat.codex.ok, `${s.name} : ${[...s.compat.claude.issues, ...s.compat.codex.issues]}`);
  }
});

test('dépôt : chaque agent précharge de 1 à 4 Skills existants et actifs', () => {
  const byName = new Map(library.skills.map((s) => [s.name, s]));
  for (const p of profiles) {
    assert.ok(p.skills.length >= 1 && p.skills.length <= MAX_PRELOADED, `${p.slug} : ${p.skills.length} Skills`);
    assert.equal(new Set(p.skills).size, p.skills.length, `${p.slug} : doublon`);
    for (const name of p.skills) {
      assert.ok(byName.has(name), `${p.slug} : « ${name} » inconnu`);
      assert.equal(byName.get(name).archived, false, `${p.slug} : « ${name} » archivé`);
    }
  }
});

test('dépôt : le coût de préchargement par agent reste borné (estimation)', () => {
  const byName = new Map(library.skills.map((s) => [s.name, s]));
  for (const p of profiles) {
    const total = p.skills.reduce((n, name) => n + byName.get(name).tokens, 0);
    assert.ok(total <= 4000, `${p.slug} : environ ${total} jetons préchargés`);
  }
});

test('dépôt : les Skills ne donnent aucune permission — les fiches n’ont pas l’outil Skill ni d’outils en plus', () => {
  for (const p of profiles) {
    const tools = [].concat(p.tools).map(String);
    assert.ok(!tools.some((t) => /^skill$/i.test(t.trim())), `${p.slug} : l’outil Skill ne doit pas être accordé`);
  }
  // Les écritures et le shell restent réservés à Ryan (écriture/édition) et Harper (Bash) comme avant les Skills.
  const can = (slug, tool) => [].concat(profiles.find((p) => p.slug === slug).tools).map(String).includes(tool);
  for (const p of profiles) {
    if (p.slug !== 'ryan') assert.equal(can(p.slug, 'Edit'), false, `${p.slug} ne doit pas pouvoir éditer`);
    if (!['ryan', 'harper'].includes(p.slug)) assert.equal(can(p.slug, 'Bash'), false, `${p.slug} ne doit pas avoir Bash`);
  }
});

test('dépôt : les copies générées sont à jour, gérées par Archipel et identiques à skills/', () => {
  const report = checkCopies(ROOT, library, profiles);
  assert.deepEqual({ missing: report.missing, outdated: report.outdated, conflict: report.conflict }, { missing: [], outdated: [], conflict: [] });
  assert.equal(report.inSync, true);
});

test('dépôt : .claude/skills contient exactement les Skills préchargés, .agents/skills tous les Skills actifs', () => {
  const used = new Set(profiles.flatMap((p) => p.skills));
  const active = library.skills.filter((s) => !s.archived).map((s) => s.name);
  const list = (target) => readdirSync(join(ROOT, TARGETS[target]), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(list('claude'), active.filter((n) => used.has(n)).sort());
  assert.deepEqual(list('codex'), [...active].sort());
  for (const target of ['claude', 'codex']) for (const name of list(target)) {
    const copy = readFileSync(join(ROOT, TARGETS[target], name, 'SKILL.md'), 'utf8');
    assert.equal(norm(copy), library.skills.find((s) => s.name === name).content, `${TARGETS[target]}/${name}`);
    assert.deepEqual(readdirSync(join(ROOT, TARGETS[target], name)).sort(), ['.archipel-managed', 'SKILL.md'], `${TARGETS[target]}/${name} : fichiers inattendus`);
  }
});

test('dépôt : le catalogue décrit exactement les dossiers de skills/ (aucun Skill orphelin ni fantôme)', () => {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'skills', 'catalog.json'), 'utf8'));
  const inCatalog = catalog.skills.map((s) => s.name).sort();
  const onDisk = readdirSync(join(ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(inCatalog, onDisk);
  const categories = new Set(catalog.categories.map((c) => c.slug));
  for (const s of catalog.skills) {
    assert.ok(categories.has(s.category), `${s.name} : catégorie inconnue`);
    assert.match(s.version, /^\d+\.\d+\.\d+$/, `${s.name} : version`);
    assert.ok(existsSync(join(ROOT, 'skills', s.name, 'SKILL.md')));
  }
});
