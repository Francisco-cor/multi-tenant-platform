import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../database.js';

export interface RetentionSweepResult {
  deletedCount: number;
  durationMs: number;
  table: string;
  /** Populated on dry runs: rows that would be deleted. */
  wouldDelete?: number;
}

export interface RetentionOptions {
  batchSize?: number;
  dryRun?: boolean;
  maxBatches?: number;
  /** Retention window in days; defaults are documented with each purge. */
  olderThanDays?: number;
}

const DEFAULT_BATCH_SIZE = 10_000;
const DEFAULT_MAX_BATCHES = 10;

function intervalDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) throw new Error('retention_window_invalid');
  return `${Math.trunc(days)} days`;
}

async function batchedDelete(
  db: DatabaseExecutor,
  table: string,
  whereClause: ReturnType<typeof sql>,
  keyColumn: string,
  orderColumn: string,
  options: RetentionOptions,
): Promise<RetentionSweepResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const start = Date.now();

  if (options.dryRun) {
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from ${sql.raw(table)} where ${whereClause}
    `);
    return {
      deletedCount: 0,
      durationMs: Date.now() - start,
      table,
      wouldDelete: Number(rows[0]?.count ?? '0'),
    };
  }

  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await db.execute<{ count: string }>(sql`
      with candidates as (
        select ${sql.raw(keyColumn)} as key
        from ${sql.raw(table)}
        where ${whereClause}
        order by ${sql.raw(orderColumn)}
        limit ${batchSize}
      ),
      deleted as (
        delete from ${sql.raw(table)}
        where ${sql.raw(keyColumn)} in (select key from candidates)
        returning 1
      )
      select count(*)::text as count from deleted
    `);
    const deleted = Number(rows[0]?.count ?? '0');
    total += deleted;
    if (deleted < batchSize) break;
  }

  return { deletedCount: total, durationMs: Date.now() - start, table };
}

/**
 * Delivered outbox rows are kept for 7 days for replay/debugging, then purged.
 * The relay never reads terminal rows, so deletion cannot lose an event.
 */
export function purgeOutboxEvents(
  db: DatabaseExecutor,
  options: RetentionOptions = {},
): Promise<RetentionSweepResult> {
  return batchedDelete(
    db,
    'outbox_events',
    sql`status in ('done', 'dead_letter') and created_at < now() - ${intervalDays(options.olderThanDays ?? 7)}::interval`,
    'id',
    'created_at',
    options,
  );
}

/**
 * Webhook payloads are customer data. Delivered/failed deliveries are retained
 * for 30 days for support, then purged (the endpoint/counters remain).
 */
export function purgeWebhookDeliveries(
  db: DatabaseExecutor,
  options: RetentionOptions = {},
): Promise<RetentionSweepResult> {
  return batchedDelete(
    db,
    'webhook_deliveries',
    sql`status in ('delivered', 'failed', 'dead_letter', 'disabled') and created_at < now() - ${intervalDays(options.olderThanDays ?? 30)}::interval`,
    'id',
    'created_at',
    options,
  );
}

/** Dedupe records only need to outlive the lease window; 7 days is ample. */
export function purgeProcessedJobs(
  db: DatabaseExecutor,
  options: RetentionOptions = {},
): Promise<RetentionSweepResult> {
  return batchedDelete(
    db,
    'processed_jobs',
    sql`status = 'completed' and processed_at < now() - ${intervalDays(options.olderThanDays ?? 7)}::interval`,
    'job_id',
    'processed_at',
    options,
  );
}

/** Resolved DLQ entries (replayed/discarded) are kept 30 days for postmortems. */
export function purgeDlqJobs(
  db: DatabaseExecutor,
  options: RetentionOptions = {},
): Promise<RetentionSweepResult> {
  return batchedDelete(
    db,
    'dlq_jobs',
    sql`status in ('replayed', 'discarded') and created_at < now() - ${intervalDays(options.olderThanDays ?? 30)}::interval`,
    'id',
    'created_at',
    options,
  );
}

export interface RetentionSweepSummary {
  results: RetentionSweepResult[];
  totalDeleted: number;
}

/**
 * One entry point for the maintenance scheduler. Run as an owner/admin
 * connection: `platform_app` deliberately cannot delete outbox/dedupe rows.
 *
 * Recommended cadence: hourly, or daily for low-volume deployments.
 */
export async function runRetentionSweep(
  db: DatabaseExecutor,
  options: RetentionOptions = {},
): Promise<RetentionSweepSummary> {
  const results: RetentionSweepResult[] = [];
  results.push(await purgeOutboxEvents(db, options));
  results.push(await purgeWebhookDeliveries(db, options));
  results.push(await purgeProcessedJobs(db, options));
  results.push(await purgeDlqJobs(db, options));
  return {
    results,
    totalDeleted: results.reduce((total, result) => total + result.deletedCount, 0),
  };
}
