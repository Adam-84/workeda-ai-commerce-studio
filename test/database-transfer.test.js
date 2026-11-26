import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { previewDatabase, compareDatabases, backupDatabase, restoreDatabase } from '../src/database-transfer.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'database-transfer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return name => join(directory, name);
}

function populate(path, rows = [[1, 'private-one'], [2, 'private-two']]) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  for (const row of rows) db.prepare('INSERT INTO records VALUES (?, ?)').run(...row);
  db.close();
}

test('backup captures committed WAL data and restores an independently verified new database', async t => {
  const path = fixture(t);
  const live = new DatabaseSync(path('live.sqlite'));
  try {
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)');
    live.prepare('INSERT INTO records VALUES (1, ?)').run('private-wal-value');
    assert.ok(existsSync(path('live.sqlite-wal')));
    const receipt = await backupDatabase(path('live.sqlite'), path('snapshot.sqlite'));
    assert.equal(receipt.sha256, createHash('sha256').update(readFileSync(path('snapshot.sqlite'))).digest('hex'));
    assert.equal(receipt.integrity, 'ok');
    assert.equal(existsSync(path('snapshot.sqlite-wal')), false);
    assert.equal(existsSync(path('snapshot.sqlite-shm')), false);
    live.exec("INSERT INTO records VALUES (2, 'later')");
    const restored = await restoreDatabase(path('snapshot.sqlite'), path('restored.sqlite'), { expectedSha256: receipt.sha256 });
    assert.equal(restored.sha256, receipt.sha256);
    const db = new DatabaseSync(path('restored.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT id, value FROM records').all().map(row => ({ ...row })), [{ id: 1, value: 'private-wal-value' }]);
    } finally { db.close(); }
    assert.equal(live.prepare('SELECT count(*) AS n FROM records').get().n, 2);
  } finally { live.close(); }
});

test('preview and comparison report aggregate conflicts without row values or key values', t => {
  const path = fixture(t);
  populate(path('left.sqlite'), [[87654321, 'private-one'], [2, 'private-two'], [3, 'same']]);
  populate(path('right.sqlite'), [[87654321, 'private-other'], [4, 'private-four'], [3, 'same']]);
  for (const name of ['left.sqlite', 'right.sqlite']) {
    const db = new DatabaseSync(path(name));
    db.exec("CREATE TABLE unkeyed (value TEXT); INSERT INTO unkeyed VALUES ('private-unkeyed')");
    db.close();
  }
  const preview = previewDatabase(path('left.sqlite'));
  assert.equal(preview.tables.find(table => table.name === 'records').rowCount, 3);
  const report = compareDatabases(path('left.sqlite'), path('right.sqlite'));
  assert.equal(report.mergePerformed, false);
  assert.deepEqual(report.tables[0].rows, { identical: 1, conflicting: 1, leftOnly: 1, rightOnly: 1 });
  assert.equal(report.tables.find(table => table.name === 'unkeyed').status, 'no-unambiguous-primary-key');
  const output = JSON.stringify({ preview, report });
  for (const secret of ['private-one', 'private-other', '87654321']) assert.equal(output.includes(secret), false);
});

test('comparison identifies incompatible historical schemas and never suggests automatic merging', t => {
  const path = fixture(t);
  populate(path('left.sqlite'));
  populate(path('right.sqlite'));
  const db = new DatabaseSync(path('right.sqlite'));
  db.exec('ALTER TABLE records ADD COLUMN extra TEXT; CREATE TABLE unkeyed (value TEXT)');
  db.close();
  const report = compareDatabases(path('left.sqlite'), path('right.sqlite'));
  assert.equal(report.compatibleSchema, false);
  assert.equal(report.mergePerformed, false);
  assert.equal(report.tables.find(table => table.name === 'records').status, 'schema-conflict');
  assert.equal(report.tables.find(table => table.name === 'unkeyed').status, 'right-only');
});

test('restore rejects missing or mismatched evidence and backup/restore never overwrite existing files', async t => {
  const path = fixture(t);
  populate(path('source.sqlite'));
  const receipt = await backupDatabase(path('source.sqlite'), path('backup.sqlite'));
  const original = readFileSync(path('source.sqlite'));
  await assert.rejects(restoreDatabase(path('backup.sqlite'), path('missing-hash.sqlite'), {}), /SHA-256/i);
  await assert.rejects(restoreDatabase(path('backup.sqlite'), path('wrong-hash.sqlite'), { expectedSha256: '0'.repeat(64) }), /mismatch/i);
  assert.equal(existsSync(path('missing-hash.sqlite')), false);
  assert.equal(existsSync(path('wrong-hash.sqlite')), false);
  await assert.rejects(restoreDatabase(path('backup.sqlite'), path('source.sqlite'), { expectedSha256: receipt.sha256 }), /exist/i);
  await assert.rejects(backupDatabase(path('backup.sqlite'), path('source.sqlite')), /exist/i);
  assert.deepEqual(readFileSync(path('source.sqlite')), original);
  writeFileSync(path('sidecar.sqlite-wal'), 'preexisting sidecar');
  await assert.rejects(backupDatabase(path('source.sqlite'), path('sidecar.sqlite')), /exist/i);
  await assert.rejects(restoreDatabase(path('backup.sqlite'), path('sidecar.sqlite'), { expectedSha256: receipt.sha256 }), /exist/i);
  assert.equal(existsSync(path('sidecar.sqlite')), false);
  assert.equal(readFileSync(path('sidecar.sqlite-wal'), 'utf8'), 'preexisting sidecar');
  writeFileSync(path('corrupt.sqlite'), 'not a database');
  const corruptHash = createHash('sha256').update(readFileSync(path('corrupt.sqlite'))).digest('hex');
  await assert.rejects(restoreDatabase(path('corrupt.sqlite'), path('corrupt-result.sqlite'), { expectedSha256: corruptHash }));
  assert.equal(existsSync(path('corrupt-result.sqlite')), false);
});

test('CLI defaults to a dry run and executes only an explicitly requested backup', t => {
  const path = fixture(t);
  populate(path('source.sqlite'));
  const args = ['tools/database-transfer.mjs', 'backup', '--source', path('source.sqlite'), '--destination', path('cli.sqlite')];
  const dry = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(existsSync(path('cli.sqlite')), false);
  const execute = spawnSync(process.execPath, [...args, '--execute'], { encoding: 'utf8' });
  assert.equal(execute.status, 0, execute.stderr);
  assert.equal(JSON.parse(execute.stdout).integrity, 'ok');
  assert.equal(existsSync(path('cli.sqlite')), true);
});
