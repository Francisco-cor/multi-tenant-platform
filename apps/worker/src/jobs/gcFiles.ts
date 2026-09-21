import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { workerGlobalTransaction } from '../tenant-db.js';

export interface GcFilesResult {
  expiredCount: number;
  deletedCount: number;
  durationMs: number;
}

/**
 * GC for orphan / expired file uploads.
 * - Finds pending files where expires_at <= now()
 * - Marks them 'expired' with FOR UPDATE SKIP LOCKED (idempotent)
 * - Optionally deletes S3 object (best effort, never fails the transaction)
 *
 * Mirrors expireReservations logic for consistency.
 */
export async function gcFiles(
  db: DatabaseHandle,
  s3: { deleteObject(key: string): Promise<void> },
  options: { batchSize?: number; now?: Date } = {},
): Promise<GcFilesResult> {
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? new Date();
  const start = Date.now();

  const result = await workerGlobalTransaction(db, async (tx) => {
    const expired = await tx.execute<{ id: string; key: string; tenant_id: string }>(sql`
      select id, key, tenant_id
      from files
      where status = 'pending' and expires_at <= ${now.toISOString()}::timestamptz
      order by expires_at
      limit ${batchSize}
      for update skip locked
    `);

    if (expired.length === 0) return { expiredCount: 0, keys: [] as string[] };

    const ids = expired.map((r) => r.id);

    await tx.execute(sql`
      update files
      set status = 'expired', updated_at = now()
      where id = any(${ids}::uuid[]) and status = 'pending'
    `);

    return { expiredCount: expired.length, keys: expired.map((r) => r.key) };
  });

  let deleted = 0;
  for (const key of (result as { keys?: string[] }).keys ?? []) {
    try {
      await s3.deleteObject(key);
      deleted++;
    } catch {
      // best effort: log but don't fail GC
    }
  }

  return {
    expiredCount: result.expiredCount,
    deletedCount: deleted,
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
  const start = Date.now();
  for (let i = 0; i < maxBatches; i++) {
    const r = await gcFiles(
      db,
      s3,
      options.batchSize !== undefined ? { batchSize: options.batchSize } : {},
    );
    totalExpired += r.expiredCount;
    totalDeleted += r.deletedCount;
    if (r.expiredCount === 0) break;
  }
  return { expiredCount: totalExpired, deletedCount: totalDeleted, durationMs: Date.now() - start };
}
