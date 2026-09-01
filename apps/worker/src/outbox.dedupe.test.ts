import { describe, expect, it } from 'vitest';
import { deterministicJobId } from './queues.js';
import { InMemoryQueueFactory } from './queues.js';

// In-memory dedupe via processed_jobs simulated with Map
describe('outbox dedupe', () => {
  it('deterministicJobId is stable and tenant-scoped', () => {
    const a = deterministicJobId('tenant-a', 'agg-1', 'file.created');
    const b = deterministicJobId('tenant-a', 'agg-1', 'file.created');
    const c = deterministicJobId('tenant-b', 'agg-1', 'file.created');
    const d = deterministicJobId('tenant-a', 'agg-2', 'file.created');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.length).toBe(32);
  });

  it('InMemoryQueue dedupes same jobId (at-least-once publish)', async () => {
    const factory = new InMemoryQueueFactory();
    const q = factory.getQueue('files');
    const payload = {
      tenantId: 'tenant-a',
      aggregateId: 'file-1',
      aggregateType: 'file',
      eventType: 'file.created',
      eventId: 'ev-1',
      payload: { foo: 'bar' },
    };
    const jobId = deterministicJobId(payload.tenantId, payload.aggregateId, payload.eventType);
    await q.add(payload, { jobId });
    await q.add(payload, { jobId });
    // Add same logical event via different instance but same jobId should dedupe
    await q.add({ ...payload, eventId: 'ev-1-dup' }, { jobId });
    // InMemoryQueue stores only one
    const jobs =
      (factory as unknown as { getJobs: (n: string) => unknown[] }).getJobs?.('files') ??
      (q as unknown as { jobs: unknown[] }).jobs;
    expect(jobs.length).toBe(1);
    expect((jobs[0] as { jobId: string }).jobId).toBe(jobId);
  });

  it('publishing same eventId twice yields one effect via processed_jobs simulation', async () => {
    // Simulate processed_jobs with Map
    const processed = new Map<string, unknown>();
    let effectCount = 0;
    async function handle(jobId: string): Promise<{ deduped: boolean }> {
      if (processed.has(jobId)) return { deduped: true };
      effectCount++;
      processed.set(jobId, { result: 'ok' });
      return { deduped: false };
    }
    const jobId = deterministicJobId('tenant-a', 'f1', 'file.created');
    const r1 = await handle(jobId);
    const r2 = await handle(jobId);
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(effectCount).toBe(1);
    expect(processed.size).toBe(1);
  });

  it('different tenants same aggregate produce different jobIds (isolation)', async () => {
    const jobA = deterministicJobId('tenant-a', 'agg-1', 'order.created');
    const jobB = deterministicJobId('tenant-b', 'agg-1', 'order.created');
    expect(jobA).not.toBe(jobB);
  });
});
