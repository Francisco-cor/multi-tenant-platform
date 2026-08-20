import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.js';
import { assertTenantRepositoryContext, type TenantRepositoryContext } from './tenant-context.js';

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseExecutor = Pick<Database, 'execute'>;

export interface DatabaseOptions {
  role?: string;
  maxConnections?: number;
}

export interface DatabaseHandle {
  db: Database;
  role?: string;
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

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): DatabaseHandle {
  if (!connectionString.trim()) throw new Error('database_url_required');
  if (options.role) assertDatabaseRole(options.role);

  const client = postgres(normalizeConnectionString(connectionString), {
    max: options.maxConnections ?? 10,
    prepare: false,
  });
  const database = drizzle(client, { schema });

  return {
    db: database,
    ...(options.role ? { role: options.role } : {}),
    close: () => client.end({ timeout: 5 }),
  };
}

export async function withTenantTransaction<T>(
  database: Database | DatabaseHandle,
  context: TenantRepositoryContext,
  callback: (transaction: DatabaseExecutor) => Promise<T>,
  options: Pick<DatabaseOptions, 'role'> = {},
): Promise<T> {
  assertTenantRepositoryContext(context);
  const db = 'db' in database ? database.db : database;
  const role = options.role ?? ('db' in database ? database.role : undefined);
  if (role) assertDatabaseRole(role);

  return db.transaction(async (transaction) => {
    if (role) {
      await transaction.execute(sql.raw(`set local role "${role}"`));
    }

    await transaction.execute(
      sql`select set_config('app.tenant_id', ${context.tenantId}, true) as tenant_id`,
    );

    return callback(transaction);
  });
}
