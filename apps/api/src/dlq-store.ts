import { sql } from '@platform/db';
import { createDatabase, type DatabaseHandle } from '@platform/db';
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
}

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
    r.status = 'replayed';
    this.map.set(id, r);
    return { jobId: r.jobId };
  }

  async discard(context: StoreTenantContext, id: string): Promise<void> {
    const r = this.map.get(id);
    if (!r || r.tenantId !== context.tenantId) throw new Error('dlq_not_found');
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

export class PersistentDlqStore implements DlqStore {
  constructor(private readonly db: DatabaseHandle) {}

  static fromConnectionString(cs: string, role = 'platform_app'): PersistentDlqStore {
    return new PersistentDlqStore(createDatabase(cs, { role }));
  }

  async list(context: StoreTenantContext, limit = 25): Promise<DlqRecordApi[]> {
    const rows = await this.db.db.execute<{
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
      where tenant_id = ${context.tenantId}::uuid
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

  async get(context: StoreTenantContext, id: string): Promise<DlqRecordApi | null> {
    const rows = await this.db.db.execute<{
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
      where id = ${id}::uuid and tenant_id = ${context.tenantId}::uuid
      limit 1
    `);
    const r = rows[0];
    if (!r) return null;
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

  async replay(context: StoreTenantContext, id: string): Promise<{ jobId: string }> {
    const rec = await this.get(context, id);
    if (!rec) throw new Error('dlq_not_found');
    // Mark replayed and clear dedupe so job can be retried
    await this.db.db.execute(
      sql`update dlq_jobs set status='replayed', updated_at=now() where id=${id}::uuid and tenant_id=${context.tenantId}::uuid`,
    );
    await this.db.db.execute(
      sql`delete from processed_jobs where job_id=${rec.jobId} and tenant_id=${context.tenantId}::uuid`,
    );
    // Re-enqueue as outbox pending (for simplicity insert new outbox event)
    // Find original payload to requeue; for now insert generic outbox if possible
    // If payload contains aggregate info, create outbox entry
    const payload = rec.payload as {
      aggregateId?: string;
      aggregateType?: string;
      eventType?: string;
    } | null;
    if (payload?.aggregateId && payload.aggregateType && payload.eventType) {
      await this.db.db.execute(sql`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
        values (${context.tenantId}::uuid, ${payload.aggregateType}, ${payload.aggregateId}::uuid, ${payload.eventType}, ${JSON.stringify(rec.payload)}::jsonb, ${context.requestId})
      `);
    }
    return { jobId: rec.jobId };
  }

  async discard(context: StoreTenantContext, id: string): Promise<void> {
    const rec = await this.get(context, id);
    if (!rec) throw new Error('dlq_not_found');
    await this.db.db.execute(
      sql`update dlq_jobs set status='discarded', updated_at=now() where id=${id}::uuid and tenant_id=${context.tenantId}::uuid`,
    );
  }

  async insertForTest(
    record: Omit<DlqRecordApi, 'createdAt'> & { createdAt?: number },
  ): Promise<void> {
    await this.db.db.execute(sql`
      insert into dlq_jobs (id, job_id, tenant_id, queue, payload, cause, attempts, status)
      values (${record.id}::uuid, ${record.jobId}, ${record.tenantId}::uuid, ${record.queue}, ${JSON.stringify(record.payload)}::jsonb, ${record.cause}, ${record.attempts}, ${record.status})
    `);
  }
}
