import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from '@platform/db';
import type { StoreTenantContext } from './identity-store.js';

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  prefix: string;
  hash: string;
  scopes: string[];
  name: string;
  expiresAt: number | null;
  revokedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  expiresInMs?: number | undefined;
  createdBy: string;
}

const VALID_SCOPES = new Set([
  'webhooks:read',
  'webhooks:manage',
  'orders:read',
  'orders:create',
  'inventory:read',
  'files:read',
  'files:upload',
  'audit:read',
  'automations:read',
  'automations:manage',
]);

export function validateScopes(scopes: string[]): void {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('scopes_required');
  for (const s of scopes) if (!VALID_SCOPES.has(s)) throw new Error(`scope_invalid:${s}`);
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `pk_${randomBytes(24).toString('base64url')}`;
  const prefix = raw.slice(0, 8);
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, prefix, hash };
}

export interface ApiKeyStore {
  create(
    context: StoreTenantContext,
    input: CreateApiKeyInput,
  ): Promise<{ record: ApiKeyRecord; raw: string }>;
  list(context: StoreTenantContext): Promise<ApiKeyRecord[]>;
  revoke(context: StoreTenantContext, id: string): Promise<void>;
  verify(prefix: string, raw: string): Promise<ApiKeyRecord | null>;
  rotate(context: StoreTenantContext, id: string): Promise<{ record: ApiKeyRecord; raw: string }>;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly rawById = new Map<string, string>();
  private readonly hashByPrefix = new Map<string, string>();

  async create(
    context: StoreTenantContext,
    input: CreateApiKeyInput,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    validateScopes(input.scopes);
    if (input.name.length < 1 || input.name.length > 100) throw new Error('name_invalid');
    const { raw, prefix, hash } = generateApiKey();
    if (this.hashByPrefix.has(prefix)) throw new Error('prefix_collision');
    const now = Date.now();
    const record: ApiKeyRecord = {
      id: randomUUID(),
      tenantId: context.tenantId,
      prefix,
      hash,
      scopes: [...input.scopes],
      name: input.name,
      expiresAt: input.expiresInMs ? now + input.expiresInMs : null,
      revokedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.keys.set(record.id, record);
    this.rawById.set(record.id, raw);
    this.hashByPrefix.set(prefix, hash);
    return { record, raw };
  }

  async list(context: StoreTenantContext): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()].filter((k) => k.tenantId === context.tenantId && !k.revokedAt);
  }

  async revoke(context: StoreTenantContext, id: string): Promise<void> {
    const k = this.keys.get(id);
    if (!k || k.tenantId !== context.tenantId) throw new Error('api_key_not_found');
    k.revokedAt = Date.now();
    this.keys.set(id, k);
  }

  async rotate(
    context: StoreTenantContext,
    id: string,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    const existing = this.keys.get(id);
    if (!existing || existing.tenantId !== context.tenantId) throw new Error('api_key_not_found');
    if (existing.revokedAt) throw new Error('api_key_not_found');
    const { raw, prefix, hash } = generateApiKey();
    if (this.hashByPrefix.has(prefix)) throw new Error('prefix_collision');
    // revoke old logically, create new with same name/scopes
    existing.revokedAt = Date.now();
    this.keys.set(id, existing);
    this.hashByPrefix.delete(existing.prefix);
    const now = Date.now();
    const record: ApiKeyRecord = {
      id: randomUUID(),
      tenantId: existing.tenantId,
      prefix,
      hash,
      scopes: [...existing.scopes],
      name: existing.name,
      expiresAt: existing.expiresAt,
      revokedAt: null,
      createdBy: context.userId ?? existing.createdBy,
      createdAt: now,
    };
    this.keys.set(record.id, record);
    this.rawById.set(record.id, raw);
    this.hashByPrefix.set(prefix, hash);
    return { record, raw };
  }

  async verify(prefix: string, raw: string): Promise<ApiKeyRecord | null> {
    const hash = createHash('sha256').update(raw).digest('hex');
    for (const k of this.keys.values()) {
      if (
        k.prefix === prefix &&
        k.hash === hash &&
        !k.revokedAt &&
        (!k.expiresAt || k.expiresAt > Date.now())
      )
        return k;
    }
    return null;
  }

  getRaw(id: string): string | undefined {
    return this.rawById.get(id);
  }
}

export class PersistentApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }
  static fromConnectionString(cs: string, role = 'platform_app'): PersistentApiKeyStore {
    return new PersistentApiKeyStore(createDatabase(cs, { role }));
  }
  async create(
    context: StoreTenantContext,
    input: CreateApiKeyInput,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    validateScopes(input.scopes);
    const { raw, prefix, hash } = generateApiKey();
    const scopesJson = JSON.stringify(input.scopes);
    const expiresAt = input.expiresInMs
      ? new Date(Date.now() + input.expiresInMs).toISOString()
      : null;
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        prefix: string;
        hash: string;
        scopes: string;
        name: string;
        expires_at: string | null;
        revoked_at: string | null;
        created_by: string;
        created_at: string;
      }>(sql`
        insert into api_keys (tenant_id, prefix, hash, scopes, name, expires_at, created_by)
        values (${context.tenantId}::uuid, ${prefix}, ${hash}, ${scopesJson}::jsonb, ${input.name}, ${expiresAt}::timestamptz, ${input.createdBy}::uuid)
        returning id, tenant_id, prefix, hash, scopes::text as scopes, name, expires_at, revoked_at, created_by, created_at
      `);
      const r = rows[0];
      if (!r) throw new Error('api_key_create_failed');
      const rec: ApiKeyRecord = {
        id: r.id,
        tenantId: r.tenant_id,
        prefix: r.prefix,
        hash: r.hash,
        scopes: JSON.parse(r.scopes),
        name: r.name,
        expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
        revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
        createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(),
      };
      return { record: rec, raw };
    });
  }
  async list(context: StoreTenantContext): Promise<ApiKeyRecord[]> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        prefix: string;
        hash: string;
        scopes: string;
        name: string;
        expires_at: string | null;
        revoked_at: string | null;
        created_by: string;
        created_at: string;
      }>(sql`
        select id, tenant_id, prefix, hash, scopes::text as scopes, name, expires_at, revoked_at, created_by, created_at from api_keys where tenant_id=${context.tenantId}::uuid and revoked_at is null order by created_at desc
      `);
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        prefix: r.prefix,
        hash: r.hash,
        scopes: JSON.parse(r.scopes),
        name: r.name,
        expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
        revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
        createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(),
      }));
    });
  }
  async revoke(context: StoreTenantContext, id: string): Promise<void> {
    await withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`update api_keys set revoked_at=now(), updated_at=now() where id=${id}::uuid and tenant_id=${context.tenantId}::uuid and revoked_at is null returning id`,
      );
      if (rows.length === 0) throw new Error('api_key_not_found');
    });
  }
  async verify(prefix: string, raw: string): Promise<ApiKeyRecord | null> {
    const hash = createHash('sha256').update(raw).digest('hex');
    // Need global lookup without tenant; we bypass RLS by using direct postgres without tenant config?
    // For demo we do tenant-agnostic search via raw sql with no RLS (superuser). Instead we query as platform_app but without tenant filter? RLS will block.
    // So we implement as application transaction scanning all keys (not RLS). Use withApplicationTransaction via direct db.
    // Simplify: use this.db.db (no set_config) to query
    const rows = await this.db.db.execute<{
      id: string;
      tenant_id: string;
      prefix: string;
      hash: string;
      scopes: string;
      name: string;
      expires_at: string | null;
      revoked_at: string | null;
      created_by: string;
      created_at: string;
    }>(sql`
      select id, tenant_id, prefix, hash, scopes::text as scopes, name, expires_at, revoked_at, created_by, created_at from api_keys where prefix=${prefix} and hash=${hash} and revoked_at is null limit 1
    `);
    const r = rows[0];
    if (!r) return null;
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      prefix: r.prefix,
      hash: r.hash,
      scopes: JSON.parse(r.scopes),
      name: r.name,
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
      revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).getTime(),
    };
  }

  async rotate(
    context: StoreTenantContext,
    id: string,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        prefix: string;
        hash: string;
        scopes: string;
        name: string;
        expires_at: string | null;
        revoked_at: string | null;
        created_by: string;
        created_at: string;
      }>(sql`
        select id, tenant_id, prefix, hash, scopes::text as scopes, name, expires_at, revoked_at, created_by, created_at from api_keys
        where id=${id}::uuid and tenant_id=${context.tenantId}::uuid for update
      `);
      const existing = rows[0];
      if (!existing || existing.revoked_at) throw new Error('api_key_not_found');
      const { raw, prefix, hash } = generateApiKey();
      // revoke old
      await tx.execute(
        sql`update api_keys set revoked_at=now(), updated_at=now() where id=${id}::uuid`,
      );
      const newId = randomUUID();
      const newRows = await tx.execute<{
        id: string;
        tenant_id: string;
        prefix: string;
        hash: string;
        scopes: string;
        name: string;
        expires_at: string | null;
        revoked_at: string | null;
        created_by: string;
        created_at: string;
      }>(sql`
        insert into api_keys (id, tenant_id, prefix, hash, scopes, name, expires_at, created_by)
        values (${newId}::uuid, ${context.tenantId}::uuid, ${prefix}, ${hash}, ${existing.scopes}::jsonb, ${existing.name}, ${existing.expires_at}::timestamptz, ${context.userId ?? existing.created_by}::uuid)
        returning id, tenant_id, prefix, hash, scopes::text as scopes, name, expires_at, revoked_at, created_by, created_at
      `);
      const r = newRows[0];
      if (!r) throw new Error('api_key_rotate_failed');
      return {
        record: {
          id: r.id,
          tenantId: r.tenant_id,
          prefix: r.prefix,
          hash: r.hash,
          scopes: JSON.parse(r.scopes),
          name: r.name,
          expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
          revokedAt: null,
          createdBy: r.created_by,
          createdAt: new Date(r.created_at).getTime(),
        },
        raw,
      };
    });
  }
}
