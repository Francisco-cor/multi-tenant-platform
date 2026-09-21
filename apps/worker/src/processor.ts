import { sql, type DatabaseHandle } from '@platform/db';
import {
  metrics,
  runWithCorrelation,
  generateTraceId,
  createLogger,
} from '@platform/observability';
import { withDedup } from './dedup.js';
import { workerTenantTransaction } from './tenant-db.js';
import type { JobPayload } from './queues.js';

const logger = createLogger({ service: 'worker' });

/**
 * Generic job processor with dedupe, timeout, backoff and DLQ handling.
 * Business effects are idempotent via processed_jobs. Each queue can define
 * its own handler; default handler is a no-op that just records the event
 * (sufficient for outbox demo where the write already happened).
 */

export type JobHandler = (
  payload: JobPayload,
  ctx: { tenantId: string; jobId: string },
) => Promise<unknown>;

export interface ProcessorOptions {
  queue: string;
  timeoutMs?: number | undefined;
  handler?: JobHandler | undefined;
  attemptsMade?: number | undefined;
  maxAttempts?: number | undefined;
}

async function writeFinalFailureToDlq(
  db: DatabaseHandle,
  input: { jobId: string; payload: JobPayload; queue: string; attempts: number; error: unknown },
): Promise<void> {
  const cause = input.error instanceof Error ? input.error.message : String(input.error);
  await workerTenantTransaction(db, input.payload.tenantId, `dlq:${input.jobId}`, (tx) =>
    tx.execute(sql`
      insert into dlq_jobs (job_id, tenant_id, queue, payload, cause, attempts)
      values (${input.jobId}, ${input.payload.tenantId}::uuid, ${input.queue}, ${JSON.stringify(input.payload)}::jsonb, ${cause.slice(0, 2000)}, ${input.attempts})
    `),
  );
}

export async function processJob(
  db: DatabaseHandle,
  jobId: string,
  payload: JobPayload,
  options: ProcessorOptions,
): Promise<{ deduped: boolean; result: unknown }> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 10000;

  const runWithTimeout = async <T>(fn: () => Promise<T>): Promise<T> => {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('job_timeout')), timeoutMs);
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

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
        withDedup(db, { jobId, tenantId: payload.tenantId, queue: options.queue }, async () =>
          runWithTimeout(() => handler(payload, { tenantId: payload.tenantId, jobId })),
        ),
    );
  } catch (error) {
    const attemptsMade = options.attemptsMade ?? 1;
    const maxAttempts = options.maxAttempts ?? 1;
    if (attemptsMade >= maxAttempts) {
      try {
        await writeFinalFailureToDlq(db, {
          jobId,
          payload,
          queue: options.queue,
          attempts: attemptsMade,
          error,
        });
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
 * Example per-queue handlers with concurrency and attempts config.
 * In production, each queue would have its own Worker with concurrency 10.
 */
export const QUEUE_CONFIG: Record<
  string,
  { concurrency: number; attempts: number; backoffDelay: number; timeoutMs: number }
> = {
  files: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  inventory: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  orders: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  webhooks: { concurrency: 10, attempts: 8, backoffDelay: 10000, timeoutMs: 10000 },
  emails: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
  generic: { concurrency: 10, attempts: 5, backoffDelay: 1000, timeoutMs: 10000 },
};

export function backoffDelayMs(attempt: number, base = 1000, max = 60000, jitter = 0.2): number {
  const exp = base * Math.pow(2, attempt);
  const capped = Math.min(exp, max);
  const jitterRange = capped * jitter;
  const delta = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + delta));
}
