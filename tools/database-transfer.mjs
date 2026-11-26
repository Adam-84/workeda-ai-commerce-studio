import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { previewDatabase, compareDatabases, backupDatabase, restoreDatabase } from '../src/database-transfer.js';

const usage = `Database transfer (Node 24)
  preview --source FILE
  compare --source FILE --other FILE
  backup --source FILE --destination NEW_FILE [--execute]
  restore --source BACKUP --destination NEW_FILE --sha256 HASH [--execute]
Backup and restore default to a dry run. No command merges or promotes a database.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { source: { type: 'string' }, other: { type: 'string' }, destination: { type: 'string' }, sha256: { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) console.log(usage);
  else {
    const [command] = positionals;
    if (positionals.length !== 1 || !['preview', 'compare', 'backup', 'restore'].includes(command)) throw new Error(usage);
    if (!values.source) throw new Error('--source is required');
    const allowed = {
      preview: ['source'], compare: ['source', 'other'], backup: ['source', 'destination', 'execute'], restore: ['source', 'destination', 'sha256', 'execute'],
    }[command];
    for (const option of Object.keys(values)) if (!allowed.includes(option)) throw new Error(`--${option} is not valid for ${command}`);
    let result;
    if (command === 'preview') result = previewDatabase(values.source);
    else if (command === 'compare') {
      if (!values.other) throw new Error('--other is required');
      result = compareDatabases(values.source, values.other);
    } else {
      if (!values.destination) throw new Error('--destination is required');
      if (command === 'restore' && !/^[a-f0-9]{64}$/i.test(values.sha256 ?? '')) throw new Error('--sha256 must be the expected SHA-256 digest');
      if (!values.execute) result = { command, dryRun: true, source: resolve(values.source), destination: resolve(values.destination), expectedSha256: values.sha256, note: 'No file opened or modified; paths and contents are validated on execution.' };
      else result = command === 'backup'
        ? await backupDatabase(values.source, values.destination)
        : await restoreDatabase(values.source, values.destination, { expectedSha256: values.sha256 });
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(`Database transfer failed: ${error.message}`);
  process.exitCode = 1;
}
