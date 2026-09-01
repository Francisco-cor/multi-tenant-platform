import type { DatabaseHandle } from '@platform/db';
import { metrics } from '@platform/observability';
import { withDedup } from './dedup.js';
import type { JobPayload } from './queues.js';

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

  const result = await withDedup(
    db,
    { jobId, tenantId: payload.tenantId, queue: options.queue },
    async () => runWithTimeout(() => handler(payload, { tenantId: payload.tenantId, jobId })),
  );

  const duration = Date.now() - start;
  metrics.recordJobDuration(options.queue, duration);
  if (result.deduped) metrics.recordRetry(options.queue);

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
