import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../database.js';

export interface PurgeSessionsResult {
  deletedCount: number;
  durationMs: number;
}

/**
 * Delete expired sessions in batches. Safe to run concurrently with other purges
 * because DELETE takes row-level locks and predicate is immutable (expires_at <= now()).
 *
 * Use FOR UPDATE SKIP LOCKED style? For sessions PK token_hash, simple DELETE is idempotent.
 * Batch limit prevents long-running transaction holding many rows.
 */
export async function purgeExpiredSessions(
  db: DatabaseExecutor,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<PurgeSessionsResult> {
  const batchSize = options.batchSize ?? 1000;
  const start = Date.now();
  if (options.dryRun) {
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from sessions where expires_at <= now()
    `);
    const count = Number(rows[0]?.count ?? '0');
    return { deletedCount: count, durationMs: Date.now() - start };
  }

  // Delete using primary key sub-select to allow LIMIT.
  // Postgres does not support DELETE ... LIMIT directly.
  const rows = await db.execute<{ count: string }>(sql`
    with expired as (
      select token_hash from sessions
      where expires_at <= now()
      order by expires_at
      limit ${batchSize}
    ),
    deleted as (
      delete from sessions
      where token_hash in (select token_hash from expired)
      returning token_hash
    )
    select count(*)::text as count from deleted
  `);
  const deletedCount = Number(rows[0]?.count ?? '0');
  return { deletedCount, durationMs: Date.now() - start };
}

/**
 * Loop until no expired rows remain. Returns total deleted.
 * Useful for scheduled job: call repeatedly with backoff until 0.
 */
export async function purgeExpiredSessionsUntilEmpty(
  db: DatabaseExecutor,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<PurgeSessionsResult> {
  const maxBatches = options.maxBatches ?? 10;
  let total = 0;
  const start = Date.now();
  for (let i = 0; i < maxBatches; i++) {
    const batchOptions = options.batchSize === undefined ? {} : { batchSize: options.batchSize };
    const result = await purgeExpiredSessions(db, batchOptions);
    total += result.deletedCount;
    if (result.deletedCount === 0) break;
  }
  return { deletedCount: total, durationMs: Date.now() - start };
}
