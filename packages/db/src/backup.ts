import { access, chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPostgresTool } from './pg-tools.js';

export interface BackupResult {
  bytes: number;
  connectionDatabase: string;
  outputPath: string;
  sha256: string;
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(name + '_value_required');
  return value;
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export async function createBackup(
  connectionString: string,
  requestedOutputPath?: string,
): Promise<BackupResult> {
  const outputPath = resolve(
    requestedOutputPath ?? resolve('.artifacts', 'db', 'platform-' + timestamp() + '.dump'),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await access(outputPath, constants.F_OK);
    throw new Error('backup_output_exists: ' + outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await runPostgresTool('pg_dump', 'PG_DUMP_BIN', connectionString, [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    outputPath,
  ]);

  // A dump of the whole platform contains every tenant's PII, webhook secrets,
  // API key hashes and session token hashes. Never leave it world-readable.
  await chmod(outputPath, 0o600);

  // Validate the archive before it is considered a backup: a truncated custom
  // dump has a plausible size and would only fail months later, during restore.
  await runPostgresTool('pg_restore', 'PG_RESTORE_BIN', connectionString, [
    '--list',
    outputPath,
  ]);

  const outputStats = await stat(outputPath);
  if (outputStats.size === 0) throw new Error('backup_empty: ' + outputPath);
  const sha256 = createHash('sha256').update(await readFile(outputPath)).digest('hex');
  const database = new URL(connectionString).pathname.replace(/^\/+/, '') || 'unknown';
  return {
    bytes: outputStats.size,
    connectionDatabase: decodeURIComponent(database),
    outputPath,
    sha256,
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to create a backup');
  const result = await createBackup(
    connectionString,
    argumentValue(process.argv.slice(2), '--output'),
  );
  console.log(JSON.stringify(result, null, 2));
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) await main();
