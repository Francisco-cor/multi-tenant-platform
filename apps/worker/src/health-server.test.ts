import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryQueueFactory } from './queues.js';
import {
  startWorkerHealthServer,
  WorkerReadinessState,
  type WorkerHealthServer,
} from './readiness.js';
import { workerMetrics } from './worker-metrics.js';

let server: WorkerHealthServer | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
  workerMetrics.reset();
});

function state(): WorkerReadinessState {
  const state = new WorkerReadinessState();
  state.setDatabase(true);
  state.setConsumers(true);
  state.setRelay(true);
  state.setScheduler(true);
  state.markRelayTick(true);
  state.markSchedulerTick(true);
  state.setOutbox(1, 0);
  return state;
}

async function start(metricsToken?: string): Promise<string> {
  const factory = new InMemoryQueueFactory();
  Object.assign(factory, {
    getHealth: async () => ({
      redis: 'ok' as const,
      configuredWorkers: 6,
      runningWorkers: 6,
      queues: [],
    }),
  });
  server = await startWorkerHealthServer(state(), () => factory, {
    host: '127.0.0.1',
    port: 0,
    ...(metricsToken ? { metricsToken } : {}),
  });
  return `http://127.0.0.1:${server.port}`;
}

describe('worker health server (P3-6)', () => {
  it('serves liveness and readiness on the same port', async () => {
    const base = await start();
    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok', service: 'worker' });

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    const report = (await ready.json()) as { status: string; checks: { relayAgeSeconds: number } };
    expect(report.status).toBe('ok');
    expect(report.checks.relayAgeSeconds).toBe(0);
  });

  it('exports worker-local counters and gauges next to the shared metrics', async () => {
    workerMetrics.increment('gc_delete_failures_total', 2);
    workerMetrics.set('dlq_oldest_age_seconds', 120);
    const base = await start();

    const response = await fetch(`${base}/metrics`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('gc_delete_failures_total 2');
    expect(body).toContain('dlq_oldest_age_seconds 120');
  });

  it('rejects unauthenticated scrapes when a metrics token is configured', async () => {
    const base = await start('scrape-secret');

    const denied = await fetch(`${base}/metrics`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer scrape-secret' },
    });
    expect(allowed.status).toBe(200);
  });
});
