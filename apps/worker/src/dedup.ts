import { randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { workerTenantTransaction } from './tenant-db.js';

/**
 * Dedupe via `processed_jobs` table.
 * - Claim a job atomically with a short lease before processing.
 * - Completed rows return the cached result; abandoned leases can be reclaimed.
 * - Successful processing marks the same row completed; failures release the claim.
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
  const rows = await workerTenantTransaction(db, tenantId, `dedup:${jobId}`, (tx) =>
    tx.execute<{ result: string | null }>(sql`
      select result from processed_jobs where job_id = ${jobId} and tenant_id = ${tenantId}::uuid and status='completed' limit 1
    `),
  );
  const row = rows[0];
  if (!row) return { hit: false };
  const result = row.result ? JSON.parse(row.result) : undefined;
  return { hit: true, result };
}

export async function markProcessed(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; leaseToken: string; result?: unknown },
): Promise<void> {
  const resultStr = input.result !== undefined ? JSON.stringify(input.result) : null;
  await workerTenantTransaction(db, input.tenantId, `dedup:${input.jobId}`, (tx) =>
    tx.execute(sql`
      update processed_jobs
      set status='completed', result=${resultStr}::jsonb, processed_at=now(), lease_until=null, lease_token=null
      where job_id=${input.jobId}
        and tenant_id=${input.tenantId}::uuid
        and status='processing'
        and lease_token=${input.leaseToken}
    `),
  );
}

async function claimJob(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; queue: string },
): Promise<{ claimed: boolean; leaseToken?: string; result?: unknown }> {
  const leaseToken = randomUUID();
  return workerTenantTransaction(db, input.tenantId, `dedup:${input.jobId}`, async (tx) => {
    const inserted = await tx.execute<{ status: string; result: string | null }>(sql`
      insert into processed_jobs (job_id, tenant_id, queue, status, lease_until, lease_token)
      values (${input.jobId}, ${input.tenantId}::uuid, ${input.queue}, 'processing', now() + interval '5 minutes', ${leaseToken})
      on conflict (job_id) do nothing
      returning status, result
    `);
    if (inserted.length > 0) return { claimed: true, leaseToken };

    const reclaimed = await tx.execute<{ status: string; result: string | null }>(sql`
      update processed_jobs
      set lease_until=now() + interval '5 minutes', lease_token=${leaseToken}
      where job_id=${input.jobId}
        and tenant_id=${input.tenantId}::uuid
        and status='processing'
        and lease_until <= now()
      returning status, result
    `);
    if (reclaimed.length > 0) return { claimed: true, leaseToken };

    const existing = await tx.execute<{ status: string; result: string | null }>(sql`
      select status, result
      from processed_jobs
      where job_id=${input.jobId} and tenant_id=${input.tenantId}::uuid
      limit 1
    `);
    const row = existing[0];
    if (!row || row.status === 'processing') throw new Error('job_in_progress');
    return { claimed: false, result: row.result ? JSON.parse(row.result) : undefined };
  });
}

async function releaseJob(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; leaseToken: string },
): Promise<void> {
  await workerTenantTransaction(db, input.tenantId, `dedup:${input.jobId}`, (tx) =>
    tx.execute(sql`
      delete from processed_jobs
      where job_id=${input.jobId}
        and tenant_id=${input.tenantId}::uuid
        and status='processing'
        and lease_token=${input.leaseToken}
    `),
  );
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
  const claim = await claimJob(db, input);
  if (!claim.claimed) return { deduped: true, result: claim.result as T };
  const leaseToken = claim.leaseToken!;
  try {
    const result = await fn();
    await markProcessed(db, { ...input, leaseToken, result });
    return { deduped: false, result };
  } catch (error) {
    await releaseJob(db, { ...input, leaseToken }).catch(() => undefined);
    throw error;
  }
}
