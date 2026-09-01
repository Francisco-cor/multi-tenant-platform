import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createBackup } from './backup.js';
import { runMigrations } from './migrate.js';
import {
  connectionStringForDatabase,
  normalizeConnectionString,
  runPostgresTool,
} from './pg-tools.js';

const verifiedTables = [
  'users',
  'organizations',
  'memberships',
  'branches',
  'sessions',
  'invitations',
  'audit_log',
  'schema_migrations',
] as const;
const rlsTables = ['organizations', 'memberships', 'branches', 'invitations', 'audit_log'] as const;

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(name + '_value_required');
  return value;
}

function hasArgument(args: string[], name: string): boolean {
  return args.includes(name);
}

function generatedDatabaseName(): string {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  return (
    'platform_restore_' +
    new Date().toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15) +
    '_' +
    suffix
  );
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) throw new Error('database_name_invalid');
  return String.fromCharCode(34) + identifier + String.fromCharCode(34);
}

async function tableCounts(client: postgres.Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of verifiedTables) {
    const rows = await client.unsafe<{ count: string }[]>(
      'select count(*)::text as count from public.' + table,
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

async function verifyRls(client: postgres.Sql): Promise<void> {
  const rows = await client.unsafe<
    { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
  >(
    'select c.relname, c.relrowsecurity, c.relforcerowsecurity ' +
      'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
      'where n.nspname = current_schema() and c.relname = any($1::text[])',
    [rlsTables],
  );
  const byName = new Map(rows.map((row) => [row.relname, row]));
  for (const table of rlsTables) {
    const row = byName.get(table);
    if (!row?.relrowsecurity || !row.relforcerowsecurity) {
      throw new Error('rls_verification_failed: ' + table);
    }
  }
}

async function verifyRestore(
  source: postgres.Sql,
  target: postgres.Sql,
): Promise<Record<string, unknown>> {
  const sourceCounts = await tableCounts(source);
  const targetCounts = await tableCounts(target);
  if (JSON.stringify(sourceCounts) !== JSON.stringify(targetCounts)) {
    throw new Error(
      'row_count_mismatch: ' + JSON.stringify({ source: sourceCounts, target: targetCounts }),
    );
  }

  await verifyRls(target);
  const sourceMigrations = await source.unsafe<{ id: string; kind: string }[]>(
    'select id, kind from schema_migrations order by id',
  );
  const targetMigrations = await target.unsafe<{ id: string; kind: string }[]>(
    'select id, kind from schema_migrations order by id',
  );
  if (JSON.stringify(sourceMigrations) !== JSON.stringify(targetMigrations)) {
    throw new Error('migration_history_mismatch');
  }

  const policies = await target.unsafe<{ count: string }[]>(
    'select count(*)::text as count from pg_policies ' +
      'where schemaname = current_schema() and tablename = any($1::text[])',
    [rlsTables],
  );
  if (Number(policies[0]?.count ?? 0) < rlsTables.length)
    throw new Error('rls_policy_verification_failed');

  return {
    migrations: targetMigrations,
    policies: Number(policies[0]?.count ?? 0),
    rows: targetCounts,
    rlsTables: [...rlsTables],
  };
}

async function main(): Promise<void> {
  const sourceConnectionString = process.env.DATABASE_URL;
  if (!sourceConnectionString) throw new Error('DATABASE_URL is required to run a restore drill');

  const args = process.argv.slice(2);
  const backup = await createBackup(sourceConnectionString, argumentValue(args, '--backup-output'));
  const targetDatabase = generatedDatabaseName();
  const targetConnectionString = connectionStringForDatabase(
    sourceConnectionString,
    targetDatabase,
  );
  const admin = postgres(normalizeConnectionString(sourceConnectionString), {
    max: 1,
    prepare: false,
  });
  let targetCreated = false;
  let verification: Record<string, unknown> | undefined;
  const keepTarget = hasArgument(args, '--keep-target');
  const evidencePath = resolve(
    argumentValue(args, '--evidence') ??
      resolve('.artifacts', 'db', 'restore-drill-' + targetDatabase + '.json'),
  );

  try {
    await admin.unsafe('create database ' + quoteIdentifier(targetDatabase));
    targetCreated = true;
    await runPostgresTool('pg_restore', 'PG_RESTORE_BIN', targetConnectionString, [
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      backup.outputPath,
    ]);

    const source = postgres(normalizeConnectionString(sourceConnectionString), {
      max: 1,
      prepare: false,
    });
    const target = postgres(normalizeConnectionString(targetConnectionString), {
      max: 1,
      prepare: false,
    });
    try {
      verification = await verifyRestore(source, target);
      const migrationResult = await runMigrations(targetConnectionString);
      if (migrationResult.applied.length > 0)
        throw new Error('restored_database_has_pending_migrations');
      verification = { ...verification, pendingMigrationsAfterReplay: migrationResult.applied };
    } finally {
      await source.end({ timeout: 5 });
      await target.end({ timeout: 5 });
    }

    const evidence = {
      backup,
      checkedAt: new Date().toISOString(),
      cleanup: !keepTarget,
      targetDatabase,
      verification,
    };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\\n', 'utf8');
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
  } finally {
    if (targetCreated && !keepTarget) {
      await admin
        .unsafe('drop database ' + quoteIdentifier(targetDatabase) + ' with (force)')
        .catch((error: unknown) => {
          console.error(
            'restore_target_cleanup_failed: ' +
              (error instanceof Error ? error.message : String(error)),
          );
        });
    }
    await admin.end({ timeout: 5 });
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) await main();
