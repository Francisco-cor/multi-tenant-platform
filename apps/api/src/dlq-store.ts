import { sql, writeOutboxEvent } from '@platform/db';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from '@platform/db';
import { metrics } from '@platform/observability';
import type { StoreTenantContext } from './identity-store.js';

export interface DlqRecordApi {
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

export interface DlqStore {
  list(context: StoreTenantContext, limit?: number): Promise<DlqRecordApi[]>;
  get(context: StoreTenantContext, id: string): Promise<DlqRecordApi | null>;
  replay(context: StoreTenantContext, id: string): Promise<{ jobId: string }>;
  discard(context: StoreTenantContext, id: string): Promise<void>;
  // test helper
  insertForTest(record: Omit<DlqRecordApi, 'createdAt'> & { createdAt?: number }): Promise<void>;
  close?(): Promise<void>;
}

interface DlqRow {
  [key: string]: unknown;
  id: string;
  job_id: string;
  tenant_id: string;
  queue: string;
  payload: string;
  cause: string;
  attempts: number;
  status: string;
  created_at: string;
}

function mapRow(r: DlqRow): DlqRecordApi {
  return {
    id: r.id,
    jobId: r.job_id,
    tenantId: r.tenant_id,
    queue: r.queue,
    payload: r.payload ? JSON.parse(r.payload) : {},
    cause: r.cause,
    attempts: r.attempts,
    status: r.status,
    createdAt: new Date(r.created_at).getTime(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTBOX_AGGREGATE_TYPES = new Set([
  'file',
  'inventory',
  'order',
  'payment',
  'generic',
  'membership',
  'branch',
  'webhook',
]);

export class InMemoryDlqStore implements DlqStore {
  private readonly map = new Map<string, DlqRecordApi>();

  async list(context: StoreTenantContext, limit = 25): Promise<DlqRecordApi[]> {
    return [...this.map.values()]
      .filter((r) => r.tenantId === context.tenantId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async get(context: StoreTenantContext, id: string): Promise<DlqRecordApi | null> {
    const r = this.map.get(id);
    if (!r || r.tenantId !== context.tenantId) return null;
    return r;
  }

  async replay(context: StoreTenantContext, id: string): Promise<{ jobId: string }> {
    const r = this.map.get(id);
    if (!r || r.tenantId !== context.tenantId) throw new Error('dlq_not_found');
    if (r.status !== 'pending') throw new Error('dlq_state_conflict');
    r.status = 'replayed';
    this.map.set(id, r);
    metrics.recordDlqReplay(r.queue);
    return { jobId: r.jobId };
  }

  async discard(context: StoreTenantContext, id: string): Promise<void> {
    const r = this.map.get(id);
    if (!r || r.tenantId !== context.tenantId) throw new Error('dlq_not_found');
    if (r.status !== 'pending') throw new Error('dlq_state_conflict');
    r.status = 'discarded';
    this.map.set(id, r);
  }

  async insertForTest(
    record: Omit<DlqRecordApi, 'createdAt'> & { createdAt?: number },
  ): Promise<void> {
    const rec: DlqRecordApi = { ...record, createdAt: record.createdAt ?? Date.now() };
    this.map.set(rec.id, rec);
  }
}

/**
 * DLQ access is tenant-scoped through RLS. Every statement runs inside
 * `withTenantTransaction`; an unscoped pool would either bypass RLS (owner) or
 * fail (platform_app). Replay/discard are single transactions with a status
 * guard so concurrent operators cannot replay the same job twice.
 */
export class PersistentDlqStore implements DlqStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  static fromConnectionString(cs: string, role = 'platform_app'): PersistentDlqStore {
    return new PersistentDlqStore(createDatabase(cs, { role }));
  }

  async list(context: StoreTenantContext, limit = 25): Promise<DlqRecordApi[]> {
    const bounded = Math.min(Math.max(limit, 1), 100);
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<DlqRow>(sql`
        select id, job_id, tenant_id, queue, payload::text as payload, cause, attempts, status, created_at
        from dlq_jobs
        where tenant_id = ${context.tenantId}::uuid
        order by created_at desc
        limit ${bounded}
      `);
      return rows.map(mapRow);
    });
  }

  async get(context: StoreTenantContext, id: string): Promise<DlqRecordApi | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<DlqRow>(sql`
        select id, job_id, tenant_id, queue, payload::text as payload, cause, attempts, status, created_at
        from dlq_jobs
        where id = ${id}::uuid and tenant_id = ${context.tenantId}::uuid
        limit 1
      `);
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }

  async replay(context: StoreTenantContext, id: string): Promise<{ jobId: string }> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<DlqRow & { replay_count: number }>(sql`
        update dlq_jobs
        set status = 'replayed',
            replay_count = replay_count + 1,
            last_replayed_at = now(),
            last_replay_correlation_id = ${context.requestId},
            updated_at = now()
        where id = ${id}::uuid
          and tenant_id = ${context.tenantId}::uuid
          and status = 'pending'
        returning id, job_id, tenant_id, queue, payload::text as payload, cause, attempts, status, created_at, replay_count
      `);
      const row = rows[0];
      if (!row) {
        const existing = await tx.execute<{ status: string }>(sql`
          select status from dlq_jobs
          where id = ${id}::uuid and tenant_id = ${context.tenantId}::uuid
          limit 1
        `);
        if (!existing[0]) throw new Error('dlq_not_found');
        throw new Error('dlq_state_conflict');
      }
      const rec = mapRow(row);

      // The original job's dedupe record must be cleared inside the same
      // transaction, otherwise the re-enqueued job is skipped as processed.
      await tx.execute(sql`
        delete from processed_jobs
        where job_id = ${rec.jobId} and tenant_id = ${context.tenantId}::uuid
      `);

      const payload =
        rec.payload && typeof rec.payload === 'object'
          ? (rec.payload as Record<string, unknown>)
          : {};
      const aggregateId =
        typeof payload.aggregateId === 'string' && UUID_RE.test(payload.aggregateId)
          ? payload.aggregateId
          : rec.id;
      const aggregateType =
        typeof payload.aggregateType === 'string' &&
        OUTBOX_AGGREGATE_TYPES.has(payload.aggregateType)
          ? payload.aggregateType
          : 'generic';
      const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'dlq.replayed';
      await writeOutboxEvent(tx, {
        tenantId: context.tenantId,
        aggregateType,
        aggregateId,
        eventType,
        payload: { ...payload, dlqId: rec.id, replayedJobId: rec.jobId },
        correlationId: context.requestId,
        dedupeKey: `dlq-replay:${rec.id}:${String(row.replay_count)}`,
      });
      metrics.recordDlqReplay(rec.queue);
      return { jobId: rec.jobId };
    });
  }

  async discard(context: StoreTenantContext, id: string): Promise<void> {
    await withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        update dlq_jobs
        set status = 'discarded', updated_at = now()
        where id = ${id}::uuid
          and tenant_id = ${context.tenantId}::uuid
          and status = 'pending'
        returning id
      `);
      if (rows.length > 0) return;
      const existing = await tx.execute<{ status: string }>(sql`
        select status from dlq_jobs
        where id = ${id}::uuid and tenant_id = ${context.tenantId}::uuid
        limit 1
      `);
      if (!existing[0]) throw new Error('dlq_not_found');
      throw new Error('dlq_state_conflict');
    });
  }

  async insertForTest(
    record: Omit<DlqRecordApi, 'createdAt'> & { createdAt?: number },
  ): Promise<void> {
    await withTenantTransaction(
      this.db,
      { tenantId: record.tenantId, requestId: `dlq-test-${record.id}` },
      async (tx) => {
        await tx.execute(sql`
          insert into dlq_jobs (id, job_id, tenant_id, queue, payload, cause, attempts, status)
          values (${record.id}::uuid, ${record.jobId}, ${record.tenantId}::uuid, ${record.queue}, ${JSON.stringify(record.payload)}::jsonb, ${record.cause}, ${record.attempts}, ${record.status})
        `);
      },
    );
  }
}
