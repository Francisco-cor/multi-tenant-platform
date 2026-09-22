import { createHash } from 'node:crypto';

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

export interface QueueAdapter {
  name: QueueName;
  add(payload: JobPayload, opts?: QueueAddOptions): Promise<void>;
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

export function deterministicJobId(
  tenantId: string,
  aggregateId: string,
  eventType: string,
): string {
  return createHash('sha256')
    .update(`${tenantId}:${aggregateId}:${eventType}`)
    .digest('hex')
    .slice(0, 32);
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

  async add(payload: JobPayload, opts?: QueueAddOptions): Promise<void> {
    const jobId =
      opts?.jobId ?? deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
    // Dedupe by jobId deterministically: if already seen, skip (idempotent publish)
    if (this.seen.has(jobId)) return;
    this.seen.add(jobId);
    const storedOpts: QueueAddOptions | undefined = opts ? { ...opts } : undefined;
    this.jobs.push({ payload, opts: storedOpts, jobId });
  }

  async close(): Promise<void> {
    this.jobs.length = 0;
    this.seen.clear();
  }

  // For testing: allow manual re-add of same jobId to simulate duplicate publish after relay retry
  async addForce(payload: JobPayload, opts?: QueueAddOptions): Promise<void> {
    const jobId =
      opts?.jobId ?? deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
    const storedOpts: QueueAddOptions | undefined = opts ? { ...opts } : undefined;
    this.jobs.push({ payload, opts: storedOpts, jobId });
  }
}

export interface QueueFactory {
  getQueue(name: QueueName): QueueAdapter;
  startWorkers?: (processor: QueueProcessor) => Promise<void>;
  getHealth?: () => Promise<QueueHealth>;
  closeAll(): Promise<void>;
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

// BullMQ real factory (lazy, only if REDIS_URL and bullmq available)
export async function createBullMqFactory(redisUrl: string): Promise<QueueFactory | null> {
  try {
    const { Queue } = await import('bullmq');
    const Redis = (await import('ioredis')).default;
    // Dynamic import ioredis indirectly via bullmq; need connection
    const queues = new Map<QueueName, QueueAdapter>();
    const workers = new Map<QueueName, { close: () => Promise<void>; isRunning: () => boolean }>();
    const healthRedis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    for (const name of QUEUES) {
      const q = new Queue(name, { connection: { url: redisUrl } });
      const adapter: QueueAdapter = {
        name,
        async add(payload: JobPayload, opts?: QueueAddOptions): Promise<void> {
          const jobId =
            opts?.jobId ??
            deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
          const addOpts: Record<string, unknown> = {
            jobId,
            attempts: opts?.attempts ?? 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 24 * 3600 },
          };
          if (opts?.delay !== undefined) addOpts.delay = opts.delay;
          await q.add(payload.eventType, payload, addOpts as never);
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
        const { Worker } = await import('bullmq');
        for (const name of QUEUES) {
          const worker = new Worker(
            name,
            async (job) => {
              const payload = job.data as JobPayload;
              const jobId = String(
                job.id ??
                  deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType),
              );
              return processor(name, payload, jobId, {
                attemptsMade: job.attemptsMade + 1,
                maxAttempts: Math.max(1, Number(job.opts.attempts ?? 1)),
              });
            },
            { connection: { url: redisUrl }, concurrency: 10 } as never,
          );
          workers.set(name, worker);
        }
      },
      async getHealth(): Promise<QueueHealth> {
        let redis: QueueHealth['redis'] = 'ok';
        try {
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
      async closeAll() {
        for (const worker of workers.values()) await worker.close();
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
