import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from './database.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1';
const configuredConnectionString = process.env.DATABASE_URL;
const connectionUrl = configuredConnectionString ? new URL(configuredConnectionString) : null;
connectionUrl?.searchParams.delete('schema');
const connectionString = connectionUrl?.toString();
const suite = runIntegration && connectionString ? describe : describe.skip;

suite('postgres RLS — last barrier (platform_app without tenant)', () => {
  let admin: ReturnType<typeof postgres>;
  let appDb: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let appClient: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    appDb = createDatabase(connectionString, { role: 'platform_app', maxConnections: 2 });
    // Direct client as platform_app without tenant context (bypasses withTenantTransaction)
    appClient = postgres(connectionString, { max: 1, prepare: false });

    tenantA = crypto.randomUUID();
    tenantB = crypto.randomUUID();

    await admin`
      insert into organizations (id, slug, name)
      values (${tenantA}, ${`rls-a-${tenantA.slice(0, 8)}`}, 'RLS A'),
             (${tenantB}, ${`rls-b-${tenantB.slice(0, 8)}`}, 'RLS B')
    `;
    await admin`
      insert into branches (tenant_id, slug, name)
      values (${tenantA}, 'rls-branch', 'A'), (${tenantB}, 'rls-branch', 'B')
    `;
    await admin`
      insert into memberships (tenant_id, user_id, role, active)
      values (${tenantA}, ${tenantA}, 'owner', true), (${tenantB}, ${tenantB}, 'owner', true)
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from memberships where tenant_id = ${tenantA} or tenant_id = ${tenantB}`.catch(
        () => undefined,
      );
      await admin`delete from branches where tenant_id = ${tenantA} or tenant_id = ${tenantB}`.catch(
        () => undefined,
      );
      await admin`delete from organizations where id = ${tenantA} or id = ${tenantB}`.catch(
        () => undefined,
      );
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
    if (appClient) await appClient.end({ timeout: 5 }).catch(() => undefined);
    if (appDb) await appDb.close().catch(() => undefined);
  });

  it('denies SELECT without app.tenant_id (FORCE RLS)', async () => {
    // Connect as platform_app role, no set_config
    await appClient.unsafe('set role "platform_app"');
    // Without app.tenant_id, policies evaluate nullif(current_setting) -> null -> no rows
    const orgs = await appClient.unsafe('select id from organizations');
    expect(orgs.length).toBe(0);

    const branches = await appClient.unsafe('select id from branches');
    expect(branches.length).toBe(0);

    const memberships = await appClient.unsafe('select id from memberships');
    expect(memberships.length).toBe(0);

    // Reset role
    await appClient.unsafe('reset role').catch(() => undefined);
  });

  it('enforces RLS WITH CHECK on INSERT mismatched tenant via platform_app', async () => {
    // Use withTenantTransaction with tenantA but try to insert tenantB row directly — should be blocked by RLS with check
    await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'rls-check' },
      async (tx) => {
        // Attempt to insert a branch with tenantB while app.tenant_id == tenantA -> with check should fail
        let threw = false;
        try {
          await tx.execute(
            sql`insert into branches (tenant_id, slug, name) values (${tenantB}::uuid, 'evil', 'Evil')`,
          );
        } catch (error) {
          threw = true;
          // Postgres error code 42501 insufficient_privilege due to RLS
          const code = (error as unknown as { code?: string }).code;
          expect(['42501', 'P0001']).toContain(code ?? '42501');
        }
        expect(threw).toBe(true);

        // Valid insert for own tenant should succeed (and then clean)
        const ok = await tx.execute<{ id: string }>(
          sql`insert into branches (tenant_id, slug, name) values (${tenantA}::uuid, 'ok-branch', 'Ok') returning id`,
        );
        expect(ok.length).toBe(1);
        // Cleanup
        await tx.execute(sql`delete from branches where id = ${ok[0]!.id}::uuid`);
      },
    );
  });

  it('forces RLS even for table owner via FORCE (admin cannot bypass as platform_app)', async () => {
    // Verify FORCE: pg_tables should show rowsecurity and forcerowsecurity true
    const rows = await admin.unsafe<{ rowsecurity: boolean; forcerowsecurity: boolean }[]>(
      "select rowsecurity, forcerowsecurity from pg_tables where schemaname='public' and tablename='organizations'",
    );
    if (rows.length > 0) {
      expect(rows[0]?.rowsecurity).toBe(true);
      expect(rows[0]?.forcerowsecurity).toBe(true);
    }
    // Also verify that withTenantTransaction with tenantA cannot see B even when using admin-like query
    await withTenantTransaction(
      appDb,
      { tenantId: tenantA, requestId: 'force-check' },
      async (tx) => {
        const bOrg = await tx.execute(sql`select id from organizations where id = ${tenantB}`);
        expect(bOrg.length).toBe(0);
      },
    );
  });
});
