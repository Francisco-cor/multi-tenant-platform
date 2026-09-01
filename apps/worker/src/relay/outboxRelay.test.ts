import { describe, expect, it } from 'vitest';
import { deterministicJobId, InMemoryQueueFactory } from '../queues.js';

// Unit test for relay's jobId deterministic logic and queue routing (without DB)
// This test does not require Postgres/Redis, validates the contract that relay will use.

describe('outbox relay queue routing and backoff', () => {
  it('routes aggregate_type to correct queue', async () => {
    const { getQueueForAggregate } = await import('../queues.js');
    expect(getQueueForAggregate('file')).toBe('files');
    expect(getQueueForAggregate('files')).toBe('files');
    expect(getQueueForAggregate('inventory')).toBe('inventory');
    expect(getQueueForAggregate('order')).toBe('orders');
    expect(getQueueForAggregate('unknown')).toBe('generic');
  });

  it('InMemoryQueueFactory isolates by queue name', async () => {
    const factory = new InMemoryQueueFactory();
    const qFiles = factory.getQueue('files');
    const qInv = factory.getQueue('inventory');
    const jobId = deterministicJobId('t1', 'a1', 'file.created');
    await qFiles.add(
      {
        tenantId: 't1',
        aggregateId: 'a1',
        aggregateType: 'file',
        eventType: 'file.created',
        eventId: 'e1',
        payload: {},
      },
      { jobId },
    );
    expect(factory.getJobs('files').length).toBe(1);
    expect(factory.getJobs('inventory').length).toBe(0);
    // inventory queue should not have files job
    await qInv.add({
      tenantId: 't1',
      aggregateId: 'a1',
      aggregateType: 'inventory',
      eventType: 'inventory.reserved',
      eventId: 'e2',
      payload: {},
    });
    expect(factory.getJobs('inventory').length).toBe(1);
  });

  it('backoff with jitter is bounded', async () => {
    const { nextAttemptDelayMs } = await import('@platform/db');
    const d0 = nextAttemptDelayMs(0, 1000, 60000, 0);
    const d1 = nextAttemptDelayMs(1, 1000, 60000, 0);
    const d5 = nextAttemptDelayMs(5, 1000, 60000, 0);
    const d6 = nextAttemptDelayMs(6, 1000, 60000, 0);
    expect(d0).toBe(1000);
    expect(d1).toBe(2000);
    expect(d5).toBe(32000);
    expect(d6).toBe(60000); // capped at 60s
    // With jitter, still within 20%
    const withJitter = nextAttemptDelayMs(0, 1000, 60000, 0.2);
    expect(withJitter).toBeGreaterThanOrEqual(800);
    expect(withJitter).toBeLessThanOrEqual(1200);
  });
});
