import {
  sql,
  withTenantTransaction,
  type DatabaseExecutor,
  type DatabaseHandle,
} from '@platform/db';

/** Every tenant-scoped worker query must establish role and app.tenant_id locally. */
export function workerTenantTransaction<T>(
  db: DatabaseHandle,
  tenantId: string,
  requestId: string,
  callback: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(db, { tenantId, requestId }, callback);
}

/** Global worker operations (relay/schedulers) run only on the dedicated worker role. */
export function workerGlobalTransaction<T>(
  db: DatabaseHandle,
  callback: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  return db.db.transaction(async (tx) => {
    if (db.role) await tx.execute(sql.raw(`set local role "${db.role}"`));
    return callback(tx);
  });
}
