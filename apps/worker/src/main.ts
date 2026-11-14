import { rm, writeFile } from 'node:fs/promises';
import { loadWorkerEnvironment } from '@platform/config';
import { createDatabase, sql, type DatabaseHandle } from '@platform/db';
import { metrics, createLogger, initTracing } from '@platform/observability';
import { createWorkerProcessor } from './consumer.js';
import { runShutdown } from './lifecycle.js';
import { createPaymentProvider } from './providers/createPaymentProvider.js';
import type { PaymentProvider } from './providers/paymentProvider.js';
import { createBullMqFactory, type QueueFactory } from './queues.js';
import { OutboxRelay } from './relay/outboxRelay.js';
import { startMaintenanceScheduler, type MaintenanceScheduler } from './scheduler.js';
import { workerGlobalTransaction } from './tenant-db.js';
import {
  startWorkerHealthServer,
  WorkerReadinessState,
  type WorkerHealthServer,
} from './readiness.js';
import { workerMetrics } from './worker-metrics.js';

const logger = createLogger({ service: process.env.OTEL_SERVICE_NAME ?? 'worker' });

await initTracing({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'worker',
  ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { exporterEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});

let shuttingDown = false;
let relay: OutboxRelay | null = null;
let queueFactory: QueueFactory | null = null;
let database: DatabaseHandle | null = null;
let relayDatabase: DatabaseHandle | null = null;
let lagTimer: NodeJS.Timeout | null = null;
let maintenanceScheduler: MaintenanceScheduler | null = null;
const readiness = new WorkerReadinessState();
let healthServer: WorkerHealthServer | null = null;
const readyFile = process.env.WORKER_READY_FILE ?? '/tmp/platform-worker-ready';

/** Steps already closed, so a forced close cannot double-close a resource. */
const closedSteps = new Set<string>();

async function closeStep(name: string, close: () => Promise<void> | void): Promise<void> {
  if (closedSteps.has(name)) return;
  closedSteps.add(name);
  await close();
}

async function closeResources(force: boolean): Promise<void> {
  if (force) {
    // The graceful drain already exceeded the deadline; skip the remaining
    // ordered steps and tear the workers down immediately (caller bounds this).
    await rm(readyFile, { force: true }).catch(() => undefined);
    if (queueFactory && !closedSteps.has('workers')) {
      await queueFactory.closeAll({ force: true }).catch(() => undefined);
    }
    return;
  }
  await closeStep('ready-file', () => rm(readyFile, { force: true }));
  await closeStep('relay', async () => {
    if (relay) await relay.stop();
  });
  await closeStep('scheduler', () => maintenanceScheduler?.stop());
  await closeStep('lag-timer', () => {
    if (lagTimer) {
      clearInterval(lagTimer);
      lagTimer = null;
    }
  });
  await closeStep('workers', () => queueFactory?.closeAll({}));
  await closeStep('health-server', () => healthServer?.close());
  await closeStep('database', () => database?.close());
  await closeStep('relay-database', () => relayDatabase?.close());
}

const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  readiness.setStopping(true);
  logger.info({ signal }, 'worker_shutdown_started');
  const outcome = await runShutdown({
    reason: signal,
    exitCode,
    close: () => closeResources(false),
    force: () => closeResources(true),
    exit: (code) => process.exit(code),
  });
  logger.info({ signal, outcome }, 'worker_shutdown_completed');
};

/** Derive whether payments are configured instead of hardcoding `true` (P3-4). */
function configuredPaymentProvider(): PaymentProvider | null {
  try {
    return createPaymentProvider();
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'payment_provider_unavailable',
    );
    return null;
  }
}

// Bootstrap worker with real DB/Redis. In-memory mode is for local development/tests only.
async function bootstrap(): Promise<void> {
  const environment = loadWorkerEnvironment();
  const dbUrl = environment.DATABASE_URL;
  const redisUrl = environment.REDIS_URL;
  if (!dbUrl || !redisUrl) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('worker_database_and_redis_required');
    }
    logger.info({ status: 'idle', reason: 'no DATABASE_URL' }, 'worker_started');
    return;
  }

  database = createDatabase(dbUrl, { role: environment.DATABASE_ROLE ?? 'platform_app' });
  relayDatabase = createDatabase(dbUrl, {
    role: environment.WORKER_DATABASE_ROLE,
  });
  await workerGlobalTransaction(relayDatabase, (tx) => tx.execute(sql`select 1`));
  readiness.setDatabase(true);

  const bullFactory = await createBullMqFactory(redisUrl);
  if (!bullFactory) throw new Error('bullmq_unavailable');
  queueFactory = bullFactory;
  logger.info(
    { mode: 'bullmq', redisUrl: redisUrl.replace(/:\/\/.*@/, '://***@') },
    'worker_queues',
  );

  const paymentProvider = configuredPaymentProvider();
  await queueFactory.startWorkers?.(
    createWorkerProcessor(database, relayDatabase, { paymentProvider }),
  );
  readiness.setConsumers(true);

  maintenanceScheduler = startMaintenanceScheduler(queueFactory, {
    paymentProviderConfigured: paymentProvider !== null,
    onTick: (ok) => readiness.markSchedulerTick(ok),
  });
  readiness.setScheduler(true);

  relay = new OutboxRelay(relayDatabase, queueFactory, {
    batchSize: 100,
    intervalMs: 2000,
    onTick: (ok) => readiness.markRelayTick(ok),
  });
  relay.start();
  readiness.setRelay(true);
  await writeFile(readyFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });

  // Metrics/readiness poll: outbox lag, DLQ size and age, gauges.
  lagTimer = setInterval(async () => {
    try {
      const rows = await workerGlobalTransaction(relayDatabase!, (tx) =>
        tx.execute<{ lag: string; pending: string }>(
          sql`select extract(epoch from (now() - min(created_at))) as lag, count(*) as pending from outbox_events where status='pending'`,
        ),
      );
      const row = rows[0];
      const lag = row?.lag ? Number(row.lag) : 0;
      const pending = row?.pending ? Number(row.pending) : 0;
      metrics.recordOutboxLag(lag, pending);
      readiness.setOutbox(lag, pending);

      const dlqRows = await workerGlobalTransaction(relayDatabase!, (tx) =>
        tx.execute<{ pending: string; oldest_age: string | null }>(
          sql`select count(*)::text as pending,
                     extract(epoch from (now() - min(created_at)))::text as oldest_age
              from dlq_jobs where status='pending'`,
        ),
      );
      const dlqSize = Number(dlqRows[0]?.pending ?? 0);
      const dlqAge = dlqRows[0]?.oldest_age ? Number(dlqRows[0]?.oldest_age) : 0;
      readiness.setDlq(dlqSize, dlqAge);
      metrics.recordDlq(dlqSize);
      workerMetrics.set('dlq_oldest_age_seconds', dlqAge);

      const deadRows = await workerGlobalTransaction(relayDatabase!, (tx) =>
        tx.execute<{ pending: string }>(
          sql`select count(*)::text as pending from outbox_events where status='dead_letter'`,
        ),
      );
      workerMetrics.set('outbox_dead_letter_pending', Number(deadRows[0]?.pending ?? 0));

      if (lag > 30) logger.warn({ lag, pending }, 'outbox lag high');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'outbox_lag_poll_failed',
      );
    }
  }, 5000);
  // Ensure lagTimer does not prevent shutdown
  lagTimer.unref?.();

  logger.info({ relay: 'outbox', queues: 'ready' }, 'worker_started');
}

const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 4010);
const metricsToken = process.env.WORKER_METRICS_TOKEN;
if (process.env.NODE_ENV === 'production' && !metricsToken) {
  logger.warn(
    { endpoint: '/metrics' },
    'worker_metrics_unauthenticated: set WORKER_METRICS_TOKEN or keep the health port private',
  );
}
if (Number.isInteger(healthPort) && healthPort > 0 && healthPort <= 65535) {
  healthServer = await startWorkerHealthServer(readiness, () => queueFactory, {
    host: process.env.WORKER_HEALTH_HOST ?? '0.0.0.0',
    port: healthPort,
    ...(metricsToken ? { metricsToken } : {}),
  });
}

void bootstrap().catch((error) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'worker_bootstrap_failed',
  );
  void shutdown('bootstrap_failed', 1);
});

// Idempotent signal handling: the first signal starts the drain, later ones are ignored.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void shutdown(signal));
}
