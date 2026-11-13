import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  withAuthTransaction,
  withTenantTransaction,
  type DatabaseHandle,
} from './database.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1';
const configuredConnectionString = process.env.DATABASE_URL;
const connectionUrl = configuredConnectionString ? new URL(configuredConnectionString) : null;
connectionUrl?.searchParams.delete('schema');
const connectionString = connectionUrl?.toString();
const suite = runIntegration && connectionString ? describe : describe.skip;

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


suite('postgres RLS — last barrier (platform_app without tenant)', () => {
  let admin: ReturnType<typeof postgres>;
  let appDb: DatabaseHandle;
  let authDb: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let branchA: string;
  let branchB: string;
  let productA: string;
  let productB: string;
  let appClient: ReturnType<typeof postgres>;

async function tenantFailure(
  context: { tenantId: string; requestId: string; userId?: string },
  expected: string,
  run: (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await withTenantTransaction(appDb, context, run);
  } catch (error) {
    caught = error;
  }
  expect(sqlState(caught)).toBe(expected);
}


  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    appDb = createDatabase(connectionString, { role: 'platform_app', maxConnections: 2 });
    authDb = createDatabase(connectionString, { role: 'platform_auth', maxConnections: 2 });
    appClient = postgres(connectionString, { max: 1, prepare: false });

    tenantA = crypto.randomUUID();
    tenantB = crypto.randomUUID();
    userA = crypto.randomUUID();
    userB = crypto.randomUUID();
    branchA = crypto.randomUUID();
    branchB = crypto.randomUUID();

    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userA}::uuid, 'rls-test', ${`a-${userA}`}, 'a@rls.test', 'A'),
             (${userB}::uuid, 'rls-test', ${`b-${userB}`}, 'b@rls.test', 'B')
    `;
    await admin`
      insert into organizations (id, slug, name)
      values (${tenantA}, ${`rls-a-${tenantA.slice(0, 8)}`}, 'RLS A'),
             (${tenantB}, ${`rls-b-${tenantB.slice(0, 8)}`}, 'RLS B')
    `;
    await admin`
      insert into branches (id, tenant_id, slug, name)
      values (${branchA}, ${tenantA}, 'rls-branch', 'A'),
             (${branchB}, ${tenantB}, 'rls-branch', 'B')
    `;
    await admin`
      insert into memberships (tenant_id, user_id, role, active)
      values (${tenantA}, ${userA}, 'owner', true), (${tenantB}, ${userB}, 'owner', true)
    `;
    productA = (
      await admin`
        insert into products (tenant_id, sku, name)
        values (${tenantA}, 'rls-a-sku', 'A product') returning id
      `
    )[0]!.id;
    productB = (
      await admin`
        insert into products (tenant_id, sku, name)
        values (${tenantB}, 'rls-b-sku', 'B product') returning id
      `
    )[0]!.id;
  });

  afterAll(async () => {
    if (admin) {
      await admin`alter table audit_log disable trigger audit_log_no_delete`.catch(() => undefined);
      await admin`delete from audit_log where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`alter table audit_log enable trigger audit_log_no_delete`.catch(() => undefined);
      await admin`alter table inventory_movements disable trigger inventory_movements_immutable`.catch(
        () => undefined,
      );
      await admin`delete from inventory_movements where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`alter table inventory_movements enable trigger inventory_movements_immutable`.catch(
        () => undefined,
      );
      await admin`delete from platform_audit_log where actor_user_id in (${userA}, ${userB})`.catch(
        () => undefined,
      );
      await admin`delete from sessions where user_id in (${userA}, ${userB})`.catch(() => undefined);
      await admin`delete from memberships where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from branches where tenant_id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from organizations where id in (${tenantA}, ${tenantB})`.catch(
        () => undefined,
      );
      await admin`delete from users where id in (${userA}, ${userB})`.catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
    if (appClient) await appClient.end({ timeout: 5 }).catch(() => undefined);
    if (appDb) await appDb.close().catch(() => undefined);
    if (authDb) await authDb.close().catch(() => undefined);
  });

  it('denies SELECT without app.tenant_id (FORCE RLS)', async () => {
    await appClient.unsafe('set role "platform_app"');
    const orgs = await appClient.unsafe('select id from organizations');
    expect(orgs.length).toBe(0);
    const branches = await appClient.unsafe('select id from branches');
    expect(branches.length).toBe(0);
    const memberships = await appClient.unsafe('select id from memberships');
    expect(memberships.length).toBe(0);
    await appClient.unsafe('reset role').catch(() => undefined);
  });

  it('enables and forces RLS with a WITH CHECK policy on every tenant table', async () => {
    const tables = await admin.unsafe<{ relname: string }[]>(
      'select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
        'join pg_attribute a on a.attrelid = c.oid and a.attname = ' +
        "'tenant_id' and not a.attisdropped " +
        "where n.nspname = 'public' and c.relkind = 'r'",
    );
    expect(tables.length).toBeGreaterThan(10);
    const rls = await admin.unsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      'select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c ' +
        "join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'",
    );
    const byName = new Map(rls.map((row) => [row.relname, row]));
    const policies = await admin.unsafe<{ tablename: string; with_check: string | null }[]>(
      "select tablename, with_check from pg_policies where schemaname = 'public'",
    );
    const withCheck = new Set(
      policies.filter((policy) => policy.with_check !== null).map((policy) => policy.tablename),
    );
    const broken = tables
      .map((row) => row.relname)
      .filter((table) => {
        const row = byName.get(table);
        return !row?.relrowsecurity || !row?.relforcerowsecurity || !withCheck.has(table);
      });
    expect(broken).toEqual([]);
  });

  it('enforces RLS WITH CHECK on INSERT mismatched tenant via platform_app', async () => {
    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'rls-check' }, async (tx) => {

      const ok = await tx.execute<{ id: string }>(
        sql`insert into branches (tenant_id, slug, name) values (${tenantA}::uuid, 'ok-branch', 'Ok') returning id`,
      );
      expect(ok.length).toBe(1);
      await tx.execute(sql`delete from branches where id = ${ok[0]!.id}::uuid`);
    });

    await tenantFailure({ tenantId: tenantA, requestId: 'rls-check-fail' }, '42501', (tx) =>
      tx.execute(
        sql`insert into branches (tenant_id, slug, name) values (${tenantB}::uuid, 'evil', 'Evil')`,
      ),
    );
  });

  it('denies a stale/garbage app.tenant_id instead of raising 22P02', async () => {
    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'garbage' }, async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', 'not-a-uuid', true)`);
      const rows = await tx.execute<{ id: string }>(sql`select id from branches`);
      expect(rows).toEqual([]);
      const orgs = await tx.execute<{ id: string }>(sql`select id from organizations`);
      expect(orgs).toEqual([]);
    });
  });

  it('binds membership listing to app.user_id and revokes the argument-taking function', async () => {
    await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'memberships', userId: userB },
      async (tx) => {
        const rows = await tx.execute<{ tenant_id: string; user_id: string }>(
          sql`select tenant_id, user_id from platform_list_my_memberships()`,
        );
        expect(rows).toEqual([{ tenant_id: tenantB, user_id: userB }]);

      },
    );

    await tenantFailure({ tenantId: tenantA, requestId: 'memberships-legacy' }, '42501', (tx) =>
      tx.execute(sql`select * from platform_list_memberships_for_user(${userA}::uuid)`),
    );

    await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'memberships-a', userId: userA },
      async (tx) => {
        const rows = await tx.execute<{ tenant_id: string }>(
          sql`select tenant_id from platform_list_my_memberships()`,
        );
        expect(rows).toEqual([{ tenant_id: tenantA }]);
      },
    );
  });

  it('keeps session credentials user-bound and invisible to other tenants', async () => {
    const tokenHash = 'rls-test-' + crypto.randomUUID();
    await withAuthTransaction(
      authDb,
      { userId: userA, tenantId: tenantA, requestId: 'session-create' },
      async (tx) => {
        await tx.execute(sql`
          insert into sessions (token_hash, user_id, expires_at, selected_tenant_id)
          values (${tokenHash}, ${userA}::uuid, now() + interval '1 hour', ${tenantA}::uuid)
        `);
      },
    );

    await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'session-other-user', userId: userB },
      async (tx) => {
        const rows = await tx.execute<{ token_hash: string }>(
          sql`select token_hash from sessions where token_hash = ${tokenHash}`,
        );
        expect(rows).toEqual([]);
        const deleted = await tx.execute<{ token_hash: string }>(
          sql`delete from sessions where token_hash = ${tokenHash} returning token_hash`,
        );
        expect(deleted).toEqual([]);
      },
    );

    await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'session-owner', userId: userA },
      async (tx) => {
        const rows = await tx.execute<{ token_hash: string }>(
          sql`select token_hash from sessions where token_hash = ${tokenHash}`,
        );
        expect(rows).toHaveLength(1);
      },
    );
  });

  it('does not expose or accept global audit rows from a tenant context', async () => {
    await admin`
      insert into platform_audit_log (actor_user_id, action, request_id, result)
      values (${userA}::uuid, 'auth.login_failed', 'global-audit', 'failure')
    `;

    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'audit' }, async (tx) => {
      const rows = await tx.execute<{ count: string }>(sql`
        select count(*)::text as count from audit_log where tenant_id is null
      `);
      expect(Number(rows[0]?.count ?? '0')).toBe(0);
    });

    await tenantFailure({ tenantId: tenantA, requestId: 'audit-null' }, '42501', (tx) =>
      tx.execute(sql`
        insert into audit_log (tenant_id, actor_user_id, action, request_id)
        values (null, ${userA}::uuid, 'auth.login_failed', 'forged')
      `),
    );
  });

  it('rejects audit rows attributed to somebody else', async () => {
    await tenantFailure(
      { tenantId: tenantA, requestId: 'audit-forge-2', userId: userA },
      '42501',
      (tx) =>
        tx.execute(sql`
          insert into audit_log (tenant_id, actor_user_id, action, request_id)
          values (${tenantA}::uuid, ${userB}::uuid, 'branch.updated', 'forged')
        `),
    );
  });

  it('rejects cross-tenant child rows through the composite foreign key', async () => {
    await tenantFailure({ tenantId: tenantA, requestId: 'fk-branch' }, '23503', (tx) =>
      tx.execute(sql`
        insert into stock_per_branch (tenant_id, branch_id, product_id, available)
        values (${tenantA}::uuid, ${branchB}::uuid, ${productA}::uuid, 1)
      `),
    );
    await tenantFailure({ tenantId: tenantA, requestId: 'fk-product' }, '23503', (tx) =>
      tx.execute(sql`
        insert into stock_per_branch (tenant_id, branch_id, product_id, available)
        values (${tenantA}::uuid, ${branchA}::uuid, ${productB}::uuid, 1)
      `),
    );
  });

  it('makes the inventory ledger append-only', async () => {
    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'movement' }, async (tx) => {
      await tx.execute(sql`
        insert into inventory_movements (tenant_id, branch_id, product_id, delta, reason, correlation_id)
        values (${tenantA}::uuid, ${branchA}::uuid, ${productA}::uuid, 1, 'adjust', ${'adj-' + crypto.randomUUID()})
      `);
    });

    await tenantFailure({ tenantId: tenantA, requestId: 'movement-update' }, '42501', (tx) =>
      tx.execute(sql`
        update inventory_movements set delta = 0
        where tenant_id = ${tenantA}::uuid and reason = 'adjust'
      `),
    );

    let triggerError: unknown;
    try {
      await admin`update inventory_movements set delta = 0 where tenant_id = ${tenantA}::uuid`;
    } catch (caught) {
      triggerError = caught;
    }
    expect(sqlState(triggerError)).toBe('45000');
  });

  it('removes BYPASSRLS from the worker role and denies tenant tables', async () => {
    const roles = await admin.unsafe<{ rolbypassrls: boolean; rolsuper: boolean }[]>(
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'platform_worker'",
    );
    expect(roles[0]?.rolbypassrls).toBe(false);
    expect(roles[0]?.rolsuper).toBe(false);

    const worker = postgres(connectionString!, { max: 1, prepare: false });
    try {
      await worker.unsafe('set role "platform_worker"');
      let error: unknown;
      try {
        await worker.unsafe('select count(*) from orders');
      } catch (caught) {
        error = caught;
      }
      expect(sqlState(error)).toBe('42501');
      const outbox = await worker.unsafe('select count(*) from outbox_events');
      expect(outbox).toHaveLength(1);
    } finally {
      await worker.unsafe('reset role').catch(() => undefined);
      await worker.end({ timeout: 5 });
    }
  });

  it('forces RLS even for table owner via FORCE (admin cannot bypass as platform_app)', async () => {
    const rows = await admin.unsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      'select c.relrowsecurity, c.relforcerowsecurity from pg_class c ' +
        "join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'organizations'",
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
    await withTenantTransaction(appDb, { tenantId: tenantA, requestId: 'force-check' }, async (tx) => {
      const bOrg = await tx.execute(sql`select id from organizations where id = ${tenantB}`);
      expect(bOrg.length).toBe(0);
    });
  });
});
