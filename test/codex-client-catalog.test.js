// Observations du VRAI client Codex (0.164.0) contre un FAUX fournisseur local : catalogue d'outils, appels forcés, skills, configurations.
// Opt-in (ARCHIPEL_CODEX_PROBES=1) : lance le vrai client NON confiné par MXC, sans clé ni compte (clé factice, CODEX_HOME temporaire), jamais OpenAI.
// Ces tests FIXENT L'ÉTAT CONNU, y compris les échecs de critères : s'ils échouent après une mise à jour du CLI, c'est le signal de RÉEXAMEN
// (docs/PAL-HARDENING.md), pas un bug. Un test réussi n'est jamais une garantie d'isolation complète.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe, probeAvailable } from './helpers/fake-responses-probe.js';

const skip = process.env.ARCHIPEL_CODEX_PROBES !== '1' ? 'sondes du vrai client désactivées par défaut (ARCHIPEL_CODEX_PROBES=1)' : !probeAvailable() ? 'Codex CLI introuvable ou plateforme non Windows' : false;
const NO_SHELL = ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.multi_agent=false', '-c', 'features.skill_search=false', '-c', 'features.sleep_tool=false', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false'];

test('client réel, configuration par défaut : catalogue NON vide, instructions/skills chargés, outil forcé refusé par la politique', { skip, timeout: 120000 }, async () => {
  const r = await runProbe({ mode: 'force' });
  assert.ok(r.requestCount >= 1, 'le client a bien parlé au faux fournisseur'); assert.ok(r.requestBytes > 10000);
  assert.ok(r.toolNames.includes('exec'), 'ÉTAT CONNU : le catalogue annoncé contient des outils (critère « catalogue vide » NON satisfait)');
  assert.equal(r.markers.agentsCwd, true, 'AGENTS.md du dossier de travail chargé : le cwd doit être vide');
  assert.equal(r.markers.agentsCodexHome, true, 'AGENTS.md et skills de CODEX_HOME chargés : CODEX_HOME doit être vierge'); assert.equal(r.markers.skillCodexHome, true);
  assert.equal(r.skillRootsReferenceRealProfile, true, 'ÉCHEC DE CRITÈRE (état connu) : la racine des skills pointe vers le VRAI profil utilisateur malgré HOME/USERPROFILE factices ; ses skills sont envoyés au modèle');
  assert.equal(r.mcpExecuted, false, 'avec --ignore-user-config, le MCP déclaré dans config.toml n\'est pas lancé');
  assert.equal(r.forcedWriteExecuted, false, 'appel forcé d\'écriture hors du cwd : non exécuté (read-only) ; observation unique, pas une preuve de sandbox');
  assert.deepEqual(r.leftovers, []);
});

test('client réel, fonctionnalités coupées par -c features.*=false : outil shell absent ; le reste du catalogue demeure', { skip, timeout: 120000 }, async () => {
  const r = await runProbe({ mode: 'force', flags: NO_SHELL });
  assert.match(r.toolOutput, /exec_command is not a function/, 'l\'outil exec_command n\'existe plus pour un appel forcé');
  assert.equal(r.forcedWriteExecuted, false);
  assert.ok(r.toolNames.includes('exec'), 'ÉTAT CONNU : l\'orchestrateur JavaScript reste annoncé même sans outil shell');
  assert.equal(r.skillRootsReferenceRealProfile, true, 'ÉTAT CONNU : les skills du profil réel restent chargés (skip_host_skill_discovery sans effet constaté)');
});
