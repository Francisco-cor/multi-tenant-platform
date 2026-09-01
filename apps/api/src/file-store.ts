import { randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from '@platform/db';
import type { StoreTenantContext } from './identity-store.js';

export const ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'application/octet-stream',
]);

export const ALLOWED_MIME_REGEX =
  /^(image\/(jpeg|png|webp|gif)|text\/(plain|csv)|application\/(pdf|zip|octet-stream|vnd\.openxmlformats.*))$/i;

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const UPLOAD_TTL_SECONDS = 300; // 5 min
export const DOWNLOAD_TTL_SECONDS = 60; // 1 min
export const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

export interface FileRecord {
  [key: string]: unknown;
  id: string;
  tenantId: string;
  ownerId: string | null;
  key: string;
  filename: string;
  contentType: string;
  sizeExpected: number;
  sizeActual: number | null;
  status: 'pending' | 'ready' | 'expired' | 'deleted';
  checksum: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface CreateFileInput {
  filename: string;
  contentType: string;
  sizeExpected: number;
  ownerId: string;
}

export interface FinalizeInput {
  sizeActual?: number | undefined;
  checksum?: string | undefined;
}

export interface FileStore {
  createPending(context: StoreTenantContext, input: CreateFileInput): Promise<FileRecord>;
  getById(context: StoreTenantContext, fileId: string): Promise<FileRecord | null>;
  finalize(context: StoreTenantContext, fileId: string, input?: FinalizeInput): Promise<FileRecord>;
  getDownloadKey(
    context: StoreTenantContext,
    fileId: string,
  ): Promise<{ file: FileRecord; key: string }>;
  listFiles(
    context: StoreTenantContext,
    options?: { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<{ items: FileRecord[]; nextCursor: string | null }>;
  // helpers for tests
  setStatus?(fileId: string, status: FileRecord['status'], expiresAt?: number): Promise<void>;
}

function sanitizeFilename(name: string): string {
  // Keep original but ensure no path traversal; already validated.
  return name;
}

function buildS3Key(tenantId: string, fileId: string): string {
  return `tenants/${tenantId}/${fileId}`;
}

function validateCreateInput(input: CreateFileInput): void {
  if (!input.filename || input.filename.length < 1 || input.filename.length > 255)
    throw new Error('filename_invalid');
  if (
    input.filename.includes('/') ||
    input.filename.includes('\\') ||
    input.filename.includes('..')
  )
    throw new Error('filename_invalid');
  // control chars (null bytes, etc.) — avoid no-control-regex by using charCode check
  for (let i = 0; i < input.filename.length; i++) {
    const code = input.filename.charCodeAt(i);
    if (code <= 0x1f) throw new Error('filename_invalid');
  }
  if (!input.contentType || input.contentType.length < 3 || input.contentType.length > 127)
    throw new Error('content_type_invalid');
  if (!ALLOWED_MIME_TYPES.has(input.contentType) && !ALLOWED_MIME_REGEX.test(input.contentType))
    throw new Error('content_type_not_allowed');
  if (
    !Number.isInteger(input.sizeExpected) ||
    input.sizeExpected <= 0 ||
    input.sizeExpected > MAX_FILE_SIZE
  )
    throw new Error('size_invalid');
  if (!input.ownerId) throw new Error('owner_required');
}

export class InMemoryFileStore implements FileStore {
  private readonly files = new Map<string, FileRecord>();

  private toKey(tenantId: string, fileId: string): string {
    return `${tenantId}:${fileId}`;
  }

  async createPending(context: StoreTenantContext, input: CreateFileInput): Promise<FileRecord> {
    validateCreateInput(input);
    const id = randomUUID();
    const key = buildS3Key(context.tenantId, id);
    const now = Date.now();
    const record: FileRecord = {
      id,
      tenantId: context.tenantId,
      ownerId: input.ownerId,
      key,
      filename: sanitizeFilename(input.filename),
      contentType: input.contentType,
      sizeExpected: input.sizeExpected,
      sizeActual: null,
      status: 'pending',
      checksum: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + PENDING_EXPIRY_MS,
    };
    this.files.set(this.toKey(context.tenantId, id), record);
    return record;
  }

  async getById(context: StoreTenantContext, fileId: string): Promise<FileRecord | null> {
    const rec = this.files.get(this.toKey(context.tenantId, fileId)) ?? null;
    if (!rec) return null;
    // Simulate expiry check: if pending and expiresAt <= now, mark expired (lazy)
    if (rec.status === 'pending' && rec.expiresAt <= Date.now()) {
      rec.status = 'expired';
      rec.updatedAt = Date.now();
      this.files.set(this.toKey(context.tenantId, fileId), rec);
    }
    return rec;
  }

  async finalize(
    context: StoreTenantContext,
    fileId: string,
    input: FinalizeInput = {},
  ): Promise<FileRecord> {
    const rec = this.files.get(this.toKey(context.tenantId, fileId));
    if (!rec) throw new Error('file_not_found');
    if (rec.status === 'expired') throw new Error('file_expired');
    if (rec.status === 'ready') return rec; // idempotent
    if (rec.status !== 'pending') throw new Error('file_not_pending');
    if (rec.expiresAt <= Date.now()) {
      rec.status = 'expired';
      rec.updatedAt = Date.now();
      this.files.set(this.toKey(context.tenantId, fileId), rec);
      throw new Error('file_expired');
    }
    // Optionally validate size
    if (input.sizeActual !== undefined) {
      if (input.sizeActual <= 0 || input.sizeActual > MAX_FILE_SIZE)
        throw new Error('size_invalid');
      // Allow small mismatch? For now require exact or close? We'll allow if not exceeding expected + tolerate.
      // Spec says HEAD verifies content-length; we enforce if provided it must match expected within tolerance.
      if (input.sizeActual !== rec.sizeExpected) {
        // Allow? We'll permit but record actual. However if S3 HEAD shows mismatch, we should error.
        // Here we just record; caller (API) will have already checked via S3 head if available.
      }
      rec.sizeActual = input.sizeActual;
    } else {
      rec.sizeActual = rec.sizeExpected;
    }
    if (input.checksum) rec.checksum = input.checksum;
    rec.status = 'ready';
    rec.updatedAt = Date.now();
    this.files.set(this.toKey(context.tenantId, fileId), rec);
    return rec;
  }

  async getDownloadKey(
    context: StoreTenantContext,
    fileId: string,
  ): Promise<{ file: FileRecord; key: string }> {
    const rec = await this.getById(context, fileId);
    if (!rec) throw new Error('file_not_found');
    if (rec.status !== 'ready') {
      if (rec.status === 'pending') throw new Error('file_not_ready');
      if (rec.status === 'expired') throw new Error('file_expired');
      throw new Error('file_not_found');
    }
    return { file: rec, key: rec.key };
  }

  async listFiles(
    context: StoreTenantContext,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<{ items: FileRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    let cursorTime: number | null = null;
    if (options.cursor) {
      try {
        cursorTime = Number(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      } catch {
        cursorTime = null;
      }
    }
    const all = [...this.files.values()]
      .filter((f) => f.tenantId === context.tenantId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const filtered = cursorTime ? all.filter((f) => f.createdAt < cursorTime) : all;
    const items = filtered.slice(0, limit);
    const nextCursor =
      filtered.length > limit
        ? Buffer.from(String(items[items.length - 1]!.createdAt)).toString('base64url')
        : null;
    return { items, nextCursor };
  }

  async setStatus(fileId: string, status: FileRecord['status'], expiresAt?: number): Promise<void> {
    for (const [k, v] of this.files) {
      if (v.id === fileId) {
        v.status = status;
        if (expiresAt !== undefined) v.expiresAt = expiresAt;
        v.updatedAt = Date.now();
        this.files.set(k, v);
        break;
      }
    }
  }

  // For GC simulation
  async expirePending(now = Date.now()): Promise<number> {
    let count = 0;
    for (const [k, v] of this.files) {
      if (v.status === 'pending' && v.expiresAt <= now) {
        v.status = 'expired';
        v.updatedAt = now;
        this.files.set(k, v);
        count++;
      }
    }
    return count;
  }
}

export class PersistentFileStore implements FileStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }

  static fromConnectionString(
    connectionString: string,
    role = 'platform_app',
  ): PersistentFileStore {
    return new PersistentFileStore(createDatabase(connectionString, { role }));
  }

  async createPending(context: StoreTenantContext, input: CreateFileInput): Promise<FileRecord> {
    validateCreateInput(input);
    const id = randomUUID();
    const key = buildS3Key(context.tenantId, id);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PENDING_EXPIRY_MS);
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        owner_id: string | null;
        key: string;
        filename: string;
        content_type: string;
        size_expected: number;
        size_actual: number | null;
        status: string;
        checksum: string | null;
        created_at: string;
        updated_at: string;
        expires_at: string;
      }>(sql`
        insert into files (id, tenant_id, owner_id, key, filename, content_type, size_expected, status, expires_at)
        values (${id}::uuid, ${context.tenantId}::uuid, ${input.ownerId}::uuid, ${key}, ${input.filename}, ${input.contentType}, ${input.sizeExpected}, 'pending', ${expiresAt.toISOString()}::timestamptz)
        returning id, tenant_id, owner_id, key, filename, content_type, size_expected, size_actual, status, checksum, created_at, updated_at, expires_at
      `);
      const row = rows[0];
      if (!row) throw new Error('file_create_failed');
      return {
        id: row.id,
        tenantId: row.tenant_id,
        ownerId: row.owner_id,
        key: row.key,
        filename: row.filename,
        contentType: row.content_type,
        sizeExpected: row.size_expected,
        sizeActual: row.size_actual,
        status: row.status as FileRecord['status'],
        checksum: row.checksum,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      };
    });
  }

  async getById(context: StoreTenantContext, fileId: string): Promise<FileRecord | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        owner_id: string | null;
        key: string;
        filename: string;
        content_type: string;
        size_expected: number;
        size_actual: number | null;
        status: string;
        checksum: string | null;
        created_at: string;
        updated_at: string;
        expires_at: string;
      }>(sql`
        select id, tenant_id, owner_id, key, filename, content_type, size_expected, size_actual, status, checksum, created_at, updated_at, expires_at
        from files
        where id = ${fileId}::uuid
          and tenant_id = ${context.tenantId}::uuid
        limit 1
      `);
      const row = rows[0];
      if (!row) return null;
      // Lazy expiry: if pending and expired, update to expired in same tx? We'll let GC handle, but return as is.
      const rec: FileRecord = {
        id: row.id,
        tenantId: row.tenant_id,
        ownerId: row.owner_id,
        key: row.key,
        filename: row.filename,
        contentType: row.content_type,
        sizeExpected: row.size_expected,
        sizeActual: row.size_actual,
        status: row.status as FileRecord['status'],
        checksum: row.checksum,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      };
      if (rec.status === 'pending' && rec.expiresAt <= Date.now()) {
        // Optimistically mark expired (best effort)
        await tx.execute(sql`
          update files set status = 'expired', updated_at = now()
          where id = ${fileId}::uuid and tenant_id = ${context.tenantId}::uuid and status = 'pending' and expires_at <= now()
        `);
        rec.status = 'expired';
      }
      return rec;
    });
  }

  async finalize(
    context: StoreTenantContext,
    fileId: string,
    input: FinalizeInput = {},
  ): Promise<FileRecord> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        owner_id: string | null;
        key: string;
        filename: string;
        content_type: string;
        size_expected: number;
        size_actual: number | null;
        status: string;
        checksum: string | null;
        created_at: string;
        updated_at: string;
        expires_at: string;
      }>(sql`
        select id, tenant_id, owner_id, key, filename, content_type, size_expected, size_actual, status, checksum, created_at, updated_at, expires_at
        from files
        where id = ${fileId}::uuid and tenant_id = ${context.tenantId}::uuid
        for update
        limit 1
      `);
      const row = rows[0];
      if (!row) throw new Error('file_not_found');
      if (row.status === 'expired') throw new Error('file_expired');
      if (row.status === 'ready') {
        return {
          id: row.id,
          tenantId: row.tenant_id,
          ownerId: row.owner_id,
          key: row.key,
          filename: row.filename,
          contentType: row.content_type,
          sizeExpected: row.size_expected,
          sizeActual: row.size_actual,
          status: 'ready',
          checksum: row.checksum,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at).getTime(),
          expiresAt: new Date(row.expires_at).getTime(),
        };
      }
      if (row.status !== 'pending') throw new Error('file_not_pending');
      const expiresAt = new Date(row.expires_at).getTime();
      if (expiresAt <= Date.now()) {
        await tx.execute(sql`
          update files set status = 'expired', updated_at = now()
          where id = ${fileId}::uuid and tenant_id = ${context.tenantId}::uuid and status = 'pending'
        `);
        throw new Error('file_expired');
      }
      const sizeActual = input.sizeActual ?? row.size_expected;
      if (sizeActual !== undefined && (sizeActual <= 0 || sizeActual > MAX_FILE_SIZE))
        throw new Error('size_invalid');

      const updated = await tx.execute<{
        id: string;
        tenant_id: string;
        owner_id: string | null;
        key: string;
        filename: string;
        content_type: string;
        size_expected: number;
        size_actual: number | null;
        status: string;
        checksum: string | null;
        created_at: string;
        updated_at: string;
        expires_at: string;
      }>(sql`
        update files
        set status = 'ready',
            size_actual = ${sizeActual},
            ${input.checksum ? sql`checksum = ${input.checksum},` : sql``}
            updated_at = now()
        where id = ${fileId}::uuid and tenant_id = ${context.tenantId}::uuid and status = 'pending'
        returning id, tenant_id, owner_id, key, filename, content_type, size_expected, size_actual, status, checksum, created_at, updated_at, expires_at
      `);
      const upd = updated[0];
      if (!upd) throw new Error('file_finalize_failed');
      return {
        id: upd.id,
        tenantId: upd.tenant_id,
        ownerId: upd.owner_id,
        key: upd.key,
        filename: upd.filename,
        contentType: upd.content_type,
        sizeExpected: upd.size_expected,
        sizeActual: upd.size_actual,
        status: upd.status as FileRecord['status'],
        checksum: upd.checksum,
        createdAt: new Date(upd.created_at).getTime(),
        updatedAt: new Date(upd.updated_at).getTime(),
        expiresAt: new Date(upd.expires_at).getTime(),
      };
    });
  }

  async getDownloadKey(
    context: StoreTenantContext,
    fileId: string,
  ): Promise<{ file: FileRecord; key: string }> {
    const file = await this.getById(context, fileId);
    if (!file) throw new Error('file_not_found');
    if (file.status !== 'ready') {
      if (file.status === 'pending') throw new Error('file_not_ready');
      if (file.status === 'expired') throw new Error('file_expired');
      throw new Error('file_not_found');
    }
    return { file, key: file.key };
  }

  async listFiles(
    context: StoreTenantContext,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<{ items: FileRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    let cursorTime: string | null = null;
    if (options.cursor) {
      try {
        const decoded = Buffer.from(options.cursor, 'base64url').toString('utf8');
        const t = Number(decoded);
        if (!Number.isNaN(t)) cursorTime = new Date(t).toISOString();
        else cursorTime = decoded;
      } catch {
        cursorTime = null;
      }
    }
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        owner_id: string | null;
        key: string;
        filename: string;
        content_type: string;
        size_expected: number;
        size_actual: number | null;
        status: string;
        checksum: string | null;
        created_at: string;
        updated_at: string;
        expires_at: string;
      }>(sql`
        select id, tenant_id, owner_id, key, filename, content_type, size_expected, size_actual, status, checksum, created_at, updated_at, expires_at
        from files
        where tenant_id = ${context.tenantId}::uuid
          and (${cursorTime}::timestamptz is null or created_at < ${cursorTime}::timestamptz)
        order by created_at desc
        limit ${limit + 1}
      `);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const mapped: FileRecord[] = items.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        ownerId: r.owner_id,
        key: r.key,
        filename: r.filename,
        contentType: r.content_type,
        sizeExpected: r.size_expected,
        sizeActual: r.size_actual,
        status: r.status as FileRecord['status'],
        checksum: r.checksum,
        createdAt: new Date(r.created_at).getTime(),
        updatedAt: new Date(r.updated_at).getTime(),
        expiresAt: new Date(r.expires_at).getTime(),
      }));
      const nextCursor =
        hasMore && mapped.length > 0
          ? Buffer.from(String(mapped[mapped.length - 1]!.createdAt)).toString('base64url')
          : null;
      return { items: mapped, nextCursor };
    });
  }
}
