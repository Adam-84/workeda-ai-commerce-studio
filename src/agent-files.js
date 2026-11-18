// src/agent-files.js — lecture des fiches d'agents (.claude/agents/*.md), sans effet sur la base.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SECTIONS = [['Métier', 'metier'], ['Ne fait jamais', 'neFaitJamais'], ['Missions', 'missions'], ['Règles', 'regles'], ['Méthode', 'methode'], ['Livrable', 'livrable'], ['Relais', 'relais'], ['Réussite', 'reussite']];
export const REQUIRED = ['name', 'description', 'tools', 'model', 'display_name', 'role', 'department', 'collaborates'];
export const MODELS = ['opus', 'sonnet', 'haiku'];
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_PRELOADED = 4; // un Skill préchargé est injecté en entier : on borne le coût en jetons
const list = (value) => (value ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export function parseAgentFile(text, filename) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!m) return { error: 'en-tête --- absent' };
  const head = {};
  let skills = [];
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 1) return { error: `ligne d'en-tête illisible : « ${line} »` };
    const key = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
    if (Object.hasOwn(head, key)) return { error: `clé en double : ${key}` };
    if (key === 'skills') { // liste YAML entre crochets : skills: [nom-un, nom-deux]
      if (!/^\[[a-z0-9, -]*\]$/.test(value)) return { error: 'skills doit être une liste entre crochets, par exemple [nom-un, nom-deux]' };
      const items = value.slice(1, -1).split(',').map((x) => x.trim());
      if (items.length === 1 && !items[0]) items.pop();
      if (items.some((x) => !SKILL_NAME.test(x))) return { error: 'skills : nom de Skill invalide (minuscules, chiffres et tirets)' };
      if (new Set(items).size !== items.length) return { error: 'skills : un Skill est cité deux fois' };
      if (items.length > MAX_PRELOADED) return { error: `skills : ${MAX_PRELOADED} Skills préchargés au maximum (chaque Skill est injecté en entier à chaque mission)` };
      skills = items; head.skills = value;
      continue;
    }
    if (value.includes(': ')) return { error: `la valeur de « ${key} » contient un deux-points suivi d'une espace, que Claude Code ne sait pas lire` };
    if (value.endsWith(':') || value.includes(' #') || /^["'#[{>|&*!%@`]/.test(value)) return { error: `la valeur de « ${key} » contient une suite que Claude Code (YAML) lit mal` };
    head[key] = value;
  }
  const missing = REQUIRED.find((k) => !head[k]);
  if (missing) return { error: `clé obligatoire manquante : ${missing}` };
  const slug = filename.replace(/\.md$/i, '');
  if (!/^[a-z][a-z0-9-]*$/.test(head.name)) return { error: 'nom invalide : minuscules, chiffres et tirets seulement' };
  if (head.name !== slug) return { error: `name « ${head.name} » différent du nom de fichier « ${slug} »` };
  if (!MODELS.includes(head.model)) return { error: `modèle inconnu : ${head.model}` };
  const parts = m[2].split(/^## +(.+?) *$/m); // [avant, titre 1, texte 1, titre 2, texte 2, …]
  const titles = parts.filter((_, i) => i % 2 === 1), expected = SECTIONS.map(([t]) => t);
  if (titles.join('|') !== expected.join('|')) return { error: `sections attendues dans cet ordre : ${expected.join(', ')}` };
  const empty = SECTIONS.findIndex((_, i) => !parts[2 * i + 2].trim());
  if (empty >= 0) return { error: `section vide : ${expected[empty]}` };
  const sections = Object.fromEntries(SECTIONS.map(([, key], i) => [key, parts[2 * i + 2].trim()]));
  const collaboratesAll = head.collaborates === 'tous';
  return {
    profile: {
      slug, description: head.description, tools: list(head.tools), model: head.model,
      displayName: head.display_name, role: head.role, department: head.department,
      collaboratesAll, collaborates: collaboratesAll ? [] : list(head.collaborates),
      connectors: list(head.connectors), skills, sections
    }
  };
}

export function loadAgentFiles(dir) {
  if (!existsSync(dir)) return { profiles: [], warnings: [] };
  const profiles = [], warnings = [];
  let files;
  try { files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name).sort(); }
  catch (e) { return { profiles: [], warnings: [{ file: '.claude/agents', reason: `dossier illisible (${e.code ?? e.message})` }] }; }
  for (const file of files) {
    let text;
    try { text = readFileSync(join(dir, file), 'utf8'); } catch (e) { warnings.push({ file, reason: `fichier illisible (${e.code ?? e.message})` }); continue; }
    const result = parseAgentFile(text, file);
    if (result.error) warnings.push({ file, reason: result.error }); else profiles.push(result.profile);
  }
  return { profiles, warnings };
}

// « détecté » veut seulement dire que le programme est présent ; aucun connecteur n'est déclaré « connecté ».
const CLI = { 'shopify-cli': 'shopify', 'codex-cli': 'codex' };
export function connectorState(id, detect) {
  if (Object.hasOwn(CLI, id)) return detect(CLI[id]) ? 'detected' : 'missing';
  if (id === 'web') return 'claude_code_only';
  return 'not_connected';
}
