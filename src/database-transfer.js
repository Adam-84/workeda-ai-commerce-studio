import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, statSync, lstatSync, copyFileSync, chmodSync, unlinkSync, constants } from 'node:fs';
import { resolve } from 'node:path';

const quote = name => `"${name.replaceAll('"', '""')}"`;
const digest = value => createHash('sha256').update(value).digest('hex');

function openSource(path) {
  if (!statSync(path).isFile()) throw new Error('Source must be a database file');
  const db = new DatabaseSync(path, { readOnly: true, enableLoadExtension: false });
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
  return db;
}

function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function assertNewDestination(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { lstatSync(`${path}${suffix}`); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('Destination or SQLite sidecar already exists; choose a NEW path');
  }
}

function integrity(path) {
  const db = openSource(path);
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('Database integrity verification failed');
  } finally { db.close(); }
}

function schema(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

function tableInfo(db, objects, name) {
  const columns = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().map(column => ({
    name: column.name, type: column.type, notNull: Boolean(column.notnull), primaryKeyPosition: column.pk, hidden: column.hidden,
  }));
  const count = db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`);
  count.setReadBigInts(true);
  const n = count.get().n;
  return {
    name, rowCount: n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString(), columns,
    schemaSha256: digest(JSON.stringify(objects.filter(object => object.tbl_name === name))),
  };
}

function inspect(db) {
  const objects = schema(db);
  return {
    schemaSha256: digest(JSON.stringify(objects)),
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    tables: objects.filter(object => object.type === 'table').map(object => tableInfo(db, objects, object.name)),
  };
}

/** Read-only structural preview; neither row contents nor SQL literal defaults are returned. */
export function previewDatabase(path) {
  const db = openSource(path);
  try { return inspect(db); } finally { db.close(); }
}

function encode(value) {
  if (value === null) return ['null'];
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')];
  return [typeof value, String(value)];
}

function rowHashes(db, table) {
  const keys = table.columns.filter(column => column.primaryKeyPosition).sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition);
  if (!keys.length) return null;
  const rows = new Map();
  const query = db.prepare(`SELECT * FROM ${quote(table.name)}`);
  query.setReadBigInts(true);
  for (const row of query.iterate()) {
    // Nullable primary keys occur in historical SQLite rowid tables. They are not merge identities.
    if (keys.some(key => row[key.name] === null)) return null;
    const key = digest(JSON.stringify(keys.map(column => encode(row[column.name]))));
    if (rows.has(key)) return null;
    rows.set(key, digest(JSON.stringify(Object.entries(row).map(([name, value]) => [name, encode(value)]))));
  }
  return rows;
}

/** Compare two independent read snapshots; this deliberately performs no migration or merge. */
export function compareDatabases(leftPath, rightPath) {
  const left = openSource(leftPath);
  let right;
  try {
    right = openSource(rightPath);
    const a = inspect(left);
    const b = inspect(right);
    const names = [...new Set([...a.tables, ...b.tables].map(table => table.name))].sort();
    const tables = names.map(name => {
      const l = a.tables.find(table => table.name === name);
      const r = b.tables.find(table => table.name === name);
      const base = { name, leftCount: l?.rowCount ?? null, rightCount: r?.rowCount ?? null };
      if (!l || !r) return { ...base, status: l ? 'left-only' : 'right-only' };
      if (l.schemaSha256 !== r.schemaSha256) return { ...base, status: 'schema-conflict' };
      const lh = rowHashes(left, l);
      const rh = rowHashes(right, r);
      if (!lh || !rh) return { ...base, status: 'no-unambiguous-primary-key' };
      const rows = { identical: 0, conflicting: 0, leftOnly: 0, rightOnly: 0 };
      for (const [key, hash] of lh) {
        if (!rh.has(key)) rows.leftOnly++;
        else if (rh.get(key) === hash) rows.identical++;
        else rows.conflicting++;
      }
      for (const key of rh.keys()) if (!lh.has(key)) rows.rightOnly++;
      return { ...base, status: rows.conflicting ? 'row-conflict' : 'compared', rows };
    });
    return {
      mergePerformed: false,
      compatibleSchema: a.schemaSha256 === b.schemaSha256 && a.userVersion === b.userVersion,
      leftSchemaSha256: a.schemaSha256, rightSchemaSha256: b.schemaSha256,
      leftUserVersion: a.userVersion, rightUserVersion: b.userVersion, tables,
    };
  } finally { right?.close(); left.close(); }
}

function receipt(path) {
  integrity(path);
  return { path: resolve(path), sha256: sha256File(path), bytes: statSync(path).size, integrity: 'ok' };
}

/** SQLite's online backup API includes committed WAL pages. Never raw-copy a live database. */
export async function backupDatabase(sourcePath, destinationPath) {
  assertNewDestination(destinationPath);
  const source = openSource(sourcePath);
  let created = false;
  try {
    // Exclusive reservation also protects against a destination created after our initial check.
    closeSync(openSync(destinationPath, 'wx', 0o600));
    created = true;
    await backup(source, destinationPath);
    // Emit a standalone artifact with no WAL dependency, even when the live source uses WAL.
    const artifact = new DatabaseSync(destinationPath);
    try { artifact.exec('PRAGMA journal_mode=DELETE'); } finally { artifact.close(); }
    return receipt(destinationPath);
  } catch (error) {
    if (created) unlinkSync(destinationPath);
    throw error;
  } finally { source.close(); }
}

/** Restore a standalone, hash-verified snapshot to a new candidate; never promote it automatically. */
export async function restoreDatabase(artifactPath, destinationPath, { expectedSha256 } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? '')) throw new Error('An expected SHA-256 digest is required');
  assertNewDestination(destinationPath);
  try {
    if (statSync(`${artifactPath}-wal`).size > 0) throw new Error('Restore requires a standalone backup artifact, not a live WAL database');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (sha256File(artifactPath) !== expectedSha256.toLowerCase()) throw new Error('Artifact SHA-256 mismatch');
  let created = false;
  try {
    copyFileSync(artifactPath, destinationPath, constants.COPYFILE_EXCL);
    created = true;
    chmodSync(destinationPath, 0o600);
    const result = receipt(destinationPath);
    if (result.sha256 !== expectedSha256.toLowerCase()) throw new Error('Restored artifact SHA-256 mismatch');
    return result;
  } catch (error) {
    if (created) unlinkSync(destinationPath);
    throw error;
  }
}
