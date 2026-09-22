import { createServer, type Server } from 'node:http';
import { metrics } from '@platform/observability';
import type { QueueFactory, QueueHealth } from './queues.js';

export interface WorkerReadinessReport {
  status: 'ok' | 'degraded';
  service: 'worker';
  checks: {
    database: boolean;
    consumers: boolean;
    relay: boolean;
    scheduler: boolean;
    redis: QueueHealth['redis'];
    workersRunning: number;
    workersConfigured: number;
    outboxLagSeconds: number;
    outboxPending: number;
    dlqSize: number;
  };
  uptimeMs: number;
}

export class WorkerReadinessState {
  private readonly startedAt = Date.now();
  private database = false;
  private consumers = false;
  private relay = false;
  private scheduler = false;
  private stopping = false;
  private outboxLagSeconds = 0;
  private outboxPending = 0;
  private dlqSize = 0;

  setDatabase(value: boolean): void {
    this.database = value;
  }

  setConsumers(value: boolean): void {
    this.consumers = value;
  }

  setRelay(value: boolean): void {
    this.relay = value;
  }

  setScheduler(value: boolean): void {
    this.scheduler = value;
  }

  setStopping(value: boolean): void {
    this.stopping = value;
  }

  setOutbox(lagSeconds: number, pending: number): void {
    this.outboxLagSeconds = lagSeconds;
    this.outboxPending = pending;
  }

  setDlq(size: number): void {
    this.dlqSize = size;
  }

  async report(queueFactory: QueueFactory | null): Promise<WorkerReadinessReport> {
    const queueHealth: QueueHealth = queueFactory?.getHealth
      ? await queueFactory.getHealth().catch(() => ({
          redis: 'fail' as const,
          configuredWorkers: 0,
          runningWorkers: 0,
          queues: [],
        }))
      : {
          redis: 'not_configured' as const,
          configuredWorkers: 0,
          runningWorkers: 0,
          queues: [],
        };
    const ready =
      !this.stopping &&
      this.database &&
      this.consumers &&
      this.relay &&
      this.scheduler &&
      queueHealth.redis === 'ok' &&
      queueHealth.runningWorkers === queueHealth.configuredWorkers &&
      queueHealth.configuredWorkers > 0;
    return {
      status: ready ? 'ok' : 'degraded',
      service: 'worker',
      checks: {
        database: this.database,
        consumers: this.consumers,
        relay: this.relay,
        scheduler: this.scheduler,
        redis: queueHealth.redis,
        workersRunning: queueHealth.runningWorkers,
        workersConfigured: queueHealth.configuredWorkers,
        outboxLagSeconds: this.outboxLagSeconds,
        outboxPending: this.outboxPending,
        dlqSize: this.dlqSize,
      },
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}

export interface WorkerHealthServer {
  close(): Promise<void>;
}

export async function startWorkerHealthServer(
  state: WorkerReadinessState,
  queueFactory: () => QueueFactory | null,
  options: { host: string; port: number },
): Promise<WorkerHealthServer> {
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health/live') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', service: 'worker' }));
        return;
      }
      if (request.url === '/health/ready') {
        const report = await state.report(queueFactory());
        response.writeHead(report.status === 'ok' ? 200 : 503, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(report));
        return;
      }
      if (request.url === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(metrics.toPrometheus());
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'degraded', service: 'worker' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
