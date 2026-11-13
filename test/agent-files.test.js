import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAgentFile, loadAgentFiles, connectorState, SECTIONS, REQUIRED } from '../src/agent-files.js';

const HEAD = { name: 'ada', description: 'Fais appel à Ada pour tester le lecteur.', tools: 'Read, Grep', model: 'sonnet', display_name: 'Ada', role: 'Testeuse', department: 'Direction', collaborates: 'lin, max', connectors: 'web, shopify-cli' };
const fiche = ({ head = {}, drop = [], titles = SECTIONS.map(([t]) => t) } = {}) => {
  const front = Object.entries({ ...HEAD, ...head }).filter(([k]) => !drop.includes(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${front}\n---\n\n${titles.map((t) => `## ${t}\nTexte de ${t}.`).join('\n\n')}\n`;
};

test('a valid file gives a complete profile', () => {
  const { profile, error } = parseAgentFile(fiche(), 'ada.md');
  assert.equal(error, undefined);
  assert.equal(profile.slug, 'ada');
  assert.equal(profile.displayName, 'Ada');
  assert.equal(profile.role, 'Testeuse');
  assert.equal(profile.department, 'Direction');
  assert.equal(profile.model, 'sonnet');
  assert.deepEqual(profile.tools, ['Read', 'Grep']);
  assert.deepEqual(profile.connectors, ['web', 'shopify-cli']);
  assert.deepEqual(profile.collaborates, ['lin', 'max']);
  assert.equal(profile.collaboratesAll, false);
  assert.equal(profile.sections.metier, 'Texte de Métier.');
  assert.equal(profile.sections.neFaitJamais, 'Texte de Ne fait jamais.');
  assert.equal(profile.sections.reussite, 'Texte de Réussite.');
});

test('CRLF line endings and a BOM are accepted', () => {
  const { profile } = parseAgentFile('\uFEFF' + fiche().replace(/\n/g, '\r\n'), 'ada.md');
  assert.equal(profile.sections.livrable, 'Texte de Livrable.');
});

test('"tous" means the whole team', () => {
  const { profile } = parseAgentFile(fiche({ head: { collaborates: 'tous' } }), 'ada.md');
  assert.equal(profile.collaboratesAll, true);
  assert.deepEqual(profile.collaborates, []);
});

test('connectors are optional', () => {
  assert.deepEqual(parseAgentFile(fiche({ drop: ['connectors'] }), 'ada.md').profile.connectors, []);
});

test('each required key is checked', () => {
  for (const key of REQUIRED) assert.match(parseAgentFile(fiche({ drop: [key] }), 'ada.md').error, new RegExp(`clé obligatoire manquante : ${key}`));
});

test('name must match the file name', () => {
  assert.match(parseAgentFile(fiche(), 'bob.md').error, /différent du nom de fichier/);
});

test('a name with capitals or accents is refused even if it matches the file name', () => {
  for (const name of ['Emma', 'chloé', '1ada', 'ada_x']) assert.match(parseAgentFile(fiche({ head: { name } }), `${name}.md`).error, /nom invalide/);
  assert.equal(parseAgentFile(fiche({ head: { name: 'ada-2' } }), 'ada-2.md').error, undefined);
});

test('an unknown model is refused', () => {
  assert.match(parseAgentFile(fiche({ head: { model: 'gpt' } }), 'ada.md').error, /modèle inconnu : gpt/);
});

test('a missing or misplaced section is refused', () => {
  const titles = SECTIONS.map(([t]) => t);
  assert.match(parseAgentFile(fiche({ titles: titles.filter((t) => t !== 'Relais') }), 'ada.md').error, /sections attendues/);
  assert.match(parseAgentFile(fiche({ titles: [titles[1], titles[0], ...titles.slice(2)] }), 'ada.md').error, /sections attendues/);
});

test('a file without header is refused', () => {
  assert.match(parseAgentFile('## Métier\nBonjour', 'ada.md').error, /en-tête/);
});

test('a value containing ": " is refused because Claude Code reads YAML', () => {
  assert.match(parseAgentFile(fiche({ head: { description: 'Utilise-le pour : tester' } }), 'ada.md').error, /deux-points/);
});

test('a missing folder gives two empty lists', () => {
  assert.deepEqual(loadAgentFiles(join(tmpdir(), 'workeda-dossier-absent-xyz')), { profiles: [], warnings: [] });
});

test('the folder loader keeps valid files and reports the others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-agents-'));
  try {
    writeFileSync(join(dir, 'ada.md'), fiche());
    writeFileSync(join(dir, 'bob.md'), 'bonjour');
    writeFileSync(join(dir, 'notes.txt'), 'ignoré');
    const { profiles, warnings } = loadAgentFiles(dir);
    assert.deepEqual(profiles.map((p) => p.slug), ['ada']);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].file, 'bob.md');
    assert.match(warnings[0].reason, /en-tête/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('connector states never claim a connection', () => {
  const detect = (c) => c === 'shopify';
  assert.equal(connectorState('shopify-cli', detect), 'detected');
  assert.equal(connectorState('codex-cli', detect), 'missing');
  assert.equal(connectorState('shopify-admin', detect), 'not_connected');
  assert.equal(connectorState('dsers', detect), 'not_connected');
  assert.equal(connectorState('playwright', detect), 'not_connected');
  assert.equal(connectorState('web', detect), 'claude_code_only');
  assert.equal(connectorState('autre', detect), 'not_connected');
});

test('a directory named like a fiche is skipped and valid files still load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-agents-'));
  try {
    mkdirSync(join(dir, 'x.md'));
    writeFileSync(join(dir, 'ada.md'), fiche());
    const { profiles, warnings } = loadAgentFiles(dir);
    assert.deepEqual(profiles.map((p) => p.slug), ['ada']);
    assert.deepEqual(warnings, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a duplicate header key is refused', () => {
  const text = fiche().replace('role: Testeuse', 'role: Testeuse\nrole: Autre');
  assert.match(parseAgentFile(text, 'ada.md').error, /clé en double : role/);
});

test('values that YAML reads badly are refused', () => {
  assert.match(parseAgentFile(fiche({ head: { description: 'Termine par deux-points:' } }), 'ada.md').error, /YAML/);
  assert.match(parseAgentFile(fiche({ head: { description: 'Un texte # commentaire' } }), 'ada.md').error, /YAML/);
  assert.match(parseAgentFile(fiche({ head: { description: '"entre guillemets"' } }), 'ada.md').error, /YAML/);
  assert.match(parseAgentFile(fiche({ head: { description: '# commentaire' } }), 'ada.md').error, /YAML/);
});

test('an empty section is refused', () => {
  const text = fiche().replace('## Relais\nTexte de Relais.', '## Relais\n   ');
  assert.match(parseAgentFile(text, 'ada.md').error, /section vide : Relais/);
});

test('connectorState ignores inherited object keys', () => {
  assert.equal(connectorState('constructor', () => true), 'not_connected');
});

test('an extra ## title after the eight is refused', () => {
  const text = fiche() + '\n## Bonus\nEn plus.\n';
  assert.match(parseAgentFile(text, 'ada.md').error, /sections attendues/);
});

test('a header line without key: value is unreadable', () => {
  const text = fiche().replace('role: Testeuse', 'pasdedeuxpoints');
  assert.match(parseAgentFile(text, 'ada.md').error, /ligne d'en-tête illisible/);
});

test('a path that is not a folder gives a warning instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workeda-notdir-'));
  try {
    const file = join(dir, 'pas-un-dossier');
    writeFileSync(file, 'x');
    const r = loadAgentFiles(file);
    assert.deepEqual(r.profiles, []);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].file, '.claude/agents');
    assert.match(r.warnings[0].reason, /^dossier illisible \(/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
