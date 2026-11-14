import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from '@platform/db';
import {
  createDatabase,
  withTenantTransaction,
  type DatabaseExecutor,
  type DatabaseHandle,
} from '@platform/db';
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
  lastUsedAt: number | null;
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

const MAX_PREFIX_ATTEMPTS = 5;

/** Cursor is the last (createdAt, id) pair, base64url-encoded. */
function encodeApiKeyCursor(record: ApiKeyRecord): string {
  return Buffer.from(`${record.createdAt}|${record.id}`).toString('base64url');
}

function decodeApiKeyCursor(cursor: string | undefined): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [rawCreatedAt, id] = decoded.split('|');
    if (!rawCreatedAt || !id) return null;
    const createdAt = Number(rawCreatedAt);
    if (!Number.isFinite(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function isApiKeyCursorAfter(
  record: ApiKeyRecord,
  cursor: { createdAt: number; id: string },
): boolean {
  return (
    record.createdAt < cursor.createdAt ||
    (record.createdAt === cursor.createdAt && record.id < cursor.id)
  );
}

/**
 * Prefixes are the lookup key and are globally unique. They are short, so a
 * collision is expected at scale; retry instead of failing the request.
 */
export function generateUniqueApiKey(
  isTaken: (prefix: string) => boolean,
  attempts = MAX_PREFIX_ATTEMPTS,
): { raw: string; prefix: string; hash: string } {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const generated = generateApiKey();
    if (!isTaken(generated.prefix)) return generated;
  }
  throw new Error('prefix_collision');
}

function hashesMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export interface ApiKeyListOptions {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ApiKeyStore {
  create(
    context: StoreTenantContext,
    input: CreateApiKeyInput,
  ): Promise<{ record: ApiKeyRecord; raw: string }>;
  list(
    context: StoreTenantContext,
    options?: ApiKeyListOptions,
  ): Promise<{ items: ApiKeyRecord[]; nextCursor: string | null }>;
  revoke(context: StoreTenantContext, id: string): Promise<void>;
  verify(prefix: string, raw: string, tenantId?: string): Promise<ApiKeyRecord | null>;
  rotate(context: StoreTenantContext, id: string): Promise<{ record: ApiKeyRecord; raw: string }>;
  close?(): Promise<void>;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly rawById = new Map<string, string>();
  private readonly hashByPrefix = new Map<string, string>();

  private generateUniquePrefix(): { raw: string; prefix: string; hash: string } {
    return generateUniqueApiKey((prefix) => this.hashByPrefix.has(prefix));
  }

  async create(
    context: StoreTenantContext,
    input: CreateApiKeyInput,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    validateScopes(input.scopes);
    if (input.name.length < 1 || input.name.length > 100) throw new Error('name_invalid');
    const { raw, prefix, hash } = this.generateUniquePrefix();
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
      lastUsedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.keys.set(record.id, record);
    this.rawById.set(record.id, raw);
    this.hashByPrefix.set(prefix, hash);
    return { record, raw };
  }

  async list(
    context: StoreTenantContext,
    options: ApiKeyListOptions = {},
  ): Promise<{ items: ApiKeyRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = decodeApiKeyCursor(options.cursor);
    const keys = [...this.keys.values()]
      .filter((key) => key.tenantId === context.tenantId && !key.revokedAt)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt - a.createdAt,
      )
      .filter((key) => (cursor ? isApiKeyCursorAfter(key, cursor) : true));
    const items = keys.slice(0, limit);
    const nextCursor =
      keys.length > limit && items.length > 0 ? encodeApiKeyCursor(items[items.length - 1]!) : null;
    return { items, nextCursor };
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
    const { raw, prefix, hash } = this.generateUniquePrefix();
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
      lastUsedAt: null,
      createdBy: context.userId ?? existing.createdBy,
      createdAt: now,
    };
    this.keys.set(record.id, record);
    this.rawById.set(record.id, raw);
    this.hashByPrefix.set(prefix, hash);
    return { record, raw };
  }

  async verify(prefix: string, raw: string, tenantId?: string): Promise<ApiKeyRecord | null> {
    const hash = createHash('sha256').update(raw).digest('hex');
    for (const k of this.keys.values()) {
      if (
        k.prefix === prefix &&
        (!tenantId || k.tenantId === tenantId) &&
        hashesMatch(k.hash, hash) &&
        !k.revokedAt &&
        (!k.expiresAt || k.expiresAt > Date.now())
      ) {
        k.lastUsedAt = Date.now();
        this.keys.set(k.id, k);
        return k;
      }
    }
    return null;
  }

  getRaw(id: string): string | undefined {
    return this.rawById.get(id);
  }
}

interface ApiKeyRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  prefix: string;
  hash: string;
  scopes: string;
  name: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_by: string;
  created_at: string;
}

const API_KEY_COLUMNS = `id, tenant_id, prefix, hash, scopes::text as scopes, name, expires_at, revoked_at, last_used_at, created_by, created_at`;

function mapApiKeyRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    prefix: row.prefix,
    hash: row.hash,
    scopes: JSON.parse(row.scopes) as string[],
    name: row.name,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/**
 * Pick a prefix that is not present in the global unique index. Checking before
 * the insert avoids aborting the transaction on the rare 23505 (a failed INSERT
 * poisons the rest of the transaction, so it cannot be retried in place).
 */
async function reserveUniquePrefix(
  tx: DatabaseExecutor,
): Promise<{ raw: string; prefix: string; hash: string }> {
  for (let attempt = 0; attempt < MAX_PREFIX_ATTEMPTS; attempt += 1) {
    const generated = generateApiKey();
    const rows = await tx.execute<{ exists: boolean }>(sql`
      select exists(select 1 from api_keys where prefix = ${generated.prefix}) as exists
    `);
    if (!rows[0]?.exists) return generated;
  }
  throw new Error('prefix_collision');
}

export class PersistentApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  static fromConnectionString(cs: string, role = 'platform_app'): PersistentApiKeyStore {
    return new PersistentApiKeyStore(createDatabase(cs, { role }));
  }

  async create(
    context: StoreTenantContext,
    input: CreateApiKeyInput,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    validateScopes(input.scopes);
    const scopesJson = JSON.stringify(input.scopes);
    const expiresAt = input.expiresInMs
      ? new Date(Date.now() + input.expiresInMs).toISOString()
      : null;
    return withTenantTransaction(this.db, context, async (tx) => {
      const generated = await reserveUniquePrefix(tx);
      const rows = await tx.execute<ApiKeyRow>(sql`
        insert into api_keys (tenant_id, prefix, hash, scopes, name, expires_at, created_by)
        values (${context.tenantId}::uuid, ${generated.prefix}, ${generated.hash}, ${scopesJson}::jsonb, ${input.name}, ${expiresAt}::timestamptz, ${input.createdBy}::uuid)
        returning ${sql.raw(API_KEY_COLUMNS)}
      `);
      const row = rows[0];
      if (!row) throw new Error('api_key_create_failed');
      return { record: mapApiKeyRow(row), raw: generated.raw };
    });
  }

  async list(
    context: StoreTenantContext,
    options: ApiKeyListOptions = {},
  ): Promise<{ items: ApiKeyRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = decodeApiKeyCursor(options.cursor);
    let cursorCreatedAt: string | null = null;
    if (cursor) cursorCreatedAt = new Date(cursor.createdAt).toISOString();
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<ApiKeyRow>(sql`
        select ${sql.raw(API_KEY_COLUMNS)}
        from api_keys
        where tenant_id=${context.tenantId}::uuid
          and revoked_at is null
          and (
            ${cursorCreatedAt}::timestamptz is null
            or (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursor?.id ?? null}::uuid)
          )
        order by created_at desc, id desc
        limit ${limit + 1}
      `);
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(mapApiKeyRow);
      const nextCursor =
        hasMore && items.length > 0 ? encodeApiKeyCursor(items[items.length - 1]!) : null;
      return { items, nextCursor };
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

  async verify(prefix: string, raw: string, tenantId?: string): Promise<ApiKeyRecord | null> {
    if (!tenantId) return null;
    const hash = createHash('sha256').update(raw).digest('hex');
    return withTenantTransaction(this.db, { tenantId, requestId: 'api-key-verify' }, async (tx) => {
      const rows = await tx.execute<ApiKeyRow>(sql`
        select ${sql.raw(API_KEY_COLUMNS)}
        from api_keys
        where tenant_id=${tenantId}::uuid and prefix=${prefix} and revoked_at is null
        limit 1
      `);
      const row = rows[0];
      if (!row || !hashesMatch(row.hash, hash)) return null;
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
      const used = await tx.execute<{ last_used_at: string }>(sql`
        update api_keys set last_used_at = now(), updated_at = now()
        where id = ${row.id}::uuid and tenant_id = ${tenantId}::uuid
        returning last_used_at
      `);
      return mapApiKeyRow({ ...row, last_used_at: used[0]?.last_used_at ?? null });
    });
  }

  async rotate(
    context: StoreTenantContext,
    id: string,
  ): Promise<{ record: ApiKeyRecord; raw: string }> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<ApiKeyRow>(sql`
        select ${sql.raw(API_KEY_COLUMNS)}
        from api_keys
        where id=${id}::uuid and tenant_id=${context.tenantId}::uuid for update
      `);
      const existing = rows[0];
      if (!existing || existing.revoked_at) throw new Error('api_key_not_found');
      const generated = await reserveUniquePrefix(tx);
      await tx.execute(
        sql`update api_keys set revoked_at=now(), updated_at=now() where id=${id}::uuid`,
      );
      const newId = randomUUID();
      const newRows = await tx.execute<ApiKeyRow>(sql`
        insert into api_keys (id, tenant_id, prefix, hash, scopes, name, expires_at, created_by)
        values (${newId}::uuid, ${context.tenantId}::uuid, ${generated.prefix}, ${generated.hash}, ${existing.scopes}::jsonb, ${existing.name}, ${existing.expires_at}::timestamptz, ${context.userId ?? existing.created_by}::uuid)
        returning ${sql.raw(API_KEY_COLUMNS)}
      `);
      const row = newRows[0];
      if (!row) throw new Error('api_key_rotate_failed');
      return { record: mapApiKeyRow(row), raw: generated.raw };
    });
  }
}
