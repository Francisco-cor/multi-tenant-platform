import { createDatabase } from '@platform/db';
import { metrics } from '@platform/observability';
import { InMemoryQueueFactory } from './queues.js';
import { OutboxRelay } from './relay/outboxRelay.js';

let shuttingDown = false;
let relay: OutboxRelay | null = null;
let queueFactory: import('./queues.js').QueueFactory | null = null;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ event: 'worker_shutdown_started', signal }));
  const deadline = Date.now() + 30000;
  try {
    if (relay) await relay.stop();
    if (queueFactory) await queueFactory.closeAll();
    console.info(
      JSON.stringify({
        event: 'worker_shutdown_completed',
        signal,
        durationMs: Date.now() - (Date.now() - 0),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker_shutdown_error',
        signal,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((r) => setTimeout(r, Math.min(remaining, 100)));
    process.exit(0);
  }
};

// Bootstrap worker if DATABASE_URL and REDIS_URL are available; otherwise idle (tests use InMemory).
async function bootstrap(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!dbUrl) {
    console.info(
      JSON.stringify({ event: 'worker_started', status: 'idle', reason: 'no DATABASE_URL' }),
    );
    return;
  }

  const db = createDatabase(dbUrl, { role: process.env.DATABASE_ROLE ?? 'platform_app' });
  // For now we use InMemory queues; BullMQ will be wired when REDIS_URL is present and bullmq is installed.
  // We keep InMemory as fallback to make tests deterministic without Redis.
  queueFactory = new InMemoryQueueFactory();

  // If REDIS_URL is set, try to upgrade to BullMQ factory (best effort)
  if (redisUrl) {
    try {
      const { createBullMqFactory } = await import('./queues.js');
      const bullFactory = await createBullMqFactory(redisUrl);
      if (bullFactory) {
        await queueFactory.closeAll();
        queueFactory = bullFactory;
        console.info(
          JSON.stringify({
            event: 'worker_queues',
            mode: 'bullmq',
            redisUrl: redisUrl.replace(/:\/\/.*@/, '://***@'),
          }),
        );
      } else {
        console.info(
          JSON.stringify({
            event: 'worker_queues',
            mode: 'in-memory',
            reason: 'bullmq_unavailable',
          }),
        );
      }
    } catch (error) {
      console.info(
        JSON.stringify({
          event: 'worker_queues',
          mode: 'in-memory',
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } else {
    console.info(JSON.stringify({ event: 'worker_queues', mode: 'in-memory' }));
  }

  relay = new OutboxRelay(db, queueFactory, { batchSize: 100, intervalMs: 2000 });
  relay.start();

  // Also start periodic GC for files and reservations (reuse existing jobs)
  // Metrics: poll outbox lag every 5s
  const lagTimer = setInterval(async () => {
    try {
      const { sql } = await import('@platform/db');
      const rows = await db.db.execute<{ lag: string; pending: string }>(
        sql`select extract(epoch from (now() - min(created_at))) as lag, count(*) as pending from outbox_events where status='pending'`,
      );
      const row = rows[0];
      const lag = row?.lag ? Number(row.lag) : 0;
      const pending = row?.pending ? Number(row.pending) : 0;
      metrics.recordOutboxLag(lag, pending);
    } catch {
      // ignore
    }
  }, 5000);
  // Ensure lagTimer does not prevent shutdown
  lagTimer.unref?.();

  console.info(
    JSON.stringify({
      event: 'worker_started',
      status: 'running',
      relay: 'outbox',
      queues: 'ready',
    }),
  );
}

void bootstrap();

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
