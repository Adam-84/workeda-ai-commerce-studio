// src/skills-sync.js — copies générées de skills/ vers les dossiers lus par Claude Code (.claude/skills) et Codex
// (.agents/skills), et écriture de la ligne `skills:` d'une fiche. Règles : seul SKILL.md est copié, un dossier qui
// n'est pas géré par Archipel n'est jamais écrasé, rien n'est jamais supprimé, aucun script n'est exécuté.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentFile, MAX_PRELOADED } from './agent-files.js';
import { hasBlocking } from './skills.js';

export const MARKER = '.archipel-managed';
const INACTIVE = 'SKILL.md.inactive';
const MARKER_TEXT = 'Copie générée par Archipel depuis skills/<nom>/SKILL.md. Modifier la source dans skills/, puis relancer « npm run skills:sync ».\n';
export const TARGETS = { claude: '.claude/skills', codex: '.agents/skills' };

const read = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const norm = (t) => String(t).replace(/\r\n?/g, '\n');

// Ce qui devrait exister : .claude/skills = Skills préchargés par au moins une fiche ; .agents/skills = tous les actifs.
export function desiredCopies(library, profiles) {
  const used = new Set(profiles.flatMap((p) => p.skills ?? []));
  // Jamais de copie d'un Skill bloqué (en-tête de permission, commande dangereuse) ni dont le nom est invalide pour l'outil visé.
  const active = library.skills.filter((s) => !s.archived && !hasBlocking(s.findings));
  return {
    claude: active.filter((s) => used.has(s.name) && s.compat.claude.ok),
    codex: active.filter((s) => s.compat.codex.ok)
  };
}

function inspect(root, target, skill) {
  const dir = join(root, TARGETS[target], skill.name);
  const file = join(dir, 'SKILL.md');
  if (!existsSync(dir)) return { state: 'missing', dir, file };
  if (!existsSync(join(dir, MARKER))) return { state: 'conflict', dir, file };
  const current = read(file);
  if (current === null) return { state: 'missing', dir, file };
  return { state: norm(current) === norm(skill.content) ? 'ok' : 'outdated', dir, file };
}

// Compare sans rien écrire.
export function checkCopies(root, library, profiles) {
  const wanted = desiredCopies(library, profiles);
  const report = { ok: [], missing: [], outdated: [], conflict: [], orphan: [] };
  for (const target of Object.keys(TARGETS)) {
    const names = new Set(wanted[target].map((s) => s.name));
    for (const s of wanted[target]) report[inspect(root, target, s).state].push({ target, skill: s.name });
    const base = join(root, TARGETS[target]);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      // Une copie générée dont le SKILL.md est déjà désactivé n'est plus lue par les outils : ce n'est plus un écart.
      if (e.isDirectory() && !names.has(e.name) && existsSync(join(base, e.name, MARKER)) && existsSync(join(base, e.name, 'SKILL.md'))) report.orphan.push({ target, skill: e.name });
    }
  }
  report.inSync = !report.missing.length && !report.outdated.length && !report.conflict.length;
  return report;
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Écrit les copies manquantes ou périmées. Un conflit (dossier non géré) est signalé et laissé intact.
export function applyCopies(root, library, profiles) {
  const wanted = desiredCopies(library, profiles);
  const result = { written: [], skipped: [], conflict: [], deactivated: [] };
  for (const target of Object.keys(TARGETS)) {
    const base = join(root, TARGETS[target]);
    // Copie générée qui ne doit plus exister (Skill archivé, retiré des fiches ou bloqué) : on la rend illisible pour
    // les outils en renommant son SKILL.md, sans rien supprimer. Les dossiers non gérés ne sont jamais touchés.
    if (existsSync(base)) {
      const names = new Set(wanted[target].map((s) => s.name));
      for (const e of readdirSync(base, { withFileTypes: true })) {
        const dir = join(base, e.name);
        if (!e.isDirectory() || names.has(e.name) || !existsSync(join(dir, MARKER)) || !existsSync(join(dir, 'SKILL.md'))) continue;
        renameSync(join(dir, 'SKILL.md'), join(dir, INACTIVE));
        result.deactivated.push({ target, skill: e.name });
      }
    }
    for (const s of wanted[target]) {
      let i = inspect(root, target, s);
      // Skill de nouveau voulu : on réactive l'ancienne copie désactivée, puis on la compare au contenu actuel.
      if (i.state === 'missing' && existsSync(join(i.dir, MARKER)) && existsSync(join(i.dir, INACTIVE))) { renameSync(join(i.dir, INACTIVE), i.file); i = inspect(root, target, s); }
      if (i.state === 'ok') { result.skipped.push({ target, skill: s.name }); continue; }
      if (i.state === 'conflict') { result.conflict.push({ target, skill: s.name }); continue; }
      mkdirSync(i.dir, { recursive: true });
      atomicWrite(i.file, s.content);
      if (!existsSync(join(i.dir, MARKER))) writeFileSync(join(i.dir, MARKER), MARKER_TEXT);
      result.written.push({ target, skill: s.name });
    }
  }
  return result;
}

// Réécrit seulement la ligne `skills:` d'une fiche. La nouvelle fiche doit être valide avant d'être écrite.
export function setFicheSkills(agentsDir, slug, skills) {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('Fiche invalide.');
  if (skills.length > MAX_PRELOADED) throw new Error(`${MAX_PRELOADED} Skills préchargés au maximum par agent (chaque Skill est injecté en entier à chaque mission).`);
  const file = join(agentsDir, `${slug}.md`);
  if (!existsSync(file) || !statSync(file).isFile()) throw Object.assign(new Error('Fiche introuvable.'), { status: 404 });
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  if (lines[0].replace(/^﻿/, '') !== '---') throw new Error('Fiche illisible : en-tête absent.');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('Fiche illisible : en-tête non fermé.');
  const value = `skills: [${skills.join(', ')}]`;
  const at = lines.slice(0, end).findIndex((l, i) => i > 0 && /^skills\s*:/.test(l));
  const next = [...lines];
  if (at >= 0) next[at] = value;
  else {
    const after = lines.slice(0, end).findLastIndex((l) => /^connectors\s*:|^collaborates\s*:/.test(l));
    next.splice(after >= 0 ? after + 1 : end, 0, value);
  }
  const text = next.join(eol);
  const check = parseAgentFile(text, `${slug}.md`);
  if (check.error) throw new Error(`La fiche ne serait plus valide : ${check.error}`);
  if (text !== raw) atomicWrite(file, text);
  return check.profile;
}
