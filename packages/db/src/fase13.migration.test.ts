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
    expect(first.pending).toEqual([]);
    expect(first.applied.length + first.skipped.length).toBeGreaterThanOrEqual(11);
    const rows = await (admin as NonNullable<
      typeof admin
    >)`select id, checksum from schema_migrations order by id`;
    expect(rows.length).toBeGreaterThanOrEqual(11);
    expect(rows.some((r) => (r as { id: string }).id.includes('0011_audit_hardening'))).toBe(true);
    // Checksums must be recorded for every applied row: a NULL checksum means
    // drift detection silently ignores that file.
    expect(rows.every((r) => (r as { checksum: string | null }).checksum !== null)).toBe(true);
    const second = await runMigrations(url);
    expect(second.applied.length).toBe(0);
    expect(second.skipped.length).toBe(rows.length);
    const rls = await (admin as NonNullable<
      typeof admin
    >)`select relname, relforcerowsecurity from pg_class where relname='audit_log'`;
    expect((rls[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
    await db.close();
  });

  it('leaves no invalid indexes after migrating', async () => {
    if (!admin || !url) throw new Error('admin required');
    await runMigrations(url);
    const invalid = await (admin as NonNullable<typeof admin>)`
      select c.relname from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and not i.indisvalid
    `;
    expect(invalid).toEqual([]);
  });

  it('reports pending migrations and can gate CI (--check semantics)', async () => {
    if (!url) throw new Error('no url');
    const dry = await runMigrations(url, { dryRun: true });
    expect(dry.applied).toEqual([]);
    expect(dry.pending).toEqual([]);
  });
});
