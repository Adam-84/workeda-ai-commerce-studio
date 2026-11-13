import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
