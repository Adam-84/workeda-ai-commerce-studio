import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './studio.js';
import { createApp } from './app.js';
import { loadAgentFiles } from './agent-files.js';
import { createSkillManager } from './skills-manager.js';

const dbFile = process.env.WORKEDA_DB || 'data/workeda.db';
await mkdir(dirname(dbFile), { recursive: true });
const root = fileURLToPath(new URL('..', import.meta.url));
// Mémoire des agents : la base est locale, le journal memory/journal/<appareil>.jsonl voyage avec git (synchro entre PC).
const studio = createStudio(dbFile, { memoryJournalDir: process.env.WORKEDA_MEMORY_JOURNAL || join(root, 'memory', 'journal'), commJournalDir: process.env.WORKEDA_COMM_JOURNAL || join(root, 'comm', 'journal') });
const memorySync = studio.memory.importJournal();
if (memorySync.applied) console.log(`Mémoire : ${memorySync.applied} changement(s) reçu(s) d'un autre ordinateur.`);
for (const w of memorySync.warnings) console.warn(`Mémoire : ${w}`);
// Communication : les fils, messages et tâches reçus d'un autre ordinateur sont recopiés ; rien n'est exécuté par un import.
// L'import attend que les fiches soient reliées aux agents (plus bas) : il est donc fait après « syncAgentFiles ».

// Fiches lues une seule fois : une modification demande de relancer npm start.
const loaded = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const synced = studio.syncAgentFiles(loaded.profiles);
const warnings = [...loaded.warnings, ...synced.warnings];
if (synced.created.length) console.log(`Agents recrutés depuis .claude/agents : ${synced.created.join(', ')}`);
for (const w of warnings) console.warn(`Fiche ignorée : ${w.file} (${w.reason})`);
const commSync = studio.comm.importJournal();
if (commSync.applied) console.log(`Communication : ${commSync.applied} changement(s) reçu(s) d'un autre ordinateur.`);
for (const w of commSync.warnings) console.warn(`Communication : ${w}`);

// Bibliothèque de Skills : le disque (skills/) fait foi, la base n'en est que le reflet. Au démarrage on signale
// seulement l'écart avec les copies générées ; « npm run skills:sync » ou une affectation dans l'interface les écrit.
const skills =createSkillManager({ root, studio, profiles: loaded.profiles });
const boot = skills.startup();
for (const p of boot.problems) console.warn(`Skills : ${p}`);
const drift = boot.drift;
if (!drift.inSync || drift.conflict.length) console.warn(`Skills : copies Claude Code / Codex à régénérer (« npm run skills:sync »), ${drift.missing.length} absente(s), ${drift.outdated.length} périmée(s), ${drift.conflict.length} dossier(s) non géré(s).`);

const port = Number(process.env.PORT || 4318);
const server = createApp({ studio, skills, publicDir: fileURLToPath(new URL('../public', import.meta.url)), agentFiles: { profiles: loaded.profiles, warnings }, pumpEveryMs: 5000 });
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Le port ${port} est déjà utilisé : le studio tourne peut-être déjà. Fermez l'autre fenêtre ou choisissez un autre port avec PORT.`);
  process.exit(1);
});
server.listen(port, () => {
  console.log(`Workeda AI Commerce Studio : http://localhost:${server.address().port}`);
  // Reprise des tâches interrompues par un arrêt, puis passage régulier : une tâche approuvée démarre dès qu'un agent est libre.
  server.orchestrator?.start();
});
