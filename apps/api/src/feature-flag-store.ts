import { createDatabase, withTenantTransaction, sql } from '@platform/db';
import type { TenantRepositoryContext } from '@platform/db';

export interface FlagRecord extends Record<string, unknown> {
  tenantId: string;
  flag: string;
  enabled: boolean;
  payload: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
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
    _updatedBy?: string,
  ): Promise<FlagRecord> {
    void _updatedBy;
    if (!/^[a-z0-9_]{3,64}$/.test(flag)) throw new Error('flag_name_invalid');
    if (!this.store.has(context.tenantId)) this.store.set(context.tenantId, new Map());
    const rec: FlagRecord = {
      tenantId: context.tenantId,
      flag,
      enabled,
      payload,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
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
  constructor(
    private connectionString: string,
    private role: string = 'platform_app',
  ) {}

  static fromConnectionString(
    connectionString: string,
    role = 'platform_app',
  ): PersistentFeatureFlagStore {
    return new PersistentFeatureFlagStore(connectionString, role);
  }

  async list(context: TenantRepositoryContext): Promise<FlagRecord[]> {
    const db = createDatabase(this.connectionString, { role: this.role });
    try {
      const rows = await withTenantTransaction(db, context, async (tx) =>
        tx.execute<FlagRecord>(
          sql`select tenant_id as "tenantId", flag, enabled, payload::text as payload_raw, updated_at as "updatedAt", created_at as "createdAt" from tenant_feature_flags where tenant_id = ${context.tenantId}::uuid order by flag`,
        ),
      );
      // payload is jsonb -> text, parse
      return rows.map((r: unknown) => {
        const rec = r as FlagRecord & { payload_raw?: string };
        let payload: Record<string, unknown> = {};
        try {
          payload = rec.payload_raw ? JSON.parse(rec.payload_raw) : {};
        } catch (_e) {
          void _e;
          payload = {};
        }
        return {
          tenantId: rec.tenantId,
          flag: rec.flag,
          enabled: rec.enabled,
          payload,
          updatedAt: rec.updatedAt,
          createdAt: rec.createdAt,
        };
      });
    } finally {
      await db.close();
    }
  }

  async get(context: TenantRepositoryContext, flag: string): Promise<FlagRecord | null> {
    const db = createDatabase(this.connectionString, { role: this.role });
    try {
      const rows = await withTenantTransaction(db, context, async (tx) =>
        tx.execute<FlagRecord>(
          sql`select tenant_id as "tenantId", flag, enabled, payload::text as payload_raw, updated_at as "updatedAt", created_at as "createdAt" from tenant_feature_flags where tenant_id = ${context.tenantId}::uuid and flag = ${flag} limit 1`,
        ),
      );
      if (rows.length === 0) return null;
      const rec = rows[0] as unknown as FlagRecord & { payload_raw: string };
      let payload: Record<string, unknown> = {};
      try {
        payload = rec.payload_raw ? JSON.parse(rec.payload_raw) : {};
      } catch (_e) {
        void _e;
      }
      return {
        tenantId: rec.tenantId,
        flag: rec.flag,
        enabled: rec.enabled,
        payload,
        updatedAt: rec.updatedAt,
        createdAt: rec.createdAt,
      };
    } finally {
      await db.close();
    }
  }

  async set(
    context: TenantRepositoryContext,
    flag: string,
    enabled: boolean,
    payload: Record<string, unknown> = {},
    _updatedBy?: string,
  ): Promise<FlagRecord> {
    void _updatedBy;
    if (!/^[a-z0-9_]{3,64}$/.test(flag)) throw new Error('flag_name_invalid');
    const db = createDatabase(this.connectionString, { role: this.role });
    try {
      const rows = await withTenantTransaction(db, context, async (tx) => {
        const res = await tx.execute<FlagRecord>(sql`
          insert into tenant_feature_flags (tenant_id, flag, enabled, payload, updated_by)
          values (${context.tenantId}::uuid, ${flag}, ${enabled}, ${JSON.stringify(payload)}::jsonb, ${context.userId ?? null}::uuid)
          on conflict (tenant_id, flag) do update set enabled = excluded.enabled, payload = excluded.payload, updated_at = now(), updated_by = excluded.updated_by
          returning tenant_id as "tenantId", flag, enabled, payload::text as payload_raw, updated_at as "updatedAt", created_at as "createdAt"
        `);
        return res;
      });
      const rec = rows[0] as unknown as FlagRecord & { payload_raw: string };
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = rec.payload_raw ? JSON.parse(rec.payload_raw) : payload;
      } catch (_e) {
        void _e;
      }
      return {
        tenantId: rec.tenantId,
        flag: rec.flag,
        enabled: rec.enabled,
        payload: parsedPayload,
        updatedAt: rec.updatedAt,
        createdAt: rec.createdAt,
      };
    } finally {
      await db.close();
    }
  }

  async isEnabled(context: TenantRepositoryContext, flag: string): Promise<boolean> {
    const rec = await this.get(context, flag);
    return rec?.enabled ?? false;
  }
}
