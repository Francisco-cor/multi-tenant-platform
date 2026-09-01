import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import type { QueueFactory } from './queues.js';

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
  const rows = await db.db.execute<{
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
    select id, job_id, tenant_id, queue, payload, cause, attempts, status, created_at
    from dlq_jobs
    where tenant_id = ${tenantId}::uuid
    order by created_at desc
    limit ${limit}
  `);
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

export async function replayDlq(
  db: DatabaseHandle,
  queueFactory: QueueFactory,
  input: { tenantId: string; dlqId: string; actorUserId?: string },
): Promise<{ jobId: string; queue: string }> {
  const rows = await db.db.execute<{
    id: string;
    job_id: string;
    tenant_id: string;
    queue: string;
    payload: string;
    cause: string;
    attempts: number;
  }>(sql`
    select id, job_id, tenant_id, queue, payload, cause, attempts
    from dlq_jobs
    where id = ${input.dlqId}::uuid and tenant_id = ${input.tenantId}::uuid
    limit 1
  `);
  const row = rows[0];
  if (!row) throw new Error('dlq_not_found');

  const payload = row.payload ? JSON.parse(row.payload) : {};
  // For replay, we create a new jobId with a suffix to avoid collision with dedup, or reuse same jobId but clear processed_jobs?
  // We'll reuse same jobId but first delete processed_jobs entry if exists, and mark dlq as replayed.
  const queueName = row.queue as Parameters<QueueFactory['getQueue']>[0];
  const queue = queueFactory.getQueue(queueName);

  // Clear dedup so replay can re-run
  await db.db.execute(
    sql`delete from processed_jobs where job_id = ${row.job_id} and tenant_id = ${input.tenantId}::uuid`,
  );

  // Mark dlq as replayed
  await db.db.execute(
    sql`update dlq_jobs set status = 'replayed', updated_at = now() where id = ${row.id}::uuid`,
  );

  // Also reset originating outbox if it was dead_letter (optional)
  // Find outbox by id == job's eventId? For simplicity we don't link; replay just re-queues payload.
  await queue.add(
    {
      tenantId: row.tenant_id,
      aggregateId: (payload as { aggregateId?: string }).aggregateId ?? row.job_id,
      aggregateType: (payload as { aggregateType?: string }).aggregateType ?? 'generic',
      eventType: (payload as { eventType?: string }).eventType ?? 'replay',
      eventId: row.job_id,
      payload,
    },
    { jobId: row.job_id },
  );

  return { jobId: row.job_id, queue: row.queue };
}

export async function discardDlq(
  db: DatabaseHandle,
  input: { tenantId: string; dlqId: string },
): Promise<void> {
  await db.db.execute(sql`
    update dlq_jobs set status = 'discarded', updated_at = now()
    where id = ${input.dlqId}::uuid and tenant_id = ${input.tenantId}::uuid
  `);
}
