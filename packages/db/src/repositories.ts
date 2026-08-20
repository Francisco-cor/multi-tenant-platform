import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from './database.js';
import { assertTenantRepositoryContext, type TenantRepositoryContext } from './tenant-context.js';

export interface OrganizationRecord {
  [key: string]: unknown;
  id: string;
  slug: string;
  name: string;
  status: string;
}

type QueryExecutor = DatabaseExecutor;

export class TenantOrganizationRepository {
  public constructor(private readonly db: QueryExecutor) {}

  public async findById(
    context: TenantRepositoryContext,
    organizationId: string,
  ): Promise<OrganizationRecord | null> {
    assertTenantRepositoryContext(context);

    const rows = await this.db.execute<OrganizationRecord>(sql`
      select id, slug, name, status
      from organizations
      where id = ${organizationId}
        and id = ${context.tenantId}
      limit 1
    `);

    return rows[0] ?? null;
  }
}
