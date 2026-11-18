// src/skills-cli.js — « npm run skills:check » (lecture seule) et « npm run skills:sync » (écrit les copies générées).
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { loadSkillLibrary, hasBlocking } from './skills.js';
import { loadAgentFiles } from './agent-files.js';
import { checkCopies, applyCopies, TARGETS } from './skills-sync.js';

// Problèmes qui rendent la configuration incohérente, indépendamment des copies générées.
export function auditSetup(library, profiles) {
  const problems = library.warnings.filter((w) => !w.reason.startsWith('fichiers annexes')).map((w) => `${w.file} : ${w.reason}`);
  const byName = new Map(library.skills.map((s) => [s.name, s]));
  for (const s of library.skills) {
    if (hasBlocking(s.findings)) problems.push(`${s.name} : ${s.findings.filter((f) => f.severity === 'bloquant').map((f) => f.message).join(' ; ')}`);
    for (const issue of [...new Set([...s.compat.claude.issues, ...s.compat.codex.issues])]) problems.push(`${s.name} : ${issue}`);
  }
  for (const p of profiles) for (const name of p.skills ?? []) {
    const s = byName.get(name);
    if (!s) problems.push(`.claude/agents/${p.slug}.md : Skill inconnu « ${name} »`);
    else if (s.archived) problems.push(`.claude/agents/${p.slug}.md : Skill archivé « ${name} »`);
    else for (const d of s.dependsOn) if (!(p.skills ?? []).includes(d)) problems.push(`.claude/agents/${p.slug}.md : « ${name} » dépend de « ${d} », qui n'est pas préchargé`);
  }
  return problems;
}

export function run(command, root, out = console.log) {
  const library = loadSkillLibrary(join(root, 'skills'));
  const { profiles, warnings } = loadAgentFiles(join(root, '.claude', 'agents'));
  const problems = [...auditSetup(library, profiles), ...warnings.map((w) => `.claude/agents/${w.file} : ${w.reason}`)];
  out(`${library.skills.length} Skills, ${profiles.length} fiches.`);
  if (command === 'sync') {
    if (problems.length) { for (const p of problems) out(`  ✗ ${p}`); out('Corrigez ces points avant de générer les copies.'); return 1; }
    const r = applyCopies(root, library, profiles);
    out(`Copies écrites : ${r.written.length} · déjà à jour : ${r.skipped.length} · copies désactivées (SKILL.md renommé en SKILL.md.inactive, rien supprimé) : ${r.deactivated.length} · dossiers non gérés laissés intacts : ${r.conflict.length}`);
    for (const c of r.conflict) out(`  ! ${TARGETS[c.target]}/${c.skill} existe et n'est pas géré par Archipel : non modifié`);
    return r.conflict.length ? 1 : 0;
  }
  const report = checkCopies(root, library, profiles);
  for (const p of problems) out(`  ✗ ${p}`);
  for (const k of ['missing', 'outdated', 'conflict']) for (const c of report[k]) out(`  ✗ ${k === 'missing' ? 'absent' : k === 'outdated' ? 'périmé' : 'non géré'} : ${TARGETS[c.target]}/${c.skill}`);
  for (const c of report.orphan) out(`  · en trop (sera désactivé, pas supprimé) : ${TARGETS[c.target]}/${c.skill}`);
  const ok = !problems.length && report.inSync && !report.conflict.length;
  out(ok ? 'Tout est cohérent.' : 'Écart détecté : « npm run skills:sync » régénère les copies (rien n’est supprimé).');
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!['check', 'sync'].includes(command)) { console.error('Usage : node src/skills-cli.js check|sync'); process.exit(2); }
  process.exitCode = run(command, resolve(fileURLToPath(import.meta.url), '..', '..'));
}
