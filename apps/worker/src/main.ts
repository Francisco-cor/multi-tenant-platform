import { rm, writeFile } from 'node:fs/promises';
import { createDatabase, sql, type DatabaseHandle } from '@platform/db';
import { metrics, createLogger, initTracing } from '@platform/observability';
import { createWorkerProcessor } from './consumer.js';
import { createBullMqFactory, type QueueFactory } from './queues.js';
import { OutboxRelay } from './relay/outboxRelay.js';
import { startMaintenanceScheduler, type MaintenanceScheduler } from './scheduler.js';
import { workerGlobalTransaction } from './tenant-db.js';
import {
  startWorkerHealthServer,
  WorkerReadinessState,
  type WorkerHealthServer,
} from './readiness.js';

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

const shutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  readiness.setStopping(true);
  logger.info({ signal }, 'worker_shutdown_started');
  const deadline = Date.now() + 30000;
  try {
    if (relay) await relay.stop();
    maintenanceScheduler?.stop();
    if (queueFactory) await queueFactory.closeAll();
    if (lagTimer) clearInterval(lagTimer);
    if (healthServer) await healthServer.close();
    await rm(readyFile, { force: true });
    if (database) await database.close();
    if (relayDatabase) await relayDatabase.close();
    logger.info({ signal }, 'worker_shutdown_completed');
  } catch (error) {
    logger.error(
      { signal, error: error instanceof Error ? error.message : String(error) },
      'worker_shutdown_error',
    );
  } finally {
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((r) => setTimeout(r, Math.min(remaining, 100)));
    process.exit(exitCode);
  }
};

// Bootstrap worker with real DB/Redis. In-memory mode is for local development/tests only.
async function bootstrap(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!dbUrl || !redisUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('worker_database_and_redis_required');
    }
    logger.info({ status: 'idle', reason: 'no DATABASE_URL' }, 'worker_started');
    return;
  }

  database = createDatabase(dbUrl, { role: process.env.DATABASE_ROLE ?? 'platform_app' });
  relayDatabase = createDatabase(dbUrl, {
    role: process.env.WORKER_DATABASE_ROLE ?? 'platform_worker',
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
  await queueFactory.startWorkers?.(createWorkerProcessor(database, relayDatabase));
  readiness.setConsumers(true);

  maintenanceScheduler = startMaintenanceScheduler(queueFactory, {
    paymentProviderConfigured: process.env.PAYMENT_PROVIDER === 'fake',
  });
  readiness.setScheduler(true);

  relay = new OutboxRelay(relayDatabase, queueFactory, { batchSize: 100, intervalMs: 2000 });
  relay.start();
  readiness.setRelay(true);
  await writeFile(readyFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });

  // Also start periodic GC for files and reservations (reuse existing jobs)
  // Metrics: poll outbox lag every 5s
  lagTimer = setInterval(async () => {
    try {
      const { sql } = await import('@platform/db');
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
        tx.execute<{ pending: string }>(
          sql`select count(*) as pending from dlq_jobs where status='pending'`,
        ),
      );
      readiness.setDlq(Number(dlqRows[0]?.pending ?? 0));
      if (lag > 30) {
        logger.warn({ lag, pending }, 'outbox lag high');
      }
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
if (Number.isInteger(healthPort) && healthPort > 0 && healthPort <= 65535) {
  healthServer = await startWorkerHealthServer(readiness, () => queueFactory, {
    host: process.env.WORKER_HEALTH_HOST ?? '0.0.0.0',
    port: healthPort,
  });
}

void bootstrap().catch((error) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    'worker_bootstrap_failed',
  );
  void shutdown('bootstrap_failed', 1);
});

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
