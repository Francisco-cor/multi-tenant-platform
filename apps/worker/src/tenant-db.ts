import {
  sql,
  withTenantTransaction,
  type DatabaseExecutor,
  type DatabaseHandle,
} from '@platform/db';

const SAFE_ROLE_PATTERN = /^[a-z_][a-z0-9_]*$/i;

/**
 * Role assumed for tenant-scoped work. It must be the RLS-restricted app role:
 * the DB branch removes BYPASSRLS from the worker role, and tenant handlers have
 * no business reading across tenants (item 10). Configurable, safe by default.
 */
export const WORKER_TENANT_ROLE = (() => {
  const configured = process.env.WORKER_TENANT_ROLE ?? 'platform_app';
  if (!SAFE_ROLE_PATTERN.test(configured)) throw new Error('worker_tenant_role_invalid');
  return configured;
})();

/** Statement timeout applied to global worker transactions (P3-2). */
const GLOBAL_STATEMENT_TIMEOUT = '5s';

/** Every tenant-scoped worker query must establish role and app.tenant_id locally. */
export function workerTenantTransaction<T>(
  db: DatabaseHandle,
  tenantId: string,
  requestId: string,
  callback: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  // Always run tenant work as the RLS-restricted role, never as the handle's
  // (possibly bypassing) global role.
  return withTenantTransaction(db, { tenantId, requestId }, callback, {
    role: WORKER_TENANT_ROLE,
  });
}

/** Global worker operations (relay/schedulers) run only on the dedicated worker role. */
export function workerGlobalTransaction<T>(
  db: DatabaseHandle,
  callback: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  return db.db.transaction(async (tx) => {
    if (db.role) await tx.execute(sql.raw(`set local role "${db.role}"`));
    // ALTER ROLE ... SET statement_timeout does not apply after SET ROLE, so
    // apply it explicitly per transaction.
    await tx.execute(sql.raw(`set local statement_timeout = '${GLOBAL_STATEMENT_TIMEOUT}'`));
    return callback(tx);
  });
}
