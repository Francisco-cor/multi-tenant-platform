import { randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import { metrics } from '@platform/observability';
import type { DatabaseHandle } from '@platform/db';
import type { QueueFactory } from './queues.js';
import { workerTenantTransaction } from './tenant-db.js';
import { workerMetrics } from './worker-metrics.js';

export interface DlqRecord {
  id: string;
  jobId: string;
  tenantId: string;
  queue: string;
  payload: unknown;
  cause: string;
  attempts: number;
  status: string;
  createdAt: number;
}

export async function listDlq(
  db: DatabaseHandle,
  tenantId: string,
  limit = 25,
): Promise<DlqRecord[]> {
  const rows = await workerTenantTransaction(db, tenantId, `dlq:list:${tenantId}`, (tx) =>
    tx.execute<{
      id: string;
      job_id: string;
      tenant_id: string;
      queue: string;
      payload: string;
      cause: string;
      attempts: number;
      status: string;
      created_at: string;
    }>(sql`
    select id, job_id, tenant_id, queue, payload::text as payload, cause, attempts, status, created_at
    from dlq_jobs
    where tenant_id = ${tenantId}::uuid
    order by created_at desc
    limit ${limit}
  `),
  );
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    tenantId: r.tenant_id,
    queue: r.queue,
    payload: r.payload ? JSON.parse(r.payload) : {},
    cause: r.cause,
    attempts: r.attempts,
    status: r.status,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

/**
 * Replay a dead-letter row.
 *
 * The replay uses a *fresh* BullMQ job id: BullMQ silently ignores an `add`
 * whose id still exists in any state (the failed job is retained for 24 h), so
 * reusing the original id made every replay a no-op (P1-2). The original id is
 * kept in the payload for tracing and the retained failed job is removed so the
 * replay is observable.
 */
export async function replayDlq(
  db: DatabaseHandle,
  queueFactory: QueueFactory,
  input: { tenantId: string; dlqId: string; actorUserId?: string },
): Promise<{
  jobId: string;
  originalJobId: string;
  queue: string;
  correlationId: string;
  accepted: boolean;
}> {
  const rows = await workerTenantTransaction(
    db,
    input.tenantId,
    `dlq:replay:${input.dlqId}`,
    (tx) =>
      tx.execute<{
        id: string;
        job_id: string;
        tenant_id: string;
        queue: string;
        payload: string;
        cause: string;
        attempts: number;
        status: string;
      }>(sql`
    select id, job_id, tenant_id, queue, payload::text as payload, cause, attempts, status
    from dlq_jobs
    where id = ${input.dlqId}::uuid and tenant_id = ${input.tenantId}::uuid
    limit 1
  `),
  );
  const row = rows[0];
  if (!row) throw new Error('dlq_not_found');
  if (row.status === 'replayed') throw new Error('dlq_already_replayed');
  if (row.status === 'discarded') throw new Error('dlq_discarded');

  const originalJobId = row.job_id;
  const replayJobId = `${originalJobId}-replay-${randomUUID()}`;
  const correlationId = `dlq-replay:${randomUUID()}`;
  const storedPayload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};

  const queueName = row.queue as Parameters<QueueFactory['getQueue']>[0];
  const queue = queueFactory.getQueue(queueName);

  // Remove the retained failed job (any state) so the replay is observable.
  await queue.remove(originalJobId).catch(() => false);

  const payload = {
    tenantId: row.tenant_id,
    aggregateId:
      typeof storedPayload.aggregateId === 'string' ? storedPayload.aggregateId : originalJobId,
    aggregateType:
      typeof storedPayload.aggregateType === 'string' ? storedPayload.aggregateType : 'generic',
    eventType: typeof storedPayload.eventType === 'string' ? storedPayload.eventType : 'replay',
    eventId: `${originalJobId}:replay`,
    correlationId,
    payloadVersion:
      typeof storedPayload.payloadVersion === 'number' ? storedPayload.payloadVersion : 1,
    payload: {
      ...storedPayload,
      originalJobId,
      replayedDlqId: row.id,
      ...(input.actorUserId ? { replayedBy: input.actorUserId } : {}),
    },
  };

  const added = await queue.add(payload, { jobId: replayJobId });
  if (!added.accepted) throw new Error('dlq_replay_not_enqueued');
  workerMetrics.increment('dlq_replay_enqueued_total');

  // The new job id makes the old dedupe row irrelevant; drop it so a future
  // replay of the same event is not reported as already processed.
  await workerTenantTransaction(db, input.tenantId, `dlq:replay:${input.dlqId}`, (tx) =>
    tx.execute(
      sql`delete from processed_jobs where job_id = ${originalJobId} and tenant_id = ${input.tenantId}::uuid`,
    ),
  );

  await workerTenantTransaction(db, input.tenantId, `dlq:replay:${input.dlqId}`, (tx) =>
    tx.execute(
      sql`update dlq_jobs
          set status = 'replayed', replay_count = replay_count + 1,
              last_replayed_at = now(), last_replay_correlation_id = ${correlationId},
              updated_at = now()
          where id = ${row.id}::uuid`,
    ),
  );

  metrics.recordDlqReplay(row.queue);

  return {
    jobId: replayJobId,
    originalJobId,
    queue: row.queue,
    correlationId,
    accepted: added.accepted,
  };
}

export async function discardDlq(
  db: DatabaseHandle,
  input: { tenantId: string; dlqId: string },
): Promise<void> {
  await workerTenantTransaction(db, input.tenantId, `dlq:discard:${input.dlqId}`, (tx) =>
    tx.execute(sql`
      update dlq_jobs set status = 'discarded', updated_at = now()
      where id = ${input.dlqId}::uuid and tenant_id = ${input.tenantId}::uuid
    `),
  );
}
