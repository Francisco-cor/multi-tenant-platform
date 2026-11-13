import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../database.js';

export interface PurgeSessionsResult {
  /** Rows actually deleted. Always 0 on a dry run. */
  deletedCount: number;
  durationMs: number;
  /** Populated on dry runs: rows that would be deleted. */
  wouldDelete?: number;
}

const EXPIRED_PREDICATE = sql`
  expires_at <= now()
  or (absolute_expires_at is not null and absolute_expires_at <= now())
`;

/**
 * Delete expired sessions in batches. Safe to run concurrently with other
 * purges because DELETE takes row-level locks and the predicate is immutable.
 *
 * Batch limit prevents a long-running transaction holding many rows.
 */
export async function purgeExpiredSessions(
  db: DatabaseExecutor,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<PurgeSessionsResult> {
  const batchSize = options.batchSize ?? 1000;
  const start = Date.now();
  if (options.dryRun) {
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from sessions where ${EXPIRED_PREDICATE}
    `);
    return {
      deletedCount: 0,
      durationMs: Date.now() - start,
      wouldDelete: Number(rows[0]?.count ?? '0'),
    };
  }

  // Delete using primary key sub-select to allow LIMIT.
  // Postgres does not support DELETE ... LIMIT directly.
  const rows = await db.execute<{ count: string }>(sql`
    with expired as (
      select token_hash from sessions
      where ${EXPIRED_PREDICATE}
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
 * Scheduled by the worker maintenance tick; exported from the package root.
 */
export async function purgeExpiredSessionsUntilEmpty(
  db: DatabaseExecutor,
  options: { batchSize?: number; maxBatches?: number; dryRun?: boolean } = {},
): Promise<PurgeSessionsResult> {
  const maxBatches = options.maxBatches ?? 10;
  let total = 0;
  const start = Date.now();
  for (let i = 0; i < maxBatches; i += 1) {
    const batchOptions: { batchSize?: number; dryRun?: boolean } = {};
    if (options.batchSize !== undefined) batchOptions.batchSize = options.batchSize;
    if (options.dryRun) batchOptions.dryRun = true;
    const result = await purgeExpiredSessions(db, batchOptions);
    if (options.dryRun) {
      return { ...result, durationMs: Date.now() - start };
    }
    total += result.deletedCount;
    if (result.deletedCount === 0) break;
  }
  return { deletedCount: total, durationMs: Date.now() - start };
}
