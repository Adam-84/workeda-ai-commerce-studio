// Aucun import de child_process : cette version ne peut lancer aucun CLI.
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Ceci ne protège pas le démarrage Node antérieur, effectué par PAL.
for (const name of Object.keys(process.env)) if (!['SystemRoot', 'WINDIR'].includes(name)) delete process.env[name];
let work;
try {
  work = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'work-'));
  process.chdir(work); // Dossier neuf et vide ; aucun contexte ni fichier utilisateur lu.
  const args = process.argv.slice(2).join(' ').normalize('NFKC').toLowerCase();
  // Diagnostic seulement : même les arguments inoffensifs finissent en refus.
  const dangerous = /--dangerously-|--yolo|danger-full-access|--full-auto|--add-dir|--enable|web_search(?!\s*=\s*["']?disabled)|--sandbox|--config|--permission|--network|--search|--mcp|--cd|\s-c(?:\s|=)/.test(args);
  process.stderr.write(JSON.stringify({
    status: 'blocked', code: dangerous ? 'forbidden_arguments' : 'isolation_unverified',
    message: 'Codex désactivé : profil vérifié et accord propriétaire requis ; cette version refuse aussi en leur présence. Aucun processus enfant lancé.',
    active: false, spawned: false, envNames: Object.keys(process.env).sort(), workFiles: readdirSync(work).length,
  }) + '\n');
} catch {
  process.stderr.write('{"status":"blocked","code":"gate_error","spawned":false}\n');
} finally {
  process.chdir(dirname(fileURLToPath(import.meta.url)));
  if (work) rmSync(work, { recursive: true, force: true });
  process.exitCode = 2;
}
