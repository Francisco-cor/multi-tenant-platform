import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { workerGlobalTransaction } from '../tenant-db.js';
import { workerMetrics } from '../worker-metrics.js';

export interface GcFilesResult {
  expiredCount: number;
  deletedCount: number;
  failedCount: number;
  durationMs: number;
}

/**
 * GC for orphan / expired file uploads.
 *
 * The object is deleted **before** the row is marked `expired`: a failed S3
 * delete leaves the row `pending`, so the next tick retries it instead of
 * leaking the object forever (P2-9). Failures are counted and returned.
 */
export async function gcFiles(
  db: DatabaseHandle,
  s3: { deleteObject(key: string): Promise<void> },
  options: { batchSize?: number; now?: Date; signal?: AbortSignal } = {},
): Promise<GcFilesResult> {
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? new Date();
  const start = Date.now();

  const expired = await workerGlobalTransaction(db, (tx) =>
    tx.execute<{ id: string; key: string; tenant_id: string }>(sql`
      select id, key, tenant_id
      from files
      where status = 'pending' and expires_at <= ${now.toISOString()}::timestamptz
      order by expires_at
      limit ${batchSize}
      for update skip locked
    `),
  );

  if (expired.length === 0) {
    return { expiredCount: 0, deletedCount: 0, failedCount: 0, durationMs: Date.now() - start };
  }

  const deletedIds: string[] = [];
  let failed = 0;
  for (const file of expired) {
    if (options.signal?.aborted) break;
    try {
      await s3.deleteObject(file.key);
      deletedIds.push(file.id);
    } catch {
      // Keep the row pending so the next tick retries the delete.
      failed++;
      workerMetrics.increment('gc_delete_failures_total');
    }
  }

  const expiredCount = deletedIds.length;
  if (deletedIds.length > 0) {
    await workerGlobalTransaction(db, (tx) =>
      tx.execute(sql`
        update files
        set status = 'expired', updated_at = now()
        where id = any(${deletedIds}::uuid[]) and status = 'pending'
      `),
    );
  }

  return {
    expiredCount,
    deletedCount: expiredCount,
    failedCount: failed,
    durationMs: Date.now() - start,
  };
}

export async function gcFilesUntilEmpty(
  db: DatabaseHandle,
  s3: { deleteObject(key: string): Promise<void> },
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<GcFilesResult> {
  const maxBatches = options.maxBatches ?? 10;
  let totalExpired = 0;
  let totalDeleted = 0;
  let totalFailed = 0;
  const start = Date.now();
  for (let i = 0; i < maxBatches; i++) {
    const r = await gcFiles(
      db,
      s3,
      options.batchSize !== undefined ? { batchSize: options.batchSize } : {},
    );
    totalExpired += r.expiredCount;
    totalDeleted += r.deletedCount;
    totalFailed += r.failedCount;
    if (r.expiredCount === 0) break;
  }
  return {
    expiredCount: totalExpired,
    deletedCount: totalDeleted,
    failedCount: totalFailed,
    durationMs: Date.now() - start,
  };
}
