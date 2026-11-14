import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.js';
import {
  assertTenantRepositoryContext,
  assertUserId,
  type TenantRepositoryContext,
} from './tenant-context.js';

function hashTenantId(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 8);
}

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseExecutor = Pick<Database, 'execute'>;

/**
 * Roles a request may assume. Both are NOLOGIN roles that are subject to
 * FORCE ROW LEVEL SECURITY; anything else (platform_worker, the table owner,
 * a superuser) would silently disable the tenant isolation layer.
 */
export const TENANT_DATABASE_ROLES = ['platform_app', 'platform_auth'] as const;
export type TenantDatabaseRole = (typeof TENANT_DATABASE_ROLES)[number];

const TENANT_ROLE_SET: ReadonlySet<string> = new Set(TENANT_DATABASE_ROLES);

export function isTenantDatabaseRole(role: string): role is TenantDatabaseRole {
  return TENANT_ROLE_SET.has(role);
}

export interface DatabaseOptions {
  /**
   * Role assumed inside every scoped transaction. Mandatory unless
   * `allowUnscoped` is set: an unscoped pool runs as the connection owner and
   * bypasses RLS, which must be an explicit, auditable decision.
   */
  role?: string;
  /**
   * Explicit opt-in for owner/administrator connections (migrations, backup,
   * restore drill, seed, tests that seed data through the owner). Never use it
   * to serve requests.
   */
  allowUnscoped?: boolean;
  maxConnections?: number;
}

export interface DatabaseHandle {
  db: Database;
  role?: string;
  /**
   * Verifies (once per handle and role) that the role exists and does not
   * carry SUPERUSER/BYPASSRLS. Scoped transactions call it before SET ROLE so
   * a misconfigured DATABASE_ROLE fails closed at the first request.
   */
  verifyRolePrivileges: (role?: string) => Promise<void>;
  close: () => Promise<void>;
}

const SAFE_ROLE_PATTERN = /^[a-z_][a-z0-9_]*$/i;

function assertDatabaseRole(role: string): void {
  if (!SAFE_ROLE_PATTERN.test(role)) throw new Error('database_role_invalid');
}

function normalizeConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('schema');
  return url.toString();
}

interface RolePrivilegeRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

export async function assertRoleIsUnprivileged(client: postgres.Sql, role: string): Promise<void> {
  const rows = (await client.unsafe(
    'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
    [role],
  )) as RolePrivilegeRow[];
  const row = rows[0];
  if (!row) throw new Error('database_role_missing: ' + role);
  if (row.rolsuper || row.rolbypassrls) throw new Error('database_role_bypasses_rls: ' + role);
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): DatabaseHandle {
  if (!connectionString.trim()) throw new Error('database_url_required');
  if (!options.role && !options.allowUnscoped) throw new Error('database_role_required');
  if (options.role) assertDatabaseRole(options.role);

  const client = postgres(normalizeConnectionString(connectionString), {
    max: options.maxConnections ?? 10,
    prepare: false,
  });
  const database = drizzle(client, { schema });

  const configuredRole = options.role;
  const privilegeChecks = new Map<string, Promise<void>>();
  const verifyRolePrivileges = (role?: string): Promise<void> => {
    const target = role ?? configuredRole;
    if (!target) return Promise.resolve();
    assertDatabaseRole(target);
    let check = privilegeChecks.get(target);
    if (!check) {
      check = assertRoleIsUnprivileged(client, target).catch((error: unknown) => {
        // Do not cache a failed check: a transient connection error must not
        // permanently wedge the handle, while a real privilege violation keeps
        // failing on every request.
        privilegeChecks.delete(target);
        throw error;
      });
      privilegeChecks.set(target, check);
    }
    return check;
  };

  return {
    db: database,
    ...(configuredRole ? { role: configuredRole } : {}),
    verifyRolePrivileges,
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Owner/administrator connection (migrations, seeds, backup/restore drill).
 * Kept separate from `createDatabase` so that serving paths cannot forget the
 * role and silently run with RLS disabled.
 */
export function createAdminDatabase(
  connectionString: string,
  options: Pick<DatabaseOptions, 'maxConnections'> = {},
): DatabaseHandle {
  return createDatabase(connectionString, { ...options, allowUnscoped: true });
}

function resolveScopedRole(
  database: Database | DatabaseHandle,
  explicitRole: string | undefined,
): string | undefined {
  const role = explicitRole ?? ('db' in database ? database.role : undefined);
  if (!role) return undefined;
  assertDatabaseRole(role);
  return role;
}

async function assertScopedRoleAllowed(
  database: Database | DatabaseHandle,
  role: string | undefined,
): Promise<void> {
  // A bare Database has no handle to verify against; callers using it are
  // trusted in-package code paths (already inside a scoped transaction).
  if ('verifyRolePrivileges' in database) await database.verifyRolePrivileges(role);
  if (role && !isTenantDatabaseRole(role)) throw new Error('database_role_not_allowed: ' + role);
}

async function applySessionSettings(
  transaction: DatabaseExecutor,
  settings: { applicationName?: string; tenantId?: string; userId?: string },
): Promise<void> {
  if (settings.tenantId) {
    await transaction.execute(
      sql`select set_config('app.tenant_id', ${settings.tenantId}, true) as tenant_id`,
    );
  }
  if (settings.userId) {
    await transaction.execute(
      sql`select set_config('app.user_id', ${settings.userId}, true) as user_id`,
    );
  }
  if (settings.applicationName) {
    await transaction.execute(
      sql`select set_config('application_name', ${settings.applicationName}, true) as application_name`,
    );
  }
}

export async function withTenantTransaction<T>(
  database: Database | DatabaseHandle,
  context: TenantRepositoryContext,
  callback: (transaction: DatabaseExecutor) => Promise<T>,
  options: Pick<DatabaseOptions, 'role'> = {},
): Promise<T> {
  assertTenantRepositoryContext(context);
  const db = 'db' in database ? database.db : database;
  const role = resolveScopedRole(database, options.role);
  await assertScopedRoleAllowed(database, role);

  return db.transaction(async (transaction) => {
    if (role) {
      await transaction.execute(sql.raw(`set local role "${role}"`));
    }

    const tenantHash = hashTenantId(context.tenantId);
    await applySessionSettings(transaction, {
      tenantId: context.tenantId,
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.requestId
        ? { applicationName: `${context.requestId.slice(0, 16)}:${tenantHash}` }
        : {}),
    });

    return callback(transaction);
  });
}

export interface AuthBootstrapContext {
  requestId: string;
}

export interface AuthTransactionContext {
  userId: string;
  /** Optional tenant binding for the pre-login / session-selection path. */
  tenantId?: string;
  requestId: string;
}

/**
 * Narrow pre-identity auth transaction (`platform_auth`, no `app.user_id`).
 *
 * Session lookup happens after the browser presents a bearer token but before
 * the API knows which user owns it. `sessions` has a full-access policy for
 * `platform_auth` and a user-bound one for `platform_app`, so using the
 * tenant role here would silently match zero rows. This helper exposes only
 * that lookup window: every write after the token has been resolved must use
 * `withAuthTransaction`, which binds `app.user_id`.
 */
export async function withAuthBootstrapTransaction<T>(
  database: Database | DatabaseHandle,
  context: AuthBootstrapContext,
  callback: (transaction: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  if (!context.requestId.trim()) throw new Error('request_id_required');
  const db = 'db' in database ? database.db : database;
  const role = 'platform_auth';
  await assertScopedRoleAllowed(database, role);

  return db.transaction(async (transaction) => {
    await transaction.execute(sql.raw(`set local role "${role}"`));
    await transaction.execute(
      sql`select set_config('app.user_id', '', true) as user_id, set_config('app.tenant_id', '', true) as tenant_id`,
    );
    await applySessionSettings(transaction, {
      applicationName: `${context.requestId.slice(0, 16)}:auth-bootstrap`,
    });
    return callback(transaction);
  });
}


/**
 * Auth-scoped transaction for `sessions`/`users`/login flows. Runs as
 * `platform_auth`, which is the only role with DML on the credential tables,
 * and binds `app.user_id` so user-scoped policies can be evaluated.
 */
export async function withAuthTransaction<T>(
  database: Database | DatabaseHandle,
  context: AuthTransactionContext,
  callback: (transaction: DatabaseExecutor) => Promise<T>,
  options: Pick<DatabaseOptions, 'role'> = {},
): Promise<T> {
  if (!context.userId.trim()) throw new Error('user_id_required');
  assertUserId(context.userId);
  if (!context.requestId.trim()) throw new Error('request_id_required');
  if (context.tenantId) assertTenantRepositoryContext(context as TenantRepositoryContext);

  const db = 'db' in database ? database.db : database;
  const role = options.role ?? 'platform_auth';
  assertDatabaseRole(role);
  if (!isTenantDatabaseRole(role)) throw new Error('database_role_not_allowed: ' + role);
  await assertScopedRoleAllowed(database, role);

  return db.transaction(async (transaction) => {
    await transaction.execute(sql.raw(`set local role "${role}"`));
    await applySessionSettings(transaction, {
      userId: context.userId,
      ...(context.tenantId ? { tenantId: context.tenantId } : {}),
      applicationName: `${context.requestId.slice(0, 16)}:auth`,
    });
    return callback(transaction);
  });
}
