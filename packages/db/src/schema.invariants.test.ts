import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimProcessedJob,
  completeProcessedJob,
  heartbeatProcessedJob,
  createDatabase,
  purgeExpiredSessions,
  purgeOutboxEvents,
  withAuthTransaction,
  withTenantTransaction,
  writeOutboxEvent,
  type DatabaseHandle,
} from './index.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = runIntegration ? describe : describe.skip;

function sqlState(error: unknown): string | undefined {
  // drizzle wraps driver errors (DrizzleQueryError); the SQLSTATE lives on the
  // cause chain, so walk it instead of reading only the top-level object.
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
}

suite('schema invariants (tenant integrity, idempotency, retention)', () => {
  let admin: ReturnType<typeof postgres>;
  let adminDb: DatabaseHandle;
  let appDb: DatabaseHandle;
  let authDb: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let branchA: string;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    adminDb = createDatabase(connectionString, { allowUnscoped: true, maxConnections: 1 });
    appDb = createDatabase(connectionString, { role: 'platform_app', maxConnections: 2 });
    authDb = createDatabase(connectionString, { role: 'platform_auth', maxConnections: 1 });
    tenantA = crypto.randomUUID();
    tenantB = crypto.randomUUID();
    userA = crypto.randomUUID();

    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userA}::uuid, 'invariants', ${`u-${userA}`}, 'inv@test', 'Invariants')
    `;
    await admin`
      insert into organizations (id, slug, name)
      values (${tenantA}, ${`inv-a-${tenantA.slice(0, 8)}`}, 'Invariants A'),
             (${tenantB}, ${`inv-b-${tenantB.slice(0, 8)}`}, 'Invariants B')
    `;
    branchA = (
      await admin`
        insert into branches (tenant_id, slug, name)
        values (${tenantA}, 'inv-branch', 'Invariants branch') returning id
      `
    )[0]!.id;
  });

  afterAll(async () => {
    if (admin) {
      await admin`alter table inventory_movements disable trigger inventory_movements_immutable`.catch(
        () => undefined,
      );
      await admin`delete from inventory_movements where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`alter table inventory_movements enable trigger inventory_movements_immutable`.catch(
        () => undefined,
      );
      await admin`delete from order_idempotency where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from processed_jobs where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from outbox_events where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from webhook_deliveries where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from sessions where user_id = ${userA}`.catch(() => undefined);
      await admin`delete from organizations where id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from users where id = ${userA}`.catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
    if (adminDb) await adminDb.close().catch(() => undefined);
    if (appDb) await appDb.close().catch(() => undefined);
    if (authDb) await authDb.close().catch(() => undefined);
  });

  it('deduplicates producer retries but not distinct events', async () => {
    const input = {
      tenantId: tenantA,
      aggregateType: 'order' as const,
      aggregateId: branchA,
      eventType: 'order.paid',
      payload: { orderId: branchA, amount: 100 },
    };
    const first = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'outbox-1' },
      (tx) => writeOutboxEvent(tx, input),
    );
    const retry = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'outbox-2' },
      (tx) => writeOutboxEvent(tx, input),
    );
    expect(retry).toBe(first);

    const distinct = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'outbox-3' },
      (tx) => writeOutboxEvent(tx, { ...input, payload: { orderId: branchA, amount: 200 } }),
    );
    expect(distinct).not.toBe(first);

    const rows = await admin<{ count: string }[]>`
      select count(*)::text as count from outbox_events
      where tenant_id = ${tenantA}::uuid and dedupe_key is not null
    `;
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('enforces (tenant_id, key) idempotency and rejects key reuse across tenants', async () => {
    const key = 'idem-' + crypto.randomUUID();
    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'idem' }, async (tx) => {
      await tx.execute(sql`
        insert into order_idempotency (tenant_id, key, request_hash, response)
        values (${tenantA}::uuid, ${key}, 'hash-0001', '{"ok":true}'::jsonb)
      `);
    });

    // Duplicate key in its own transaction: a failed statement aborts the
    // surrounding transaction, so it cannot be asserted inline.
    let duplicate: unknown;
    try {
      await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'idem-dup' }, (tx) =>
        tx.execute(sql`
          insert into order_idempotency (tenant_id, key, request_hash)
          values (${tenantA}::uuid, ${key}, 'hash-0002')
        `),
      );
    } catch (caught) {
      duplicate = caught;
    }
    expect(sqlState(duplicate)).toBe('23505');

    await withTenantTransaction(appDb, { tenantId: tenantB, requestId: 'idem-b' }, async (tx) => {
      await tx.execute(sql`
        insert into order_idempotency (tenant_id, key, request_hash)
        values (${tenantB}::uuid, ${key}, 'hash-0003')
      `);
      const visible = await tx.execute<{ tenant_id: string }>(
        sql`select tenant_id from order_idempotency where key = ${key}`,
      );
      expect(visible.map((row) => row.tenant_id)).toEqual([tenantB]);
    });
  });

  it('fences processed_jobs lease takeovers', async () => {
    const jobId = 'job-' + crypto.randomUUID();
    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'lease' }, async (tx) => {
      await tx.execute(sql`
        insert into processed_jobs (job_id, tenant_id, queue, status, lease_token, lease_until)
        values (${jobId}, ${tenantA}::uuid, 'test', 'processing', 'lease-1', now() + interval '1 minute')
      `);
      await tx.execute(sql`
        update processed_jobs set lease_until = now() + interval '1 minute'
        where job_id = ${jobId} and lease_token = 'lease-1'
      `);
      const first = await tx.execute<{ lease_fence: string }>(
        sql`select lease_fence from processed_jobs where job_id = ${jobId}`,
      );
      expect(Number(first[0]?.lease_fence)).toBe(0);

      // Takeover: status stays processing, token changes -> fence bumps.
      await tx.execute(sql`
        update processed_jobs set lease_token = 'lease-2', lease_until = now() + interval '1 minute'
        where job_id = ${jobId} and status = 'processing'
      `);
      const second = await tx.execute<{ lease_fence: string }>(
        sql`select lease_fence from processed_jobs where job_id = ${jobId}`,
      );
      expect(Number(second[0]?.lease_fence)).toBe(1);

      // The loser's terminal update must affect zero rows.
      const loser = await tx.execute<{ job_id: string }>(sql`
        update processed_jobs set status = 'completed', lease_token = null
        where job_id = ${jobId} and lease_token = 'lease-1' returning job_id
      `);
      expect(loser).toEqual([]);
    });
  });

  it('requires an explicit webhook delivery_key', async () => {
    const endpoint = await admin<{ id: string }[]>`
      insert into webhook_endpoints (tenant_id, url, secret_hash, events)
      values (${tenantA}, ${'https://example.test/' + crypto.randomUUID()}, ${'a'.repeat(64)}, '[]'::jsonb)
      returning id
    `;
    let error: unknown;
    try {
      await admin`
        insert into webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload)
        values (${tenantA}, ${endpoint[0]!.id}, ${'evt-' + crypto.randomUUID()}, 'order.paid', '{}'::jsonb)
      `;
    } catch (caught) {
      error = caught;
    }
    expect(sqlState(error)).toBe('23502');
  });

  it('rejects non-canonical tenant slugs', async () => {
    let error: unknown;
    try {
      await admin`
        insert into organizations (slug, name) values (${'ACME-' + crypto.randomUUID().slice(0, 6)}, 'Upper')
      `;
    } catch (caught) {
      error = caught;
    }
    expect(sqlState(error)).toBe('23514');
  });

  it('purges terminal outbox rows in batches and reports dry-run counts', async () => {
    const old = await admin<{ id: string }[]>`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, status, created_at)
      values (${tenantA}, 'generic', ${branchA}, 'test.retention', '{}'::jsonb, 'done', now() - interval '30 days')
      returning id
    `;
    const dry = await purgeOutboxEvents(adminDb.db, { dryRun: true, olderThanDays: 7 });
    expect(dry.deletedCount).toBe(0);
    expect(dry.wouldDelete).toBeGreaterThanOrEqual(1);

    const purged = await purgeOutboxEvents(adminDb.db, { olderThanDays: 7, batchSize: 100 });
    expect(purged.deletedCount).toBeGreaterThanOrEqual(1);
    const remaining = await admin`
      select id from outbox_events where id = ${old[0]!.id}::uuid
    `;
    expect(remaining).toEqual([]);
  });

  it('purges expired sessions and separates dry-run counts', async () => {
    const tokenHash = 'expired-' + crypto.randomUUID();
    await withAuthTransaction(
      authDb,
      { userId: userA, tenantId: tenantA, requestId: 'session-expired' },
      async (tx) => {
        await tx.execute(sql`
          insert into sessions (token_hash, user_id, expires_at, absolute_expires_at)
          values (${tokenHash}, ${userA}::uuid, now() - interval '1 day', now() - interval '1 day')
        `);
      },
    );
    const dry = await purgeExpiredSessions(adminDb.db, { dryRun: true });
    expect(dry.deletedCount).toBe(0);
    expect(dry.wouldDelete).toBeGreaterThanOrEqual(1);

    const purged = await purgeExpiredSessions(adminDb.db, { batchSize: 100 });
    expect(purged.deletedCount).toBeGreaterThanOrEqual(1);
  });

  it('claims, fences and completes worker jobs through the helper contract', async () => {
    const jobId = 'helper-' + crypto.randomUUID();
    const first = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'claim-1' },
      (tx) => claimProcessedJob(tx, { jobId, tenantId: tenantA, queue: 'q', token: 'token-1' }),
    );
    expect(first).toEqual({ claimed: true, fence: 0 });

    const second = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'claim-2' },
      (tx) => claimProcessedJob(tx, { jobId, tenantId: tenantA, queue: 'q', token: 'token-2' }),
    );
    expect(second.claimed).toBe(false);

    const renewed = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'heartbeat' },
      (tx) =>
        heartbeatProcessedJob(tx, {
          jobId,
          tenantId: tenantA,
          leaseToken: 'token-1',
          leaseMs: 60_000,
        }),
    );
    expect(renewed).toBe(true);

    const stale = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'heartbeat-stale' },
      (tx) =>
        heartbeatProcessedJob(tx, {
          jobId,
          tenantId: tenantA,
          leaseToken: 'token-2',
          leaseMs: 60_000,
        }),
    );
    expect(stale).toBe(false);

    const lost = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'complete-lost' },
      (tx) =>
        completeProcessedJob(tx, {
          jobId,
          tenantId: tenantA,
          leaseToken: 'token-2',
          result: { ok: true },
        }),
    );
    expect(lost).toBe('lease_lost');

    const completed = await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'complete' },
      (tx) =>
        completeProcessedJob(tx, {
          jobId,
          tenantId: tenantA,
          leaseToken: 'token-1',
          result: { ok: true },
        }),
    );
    expect(completed).toBe('completed');
  });

  it('revokes the old definer helpers from the tenant role', async () => {
    const rows = await admin.unsafe<{ allowed: boolean | null; legacy: string | null }[]>(
      "select has_function_privilege('platform_app', 'platform_list_memberships_for_user(uuid)', 'EXECUTE') as allowed, " +
        "to_regprocedure('platform_get_product_by_sku(uuid,text)')::text as legacy",
    );
    expect(rows[0]?.allowed).toBe(false);
    expect(rows[0]?.legacy).toBeNull();
  });

  it('keeps the new table RLS-enabled and tenant-scoped', async () => {
    const rows = await admin.unsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      'select c.relrowsecurity, c.relforcerowsecurity from pg_class c ' +
        "join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'order_idempotency'",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
