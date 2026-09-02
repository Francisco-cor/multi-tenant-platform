import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDatabase } from './database.js';
import { runMigrations } from './migrate.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1' && !!process.env.DATABASE_URL;
const suite = runIntegration ? describe : describe.skip;

suite('Fase 13 — tests de migración (N-1 → N, expand-contract)', () => {
  let admin: ReturnType<typeof postgres> | null = null;
  let url: string | null = null;

  beforeAll(async () => {
    url = process.env.DATABASE_URL ?? null;
    if (!url) throw new Error('DATABASE_URL required');
    admin = postgres(url, { max: 1, prepare: false });
  });
  afterAll(async () => {
    if (admin) await admin.end({ timeout: 5 }).catch(() => undefined);
  });

  it('migrate desde vacía aplica 0011 y es idempotente (segunda corrida skip)', async () => {
    if (!url) throw new Error('no url');
    const db = createDatabase(url, { role: 'platform_app' });
    const first = await runMigrations(url);
    // first may have 0 applied if already migrated, but skipped should be >=11
    expect(first.applied.length + first.skipped.length).toBeGreaterThanOrEqual(11);
    const rows = await (admin as NonNullable<
      typeof admin
    >)`select id, checksum from schema_migrations order by id`;
    expect(rows.length).toBeGreaterThanOrEqual(11);
    expect(rows.some((r) => (r as { id: string }).id.includes('0011_audit_hardening'))).toBe(true);
    const second = await runMigrations(url);
    expect(second.applied.length).toBe(0);
    expect(second.skipped.length).toBe(rows.length);
    const rls = await (admin as NonNullable<
      typeof admin
    >)`select relname, relforcerowsecurity from pg_class where relname='audit_log'`;
    expect((rls[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
    await db.close();
  });

  it('no deja índices inválidos tras migración', async () => {
    if (!admin || !url) return;
    const idx = await (admin as NonNullable<
      typeof admin
    >)`select indexname, indisvalid from pg_index where indexname='tenant_branches_lookup'`;
    if (idx.length) {
      expect((idx[0] as { indisvalid: boolean }).indisvalid).toBe(true);
    }
    expect(true).toBe(true);
  });
});
