import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';

/**
 * Dedupe via `processed_jobs` table.
 * - Before processing a job, check if job_id already exists → return cached result (hit)
 * - After successful processing, insert job_id with result (idempotent via ON CONFLICT DO NOTHING)
 * - All operations are tenant-scoped via withTenantTransaction wrapper or direct sql with tenant_id filter.
 *
 * The jobId is deterministic: sha256(tenantId:aggregateId:eventType). This ensures
 * duplicate outbox publishes (e.g. relay retry) map to same jobId and only one effect.
 */

export async function isProcessed(
  db: DatabaseHandle,
  jobId: string,
  tenantId: string,
): Promise<{ hit: boolean; result?: unknown }> {
  const rows = await db.db.execute<{ result: string | null }>(sql`
    select result from processed_jobs where job_id = ${jobId} and tenant_id = ${tenantId}::uuid limit 1
  `);
  const row = rows[0];
  if (!row) return { hit: false };
  const result = row.result ? JSON.parse(row.result) : undefined;
  return { hit: true, result };
}

export async function markProcessed(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; queue: string; result?: unknown },
): Promise<void> {
  const resultStr = input.result !== undefined ? JSON.stringify(input.result) : null;
  await db.db.execute(sql`
    insert into processed_jobs (job_id, tenant_id, queue, result)
    values (${input.jobId}, ${input.tenantId}::uuid, ${input.queue}, ${resultStr}::jsonb)
    on conflict (job_id) do nothing
  `);
}

/**
 * Higher-level helper: executes `fn` only if not already processed.
 * Returns { deduped: true, result } if already processed, else { deduped: false, result: fn() }
 */
export async function withDedup<T>(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; queue: string },
  fn: () => Promise<T>,
): Promise<{ deduped: boolean; result: T }> {
  const existing = await isProcessed(db, input.jobId, input.tenantId);
  if (existing.hit) return { deduped: true, result: existing.result as T };
  const result = await fn();
  await markProcessed(db, {
    jobId: input.jobId,
    tenantId: input.tenantId,
    queue: input.queue,
    result,
  });
  return { deduped: false, result };
}
