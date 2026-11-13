import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobInProgressError } from './dedup.js';
import { JobTimeoutError, processJob, queueConfig, QUEUE_CONFIG } from './processor.js';
import type { JobPayload } from './queues.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';

const payload: JobPayload = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  aggregateId: '22222222-2222-2222-2222-222222222222',
  aggregateType: 'order',
  eventType: 'order.paid',
  eventId: '33333333-3333-3333-3333-333333333333',
  payload: {},
};

function claimedDatabase() {
  return createFakeDatabase(({ text }) => {
    if (text.includes('insert into processed_jobs')) return [{ status: 'processing' }];
    if (text.includes("status='completed'")) return [{ id: 'x' }];
    if (text.includes('delete from processed_jobs')) return [];
    if (text.includes('insert into dlq_jobs')) return [];
    throw new Error(`unexpected query: ${text}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('job processor timeout', () => {
  it('does not start a retry until the timed-out handler has settled (P1-5)', async () => {
    vi.useFakeTimers();
    const fake = claimedDatabase();
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = processJob(fake.handle, 'job-1', payload, {
      queue: 'orders',
      timeoutMs: 50,
      attemptsMade: 1,
      maxAttempts: 1,
      handler: async () => {
        await gate;
        settled = true;
        return { ok: true };
      },
    });
    const assertion = expect(running).rejects.toBeInstanceOf(JobTimeoutError);

    await vi.advanceTimersByTimeAsync(60);
    // The deadline fired but the handler has not settled: no retry may start.
    expect(settled).toBe(false);
    release();
    await assertion;
    expect(settled).toBe(true);

    // A timeout is retried through delayed redelivery/reconciliation, not DLQ'd.
    expect(fake.queries.some((q) => q.includes('insert into dlq_jobs'))).toBe(false);
  });

  it('passes an abort signal to the handler and aborts it on timeout', async () => {
    vi.useFakeTimers();
    const fake = claimedDatabase();
    let aborted = false;

    const running = processJob(fake.handle, 'job-2', payload, {
      queue: 'orders',
      timeoutMs: 10,
      handler: async (_payload, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        return { ok: true };
      },
    });
    const assertion = expect(running).rejects.toBeInstanceOf(JobTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('does not write a DLQ row for job_in_progress on the last attempt (P2-5)', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('insert into processed_jobs')) return [];
      if (text.includes('update processed_jobs')) return [];
      if (text.includes('select status, result::text'))
        return [{ status: 'processing', result: null }];
      if (text.includes('insert into dlq_jobs')) throw new Error('dlq must not be written');
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      processJob(fake.handle, 'job-3', payload, {
        queue: 'orders',
        attemptsMade: 5,
        maxAttempts: 5,
        handler: async () => ({ ok: true }),
      }),
    ).rejects.toBeInstanceOf(JobInProgressError);
    expect(fake.queries.some((q) => q.includes('insert into dlq_jobs'))).toBe(false);
  });

  it('uses per-queue configuration instead of a single global policy (P3-5)', () => {
    expect(QUEUE_CONFIG.webhooks!.attempts).toBeGreaterThan(QUEUE_CONFIG.orders!.attempts - 1);
    expect(queueConfig('webhooks').timeoutMs).toBe(20_000);
    expect(queueConfig('unknown-queue')).toBe(QUEUE_CONFIG.generic);
  });
});
