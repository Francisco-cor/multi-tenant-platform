import { createServer } from 'node:http';
import { metrics } from '@platform/observability';
import type { QueueFactory, QueueHealth } from './queues.js';
import { workerMetrics } from './worker-metrics.js';

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
    dlqOldestAgeSeconds: number;
    relayAgeSeconds: number | null;
    schedulerAgeSeconds: number | null;
    lagPollAgeSeconds: number | null;
  };
  uptimeMs: number;
}

export interface ReadinessOptions {
  now?: (() => number) | undefined;
  /** A component is unhealthy when its last success is older than this. */
  relayStaleMs?: number | undefined;
  schedulerStaleMs?: number | undefined;
  lagPollStaleMs?: number | undefined;
  /** Ready degrades above this outbox lag. */
  outboxLagLimitSeconds?: number | undefined;
  /** Ready degrades when the oldest pending DLQ row is older than this. */
  dlqAgeLimitSeconds?: number | undefined;
}

/**
 * Liveness of the worker components. Booleans are only the bootstrap flags;
 * readiness also requires a recent successful relay/scheduler/lag-poll tick so
 * a dead relay still reports degraded instead of a false Ready (P2-6).
 */
export class WorkerReadinessState {
  private readonly startedAt = Date.now();
  private readonly now: () => number;
  private readonly relayStaleMs: number;
  private readonly schedulerStaleMs: number;
  private readonly lagPollStaleMs: number;
  private readonly outboxLagLimitSeconds: number;
  private readonly dlqAgeLimitSeconds: number;
  private database = false;
  private consumers = false;
  private relay = false;
  private scheduler = false;
  private stopping = false;
  private outboxLagSeconds = 0;
  private outboxPending = 0;
  private dlqSize = 0;
  private dlqOldestAgeSeconds = 0;
  private lastRelayTickAt: number | null = null;
  private lastSchedulerTickAt: number | null = null;
  private lastLagPollAt: number | null = null;

  constructor(options: ReadinessOptions = {}) {
    this.now = options.now ?? Date.now;
    this.relayStaleMs = options.relayStaleMs ?? 30_000;
    this.schedulerStaleMs = options.schedulerStaleMs ?? 120_000;
    this.lagPollStaleMs = options.lagPollStaleMs ?? 30_000;
    this.outboxLagLimitSeconds = options.outboxLagLimitSeconds ?? 300;
    this.dlqAgeLimitSeconds = options.dlqAgeLimitSeconds ?? 3600;
  }

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
    this.lastLagPollAt = this.now();
  }

  setDlq(size: number, oldestAgeSeconds = 0): void {
    this.dlqSize = size;
    this.dlqOldestAgeSeconds = oldestAgeSeconds;
  }

  /** Relay heartbeat: called after every tick (success or failure). */
  markRelayTick(ok: boolean): void {
    if (ok) this.lastRelayTickAt = this.now();
  }

  /** Scheduler heartbeat. */
  markSchedulerTick(ok: boolean): void {
    if (ok) this.lastSchedulerTickAt = this.now();
  }

  private ageSeconds(at: number | null): number | null {
    return at === null ? null : Math.max(0, Math.round((this.now() - at) / 1000));
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

    const relayAge = this.ageSeconds(this.lastRelayTickAt);
    const schedulerAge = this.ageSeconds(this.lastSchedulerTickAt);
    const lagPollAge = this.ageSeconds(this.lastLagPollAt);
    const relayHealthy = relayAge !== null && relayAge * 1000 <= this.relayStaleMs;
    const schedulerHealthy = schedulerAge !== null && schedulerAge * 1000 <= this.schedulerStaleMs;
    const lagPollHealthy = lagPollAge !== null && lagPollAge * 1000 <= this.lagPollStaleMs;
    const backlogHealthy = this.outboxLagSeconds <= this.outboxLagLimitSeconds;
    const dlqHealthy = this.dlqOldestAgeSeconds <= this.dlqAgeLimitSeconds;

    const ready =
      !this.stopping &&
      this.database &&
      this.consumers &&
      this.relay &&
      this.scheduler &&
      relayHealthy &&
      schedulerHealthy &&
      lagPollHealthy &&
      backlogHealthy &&
      dlqHealthy &&
      queueHealth.redis === 'ok' &&
      queueHealth.runningWorkers > 0 &&
      queueHealth.runningWorkers === queueHealth.configuredWorkers;

    return {
      status: ready ? 'ok' : 'degraded',
      service: 'worker',
      checks: {
        database: this.database,
        consumers: this.consumers,
        relay: this.relay && relayHealthy,
        scheduler: this.scheduler && schedulerHealthy,
        redis: queueHealth.redis,
        workersRunning: queueHealth.runningWorkers,
        workersConfigured: queueHealth.configuredWorkers,
        outboxLagSeconds: this.outboxLagSeconds,
        outboxPending: this.outboxPending,
        dlqSize: this.dlqSize,
        dlqOldestAgeSeconds: this.dlqOldestAgeSeconds,
        relayAgeSeconds: relayAge,
        schedulerAgeSeconds: schedulerAge,
        lagPollAgeSeconds: lagPollAge,
      },
      uptimeMs: this.now() - this.startedAt,
    };
  }
}

export interface WorkerHealthServer {
  /** Bound port (useful when `options.port` is 0 in tests). */
  port: number;
  close(): Promise<void>;
}

export interface WorkerHealthServerOptions {
  host: string;
  port: number;
  /** When set, `/metrics` requires `authorization: Bearer <token>` (P3-6). */
  metricsToken?: string | undefined;
}

export async function startWorkerHealthServer(
  state: WorkerReadinessState,
  queueFactory: () => QueueFactory | null,
  options: WorkerHealthServerOptions,
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
        if (options.metricsToken) {
          const auth = request.headers.authorization ?? '';
          if (auth !== `Bearer ${options.metricsToken}`) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }
        const local = workerMetrics.toPrometheus();
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(local ? `${metrics.toPrometheus()}\n${local}` : metrics.toPrometheus());
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
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : options.port;
  return {
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
