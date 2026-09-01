import { sql, nextAttemptDelayMs } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import {
  deterministicJobId,
  getQueueForAggregate,
  type QueueFactory,
  type JobPayload,
} from '../queues.js';

export interface OutboxRelayOptions {
  batchSize?: number | undefined;
  queueFactory: QueueFactory;
}

export interface OutboxRelayResult {
  claimed: number;
  published: number;
  failed: number;
  durationMs: number;
}

/**
 * Poll `outbox_events` with `FOR UPDATE SKIP LOCKED` and publish to BullMQ.
 * - Claims batch where status='pending' and next_attempt_at <= now()
 * - For each event, computes deterministic jobId = sha256(tenantId:aggregateId:eventType)
 * - Publishes to queue derived from aggregate_type
 * - On success: updates status='done', published_at=now()
 * - On publish failure: increments attempts, sets next_attempt_at with jitter, last_error
 * - After max attempts (5) → status='dead_letter' and insert into dlq_jobs (handled by caller or here)
 *
 * The relay is idempotent: re-publishing same jobId is deduped by BullMQ / processed_jobs.
 */
export async function runOutboxRelayOnce(
  db: DatabaseHandle,
  options: OutboxRelayOptions,
): Promise<OutboxRelayResult> {
  const batchSize = options.batchSize ?? 100;
  const start = Date.now();

  const events = await db.db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      tenant_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: string;
      attempts: number;
      correlation_id: string | null;
    }>(sql`
      select id, tenant_id, aggregate_type, aggregate_id, event_type, payload, attempts, correlation_id
      from outbox_events
      where status = 'pending' and next_attempt_at <= now()
      order by created_at
      limit ${batchSize}
      for update skip locked
    `);

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    // Claim them to avoid other relays picking same batch concurrently: set status='claimed' transiently
    await tx.execute(sql`
      update outbox_events
      set status = 'claimed', updated_at = now()
      where id = any(${ids}::uuid[]) and status = 'pending'
    `);

    return rows;
  });

  if (events.length === 0)
    return { claimed: 0, published: 0, failed: 0, durationMs: Date.now() - start };

  let published = 0;
  let failed = 0;

  for (const ev of events) {
    const jobId = deterministicJobId(ev.tenant_id, ev.aggregate_id, ev.event_type);
    const queueName = getQueueForAggregate(ev.aggregate_type);
    const queue = options.queueFactory.getQueue(queueName);
    const payload: JobPayload = {
      tenantId: ev.tenant_id,
      aggregateId: ev.aggregate_id,
      aggregateType: ev.aggregate_type,
      eventType: ev.event_type,
      eventId: ev.id,
      ...(ev.correlation_id ? { correlationId: ev.correlation_id } : {}),
      payload: ev.payload
        ? typeof ev.payload === 'string'
          ? JSON.parse(ev.payload as unknown as string)
          : ev.payload
        : {},
    };

    try {
      await queue.add(payload, { jobId });
      // Mark done
      await db.db.execute(sql`
        update outbox_events
        set status = 'done', published_at = now(), updated_at = now()
        where id = ${ev.id}::uuid
      `);
      published++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextDelay = nextAttemptDelayMs(ev.attempts, 1000, 60000, 0.2);
      const shouldDeadLetter = ev.attempts + 1 >= 5;
      if (shouldDeadLetter) {
        await db.db.execute(sql`
          update outbox_events
          set status = 'dead_letter', last_error = ${message}, attempts = attempts + 1, next_attempt_at = now() + interval '1 hour', updated_at = now()
          where id = ${ev.id}::uuid
        `);
        // Also insert into dlq_jobs for operational replay
        await db.db.execute(sql`
          insert into dlq_jobs (job_id, tenant_id, queue, payload, cause, attempts)
          values (${jobId}, ${ev.tenant_id}::uuid, ${queueName}, ${JSON.stringify(payload)}::jsonb, ${message}, ${ev.attempts + 1})
        `);
      } else {
        await db.db.execute(sql`
          update outbox_events
          set status = 'pending', last_error = ${message}, attempts = attempts + 1, next_attempt_at = now() + (${nextDelay}::text || ' ms')::interval, updated_at = now()
          where id = ${ev.id}::uuid
        `);
      }
      failed++;
    }
  }

  return { claimed: events.length, published, failed, durationMs: Date.now() - start };
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly queueFactory: QueueFactory,
    private readonly options: {
      batchSize?: number | undefined;
      intervalMs?: number | undefined;
    } = {},
  ) {}

  start(intervalMs = this.options.intervalMs ?? 2000): void {
    if (this.timer) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped || this.running) return;
      this.running = true;
      try {
        await runOutboxRelayOnce(this.db, {
          batchSize: this.options.batchSize,
          queueFactory: this.queueFactory,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'outbox_relay_error',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        this.running = false;
        if (!this.stopped) this.timer = setTimeout(loop, intervalMs);
      }
    };
    // Initial tick
    this.timer = setTimeout(loop, intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight run to finish (max 5s)
    const deadline = Date.now() + 5000;
    while (this.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  // For tests / manual trigger
  async tick(): Promise<OutboxRelayResult> {
    return runOutboxRelayOnce(this.db, {
      batchSize: this.options.batchSize,
      queueFactory: this.queueFactory,
    });
  }
}
