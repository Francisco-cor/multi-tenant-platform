import { sql, nextAttemptDelayMs } from '@platform/db';
import type { DatabaseExecutor, DatabaseHandle } from '@platform/db';
import {
  deterministicJobId,
  getQueueForAggregate,
  type QueueFactory,
  type JobPayload,
} from '../queues.js';
import { metrics } from '@platform/observability';
import { workerMetrics } from '../worker-metrics.js';

/** Outbox events are only dead-lettered once they are old *and* repeatedly failing. */
export const OUTBOX_DEAD_LETTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_DEAD_LETTER_MIN_ATTEMPTS = 5;
/** Rows published per transaction. Small enough to keep the row lock bounded. */
export const OUTBOX_CHUNK_SIZE = 10;

export interface OutboxRelayOptions {
  batchSize?: number | undefined;
  queueFactory: QueueFactory;
  /** Max events resolved per run; work is chunked into small transactions. */
  chunkSize?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface OutboxRelayResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
  durationMs: number;
}

async function globalTransaction<T>(
  db: DatabaseHandle,
  callback: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  return db.db.transaction(async (tx) => {
    if (db.role) await tx.execute(sql.raw(`set local role "${db.role}"`));
    return callback(tx);
  });
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_version: number;
  payload: unknown;
  attempts: number;
  correlation_id: string | null;
  created_at: string;
}

function decodePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

/**
 * Poll `outbox_events` and publish to BullMQ.
 *
 * - One small chunk per transaction, published while the rows are locked, so a
 *   slow/duplicated relay cannot publish the same event twice (P2-7).
 * - Payload decoding happens inside the per-event `try`, so one poison event is
 *   isolated instead of failing the whole batch.
 * - Failures retry with capped jittered backoff; an event is dead-lettered only
 *   when it is older than {@link OUTBOX_DEAD_LETTER_MAX_AGE_MS} and has at least
 *   {@link OUTBOX_DEAD_LETTER_MIN_ATTEMPTS} attempts (P1-3). A short Redis
 *   outage therefore never loses events.
 */
export async function runOutboxRelayOnce(
  db: DatabaseHandle,
  options: OutboxRelayOptions,
): Promise<OutboxRelayResult> {
  const batchSize = options.batchSize ?? 100;
  const chunkSize = Math.max(1, Math.min(options.chunkSize ?? OUTBOX_CHUNK_SIZE, batchSize));
  const now = options.now?.() ?? new Date();
  const start = Date.now();
  const totals = { claimed: 0, published: 0, failed: 0, deadLettered: 0 };

  while (totals.claimed < batchSize) {
    const chunk = await publishChunk(db, options, chunkSize, now);
    if (chunk.claimed === 0) break;
    totals.claimed += chunk.claimed;
    totals.published += chunk.published;
    totals.failed += chunk.failed;
    totals.deadLettered += chunk.deadLettered;
    if (chunk.claimed < chunkSize) break;
  }

  return { ...totals, durationMs: Date.now() - start };
}

async function publishChunk(
  db: DatabaseHandle,
  options: OutboxRelayOptions,
  chunkSize: number,
  now: Date,
): Promise<Omit<OutboxRelayResult, 'durationMs'>> {
  return globalTransaction(db, async (tx) => {
    const rows = await tx.execute<OutboxRow>(sql`
      select id, tenant_id, aggregate_type, aggregate_id, event_type, payload_version,
             payload::text as payload, attempts, correlation_id, created_at
      from outbox_events
      where (
        (status = 'pending' and next_attempt_at <= now())
        or (status = 'claimed' and updated_at <= now() - interval '5 minutes')
      )
      order by created_at
      limit ${chunkSize}
      for update skip locked
    `);
    if (rows.length === 0) return { claimed: 0, published: 0, failed: 0, deadLettered: 0 };

    let published = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const ev of rows) {
      const jobId = deterministicJobId(ev.tenant_id, ev.aggregate_id, ev.event_type, ev.id);
      let queueName: ReturnType<typeof getQueueForAggregate> | null = null;
      try {
        queueName = getQueueForAggregate(ev.aggregate_type);
        const queue = options.queueFactory.getQueue(queueName);
        const payload: JobPayload = {
          tenantId: ev.tenant_id,
          aggregateId: ev.aggregate_id,
          aggregateType: ev.aggregate_type,
          eventType: ev.event_type,
          eventId: ev.id,
          payloadVersion: ev.payload_version,
          ...(ev.correlation_id ? { correlationId: ev.correlation_id } : {}),
          payload: ev.payload === null ? {} : decodePayload(ev.payload),
        };

        const added = await queue.add(payload, { jobId });
        if (!added.accepted) {
          // Another relay/enqueue already owns this job id. Treat it as published
          // (the work exists) instead of retrying forever.
          workerMetrics.increment('outbox_publish_failures_total');
        }
        await tx.execute(sql`
          update outbox_events
          set status = 'done', published_at = now(), updated_at = now()
          where id = ${ev.id}::uuid
        `);
        published++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        workerMetrics.increment('outbox_publish_failures_total');
        failed++;
        const attempts = ev.attempts + 1;
        const ageMs = now.getTime() - new Date(ev.created_at).getTime();
        const shouldDeadLetter =
          attempts >= OUTBOX_DEAD_LETTER_MIN_ATTEMPTS && ageMs >= OUTBOX_DEAD_LETTER_MAX_AGE_MS;
        if (shouldDeadLetter) {
          const resolvedQueue = queueName ?? 'generic';
          const payloadForDlq: JobPayload = {
            tenantId: ev.tenant_id,
            aggregateId: ev.aggregate_id,
            aggregateType: ev.aggregate_type,
            eventType: ev.event_type,
            eventId: ev.id,
            payloadVersion: ev.payload_version,
            ...(ev.correlation_id ? { correlationId: ev.correlation_id } : {}),
            payload: {},
          };
          await tx.execute(sql`
            update outbox_events
            set status = 'dead_letter', last_error = ${message}, attempts = ${attempts}, updated_at = now()
            where id = ${ev.id}::uuid
          `);
          await tx.execute(sql`
            insert into dlq_jobs (job_id, tenant_id, queue, payload, cause, attempts, correlation_id)
            values (${jobId}, ${ev.tenant_id}::uuid, ${resolvedQueue}, ${JSON.stringify(payloadForDlq)}::jsonb, ${message}, ${attempts}, ${ev.correlation_id})
            on conflict (job_id) where status='pending' do update
            set cause=excluded.cause,
                attempts=greatest(dlq_jobs.attempts, excluded.attempts),
                correlation_id=coalesce(excluded.correlation_id, dlq_jobs.correlation_id),
                updated_at=now()
          `);
          metrics.recordFinalFailure(resolvedQueue);
          workerMetrics.increment('outbox_dead_letter_total');
          deadLettered++;
        } else {
          const nextDelay = nextAttemptDelayMs(ev.attempts, 1000, 60000, 0.2);
          await tx.execute(sql`
            update outbox_events
            set status = 'pending', last_error = ${message}, attempts = ${attempts},
                next_attempt_at = now() + (${String(nextDelay)}::text || ' ms')::interval,
                updated_at = now()
            where id = ${ev.id}::uuid
          `);
        }
      }
    }

    return { claimed: rows.length, published, failed, deadLettered };
  });
}

export interface RedriveOptions {
  limit?: number;
  /** Only re-drive events older than this (default: none). */
  olderThanMs?: number;
  /** Restrict to one tenant (operator action). */
  tenantId?: string;
  now?: Date;
}

export interface RedriveResult {
  redriven: number;
  ids: string[];
}

/**
 * Operator/maintenance re-drive: flip `dead_letter` events back to `pending`,
 * reset attempts and mark the matching DLQ rows replayed. Audited through the
 * metrics package plus the per-row `last_error` marker.
 */
export async function redriveDeadLetterEvents(
  db: DatabaseHandle,
  options: RedriveOptions = {},
): Promise<RedriveResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const now = options.now ?? new Date();
  const olderThan = options.olderThanMs ?? 0;
  const cutoffIso = new Date(now.getTime() - olderThan).toISOString();

  return globalTransaction(db, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      tenant_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
    }>(sql`
      update outbox_events
      set status = 'pending',
          attempts = 0,
          next_attempt_at = now(),
          last_error = 'redrive:' || coalesce(last_error, ''),
          updated_at = now()
      where id in (
        select id from outbox_events
        where status = 'dead_letter'
          and created_at <= ${cutoffIso}::timestamptz
          ${options.tenantId ? sql`and tenant_id = ${options.tenantId}::uuid` : sql``}
        order by created_at
        limit ${limit}
        for update skip locked
      )
      returning id, tenant_id, aggregate_type, aggregate_id, event_type
    `);
    if (rows.length === 0) return { redriven: 0, ids: [] };

    const jobIds = rows.map((row) =>
      deterministicJobId(row.tenant_id, row.aggregate_id, row.event_type, row.id),
    );
    await tx.execute(sql`
      update dlq_jobs
      set status = 'replayed', replay_count = replay_count + 1, last_replayed_at = now(),
          updated_at = now()
      where job_id = any(${jobIds}::text[]) and status = 'pending'
    `);
    workerMetrics.increment('outbox_redriven_total', rows.length);
    metrics.recordDlqReplay('outbox');
    return { redriven: rows.length, ids: rows.map((row) => row.id) };
  });
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
      chunkSize?: number | undefined;
      intervalMs?: number | undefined;
      /** Called after every tick so readiness can track liveness (P2-6). */
      onTick?: ((ok: boolean, error?: string) => void) | undefined;
      now?: (() => Date) | undefined;
    } = {},
  ) {}

  start(intervalMs = this.options.intervalMs ?? 2000): void {
    if (this.timer) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped || this.running) return;
      this.running = true;
      let ok = false;
      let message: string | undefined;
      try {
        await runOutboxRelayOnce(this.db, {
          batchSize: this.options.batchSize,
          chunkSize: this.options.chunkSize,
          queueFactory: this.queueFactory,
          now: this.options.now,
        });
        ok = true;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'outbox_relay_error', error: message }));
      } finally {
        this.options.onTick?.(ok, message);
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
      chunkSize: this.options.chunkSize,
      queueFactory: this.queueFactory,
      now: this.options.now,
    });
  }
}
