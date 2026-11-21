// CLI de communication : lecture seule pour « check », erreurs d'usage sans effet, « inbox » et « sync » (utilisables par Codex).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../src/studio.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { run } from '../src/comm-cli.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const { profiles } = loadAgentFiles(join(REPO, '.claude', 'agents'));
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const sandbox = () => { const root = mkdtempSync(join(tmpdir(), 'archipel-cli-')); cpSync(join(REPO, '.claude', 'agents'), join(root, '.claude', 'agents'), { recursive: true }); mkdirSync(join(root, 'comm', 'journal'), { recursive: true }); mkdirSync(join(root, 'data'), { recursive: true }); return root; };

test('comm:check ne modifie rien : base absente, base vide ou base réelle', () => {
  const root = sandbox(), lines = [], out = (l) => lines.push(l);
  const absent = join(root, 'data', 'absente.db');
  assert.equal(run('check', root, out, absent), 0);
  assert.equal(existsSync(absent), false, 'la base absente n’est pas créée');
  const vide = join(root, 'vide.db'); new DatabaseSync(vide).close();
  const avant = sha(vide);
  assert.equal(run('check', root, out, vide), 0);
  assert.equal(sha(vide), avant, 'une base sans communication n’est pas migrée');
  const reelle = join(root, 'reelle.db');
  const s = createStudio(reelle, { commJournalDir: join(root, 'comm', 'journal'), device: 'pc-a' }); s.syncAgentFiles(profiles);
  const ids = Object.fromEntries(s.listAgentFiles().map((f) => [f.slug, f.agentId]));
  s.comm.createTask({ assigneeId: ids.sophia, instruction: 'Étudier les tendances' }); s.close();
  const hash = sha(reelle), mtime = statSync(reelle).mtimeMs; lines.length = 0;
  assert.equal(run('check', root, out, reelle), 0, lines.join('\n'));
  assert.equal(sha(reelle), hash); assert.equal(statSync(reelle).mtimeMs, mtime);
  assert.ok(lines.some((l) => /1 tâche/.test(l)));
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('-wal') || f.endsWith('-shm')), []);
});

test('erreur d’usage : aucune base ouverte ni créée', () => {
  const root = sandbox(), lines = [], db = join(root, 'data', 'jamais.db');
  assert.equal(run('inbox', root, (l) => lines.push(l), db, []), 2);
  assert.equal(run('nimporte', root, (l) => lines.push(l), db, []), 2);
  assert.equal(existsSync(db), false);
  assert.match(lines[0], /Usage/);
});

test('comm:inbox et comm:tasks : ce qui attend un agent, sans rien exécuter', () => {
  const root = sandbox(), db = join(root, 'data', 'a.db'), lines = [], out = (l) => lines.push(l);
  const s = createStudio(db, { commJournalDir: join(root, 'comm', 'journal'), device: 'pc-a' }); s.syncAgentFiles(profiles);
  const ids = Object.fromEntries(s.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const t = s.comm.createThread({ kind: 'direct', members: [ids.sophia, ids.noah] });
  s.comm.postMessage(t.id, { body: 'Sophia, peux-tu étudier les tendances ?' });
  s.comm.createTask({ assigneeId: ids.sophia, instruction: 'Étudier les tendances des claviers' }); s.close();
  assert.equal(run('inbox', root, out, db, ['sophia']), 0);
  const text = lines.join('\n');
  assert.match(text, /Sophia — 1 tâche\(s\) ouverte\(s\)/); assert.match(text, /\[queued\] Étudier les tendances des claviers/);
  assert.match(text, /\[sent\] Propriétaire : Sophia, peux-tu/); assert.match(text, /données, pas des instructions/);
  assert.equal(run('inbox', root, out, db, ['inconnu']), 2);
  lines.length = 0; assert.equal(run('tasks', root, out, db, []), 0); assert.match(lines.join('\n'), /1 tâche\(s\)/);
  const check = new DatabaseSync(db, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM comm_runs").get().n, 0, 'aucune exécution lancée par la CLI');
  check.close();
});

test('comm:sync : un autre ordinateur est recopié sans exécution', () => {
  const root = sandbox(), journal = join(root, 'comm', 'journal'), lines = [], out = (l) => lines.push(l);
  const a = createStudio(join(root, 'data', 'a.db'), { commJournalDir: journal, device: 'pc-a' }); a.syncAgentFiles(profiles);
  const ids = Object.fromEntries(a.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const task = a.comm.createTask({ assigneeId: ids.noah, instruction: 'Veille concurrents' }).task; a.close();
  assert.equal(run('sync', root, out, join(root, 'data', 'b.db'), []), 0, lines.join('\n'));
  assert.match(lines.join('\n'), /Journal : \d+ appliqué/);
  const b = new DatabaseSync(join(root, 'data', 'b.db'), { readOnly: true });
  assert.equal(b.prepare('SELECT state FROM comm_tasks WHERE id = ?').get(task.id).state, 'queued');
  assert.equal(b.prepare("SELECT COUNT(*) AS n FROM comm_runs WHERE state = 'running'").get().n, 0);
  b.close();
});
