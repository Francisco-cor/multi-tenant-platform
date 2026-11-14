import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../database.js';

export interface ClaimJobInput {
  jobId: string;
  leaseMs?: number;
  queue: string;
  tenantId: string;
  token: string;
}

export interface ClaimJobResult {
  claimed: boolean;
  /** Fence value when claimed; a newer fence means another worker took over. */
  fence?: number;
}

/**
 * Atomically claim a dedupe row. Succeeds for a brand-new job or for an
 * expired processing lease; never for a completed job or a live lease.
 *
 * The caller must pass the same token to completeProcessedJob, which reports
 * `lease_lost` if a takeover happened in between.
 */
export async function claimProcessedJob(
  tx: DatabaseExecutor,
  input: ClaimJobInput,
): Promise<ClaimJobResult> {
  const leaseMs = input.leaseMs ?? 5 * 60 * 1000;
  const rows = await tx.execute<{ lease_fence: string }>(sql`
    insert into processed_jobs (job_id, tenant_id, queue, status, lease_token, lease_until)
    values (
      ${input.jobId}, ${input.tenantId}::uuid, ${input.queue}, 'processing',
      ${input.token}, now() + (${leaseMs}::text || ' milliseconds')::interval
    )
    on conflict (job_id) do update
      set lease_token = excluded.lease_token,
          lease_until = excluded.lease_until,
          status = 'processing'
      where processed_jobs.status <> 'completed'
        and (
          processed_jobs.lease_until is null
          or processed_jobs.lease_until <= now()
        )
    returning lease_fence
  `);
  const row = rows[0];
  return row ? { claimed: true, fence: Number(row.lease_fence) } : { claimed: false };
}

/**
 * Finish a job only if this worker still owns the lease. Returns `lease_lost`
 * when a takeover already happened, so the caller must not report success and
 * must not retry the side effect (the new owner is running it).
 */
export async function completeProcessedJob(
  tx: DatabaseExecutor,
  input: { jobId: string; leaseToken: string; result?: unknown; tenantId: string },
): Promise<'completed' | 'lease_lost'> {
  const resultValue =
    input.result === undefined
      ? null
      : typeof input.result === 'string'
        ? input.result
        : JSON.stringify(input.result);
  const rows = await tx.execute<{ job_id: string }>(sql`
    update processed_jobs
       set status = 'completed',
           result = ${resultValue}::jsonb,
           processed_at = now(),
           lease_until = null,
           lease_token = null
     where job_id = ${input.jobId}
       and tenant_id = ${input.tenantId}::uuid
       and status = 'processing'
       and lease_token = ${input.leaseToken}
    returning job_id
  `);
  return rows.length > 0 ? 'completed' : 'lease_lost';
}

/** Extend a live lease for a job that legitimately runs longer than the TTL. */
export async function heartbeatProcessedJob(
  tx: DatabaseExecutor,
  input: { jobId: string; leaseMs?: number; leaseToken: string; tenantId: string },
): Promise<boolean> {
  const leaseMs = input.leaseMs ?? 60 * 1000;
  const rows = await tx.execute<{ job_id: string }>(sql`
    update processed_jobs
       set lease_until = now() + (${leaseMs}::text || ' milliseconds')::interval
     where job_id = ${input.jobId}
       and tenant_id = ${input.tenantId}::uuid
       and status = 'processing'
       and lease_token = ${input.leaseToken}
    returning job_id
  `);
  return rows.length > 0;
}
