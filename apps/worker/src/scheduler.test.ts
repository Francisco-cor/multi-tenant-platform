import { describe, expect, it } from 'vitest';
import { InMemoryQueueFactory } from './queues.js';
import { startMaintenanceScheduler } from './scheduler.js';

describe('maintenance scheduler', () => {
  it('enqueues deterministic global jobs and skips unconfigured payment reconciliation', async () => {
    const factory = new InMemoryQueueFactory();
    const scheduler = startMaintenanceScheduler(factory, {
      startImmediately: false,
      now: () => 1_800_000_000_000,
      paymentProviderConfigured: false,
    });

    await scheduler.runNow();
    const jobs = factory.getJobs('generic');
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.payload.eventType).sort()).toEqual([
      'maintenance.deliver_pending_webhooks',
      'maintenance.expire_reservations',
      'maintenance.gc_files',
    ]);
    expect(jobs.every((job) => job.payload.scope === 'global')).toBe(true);
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(3);
    scheduler.stop();
  });
});
