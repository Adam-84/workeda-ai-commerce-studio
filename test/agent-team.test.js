import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentFiles } from '../src/agent-files.js';
import { createStudio } from '../src/studio.js';

const DIR = fileURLToPath(new URL('../.claude/agents', import.meta.url));
const SOCLE = [
  "N'invente jamais un prix, un chiffre, une date ou une promesse. Si une donnée manque, écris « donnée manquante ».",
  'Chaque chiffre porte sa source et sa date de relevé.',
  "Si un outil dont tu as besoin n'est pas connecté, dis-le et travaille avec ce qu'on te fournit.",
  "Tu prépares, tu n'exécutes pas : toute écriture sur Shopify (thème publié, prix, commande) reste une proposition à faire valider.",
  'Quand la demande est claire, ne pose pas de question inutile : fais une hypothèse raisonnable, note-la, avance.'
];
const R = ['Read', 'Grep', 'Glob'];
const TEAM = {
  alexander: { department: 'Direction', role: 'Directeur général IA', model: 'opus', tools: R, connectors: [], collaborates: 'tous', rule: ['session principale'] },
  olivia: { department: 'Direction', role: 'Coordinatrice des missions', model: 'sonnet', tools: R, connectors: [], collaborates: 'tous', rule: ['demandes à Alexander'] },
  sophia: { department: 'Laboratoire', role: 'Analyste de marché e-commerce', model: 'sonnet', tools: ['WebSearch', 'WebFetch', ...R], connectors: ['web'], collaborates: ['noah', 'lucas', 'alexander'], rule: ['cinq recommandations'] },
  noah: { department: 'Laboratoire', role: 'Analyste de veille concurrentielle', model: 'sonnet', tools: ['WebSearch', 'WebFetch', ...R], connectors: ['web', 'shopify-admin'], collaborates: ['sophia', 'isabella', 'chloe'], rule: ['son lien et sa date'] },
  lucas: { department: 'Catalogue', role: 'Responsable catalogue Shopify', model: 'sonnet', tools: R, connectors: ['shopify-admin'], collaborates: ['isabella', 'chloe', 'benjamin'], rule: ['par priorité'] },
  isabella: { department: 'Catalogue', role: 'Analyste des prix et marges', model: 'sonnet', tools: R, connectors: ['shopify-admin', 'dsers'], collaborates: ['noah', 'lucas', 'benjamin'], rule: ['formule'] },
  chloe: { department: 'Création', role: 'Designer UX/UI e-commerce', model: 'sonnet', tools: ['WebFetch', ...R], connectors: ['web', 'shopify-admin'], collaborates: ['sophia', 'ryan', 'harper'], rule: ["mobile d'abord"] },
  ryan: { department: 'Création', role: 'Développeur Shopify', model: 'opus', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'], connectors: ['shopify-cli', 'codex-cli'], collaborates: ['chloe', 'harper', 'olivia'], rule: ['shopify theme push', 'shopify theme publish'] },
  harper: { department: 'Opérations', role: 'Responsable contrôle qualité', model: 'sonnet', tools: [...R, 'Bash'], connectors: ['shopify-cli', 'playwright'], collaborates: ['ryan', 'chloe', 'alexander'], rule: ['« À corriger »'] },
  benjamin: { department: 'Données', role: 'Analyste des performances commerciales', model: 'sonnet', tools: R, connectors: ['shopify-admin'], collaborates: ['alexander', 'lucas', 'isabella'], rule: ['période'] }
};

test('the ten real profiles are all valid', () => {
  const { profiles, warnings } = loadAgentFiles(DIR);
  assert.deepEqual(warnings, []);
  assert.deepEqual(profiles.map((p) => p.slug).sort(), Object.keys(TEAM).sort());
});

test('each profile matches the team table of the spec', () => {
  for (const p of loadAgentFiles(DIR).profiles) {
    const t = TEAM[p.slug];
    assert.equal(p.displayName, p.slug[0].toUpperCase() + p.slug.slice(1), p.slug);
    assert.equal(p.department, t.department, p.slug);
    assert.equal(p.role, t.role, p.slug);
    assert.equal(p.model, t.model, p.slug);
    assert.deepEqual(p.tools, t.tools, p.slug);
    assert.deepEqual(p.connectors, t.connectors, p.slug);
    if (t.collaborates === 'tous') assert.equal(p.collaboratesAll, true, p.slug);
    else assert.deepEqual(p.collaborates, t.collaborates, p.slug);
  }
});

test('each profile carries the common base word for word, then its own rules', () => {
  for (const p of loadAgentFiles(DIR).profiles) {
    for (const line of SOCLE) assert.ok(p.sections.regles.includes(line), `${p.slug} : ${line}`);
    const positions = SOCLE.map((line) => p.sections.regles.indexOf(line));
    assert.ok(positions.every((pos, i) => i === 0 || pos > positions[i - 1]), `${p.slug} : ordre du socle`);
    assert.match(p.sections.regles.trimStart(), /^(1. )?N'invente jamais/, `${p.slug} : le socle ouvre les règles`);
    for (const phrase of TEAM[p.slug].rule) assert.ok(p.sections.regles.includes(phrase), `${p.slug} : ${phrase}`);
  }
});

test('no raw file uses Markdown bold', () => {
  for (const slug of Object.keys(TEAM)) {
    assert.ok(!readFileSync(join(DIR, `${slug}.md`), 'utf8').includes('**'), slug);
  }
});

test('Ryan has a command allowlist and Harper names her checks', () => {
  const ryan = readFileSync(join(DIR, 'ryan.md'), 'utf8');
  assert.ok(ryan.includes('Les seules commandes Shopify CLI que tu lances'));
  assert.ok(ryan.includes('codex exec --sandbox read-only'));
  assert.ok(readFileSync(join(DIR, 'harper.md'), 'utf8').includes('shopify theme check'));
  assert.ok(readFileSync(join(DIR, 'harper.md'), 'utf8').includes('Les seules commandes que tu lances'));
});

test('the ten profiles sync into the default departments', () => {
  const studio = createStudio(':memory:');
  try {
    const r = studio.syncAgentFiles(loadAgentFiles(DIR).profiles);
    assert.equal(r.created.length, 10);
    assert.deepEqual(r.warnings, []);
  } finally {
    studio.close();
  }
});
