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

function readyState(now: () => number = () => Date.now()): WorkerReadinessState {
  const state = new WorkerReadinessState({ now });
  state.setDatabase(true);
  state.setConsumers(true);
  state.setRelay(true);
  state.setScheduler(true);
  state.markRelayTick(true);
  state.markSchedulerTick(true);
  state.setOutbox(1, 1);
  return state;
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
    // Bootstrap flags alone are not enough: the first successful tick is required.
    expect((await state.report(factory)).status).toBe('degraded');

    state.markRelayTick(true);
    state.markSchedulerTick(true);
    state.setOutbox(1, 1);
    expect((await state.report(factory)).status).toBe('ok');

    state.setStopping(true);
    expect((await state.report(factory)).status).toBe('degraded');
  });

  it('degrades when the relay stops making progress (P2-6)', async () => {
    let clock = 1_000_000;
    const state = readyState(() => clock);
    const factory = healthyFactory();
    expect((await state.report(factory)).status).toBe('ok');

    clock += 5 * 60 * 1000;
    const report = await state.report(factory);
    expect(report.status).toBe('degraded');
    expect(report.checks.relay).toBe(false);
    expect(report.checks.relayAgeSeconds).toBe(300);
  });

  it('degrades on outbox lag and on an aged DLQ (P2-6)', async () => {
    const state = readyState();
    const factory = healthyFactory();

    state.setOutbox(600, 5000);
    expect((await state.report(factory)).status).toBe('degraded');

    state.setOutbox(2, 5);
    state.setDlq(1, 7200);
    const dlqReport = await state.report(factory);
    expect(dlqReport.status).toBe('degraded');
    expect(dlqReport.checks.dlqOldestAgeSeconds).toBe(7200);

    state.setDlq(1, 60);
    expect((await state.report(factory)).status).toBe('ok');
  });

  it('reports counters without treating a non-empty young DLQ as outage', async () => {
    const state = readyState();
    state.setOutbox(42, 3);
    state.setDlq(2);
    const report = await state.report(healthyFactory());
    expect(report.status).toBe('ok');
    expect(report.checks.outboxLagSeconds).toBe(42);
    expect(report.checks.outboxPending).toBe(3);
    expect(report.checks.dlqSize).toBe(2);
  });
});
