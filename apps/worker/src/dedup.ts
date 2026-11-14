import { randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { workerTenantTransaction } from './tenant-db.js';
import { workerMetrics } from './worker-metrics.js';

/**
 * Dedupe via `processed_jobs` table.
 * - Claim a job atomically with a short lease before processing.
 * - Completed rows return the cached result; abandoned leases can be reclaimed.
 * - Successful processing marks the same row completed; failures release the claim.
 * - All operations are tenant-scoped via withTenantTransaction wrapper or direct sql with tenant_id filter.
 *
 * The jobId is deterministic per outbox event. Duplicate outbox publishes
 * (e.g. relay retry) map to the same jobId and produce one effect.
 *
 * jsonb columns are read back as `::text` on purpose: postgres.js already parses
 * jsonb into JS values, so `JSON.parse(row.result)` would throw.
 */

/** The lease belongs to another worker: this worker must not report success. */
export class JobLeaseLostError extends Error {
  constructor() {
    super('job_lease_lost');
    this.name = 'JobLeaseLostError';
  }
}

/** Another worker holds an unexpired lease for the same job id. */
export class JobInProgressError extends Error {
  constructor() {
    super('job_in_progress');
    this.name = 'JobInProgressError';
  }
}

export const JOB_LEASE_DURATION_MS = 5 * 60 * 1000;
export const JOB_LEASE_RENEWAL_MS = 60 * 1000;

function decodeJsonbResult(value: string | null): unknown {
  if (value === null) return undefined;
  return JSON.parse(value);
}

export async function isProcessed(
  db: DatabaseHandle,
  jobId: string,
  tenantId: string,
): Promise<{ hit: boolean; result?: unknown }> {
  const rows = await workerTenantTransaction(db, tenantId, `dedup:${jobId}`, (tx) =>
    tx.execute<{ result: string | null }>(sql`
      select result::text as result from processed_jobs where job_id = ${jobId} and tenant_id = ${tenantId}::uuid and status='completed' limit 1
    `),
  );
  const row = rows[0];
  if (!row) return { hit: false };
  return { hit: true, result: decodeJsonbResult(row.result) };
}

/**
 * Complete the job under the current lease. Throws {@link JobLeaseLostError}
 * when the lease was taken over (0 rows affected) so the caller never reports a
 * duplicate side effect as success.
 */
export async function markProcessed(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; leaseToken: string; result?: unknown },
): Promise<void> {
  const resultStr = input.result !== undefined ? JSON.stringify(input.result) : null;
  const updated = await workerTenantTransaction(db, input.tenantId, `dedup:${input.jobId}`, (tx) =>
    tx.execute<{ id: string }>(sql`
      update processed_jobs
      set status='completed', result=${resultStr}::jsonb, processed_at=now(), lease_until=null, lease_token=null
      where job_id=${input.jobId}
        and tenant_id=${input.tenantId}::uuid
        and status='processing'
        and lease_token=${input.leaseToken}
      returning job_id as id
    `),
  );
  if (updated.length === 0) throw new JobLeaseLostError();
}

/** Extend the lease. Returns false when the lease is no longer owned. */
export async function renewJobLease(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; leaseToken: string; durationMs?: number },
): Promise<boolean> {
  const durationMs = input.durationMs ?? JOB_LEASE_DURATION_MS;
  const renewed = await workerTenantTransaction(db, input.tenantId, `dedup:${input.jobId}`, (tx) =>
    tx.execute<{ id: string }>(sql`
      update processed_jobs
      set lease_until=now() + (${durationMs}::text || ' milliseconds')::interval
      where job_id=${input.jobId}
        and tenant_id=${input.tenantId}::uuid
        and status='processing'
        and lease_token=${input.leaseToken}
      returning job_id as id
    `),
  );
  return renewed.length > 0;
}

export interface LeaseHeartbeat {
  lost: () => boolean;
  stop: () => Promise<void>;
}

/**
 * Renew a job lease while a long handler runs. Losing the lease is reported via
 * `lost()` and a metric; the handler is not aborted because it may already have
 * performed an external effect.
 */
export function startJobLeaseHeartbeat(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; leaseToken: string },
  options: { renewalMs?: number; durationMs?: number } = {},
): LeaseHeartbeat {
  let lost = false;
  let active = true;
  let inFlight: Promise<void> = Promise.resolve();
  const renewalMs = options.renewalMs ?? JOB_LEASE_RENEWAL_MS;

  const renew = async (): Promise<void> => {
    if (!active || lost) return;
    try {
      const ok = await renewJobLease(db, {
        ...input,
        ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      });
      if (!ok) {
        lost = true;
        workerMetrics.increment('job_lease_lost_total');
      }
    } catch {
      lost = true;
      workerMetrics.increment('job_lease_lost_total');
    }
  };

  const timer = setInterval(() => {
    if (!active) return;
    inFlight = inFlight.then(renew, renew);
  }, renewalMs);
  timer.unref?.();

  return {
    lost: () => lost,
    stop: async () => {
      active = false;
      clearInterval(timer);
      await inFlight;
    },
  };
}

type ClaimOutcome =
  | { status: 'claimed'; leaseToken: string }
  | { status: 'completed'; result: unknown }
  | { status: 'in_progress' };

async function claimJob(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; queue: string },
): Promise<ClaimOutcome> {
  const leaseToken = randomUUID();
  return workerTenantTransaction(db, input.tenantId, `dedup:${input.jobId}`, async (tx) => {
    const inserted = await tx.execute<{ status: string }>(sql`
      insert into processed_jobs (job_id, tenant_id, queue, status, lease_until, lease_token)
      values (${input.jobId}, ${input.tenantId}::uuid, ${input.queue}, 'processing', now() + interval '5 minutes', ${leaseToken})
      on conflict (job_id) do nothing
      returning status
    `);
    if (inserted.length > 0) return { status: 'claimed', leaseToken };

    const reclaimed = await tx.execute<{ status: string }>(sql`
      update processed_jobs
      set lease_until=now() + interval '5 minutes', lease_token=${leaseToken}
      where job_id=${input.jobId}
        and tenant_id=${input.tenantId}::uuid
        and status='processing'
        and lease_until <= now()
      returning status
    `);
    if (reclaimed.length > 0) {
      workerMetrics.increment('job_lease_renewals_total');
      return { status: 'claimed', leaseToken };
    }

    const existing = await tx.execute<{ status: string; result: string | null }>(sql`
      select status, result::text as result
      from processed_jobs
      where job_id=${input.jobId} and tenant_id=${input.tenantId}::uuid
      limit 1
    `);
    const row = existing[0];
    if (!row) return { status: 'in_progress' };
    if (row.status === 'processing') return { status: 'in_progress' };
    return { status: 'completed', result: decodeJsonbResult(row.result) };
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

export interface WithDedupOptions {
  leaseRenewalMs?: number;
  onLeaseLost?: (jobId: string) => void;
}

/**
 * Higher-level helper: executes `fn` only if not already processed.
 * Returns { deduped: true, result } if already processed, else { deduped: false, result: fn() }.
 *
 * The claim is only released after `fn` has settled (the caller is responsible
 * for making `fn` settle when a job times out).
 */
export async function withDedup<T>(
  db: DatabaseHandle,
  input: { jobId: string; tenantId: string; queue: string },
  fn: () => Promise<T>,
  options: WithDedupOptions = {},
): Promise<{ deduped: boolean; result: T }> {
  const claim = await claimJob(db, input);
  if (claim.status === 'in_progress') throw new JobInProgressError();
  if (claim.status === 'completed') return { deduped: true, result: claim.result as T };

  const leaseToken = claim.leaseToken;
  const heartbeat = startJobLeaseHeartbeat(
    db,
    { ...input, leaseToken },
    options.leaseRenewalMs !== undefined ? { renewalMs: options.leaseRenewalMs } : {},
  );
  try {
    const result = await fn();
    if (heartbeat.lost()) {
      options.onLeaseLost?.(input.jobId);
      throw new JobLeaseLostError();
    }
    await markProcessed(db, { ...input, leaseToken, result });
    return { deduped: false, result };
  } catch (error) {
    // A lost lease owns this row now: deleting it would release the new owner's claim.
    if (!(error instanceof JobLeaseLostError) && !heartbeat.lost()) {
      await releaseJob(db, { ...input, leaseToken }).catch(() => undefined);
    }
    throw error;
  } finally {
    await heartbeat.stop();
  }
}
