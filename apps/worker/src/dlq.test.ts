import { describe, expect, it } from 'vitest';
import { InMemoryQueueFactory } from './queues.js';
import { listDlq, replayDlq } from './dlq.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const dlqId = '44444444-4444-4444-4444-444444444444';
const originalJobId = 'outbox-job-abcdef';

function dlqDatabase() {
  return createFakeDatabase(({ text }) => {
    if (text.includes('select id, job_id') && text.includes('from dlq_jobs')) {
      return [
        {
          id: dlqId,
          job_id: originalJobId,
          tenant_id: tenantId,
          queue: 'orders',
          payload: JSON.stringify({
            tenantId,
            aggregateId: '22222222-2222-2222-2222-222222222222',
            aggregateType: 'order',
            eventType: 'order.paid',
            eventId: 'evt-1',
            payload: { orderId: 'o-1' },
          }),
          cause: 'redis_down',
          attempts: 5,
          status: 'pending',
        },
      ];
    }
    if (text.includes('delete from processed_jobs')) return [];
    if (text.includes('update dlq_jobs')) return [];
    throw new Error(`unexpected query: ${text}`);
  });
}

describe('DLQ replay', () => {
  it('replays under a fresh job id and removes the retained failed job (P1-2)', async () => {
    const fake = dlqDatabase();
    const factory = new InMemoryQueueFactory();
    const queue = factory.getQueue('orders');
    // Simulate the failed job BullMQ keeps for 24h under the original id.
    await queue.add(
      {
        tenantId,
        aggregateId: '22222222-2222-2222-2222-222222222222',
        aggregateType: 'order',
        eventType: 'order.paid',
        eventId: 'evt-1',
        payload: {},
      },
      { jobId: originalJobId },
    );

    const result = await replayDlq(fake.handle, factory, { tenantId, dlqId });

    expect(result.originalJobId).toBe(originalJobId);
    expect(result.jobId).not.toBe(originalJobId);
    expect(result.jobId.startsWith(`${originalJobId}-replay-`)).toBe(true);
    expect(result.accepted).toBe(true);

    const jobs = factory.getJobs('orders');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobId).toBe(result.jobId);
    expect(jobs[0]?.payload.payload).toMatchObject({ originalJobId, replayedDlqId: dlqId });

    expect(fake.queries.some((q) => q.includes("set status = 'replayed'"))).toBe(true);
  });

  it('rejects an already replayed row', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from dlq_jobs')) {
        return [
          {
            id: dlqId,
            job_id: originalJobId,
            tenant_id: tenantId,
            queue: 'orders',
            payload: '{}',
            cause: 'x',
            attempts: 1,
            status: 'replayed',
          },
        ];
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      replayDlq(fake.handle, new InMemoryQueueFactory(), { tenantId, dlqId }),
    ).rejects.toThrow('dlq_already_replayed');
  });

  it('reads the jsonb payload as text in listDlq (P1-1 companion)', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from dlq_jobs')) {
        return [
          {
            id: dlqId,
            job_id: originalJobId,
            tenant_id: tenantId,
            queue: 'orders',
            payload: '{"orderId":"o-1"}',
            cause: 'x',
            attempts: 1,
            status: 'pending',
            created_at: new Date().toISOString(),
          },
        ];
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await listDlq(fake.handle, tenantId);
    expect(rows[0]?.payload).toEqual({ orderId: 'o-1' });
    expect(fake.queries.find((q) => q.includes('from dlq_jobs'))).toContain('payload::text');
  });
});
