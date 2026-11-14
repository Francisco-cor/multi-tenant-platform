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
  pending: string[];
  skipped: string[];
}

const migrationKinds: MigrationKind[] = ['schema', 'data', 'indexes'];
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const DOLLAR_QUOTE_PATTERN = /^\$[A-Za-z_0-9]*\$/;

/**
 * Split only the non-transactional migration files, preserving quoted SQL.
 * Understands dollar-quoted bodies (`$$ ... $$`, `$tag$ ... $tag$`) so a
 * PL/pgSQL `DO` block is sent as one statement instead of being shredded at
 * its inner semicolons.
 */
export function splitNonTransactionalSql(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (dollarTag) {
      if (character === '$' && source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inLineComment) {
      if (character === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === '-' && next === '-') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === '$') {
      const match = DOLLAR_QUOTE_PATTERN.exec(source.slice(index));
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (!inDoubleQuote && character === "'" && source[index - 1] !== '\\') {
      if (inSingleQuote && next === "'") {
        index += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }
    if (!inSingleQuote && character === '"' && source[index - 1] !== '\\') {
      if (inDoubleQuote && next === '"') {
        index += 1;
      } else {
        inDoubleQuote = !inDoubleQuote;
      }
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === ';') {
      const statement = source.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const last = source.slice(start).trim();
  if (last) statements.push(last);
  return statements;
}

async function readMigrationFiles(): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  const rootEntries = await readdir(migrationsDirectory, { withFileTypes: true });
  const basenames = new Map<string, string>();

  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.sql')) {
      files.push(
        await toMigrationFile('schema', entry.name, join(migrationsDirectory, entry.name), []),
      );
      basenames.set(entry.name, 'schema/' + entry.name);
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
      const duplicate = basenames.get(entry.name);
      if (duplicate && kind === 'schema') {
        throw new Error(`migration_duplicate_basename: ${displayPath(duplicate)} and ${id}`);
      }
      basenames.set(entry.name, id);
      const legacyIds = kind === 'schema' ? [entry.name] : [];
      files.push(await toMigrationFile(kind, id, join(directory, entry.name), legacyIds));
    }
  }

  return files.sort((left, right) => {
    const kindOrder = migrationKinds.indexOf(left.kind) - migrationKinds.indexOf(right.kind);
    return kindOrder || left.id.localeCompare(right.id);
  });
}

function displayPath(id: string): string {
  return id.replaceAll(sep, '/');
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
    'select id, checksum from schema_migrations where id = any($1::text[]) order by applied_at, id limit 1',
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

function readTimeoutMilliseconds(
  environmentVariable: string,
  fallback: number,
  options: { allowZero: boolean },
): number {
  const raw = process.env[environmentVariable];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!options.allowZero && value === 0)) {
    throw new Error(`${environmentVariable}_invalid: ${raw}`);
  }
  return Math.trunc(value);
}

interface InvalidIndexRow {
  relname: string;
}

async function findInvalidIndexes(client: postgres.Sql): Promise<string[]> {
  const rows = await client.unsafe<InvalidIndexRow[]>(
    'select c.relname from pg_index i ' +
      'join pg_class c on c.oid = i.indexrelid ' +
      'join pg_namespace n on n.oid = c.relnamespace ' +
      'where n.nspname = current_schema() and not i.indisvalid',
  );
  return rows.map((row) => row.relname);
}

/** A cancelled CONCURRENTLY build leaves indisvalid = false forever. */
async function dropInvalidIndexes(client: postgres.Sql): Promise<string[]> {
  const invalid = await findInvalidIndexes(client);
  for (const relname of invalid) {
    await client.unsafe(
      'drop index concurrently if exists "' + relname.replaceAll('"', '""') + '"',
    );
  }
  return invalid;
}

export interface RunMigrationsOptions {
  dryRun?: boolean;
}

export async function runMigrations(
  connectionString: string,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const dryRun = options.dryRun ?? false;
  const client = postgres(normalizeConnectionString(connectionString), { max: 1, prepare: false });
  const applied: string[] = [];
  const skipped: string[] = [];
  const pending: string[] = [];
  const migrationFiles = await readMigrationFiles();
  const quote = String.fromCharCode(39);
  // Advisory-lock acquisition window. Distinct from lock_timeout (DDL locks).
  const migrationLockTimeoutMs = readTimeoutMilliseconds('MIGRATION_LOCK_TIMEOUT_MS', 10000, {
    allowZero: false,
  });
  const migrationStatementTimeoutMs = readTimeoutMilliseconds(
    'MIGRATION_STATEMENT_TIMEOUT_MS',
    30000,
    { allowZero: true },
  );

  const acquireLock = async (): Promise<void> => {
    const deadline = Date.now() + migrationLockTimeoutMs;
    while (Date.now() < deadline) {
      const rows = await client.unsafe<{ locked: boolean }[]>(
        'select pg_try_advisory_lock(hashtext(' +
          quote +
          'platform:schema-migrations' +
          quote +
          ')) as locked',
      );
      if (rows[0]?.locked) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      'migration_lock_timeout: could not acquire advisory lock within ' +
        migrationLockTimeoutMs +
        'ms',
    );
  };
  const migrationUnlock =
    'select pg_advisory_unlock(hashtext(' + quote + 'platform:schema-migrations' + quote + '))';

  const logJson = (payload: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), component: 'migrate', ...payload });
    console.log(line);
  };

  try {
    // DDL lock timeout is validated, never silently swallowed: a malformed env
    // var must fail the deploy instead of running with the server default.
    await client.unsafe(`set lock_timeout = '${migrationLockTimeoutMs}ms'`);
    await client.unsafe(`set statement_timeout = '${migrationStatementTimeoutMs}ms'`);
    await acquireLock();
    logJson({ event: 'lock_acquired', timeoutMs: migrationLockTimeoutMs });
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
    await client.unsafe(
      'alter table schema_migrations add column if not exists duration_ms integer',
    );
    await client.unsafe(
      'alter table schema_migrations add column if not exists applied_by text default current_user',
    );

    let lastAppliedIndex = -1;
    for (const [index, migration] of migrationFiles.entries()) {
      const status = await migrationIsApplied(client, migration);
      if (status.applied) {
        lastAppliedIndex = index;
        if (status.checksum && status.checksum !== migration.checksum) {
          throw new Error('migration_checksum_mismatch: ' + migration.id);
        }
        if (!status.checksum && !dryRun) {
          // Rows created before the checksum column existed were never
          // verified. Backfill so the next run can detect edits.
          await client.unsafe('update schema_migrations set checksum = $1 where id = $2', [
            migration.checksum,
            status.legacyId ?? migration.id,
          ]);
          logJson({ event: 'checksum_backfilled', id: migration.id });
        }
        skipped.push(migration.id);
        if (status.legacyId) {
          logJson({ event: 'skipped_legacy', id: migration.id, legacyId: status.legacyId });
        } else {
          logJson({ event: 'skipped', id: migration.id, kind: migration.kind });
        }
        continue;
      }

      if (!dryRun && index < lastAppliedIndex) {
        throw new Error('migration_out_of_order: ' + migration.id);
      }

      if (dryRun) {
        pending.push(migration.id);
        logJson({
          event: 'pending',
          id: migration.id,
          kind: migration.kind,
          transactional: migration.transactional,
        });
        continue;
      }

      const migrationSql = await readFile(migration.path, 'utf8');
      // Basic safety check: indexes must use CONCURRENTLY outside tx
      if (migration.kind === 'indexes' && !/CONCURRENTLY/i.test(migrationSql)) {
        logJson({
          event: 'warn',
          id: migration.id,
          msg: 'indexes migration should use CREATE INDEX CONCURRENTLY',
        });
      }
      // Destructive check warning
      if (
        /(DROP\s+COLUMN|DROP\s+TABLE|ALTER\s+TABLE.*DROP)/i.test(migrationSql) &&
        !migration.id.includes('contract')
      ) {
        logJson({
          event: 'warn',
          id: migration.id,
          msg: 'potential destructive change — ensure expand-contract deferred contract',
        });
      }
      const migrationStart = Date.now();
      logJson({
        event: 'applying',
        id: migration.id,
        kind: migration.kind,
        transactional: migration.transactional,
        checksum: migration.checksum.slice(0, 8),
      });

      const record = async (executor: MigrationExecutor, durationMs: number) => {
        await executor.unsafe(
          'insert into schema_migrations (id, kind, checksum, duration_ms) values ($1, $2, $3, $4)',
          [migration.id, migration.kind, migration.checksum, durationMs],
        );
      };

      try {
        if (migration.transactional) {
          await client.begin(async (transaction) => {
            await transaction.unsafe(migrationSql);
            await record(transaction, Date.now() - migrationStart);
          });
        } else {
          // Index builds legitimately exceed the generic statement timeout;
          // lock_timeout still protects against blocked DDL.
          await client.unsafe('set statement_timeout = 0');
          const dropped = await dropInvalidIndexes(client);
          if (dropped.length > 0) {
            logJson({ event: 'invalid_indexes_dropped', id: migration.id, indexes: dropped });
          }
          for (const statement of splitNonTransactionalSql(migrationSql)) {
            await client.unsafe(statement);
          }
          const remaining = await findInvalidIndexes(client);
          if (remaining.length > 0) {
            throw new Error(
              'migration_invalid_index: ' + migration.id + ': ' + remaining.join(','),
            );
          }
          await record(client, Date.now() - migrationStart);
          await client.unsafe(`set statement_timeout = '${migrationStatementTimeoutMs}ms'`);
        }
        const durationMsLog = Date.now() - migrationStart;
        applied.push(migration.id);
        logJson({
          event: 'applied',
          id: migration.id,
          kind: migration.kind,
          durationMs: durationMsLog,
          checksum: migration.checksum.slice(0, 8),
        });
        console.log(
          'Applied ' +
            migration.id +
            ' (' +
            migration.kind +
            (migration.transactional ? '' : ', non-transactional') +
            `, ${durationMsLog}ms` +
            ')',
        );
      } catch (error) {
        const durationMsLog = Date.now() - migrationStart;
        logJson({
          event: 'failed',
          id: migration.id,
          kind: migration.kind,
          durationMs: durationMsLog,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (dryRun) {
      logJson({
        event: 'dry_run_complete',
        pendingCount: pending.length,
        pending,
        skippedCount: skipped.length,
      });
      if (pending.length > 0)
        console.log(`[migrate:dry-run] ${pending.length} pending: ${pending.join(', ')}`);
      else console.log('[migrate:dry-run] no pending migrations');
      return { applied: [], pending, skipped };
    }

    logJson({
      event: 'complete',
      appliedCount: applied.length,
      skippedCount: skipped.length,
      applied,
      skipped,
    });
    return { applied, pending: [], skipped };
  } finally {
    await client.unsafe(migrationUnlock).catch(() => undefined);
    logJson({ event: 'lock_released' });
    await client.end({ timeout: 5 });
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  const configuredConnectionString = process.env.DATABASE_URL;
  if (!configuredConnectionString) throw new Error('DATABASE_URL is required to run migrations');
  const checkOnly = process.argv.includes('--check');
  const dryRun =
    process.argv.includes('--dry-run') || checkOnly || process.env.MIGRATE_DRY_RUN === '1';
  const result = await runMigrations(configuredConnectionString, { dryRun });
  if (checkOnly && result.pending.length > 0) {
    console.error(`[migrate:check] ${result.pending.length} pending migration(s)`);
    process.exitCode = 1;
  }
}
