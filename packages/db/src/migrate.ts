import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { normalizeConnectionString } from './pg-tools.js';

export type MigrationKind = 'schema' | 'data' | 'indexes';

interface MigrationExecutor {
  unsafe(query: string, parameters?: readonly unknown[]): PromiseLike<unknown>;
}

interface MigrationFile {
  checksum: string;
  id: string;
  kind: MigrationKind;
  legacyIds: string[];
  path: string;
  transactional: boolean;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
}

const migrationKinds: MigrationKind[] = ['schema', 'data', 'indexes'];
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

async function readMigrationFiles(): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  const rootEntries = await readdir(migrationsDirectory, { withFileTypes: true });

  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.sql')) {
      files.push(
        await toMigrationFile('schema', entry.name, join(migrationsDirectory, entry.name), []),
      );
    }
  }

  for (const kind of migrationKinds) {
    const directory = join(migrationsDirectory, kind);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
      const id = kind + '/' + entry.name;
      const legacyIds = kind === 'schema' ? [entry.name] : [];
      files.push(await toMigrationFile(kind, id, join(directory, entry.name), legacyIds));
    }
  }

  return files.sort((left, right) => {
    const kindOrder = migrationKinds.indexOf(left.kind) - migrationKinds.indexOf(right.kind);
    return kindOrder || left.id.localeCompare(right.id);
  });
}

async function toMigrationFile(
  kind: MigrationKind,
  id: string,
  path: string,
  legacyIds: string[],
): Promise<MigrationFile> {
  const contents = await readFile(path, 'utf8');
  return {
    checksum: createHash('sha256').update(contents).digest('hex'),
    id: id.replaceAll(sep, '/'),
    kind,
    legacyIds,
    path,
    transactional: kind !== 'indexes',
  };
}

async function migrationIsApplied(
  client: postgres.Sql,
  migration: MigrationFile,
): Promise<{ applied: boolean; checksum?: string; legacyId?: string }> {
  const ids = [migration.id, ...migration.legacyIds];
  const rows = await client.unsafe<{ checksum: string | null; id: string }[]>(
    'select id, checksum from schema_migrations where id = any($1::text[]) limit 1',
    [ids],
  );
  const row = rows[0];
  const id = row?.id;
  return id
    ? {
        applied: true,
        ...(row.checksum ? { checksum: row.checksum } : {}),
        ...(id === migration.id ? {} : { legacyId: id }),
      }
    : { applied: false };
}

export async function runMigrations(connectionString: string): Promise<MigrationRunResult> {
  const client = postgres(normalizeConnectionString(connectionString), { max: 1, prepare: false });
  const applied: string[] = [];
  const skipped: string[] = [];
  const migrationFiles = await readMigrationFiles();
  const quote = String.fromCharCode(39);
  const migrationLock =
    'select pg_advisory_lock(hashtext(' + quote + 'platform:schema-migrations' + quote + '))';
  const migrationUnlock =
    'select pg_advisory_unlock(hashtext(' + quote + 'platform:schema-migrations' + quote + '))';

  try {
    await client.unsafe(migrationLock);
    await client.unsafe(
      'create table if not exists schema_migrations (' +
        'id text primary key, ' +
        'applied_at timestamptz not null default now()' +
        ')',
    );
    await client.unsafe(
      'alter table schema_migrations ' +
        'add column if not exists kind text not null default ' +
        quote +
        'schema' +
        quote +
        ', ' +
        'add column if not exists checksum text',
    );
    await client.unsafe('alter table schema_migrations add column if not exists duration_ms integer');
    await client.unsafe('alter table schema_migrations add column if not exists applied_by text default current_user');

    for (const migration of migrationFiles) {
      const status = await migrationIsApplied(client, migration);
      if (status.applied) {
        if (status.checksum && status.checksum !== migration.checksum) {
          throw new Error('migration_checksum_mismatch: ' + migration.id);
        }
        skipped.push(migration.id);
        if (status.legacyId)
          console.log('Skipped ' + migration.id + ' (legacy id ' + status.legacyId + ')');
        continue;
      }

      const migrationSql = await readFile(migration.path, 'utf8');
      const migrationStart = Date.now();
      const apply = async (executor: MigrationExecutor) => {
        await executor.unsafe(migrationSql);
        const durationMs = Date.now() - migrationStart;
        await executor.unsafe(
          'insert into schema_migrations (id, kind, checksum, duration_ms) values ($1, $2, $3, $4)',
          [migration.id, migration.kind, migration.checksum, durationMs],
        );
      };

      if (migration.transactional) {
        await client.begin(async (transaction) => apply(transaction));
      } else {
        await apply(client);
      }
      const durationMsLog = Date.now() - migrationStart;
      applied.push(migration.id);
      console.log(
        'Applied ' +
          migration.id +
          ' (' +
          migration.kind +
          (migration.transactional ? '' : ', non-transactional') +
          `, ${durationMsLog}ms` +
          ')',
      );
    }

    return { applied, skipped };
  } finally {
    await client.unsafe(migrationUnlock).catch(() => undefined);
    await client.end({ timeout: 5 });
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  const configuredConnectionString = process.env.DATABASE_URL;
  if (!configuredConnectionString) throw new Error('DATABASE_URL is required to run migrations');
  await runMigrations(configuredConnectionString);
}
