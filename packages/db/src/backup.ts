import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPostgresTool } from './pg-tools.js';

export interface BackupResult {
  bytes: number;
  connectionDatabase: string;
  outputPath: string;
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
  const outputStats = await stat(outputPath);
  const database = new URL(connectionString).pathname.replace(/^\/+/, '') || 'unknown';
  return { bytes: outputStats.size, connectionDatabase: decodeURIComponent(database), outputPath };
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
