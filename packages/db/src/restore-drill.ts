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

interface TableFingerprint {
  count: number;
  digest: string;
}

interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

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

function quoteLiteral(value: string): string {
  return String.fromCharCode(39) + value.replaceAll(String.fromCharCode(39), "''") + String.fromCharCode(39);
}

/** All business tables, derived from the catalog instead of a hand-picked list. */
async function businessTables(client: postgres.Sql): Promise<string[]> {
  const rows = await client.unsafe<{ tablename: string }[]>(
    "select tablename from pg_tables where schemaname = 'public' " +
      "and tablename <> 'schema_migrations' order by tablename",
  );
  return rows.map((row) => row.tablename);
}

/**
 * Row counts plus an order-independent content digest. A restore that loses
 * the payment ledger or silently truncates outbox rows cannot pass anymore.
 */
async function tableFingerprints(client: postgres.Sql): Promise<Record<string, TableFingerprint>> {
  const fingerprints: Record<string, TableFingerprint> = {};
  for (const table of await businessTables(client)) {
    const rows = await client.unsafe<{ count: string; digest: string | null }[]>(
      'select count(*)::text as count, ' +
        'md5(coalesce(sum(hashtext(t::text)::bigint), 0)::text) as digest ' +
        'from public.' +
        quoteIdentifier(table) +
        ' t',
    );
    fingerprints[table] = {
      count: Number(rows[0]?.count ?? 0),
      digest: rows[0]?.digest ?? '',
    };
  }
  return fingerprints;
}

async function tenantTables(client: postgres.Sql): Promise<string[]> {
  const rows = await client.unsafe<{ table_name: string }[]>(
    'select c.relname as table_name from pg_class c ' +
      'join pg_namespace n on n.oid = c.relnamespace ' +
      'join pg_attribute a on a.attrelid = c.oid and a.attname = ' +
      quoteLiteral('tenant_id') +
      ' and not a.attisdropped ' +
      "where n.nspname = 'public' and c.relkind = 'r'",
  );
  return rows.map((row) => row.table_name);
}

async function verifyRls(client: postgres.Sql): Promise<string[]> {
  const expected = await tenantTables(client);
  const rows = await client.unsafe<RlsRow[]>(
    'select c.relname, c.relrowsecurity, c.relforcerowsecurity ' +
      'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
      "where n.nspname = 'public' and c.relkind = 'r'",
  );
  const byName = new Map(rows.map((row) => [row.relname, row]));

  for (const table of expected) {
    const row = byName.get(table);
    if (!row?.relrowsecurity || !row.relforcerowsecurity) {
      throw new Error('rls_verification_failed: ' + table);
    }
  }

  // Per-table policy assertion: a table with two policies and another with zero
  // must not average out to "ok". WITH CHECK must be present for write paths.
  const policies = await client.unsafe<{ tablename: string; with_check: string | null }[]>(
    "select tablename, with_check from pg_policies where schemaname = 'public'",
  );
  const withCheck = new Set(
    policies.filter((policy) => policy.with_check !== null).map((policy) => policy.tablename),
  );
  const missing = expected.filter((table) => !withCheck.has(table));
  if (missing.length > 0) throw new Error('rls_policy_missing: ' + missing.join(','));

  // The credential/identity tables must not be reachable without a policy even
  // though they have no tenant_id column.
  for (const table of ['sessions', 'platform_audit_log']) {
    const row = byName.get(table);
    if (!row?.relrowsecurity || !row?.relforcerowsecurity) {
      throw new Error('rls_verification_failed: ' + table);
    }
  }

  return expected;
}

async function verifyPrivileges(client: postgres.Sql): Promise<void> {
  const tables = await tenantTables(client);
  for (const table of tables) {
    const rows = await client.unsafe<{ allowed: boolean | null }[]>(
      'select has_table_privilege(' +
        quoteLiteral('platform_app') +
        ', ' +
        quoteLiteral('public.' + table) +
        ", 'SELECT') as allowed",
    );
    if (rows[0]?.allowed !== true) throw new Error('privilege_verification_failed: ' + table);
  }

  const role = await client.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
    "select rolsuper, rolbypassrls from pg_roles where rolname = 'platform_worker'",
  );
  if (role[0]?.rolbypassrls || role[0]?.rolsuper) {
    throw new Error('worker_role_bypasses_rls');
  }
}

/**
 * Actually uses the restored database as a tenant would: assume platform_app,
 * bind one tenant and assert the isolation policy hides the others.
 */
async function verifyTenantIsolation(client: postgres.Sql): Promise<{ tenantId: string | null }> {
  const organizations = await client.unsafe<{ id: string; total: string }[]>(
    'select (select id::text from organizations order by id limit 1) as id, ' +
      'count(*)::text as total from organizations',
  );
  const tenantId = organizations[0]?.id ?? null;
  if (!tenantId) return { tenantId: null };

  await client.begin(async (tx) => {
    await tx.unsafe('set local role platform_app');
    await tx.unsafe("select set_config('app.tenant_id', " + quoteLiteral(tenantId) + ', true)');
    const visible = await tx.unsafe<{ count: string }[]>(
      'select count(*)::text as count from organizations',
    );
    if (Number(visible[0]?.count ?? 0) !== 1) throw new Error('tenant_probe_visible_orgs');
    const other = await tx.unsafe<{ count: string }[]>(
      'select count(*)::text as count from organizations where id <> ' +
        quoteLiteral(tenantId) +
        '::uuid',
    );
    if (Number(other[0]?.count ?? 0) !== 0) throw new Error('tenant_probe_cross_tenant_rows');
  });

  return { tenantId };
}

async function verifyRestore(
  source: postgres.Sql,
  target: postgres.Sql,
): Promise<Record<string, unknown>> {
  const sourceFingerprints = await tableFingerprints(source);
  const targetFingerprints = await tableFingerprints(target);

  const missingTables = Object.keys(sourceFingerprints).filter(
    (table) => !(table in targetFingerprints),
  );
  if (missingTables.length > 0) throw new Error('restore_missing_tables: ' + missingTables.join(','));

  for (const [table, sourcePrint] of Object.entries(sourceFingerprints)) {
    const targetPrint = targetFingerprints[table];
    if (!targetPrint) throw new Error('restore_missing_table: ' + table);
    if (sourcePrint.count !== targetPrint.count) {
      throw new Error(
        'row_count_mismatch: ' + table + ' ' + sourcePrint.count + ' -> ' + targetPrint.count,
      );
    }
    if (sourcePrint.digest !== targetPrint.digest) {
      throw new Error('row_digest_mismatch: ' + table);
    }
  }

  const sourceMigrations = await source.unsafe<{ id: string; kind: string }[]>(
    'select id, kind from schema_migrations order by id',
  );
  const targetMigrations = await target.unsafe<{ id: string; kind: string }[]>(
    'select id, kind from schema_migrations order by id',
  );
  if (JSON.stringify(sourceMigrations) !== JSON.stringify(targetMigrations)) {
    throw new Error('migration_history_mismatch');
  }

  const rlsTables = await verifyRls(target);
  await verifyPrivileges(target);
  const isolation = await verifyTenantIsolation(target);

  return {
    isolation,
    migrations: targetMigrations,
    rlsTables,
    rows: Object.fromEntries(
      Object.entries(targetFingerprints).map(([table, value]) => [table, value.count]),
    ),
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
      // Replay migrations before comparing: a restore missing a table that a
      // later migration creates must be visible, not hidden by ordering.
      const migrationResult = await runMigrations(targetConnectionString);
      if (migrationResult.applied.length > 0)
        throw new Error('restored_database_has_pending_migrations');
      verification = await verifyRestore(source, target);
      verification = { ...verification, pendingMigrationsAfterReplay: [] };
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
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
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

export { verifyRestore };
