import { describe, expect, it } from 'vitest';
import { InMemoryQueueFactory, type QueueHealth } from './queues.js';
import { WorkerReadinessState } from './readiness.js';

function healthyFactory(): InMemoryQueueFactory & { getHealth: () => Promise<QueueHealth> } {
  const factory = new InMemoryQueueFactory();
  Object.assign(factory, {
    getHealth: async (): Promise<QueueHealth> => ({
      redis: 'ok',
      configuredWorkers: 6,
      runningWorkers: 6,
      queues: ['files', 'inventory', 'orders', 'webhooks', 'emails', 'generic'],
    }),
  });
  return factory as InMemoryQueueFactory & { getHealth: () => Promise<QueueHealth> };
}

describe('worker readiness', () => {
  it('stays degraded until all runtime components and workers are ready', async () => {
    const state = new WorkerReadinessState();
    const factory = healthyFactory();
    expect((await state.report(factory)).status).toBe('degraded');

    state.setDatabase(true);
    state.setConsumers(true);
    state.setRelay(true);
    state.setScheduler(true);
    expect((await state.report(factory)).status).toBe('ok');

    state.setStopping(true);
    expect((await state.report(factory)).status).toBe('degraded');
  });

  it('exposes lag and DLQ counters without making a non-empty DLQ look healthy infrastructure', async () => {
    const state = new WorkerReadinessState();
    const factory = healthyFactory();
    state.setDatabase(true);
    state.setConsumers(true);
    state.setRelay(true);
    state.setScheduler(true);
    state.setOutbox(42, 3);
    state.setDlq(2);
    const report = await state.report(factory);
    expect(report.status).toBe('ok');
    expect(report.checks.outboxLagSeconds).toBe(42);
    expect(report.checks.outboxPending).toBe(3);
    expect(report.checks.dlqSize).toBe(2);
  });
});
