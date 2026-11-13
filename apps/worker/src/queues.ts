import { createHash } from 'node:crypto';
import { isJobInProgressError, isJobTimeoutError, queueConfig } from './processor.js';

export const QUEUES = ['files', 'inventory', 'orders', 'webhooks', 'emails', 'generic'] as const;
export type QueueName = (typeof QUEUES)[number];
export const GLOBAL_MAINTENANCE_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface JobPayload {
  tenantId: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  eventId: string;
  payloadVersion?: number | undefined;
  correlationId?: string | undefined;
  scope?: 'tenant' | 'global' | undefined;
  payload: unknown;
}

export interface QueueAddOptions {
  jobId?: string | undefined;
  delay?: number | undefined;
  attempts?: number | undefined;
}

/** Result of an enqueue. `accepted: false` means BullMQ dropped a duplicate id. */
export interface QueueAddResult {
  jobId: string;
  accepted: boolean;
}

export interface QueueAdapter {
  name: QueueName;
  add(payload: JobPayload, opts?: QueueAddOptions): Promise<QueueAddResult>;
  /** Remove a job in any state. Returns false when it does not exist. */
  remove(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface WorkerAdapter {
  close(): Promise<void>;
}

export interface QueueHealth {
  redis: 'ok' | 'fail' | 'not_configured';
  configuredWorkers: number;
  runningWorkers: number;
  queues: QueueName[];
}

export type QueueProcessor = (
  queue: QueueName,
  payload: JobPayload,
  jobId: string,
  attempt?: { attemptsMade: number; maxAttempts: number } | undefined,
) => Promise<unknown>;

/**
 * Stable job id for an outbox event. `eventId` (the outbox row id) keeps two
 * legitimate events of the same type on the same aggregate distinct (P2-3);
 * it stays optional so callers that only have the legacy triple keep working.
 */
export function deterministicJobId(
  tenantId: string,
  aggregateId: string,
  eventType: string,
  eventId?: string,
): string {
  const identity = eventId
    ? `${tenantId}:${aggregateId}:${eventType}:${eventId}`
    : `${tenantId}:${aggregateId}:${eventType}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/**
 * In-memory queue for tests and when Redis is unavailable.
 * Stores added jobs in an array; worker processing is simulated via `processNext`.
 */
export class InMemoryQueue implements QueueAdapter {
  public readonly jobs: Array<{
    payload: JobPayload;
    opts?: QueueAddOptions | undefined;
    jobId: string;
  }> = [];
  private readonly seen = new Set<string>();

  constructor(public readonly name: QueueName) {}

  async add(payload: JobPayload, opts?: QueueAddOptions): Promise<QueueAddResult> {
    const jobId =
      opts?.jobId ?? deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
    // Dedupe by jobId deterministically: if already seen, skip (idempotent publish)
    if (this.seen.has(jobId)) return { jobId, accepted: false };
    this.seen.add(jobId);
    const storedOpts: QueueAddOptions | undefined = opts ? { ...opts } : undefined;
    this.jobs.push({ payload, opts: storedOpts, jobId });
    return { jobId, accepted: true };
  }

  async remove(jobId: string): Promise<boolean> {
    const index = this.jobs.findIndex((job) => job.jobId === jobId);
    this.seen.delete(jobId);
    if (index < 0) return false;
    this.jobs.splice(index, 1);
    return true;
  }

  async close(): Promise<void> {
    this.jobs.length = 0;
    this.seen.clear();
  }

  // For testing: allow manual re-add of same jobId to simulate duplicate publish after relay retry
  async addForce(payload: JobPayload, opts?: QueueAddOptions): Promise<QueueAddResult> {
    const jobId =
      opts?.jobId ?? deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
    const storedOpts: QueueAddOptions | undefined = opts ? { ...opts } : undefined;
    this.jobs.push({ payload, opts: storedOpts, jobId });
    return { jobId, accepted: true };
  }
}

export interface QueueFactory {
  getQueue(name: QueueName): QueueAdapter;
  startWorkers?: (processor: QueueProcessor) => Promise<void>;
  getHealth?: () => Promise<QueueHealth>;
  /** `force` closes workers without waiting for in-flight jobs (shutdown deadline). */
  closeAll(options?: { force?: boolean }): Promise<void>;
}

export class InMemoryQueueFactory implements QueueFactory {
  private readonly map = new Map<QueueName, InMemoryQueue>();

  getQueue(name: QueueName): QueueAdapter {
    let q = this.map.get(name);
    if (!q) {
      q = new InMemoryQueue(name);
      this.map.set(name, q);
    }
    return q;
  }

  async startWorkers(): Promise<void> {
    // Tests deliberately keep the in-memory adapter producer-only.
  }

  async getHealth(): Promise<QueueHealth> {
    return {
      redis: 'not_configured',
      configuredWorkers: 0,
      runningWorkers: 0,
      queues: [...this.map.keys()],
    };
  }

  async closeAll(): Promise<void> {
    for (const q of this.map.values()) await q.close();
    this.map.clear();
  }

  // Test helper: get raw jobs
  getJobs(name: QueueName): Array<{ payload: JobPayload; jobId: string }> {
    const q = this.map.get(name);
    if (!q) return [];
    return q.jobs.map((j) => ({ payload: j.payload, jobId: j.jobId }));
  }
}

/** Delay applied to an aborted/timed-out job before it is retried. */
export const JOB_TIMEOUT_REDELIVERY_MS = 30_000;
export const JOB_IN_PROGRESS_REDELIVERY_MS = 5_000;

// BullMQ real factory (lazy, only if REDIS_URL and bullmq available)
export async function createBullMqFactory(redisUrl: string): Promise<QueueFactory | null> {
  try {
    const { Queue, Worker, DelayedError } = await import('bullmq');
    const Redis = (await import('ioredis')).default;
    // Dynamic import ioredis indirectly via bullmq; need connection
    const queues = new Map<QueueName, QueueAdapter>();
    const workers = new Map<
      QueueName,
      { close: (force?: boolean) => Promise<void>; isRunning: () => boolean }
    >();
    const healthRedis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    for (const name of QUEUES) {
      const q = new Queue(name, { connection: { url: redisUrl } });
      const adapter: QueueAdapter = {
        name,
        async add(payload: JobPayload, opts?: QueueAddOptions): Promise<QueueAddResult> {
          const config = queueConfig(name);
          const jobId =
            opts?.jobId ??
            deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
          const existing = await q.getJob(jobId).catch(() => undefined);
          if (existing) return { jobId, accepted: false };
          const addOpts: Record<string, unknown> = {
            jobId,
            attempts: opts?.attempts ?? config.attempts,
            backoff: { type: 'exponential', delay: config.backoffDelay },
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 24 * 3600 },
          };
          if (opts?.delay !== undefined) addOpts.delay = opts.delay;
          const job = await q.add(payload.eventType, payload, addOpts as never);
          return { jobId: String(job.id ?? jobId), accepted: true };
        },
        async remove(jobId: string): Promise<boolean> {
          try {
            const job = await q.getJob(jobId);
            if (!job) return false;
            await job.remove();
            return true;
          } catch {
            // Active/locked jobs cannot be removed; caller can still enqueue a fresh id.
            return false;
          }
        },
        async close(): Promise<void> {
          await q.close();
        },
      };
      queues.set(name, adapter);
    }
    return {
      getQueue(name: QueueName) {
        const q = queues.get(name);
        if (!q) throw new Error(`queue_not_found:${name}`);
        return q;
      },
      async startWorkers(processor: QueueProcessor): Promise<void> {
        if (workers.size > 0) return;
        for (const name of QUEUES) {
          const config = queueConfig(name);
          const worker = new Worker(
            name,
            async (job) => {
              const payload = job.data as JobPayload;
              const jobId = String(
                job.id ??
                  deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType),
              );
              try {
                return await processor(name, payload, jobId, {
                  attemptsMade: job.attemptsMade + 1,
                  maxAttempts: Math.max(1, Number(job.opts.attempts ?? 1)),
                });
              } catch (error) {
                // Timeouts are retried on a delay, not immediately and not with
                // the previous attempt still running (P1-5). A concurrent
                // duplicate is also just deferred (P2-5).
                if (isJobTimeoutError(error) || isJobInProgressError(error)) {
                  const delay = isJobTimeoutError(error)
                    ? JOB_TIMEOUT_REDELIVERY_MS
                    : JOB_IN_PROGRESS_REDELIVERY_MS;
                  const token = job.token as string | undefined;
                  if (token) {
                    await job.moveToDelayed(Date.now() + delay, token);
                    throw new DelayedError();
                  }
                }
                throw error;
              }
            },
            {
              connection: { url: redisUrl },
              concurrency: config.concurrency,
              lockDuration: 120_000,
            } as never,
          );
          workers.set(
            name,
            worker as unknown as {
              close: (force?: boolean) => Promise<void>;
              isRunning: () => boolean;
            },
          );
        }
      },
      async getHealth(): Promise<QueueHealth> {
        let redis: QueueHealth['redis'] = 'ok';
        try {
          if (healthRedis.status === 'wait') await healthRedis.connect();
          await healthRedis.ping();
        } catch {
          redis = 'fail';
        }
        const runningWorkers = [...workers.values()].filter((worker) => worker.isRunning()).length;
        return {
          redis,
          configuredWorkers: QUEUES.length,
          runningWorkers,
          queues: [...QUEUES],
        };
      },
      async closeAll(options): Promise<void> {
        for (const worker of workers.values()) await worker.close(options?.force === true);
        workers.clear();
        for (const q of queues.values()) await q.close();
        queues.clear();
        await healthRedis.quit().catch(() => healthRedis.disconnect());
      },
    };
  } catch {
    return null;
  }
}

export function getQueueForAggregate(aggregateType: string): QueueName {
  const map: Record<string, QueueName> = {
    file: 'files',
    files: 'files',
    inventory: 'inventory',
    order: 'orders',
    orders: 'orders',
    payment: 'orders',
    payments: 'orders',
    webhook: 'webhooks',
    webhooks: 'webhooks',
    email: 'emails',
    emails: 'emails',
  };
  return map[aggregateType] ?? 'generic';
}
