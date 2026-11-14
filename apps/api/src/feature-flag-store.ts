import { createDatabase, withTenantTransaction, sql } from '@platform/db';
import type { DatabaseHandle, TenantRepositoryContext } from '@platform/db';

export interface FlagRecord extends Record<string, unknown> {
  tenantId: string;
  flag: string;
  enabled: boolean;
  payload: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
  updatedBy?: string | null;
}

export interface FeatureFlagStore {
  list(context: TenantRepositoryContext): Promise<FlagRecord[]>;
  get(context: TenantRepositoryContext, flag: string): Promise<FlagRecord | null>;
  set(
    context: TenantRepositoryContext,
    flag: string,
    enabled: boolean,
    payload?: Record<string, unknown>,
    updatedBy?: string,
  ): Promise<FlagRecord>;
  isEnabled(context: TenantRepositoryContext, flag: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class InMemoryFeatureFlagStore implements FeatureFlagStore {
  private store = new Map<string, Map<string, FlagRecord>>(); // tenantId -> flag -> record

  async list(context: TenantRepositoryContext): Promise<FlagRecord[]> {
    const m = this.store.get(context.tenantId);
    return m ? [...m.values()] : [];
  }

  async get(context: TenantRepositoryContext, flag: string): Promise<FlagRecord | null> {
    const m = this.store.get(context.tenantId);
    return m?.get(flag) ?? null;
  }

  async set(
    context: TenantRepositoryContext,
    flag: string,
    enabled: boolean,
    payload: Record<string, unknown> = {},
    updatedBy?: string,
  ): Promise<FlagRecord> {
    if (!/^[a-z0-9_]{3,64}$/.test(flag)) throw new Error('flag_name_invalid');
    if (!this.store.has(context.tenantId)) this.store.set(context.tenantId, new Map());
    const existing = this.store.get(context.tenantId)!.get(flag);
    const now = new Date().toISOString();
    const rec: FlagRecord = {
      tenantId: context.tenantId,
      flag,
      enabled,
      payload,
      // A flag's creation time is immutable; the previous implementation reset
      // it on every update, so `createdAt === updatedAt` told operators nothing.
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: updatedBy ?? context.userId ?? existing?.updatedBy ?? null,
    };
    this.store.get(context.tenantId)!.set(flag, rec);
    return rec;
  }

  async isEnabled(context: TenantRepositoryContext, flag: string): Promise<boolean> {
    const r = await this.get(context, flag);
    return r?.enabled ?? false;
  }
}

export class PersistentFeatureFlagStore implements FeatureFlagStore {
  private readonly db: DatabaseHandle;

  constructor(connectionStringOrHandle: string | DatabaseHandle, role: string = 'platform_app') {
    this.db =
      typeof connectionStringOrHandle === 'string'
        ? createDatabase(connectionStringOrHandle, { role })
        : connectionStringOrHandle;
    if (!this.db.role) throw new Error('database_role_required');
  }

  static fromConnectionString(
    connectionString: string,
    role = 'platform_app',
  ): PersistentFeatureFlagStore {
    return new PersistentFeatureFlagStore(connectionString, role);
  }

  private mapRow(row: FlagRecord & { payload_raw?: string }): FlagRecord {
    let payload: Record<string, unknown> = {};
    try {
      payload = row.payload_raw ? JSON.parse(row.payload_raw) : {};
    } catch {
      payload = {};
    }
    return {
      tenantId: row.tenantId,
      flag: row.flag,
      enabled: row.enabled,
      payload,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      updatedBy: row.updatedBy ?? null,
    };
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async list(context: TenantRepositoryContext): Promise<FlagRecord[]> {
    const rows = await withTenantTransaction(this.db, context, async (tx) =>
      tx.execute<FlagRecord & { payload_raw?: string }>(
        sql`select tenant_id as "tenantId", flag, enabled, payload::text as payload_raw, updated_at as "updatedAt", created_at as "createdAt", updated_by as "updatedBy" from tenant_feature_flags where tenant_id = ${context.tenantId}::uuid order by flag`,
      ),
    );
    return rows.map((row) => this.mapRow(row));
  }

  async get(context: TenantRepositoryContext, flag: string): Promise<FlagRecord | null> {
    const rows = await withTenantTransaction(this.db, context, async (tx) =>
      tx.execute<FlagRecord & { payload_raw?: string }>(
        sql`select tenant_id as "tenantId", flag, enabled, payload::text as payload_raw, updated_at as "updatedAt", created_at as "createdAt", updated_by as "updatedBy" from tenant_feature_flags where tenant_id = ${context.tenantId}::uuid and flag = ${flag} limit 1`,
      ),
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async set(
    context: TenantRepositoryContext,
    flag: string,
    enabled: boolean,
    payload: Record<string, unknown> = {},
    updatedBy?: string,
  ): Promise<FlagRecord> {
    if (!/^[a-z0-9_]{3,64}$/.test(flag)) throw new Error('flag_name_invalid');
    const rows = await withTenantTransaction(this.db, context, async (tx) =>
      tx.execute<FlagRecord & { payload_raw?: string }>(sql`
        insert into tenant_feature_flags (tenant_id, flag, enabled, payload, updated_by)
        values (${context.tenantId}::uuid, ${flag}, ${enabled}, ${JSON.stringify(payload)}::jsonb, ${updatedBy ?? context.userId ?? null}::uuid)
        on conflict (tenant_id, flag) do update set enabled = excluded.enabled, payload = excluded.payload, updated_at = now(), updated_by = excluded.updated_by
        returning tenant_id as "tenantId", flag, enabled, payload::text as payload_raw, updated_at as "updatedAt", created_at as "createdAt", updated_by as "updatedBy"
      `),
    );
    const row = rows[0];
    if (!row) throw new Error('flag_update_failed');
    return this.mapRow(row);
  }

  async isEnabled(context: TenantRepositoryContext, flag: string): Promise<boolean> {
    const rec = await this.get(context, flag);
    return rec?.enabled ?? false;
  }
}
