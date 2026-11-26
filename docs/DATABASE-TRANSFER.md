# SQLite backup and transfer

These tools use Node 24's built-in SQLite support. They never merge, replace, or promote an application database. Source connections are read-only. Only explicitly named new backup/restoration files are written. No real database is exercised by the tests.

Run from the repository root (quote paths containing spaces):

```powershell
node tools/database-transfer.mjs preview --source "D:\private\pc-a.sqlite"
node tools/database-transfer.mjs compare --source "D:\private\pc-a.sqlite" --other "D:\private\pc-b.sqlite"
node tools/database-transfer.mjs backup --source "D:\private\pc-a.sqlite" --destination "D:\private\backups\pc-a-2026-11-26.sqlite"
```

`preview` returns table names, counts, column names/types/nullability/primary-key order, schema fingerprints and SQLite `user_version`. It omits row contents and SQL literals. `compare` takes a read transaction on each source and returns aggregate identical/conflicting/left-only/right-only counts for tables with identical definitions and unambiguous primary keys. Neither row keys nor row hashes are emitted. Tables without usable keys are flagged, not guessed. Counts and schema names are metadata and should still be handled privately.

Both mutation commands default to **dry run**: they display the proposed paths without opening or validating files. Add `--execute` for an intentional operation:

```powershell
node tools/database-transfer.mjs backup --source "D:\private\pc-a.sqlite" --destination "D:\private\backups\pc-a-2026-11-26.sqlite" --execute
node tools/database-transfer.mjs restore --source "D:\private\backups\pc-a-2026-11-26.sqlite" --destination "D:\private\candidates\pc-a-restored.sqlite" --sha256 "PASTE_THE_64_CHARACTER_DIGEST_FROM_BACKUP" --execute
```

Parent directories must already exist. Every successful backup and restoration reports its absolute path, byte count, SHA-256 and `integrity: "ok"`. Save this receipt separately with your protected backup records. Restore requires the expected digest and compares it before copying and again on the newly restored candidate. A mismatched or corrupt artifact fails; an incomplete candidate is removed. Existing destination files, symlinks, or SQLite sidecars are refused. The CLI exits nonzero on failures.

Backups use SQLite's online backup API, including committed WAL pages, and are converted to standalone rollback-journal format before integrity checking and hashing. Do not copy just the main file of a live WAL database. Restore accepts a standalone snapshot, refuses a nonempty source WAL, copies exclusively to a new path, and runs SQLite's full `integrity_check`. Source files are never checkpointed or migrated. SQLite read-only connections can still need access to existing WAL/shared-memory sidecars; a normal live database should have those available.

Keep source PCs intact. First create separate backups from both PCs, record their hashes, and compare those frozen artifacts. Comparing two live databases is consistent within each connection, but does not give a synchronized point in time across devices. Schema fingerprints deliberately treat different SQL definitions as conflicts, even when they might be semantically equivalent. `user_version` differences also make the overall schema incompatible.

A conflict report is **not a lossless merge plan**. Same-key conflicts need domain-specific reconciliation, foreign-key/deletion semantics and an approved target schema. Different historical schemas need reviewed transformation rules and separate validation. This tool creates only a verified copy of one chosen backup as a new candidate. It never guesses a combined history, modifies either PC, runs application migrations, or changes the server's database configuration. Any later promotion or merge is a separate human-controlled operation.

Use a private destination directory outside Git/source trees and outside publicly served paths. Files request owner-only permissions on systems supporting POSIX modes; on Windows, directory ACLs are the operator's protection boundary. Backups contain the entire database, including any secrets or private messages stored in it. They are not encrypted by this tool. Hashes detect changed bytes when compared to a trusted receipt; they do not authenticate who produced the backup. Keep the artifact immutable and don't open it in an application that may migrate it before restoration.

The comparison scans all table rows and retains primary-key and row digests in memory; use frozen snapshots during a maintenance window for large databases. It does not compare attached databases, external files, authentication secrets outside SQLite, or filesystem journals. `integrity_check` verifies SQLite structure, not application correctness or cross-table business rules. Use the application's read-only validation after restoring a candidate.

Focused synthetic validation:

```powershell
node --test test/database-transfer.test.js
```

Coverage includes committed WAL backup, independent restoration checks, aggregate privacy/conflict reports, historical schema mismatch, digest mismatch, corruption cleanup, overwrite/sidecar refusal and CLI dry-run behavior.
