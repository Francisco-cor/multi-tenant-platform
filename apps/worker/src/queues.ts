import { createHash } from 'node:crypto';

export const QUEUES = ['files', 'inventory', 'orders', 'webhooks', 'emails', 'generic'] as const;
export type QueueName = (typeof QUEUES)[number];

export interface JobPayload {
  tenantId: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  eventId: string;
  correlationId?: string | undefined;
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
    // Dynamic import ioredis indirectly via bullmq; need connection
    const queues = new Map<QueueName, QueueAdapter>();
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
      async closeAll() {
        for (const q of queues.values()) await q.close();
        queues.clear();
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
