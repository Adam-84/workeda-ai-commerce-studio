// src/memory-cli.js — « npm run memory:check » (lecture seule), « memory:backup » (copie de la base) et « memory:sync »
// (importe les journaux reçus par git). Rien n'est supprimé par ces commandes.
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './studio.js';
import { createMemoryStore } from './studio-memory.js';

export function run(command, root, out = console.log, dbFile = process.env.WORKEDA_DB || join(root, 'data', 'workeda.db')) {
  const journalDir = join(root, 'memory', 'journal');
  if (command === 'check') { // « check » ne modifie rien, pas même le schéma : base ouverte en lecture seule
    if (!existsSync(dbFile)) { out('Aucune base sur cet ordinateur : rien à vérifier (elle sera créée au premier « npm start »).'); return 0; }
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const store = createMemoryStore(db, { filename: dbFile, journalDir, readOnly: true });
      const report = store.check();
      out(`${report.total} souvenir(s) · ${report.pending} en attente · ${report.stale} à revoir · ${report.expired} expiré(s) · ${report.journalFiles} journal(aux).`);
      for (const p of report.problems) out(`  ✗ ${p}`);
      for (const n of report.notes) out(`  · ${n}`);
      out(report.ok ? 'Mémoire cohérente.' : 'Problèmes à corriger (aucune modification faite).');
      return report.ok ? 0 : 1;
    } finally { db.close(); }
  }
  mkdirSync(dirname(dbFile), { recursive: true });
  const studio = createStudio(dbFile, { memoryJournalDir: journalDir });
  try {
    const memory = studio.memory;
    if (command === 'sync') {
      const r = memory.importJournal();
      out(`Journal : ${r.applied} appliqué(s), ${r.superseded} plus ancien(s) conservé(s) dans l'historique, ${r.invalid} invalide(s).`);
      for (const w of r.warnings) out(`  ! ${w}`);
      return r.invalid ? 1 : 0;
    }
    if (command === 'backup') {
      const saved = memory.backup('manuelle');
      out(`Sauvegarde écrite : ${saved}`);
      return 0;
    }
    const report = memory.check();
    out(`${report.total} souvenir(s) · ${report.pending} en attente · ${report.stale} à revoir · ${report.expired} expiré(s) · ${report.journalFiles} journal(aux) · appareil ${memory.device}.`);
    for (const p of report.problems) out(`  ✗ ${p}`);
    for (const n of report.notes) out(`  · ${n}`);
    out(report.ok ? 'Mémoire cohérente.' : 'Problèmes à corriger (aucune modification faite).');
    return report.ok ? 0 : 1;
  } finally {
    studio.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!['check', 'backup', 'sync'].includes(command)) { console.error('Usage : node src/memory-cli.js check|backup|sync'); process.exit(2); }
  process.exitCode = run(command, resolve(fileURLToPath(import.meta.url), '..', '..'));
}
