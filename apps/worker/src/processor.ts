import { sql, type DatabaseHandle } from '@platform/db';
import {
  metrics,
  runWithCorrelation,
  generateTraceId,
  createLogger,
} from '@platform/observability';
import {
  JobInProgressError,
  JobLeaseLostError,
  withDedup,
  type WithDedupOptions,
} from './dedup.js';
import { workerTenantTransaction } from './tenant-db.js';
import type { JobPayload } from './queues.js';
import { workerMetrics } from './worker-metrics.js';

const logger = createLogger({ service: 'worker' });

/**
 * Generic job processor with dedupe, timeout, backoff and DLQ handling.
 * Business effects are idempotent via processed_jobs. Each queue can define
 * its own handler; default handler is a no-op that just records the event
 * (sufficient for outbox demo where the write already happened).
 */

export interface JobContext {
  tenantId: string;
  jobId: string;
  /** Aborted when the job deadline expires; handlers must pass it to I/O. */
  signal: AbortSignal;
}

export type JobHandler = (payload: JobPayload, ctx: JobContext) => Promise<unknown>;

export interface ProcessorOptions {
  queue: string;
  timeoutMs?: number | undefined;
  handler?: JobHandler | undefined;
  attemptsMade?: number | undefined;
  maxAttempts?: number | undefined;
  /** Lease heartbeat overrides, mainly for tests. */
  lease?: Pick<WithDedupOptions, 'leaseRenewalMs' | 'onLeaseLost'> | undefined;
}

/** The handler exceeded its deadline. Retried only through reconciliation. */
export class JobTimeoutError extends Error {
  constructor() {
    super('job_timeout');
    this.name = 'JobTimeoutError';
  }
}

export function isJobTimeoutError(error: unknown): error is JobTimeoutError {
  return (
    error instanceof JobTimeoutError || (error as { message?: string })?.message === 'job_timeout'
  );
}

export function isJobInProgressError(error: unknown): error is JobInProgressError {
  return error instanceof JobInProgressError;
}

async function writeFinalFailureToDlq(
  db: DatabaseHandle,
  input: { jobId: string; payload: JobPayload; queue: string; attempts: number; error: unknown },
): Promise<void> {
  const cause = input.error instanceof Error ? input.error.message : String(input.error);
  await workerTenantTransaction(db, input.payload.tenantId, `dlq:${input.jobId}`, (tx) =>
    tx.execute(sql`
      insert into dlq_jobs (job_id, tenant_id, queue, payload, cause, attempts, correlation_id)
      values (${input.jobId}, ${input.payload.tenantId}::uuid, ${input.queue}, ${JSON.stringify(input.payload)}::jsonb, ${cause.slice(0, 2000)}, ${input.attempts}, ${input.payload.correlationId ?? null})
      on conflict (job_id) where status='pending' do update
      set cause=excluded.cause,
          attempts=greatest(dlq_jobs.attempts, excluded.attempts),
          correlation_id=coalesce(excluded.correlation_id, dlq_jobs.correlation_id),
          updated_at=now()
    `),
  );
}

/**
 * Run `fn` with a deadline. The signal is aborted on timeout but the returned
 * promise only settles once `fn` settles, so the dedupe claim is never released
 * while the previous attempt is still running (P1-5).
 */
export async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new JobTimeoutError());
        }, timeoutMs)
      : null;
  timer?.unref?.();
  try {
    const result = await fn(controller.signal);
    if (timedOut) throw new JobTimeoutError();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function processJob(
  db: DatabaseHandle,
  jobId: string,
  payload: JobPayload,
  options: ProcessorOptions,
): Promise<{ deduped: boolean; result: unknown }> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 10000;

  const handler = options.handler ?? (async () => ({ ok: true, eventType: payload.eventType }));

  // Extract correlation from payload (requestId:traceId) for trace propagation
  const correlationId = payload.correlationId ?? '';
  const [requestId, traceId] = correlationId.includes(':')
    ? (correlationId.split(':') as [string, string])
    : [correlationId || jobId.slice(0, 8), undefined];
  const effectiveTraceId = traceId || generateTraceId();
  const effectiveRequestId = requestId || jobId.slice(0, 8);

  let result: { deduped: boolean; result: unknown };
  try {
    result = await runWithCorrelation(
      {
        requestId: effectiveRequestId,
        traceId: effectiveTraceId,
        tenantId: payload.tenantId,
      },
      async () =>
        withDedup(
          db,
          { jobId, tenantId: payload.tenantId, queue: options.queue },
          async () =>
            runWithTimeout(
              (signal) => handler(payload, { tenantId: payload.tenantId, jobId, signal }),
              timeoutMs,
            ),
          options.lease ?? {},
        ),
    );
  } catch (error) {
    const attemptsMade = options.attemptsMade ?? 1;
    const maxAttempts = options.maxAttempts ?? 1;

    // A concurrent duplicate is not a failure: let BullMQ re-deliver without
    // burning an attempt or writing a phantom DLQ row (P2-5).
    if (error instanceof JobInProgressError) {
      workerMetrics.increment('job_in_progress_total');
      throw error;
    }

    // A timeout aborts the handler and is retried through reconciliation /
    // delayed re-delivery instead of an immediate concurrent retry (P1-5).
    if (error instanceof JobTimeoutError) {
      workerMetrics.increment('job_timeouts_total');
      metrics.recordRetry(options.queue);
      throw error;
    }

    if (error instanceof JobLeaseLostError) {
      workerMetrics.increment('job_lease_lost_total');
      throw error;
    }

    if (attemptsMade >= maxAttempts) {
      try {
        await writeFinalFailureToDlq(db, {
          jobId,
          payload,
          queue: options.queue,
          attempts: attemptsMade,
          error,
        });
        metrics.recordFinalFailure(options.queue);
      } catch (dlqError) {
        logger.error(
          {
            jobId,
            queue: options.queue,
            error: dlqError instanceof Error ? dlqError.message : String(dlqError),
          },
          'dlq_write_failed',
        );
      }
    }
    throw error;
  }

  const duration = Date.now() - start;
  metrics.recordJobDuration(options.queue, duration);
  if (result.deduped) {
    metrics.recordRetry(options.queue);
    logger.info(
      {
        jobId,
        queue: options.queue,
        tenantHash: payload.tenantId.slice(0, 8),
        traceId: effectiveTraceId,
        requestId: effectiveRequestId,
        deduped: true,
        durationMs: duration,
      },
      'job deduped',
    );
  } else {
    logger.info(
      {
        jobId,
        queue: options.queue,
        eventType: payload.eventType,
        tenantHash: payload.tenantId.slice(0, 8),
        traceId: effectiveTraceId,
        requestId: effectiveRequestId,
        durationMs: duration,
      },
      'job processed',
    );
  }

  return result;
}

/**
 * Per-queue concurrency, attempts, backoff and timeout. Consumed by the BullMQ
 * worker construction so the declared policies are no longer inert (P3-5).
 */
export const QUEUE_CONFIG: Record<
  string,
  { concurrency: number; attempts: number; backoffDelay: number; timeoutMs: number }
> = {
  files: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  inventory: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  orders: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 30000 },
  webhooks: { concurrency: 10, attempts: 8, backoffDelay: 10000, timeoutMs: 20000 },
  emails: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  generic: { concurrency: 5, attempts: 5, backoffDelay: 1000, timeoutMs: 60000 },
};

export function queueConfig(queue: string): (typeof QUEUE_CONFIG)[string] {
  return QUEUE_CONFIG[queue] ?? QUEUE_CONFIG.generic!;
}

export function backoffDelayMs(attempt: number, base = 1000, max = 60000, jitter = 0.2): number {
  const exp = base * Math.pow(2, attempt);
  const capped = Math.min(exp, max);
  const jitterRange = capped * jitter;
  const delta = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + delta));
}
