import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './studio.js';
import { createApp } from './app.js';
import { loadAgentFiles } from './agent-files.js';

const dbFile = process.env.WORKEDA_DB || 'data/workeda.db';
await mkdir(dirname(dbFile), { recursive: true });
const studio = createStudio(dbFile);

// Fiches lues une seule fois : une modification demande de relancer npm start.
const loaded = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const synced = studio.syncAgentFiles(loaded.profiles);
const warnings = [...loaded.warnings, ...synced.warnings];
if (synced.created.length) console.log(`Agents recrutés depuis .claude/agents : ${synced.created.join(', ')}`);
for (const w of warnings) console.warn(`Fiche ignorée : ${w.file} (${w.reason})`);

const port = Number(process.env.PORT || 4318);
const server = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), agentFiles: { profiles: loaded.profiles, warnings } });
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Le port ${port} est déjà utilisé : le studio tourne peut-être déjà. Fermez l'autre fenêtre ou choisissez un autre port avec PORT.`);
  process.exit(1);
});
server.listen(port, () => console.log(`Workeda AI Commerce Studio : http://localhost:${server.address().port}`));
