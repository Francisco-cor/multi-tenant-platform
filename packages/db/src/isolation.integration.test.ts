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

suite('postgres tenant isolation', () => {
  let admin: ReturnType<typeof postgres>;
  let databaseHandle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    databaseHandle = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    tenantA = crypto.randomUUID();
    tenantB = crypto.randomUUID();

    await admin`
      insert into organizations (id, slug, name)
      values (${tenantA}, ${`integration-a-${tenantA}`}, 'Tenant A'), (${tenantB}, ${`integration-b-${tenantB}`}, 'Tenant B')
    `;
    await admin`
      insert into branches (tenant_id, slug, name)
      values (${tenantA}, 'same-branch', 'A branch'), (${tenantB}, 'same-branch', 'B branch')
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from organizations where id = ${tenantA} or id = ${tenantB}`;
      await admin.end({ timeout: 5 });
    }
    if (databaseHandle) await databaseHandle.close();
  });

  it('hides another tenant even when the caller knows its identifier', async () => {
    const contextA: TenantRepositoryContext = { tenantId: tenantA, requestId: 'integration-a' };
    await withTenantTransaction(databaseHandle, contextA, async (transaction) => {
      const repository = new TenantOrganizationRepository(transaction);
      await expect(repository.findById(contextA, tenantA)).resolves.toMatchObject({
        name: 'Tenant A',
      });
      await expect(repository.findById(contextA, tenantB)).resolves.toBeNull();

      const directRows = await transaction.execute<{ id: string }>(sql`
        select id from organizations where id = ${tenantB}
      `);
      expect(directRows).toHaveLength(0);
    });
  });
});
