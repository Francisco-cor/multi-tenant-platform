import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from './database.js';
import { TenantOrganizationRepository } from './repositories.js';
import type { TenantRepositoryContext } from './tenant-context.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1';
const configuredConnectionString = process.env.DATABASE_URL;
const connectionUrl = configuredConnectionString ? new URL(configuredConnectionString) : null;
connectionUrl?.searchParams.delete('schema');
const connectionString = connectionUrl?.toString();
const suite = runIntegration && connectionString ? describe : describe.skip;

suite('postgres tenant isolation — pool stickiness 50 concurrent', () => {
  let admin: ReturnType<typeof postgres>;
  let dbHandle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    // Use pool max 5 to force connection reuse and detect sticky app.tenant_id
    dbHandle = createDatabase(connectionString, { role: 'platform_app', maxConnections: 5 });
    tenantA = crypto.randomUUID();
    tenantB = crypto.randomUUID();

    // Insert organizations and branches with same branch slug to ensure names collide but tenant isolation hides
    await admin`
      insert into organizations (id, slug, name)
      values (${tenantA}, ${`conc-a-${tenantA.slice(0, 8)}`}, 'Concurrent A'),
             (${tenantB}, ${`conc-b-${tenantB.slice(0, 8)}`}, 'Concurrent B')
    `;
    await admin`
      insert into branches (tenant_id, slug, name)
      values (${tenantA}, 'same-branch', 'A branch'), (${tenantB}, 'same-branch', 'B branch')
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from branches where tenant_id = ${tenantA} or tenant_id = ${tenantB}`.catch(
        () => undefined,
      );
      await admin`delete from organizations where id = ${tenantA} or id = ${tenantB}`.catch(
        () => undefined,
      );
      await admin.end({ timeout: 5 });
    }
    if (dbHandle) await dbHandle.close();
  });

  it('keeps app.tenant_id correctly bound across 50 concurrent withTenantTransaction', async () => {
    const total = 50;
    const tasks: Promise<void>[] = [];

    for (let i = 0; i < total; i++) {
      const isA = i % 2 === 0;
      const tenantId = isA ? tenantA : tenantB;
      const otherTenant = isA ? tenantB : tenantA;
      const requestId = `conc-${i}-${tenantId.slice(0, 8)}`;
      const context: TenantRepositoryContext = { tenantId, requestId };

      tasks.push(
        withTenantTransaction(dbHandle, context, async (tx) => {
          // 1) Verify app.tenant_id is exactly the transaction's tenant
          const [setting] = await tx.execute<{ tenant: string }>(
            sql`select current_setting('app.tenant_id', true) as tenant`,
          );
          expect(setting?.tenant).toBe(tenantId);

          // 2) Repository findById respects tenant filter
          const repo = new TenantOrganizationRepository(tx);
          const own = await repo.findById(context, tenantId);
          expect(own).not.toBeNull();
          expect(own?.id).toBe(tenantId);

          const cross = await repo.findById(context, otherTenant);
          expect(cross).toBeNull();

          // 3) Direct query without explicit filter must still be blocked by RLS (since app.tenant_id is set)
          const direct = await tx.execute<{ id: string }>(
            sql`select id from organizations where id = ${otherTenant}`,
          );
          expect(direct.length).toBe(0);

          // 4) Branches RLS hides other tenant even with same slug
          const branches = await tx.execute<{ tenant_id: string }>(
            sql`select tenant_id from branches where slug = 'same-branch'`,
          );
          // Should only see own tenant branch
          expect(branches.length).toBe(1);
          expect(branches[0]?.tenant_id).toBe(tenantId);
        }),
      );
    }

    await Promise.all(tasks);
  });

  it('does not leak app.tenant_id to connections after transactions complete', async () => {
    // After all concurrent, a new transaction with tenantA should not see tenantB residue
    const contextA: TenantRepositoryContext = { tenantId: tenantA, requestId: 'leak-check-a' };
    const contextB: TenantRepositoryContext = { tenantId: tenantB, requestId: 'leak-check-b' };
    await withTenantTransaction(dbHandle, contextA, async (tx) => {
      const [setting] = await tx.execute<{ tenant: string }>(
        sql`select current_setting('app.tenant_id', true) as tenant`,
      );
      expect(setting?.tenant).toBe(tenantA);
    });
    await withTenantTransaction(dbHandle, contextB, async (tx) => {
      const [setting] = await tx.execute<{ tenant: string }>(
        sql`select current_setting('app.tenant_id', true) as tenant`,
      );
      expect(setting?.tenant).toBe(tenantB);
    });
  });
});
