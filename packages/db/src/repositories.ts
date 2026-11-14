import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from './database.js';
import { TenantRepository } from './tenant-repository.js';
import type { TenantRepositoryContext } from './tenant-context.js';

export interface OrganizationRecord {
  [key: string]: unknown;
  id: string;
  slug: string;
  name: string;
  status: string;
}

export interface MembershipRecord {
  [key: string]: unknown;
  id: string;
  tenantId: string;
  userId: string;
  role: string;
  active: boolean;
}

export interface BranchRecord {
  [key: string]: unknown;
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  active: boolean;
}

export interface PageOptions {
  /** Keyset cursor: last id of the previous page. */
  afterId?: string | undefined;
  /** Defaults to 100, capped at 500. */
  limit?: number | undefined;
}

type QueryExecutor = DatabaseExecutor;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function pageSize(options: PageOptions): number {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('page_limit_invalid');
  return Math.min(Math.trunc(limit), MAX_PAGE_SIZE);
}

export class TenantOrganizationRepository extends TenantRepository {
  public constructor(db: QueryExecutor) {
    super(db);
  }

  public async findById(
    context: TenantRepositoryContext,
    organizationId: string,
  ): Promise<OrganizationRecord | null> {
    this.assertContext(context);
    const rows = await this.db.execute<OrganizationRecord>(sql`
      select id, slug, name, status
      from organizations
      where id = ${organizationId}
        and id = ${context.tenantId}
      limit 1
    `);
    return rows[0] ?? null;
  }

  public async findBySlug(
    context: TenantRepositoryContext,
    slug: string,
  ): Promise<OrganizationRecord | null> {
    this.assertContext(context);
    const rows = await this.db.execute<OrganizationRecord>(sql`
      select id, slug, name, status
      from organizations
      where slug = ${slug}
        and id = ${context.tenantId}
      limit 1
    `);
    return rows[0] ?? null;
  }
}

export class TenantMembershipRepository extends TenantRepository {
  public constructor(db: QueryExecutor) {
    super(db);
  }

  public async findById(
    context: TenantRepositoryContext,
    membershipId: string,
  ): Promise<MembershipRecord | null> {
    this.assertContext(context);
    const rows = await this.db.execute<MembershipRecord>(sql`
      select id, tenant_id as "tenantId", user_id as "userId", role, active
      from memberships
      where id = ${membershipId}
        and tenant_id = ${context.tenantId}
      limit 1
    `);
    return rows[0] ?? null;
  }

  public async findActiveByTenantAndUser(
    context: TenantRepositoryContext,
    userId: string,
  ): Promise<MembershipRecord | null> {
    this.assertContext(context);
    const rows = await this.db.execute<MembershipRecord>(sql`
      select id, tenant_id as "tenantId", user_id as "userId", role, active
      from memberships
      where tenant_id = ${context.tenantId}
        and user_id = ${userId}
        and active = true
      limit 1
    `);
    return rows[0] ?? null;
  }

  public async listForTenant(
    context: TenantRepositoryContext,
    options: PageOptions = {},
  ): Promise<MembershipRecord[]> {
    this.assertContext(context);
    const limit = pageSize(options);
    const afterId = options.afterId ?? null;
    return this.db.execute<MembershipRecord>(sql`
      select id, tenant_id as "tenantId", user_id as "userId", role, active
      from memberships
      where tenant_id = ${context.tenantId}
        and active = true
        and (
          ${afterId}::uuid is null
          or (created_at, id) < (
            select created_at, id from memberships
            where id = ${afterId}::uuid and tenant_id = ${context.tenantId}
          )
        )
      order by created_at desc, id desc
      limit ${limit}
    `);
  }
}

export class TenantBranchRepository extends TenantRepository {
  public constructor(db: QueryExecutor) {
    super(db);
  }

  public async findById(
    context: TenantRepositoryContext,
    branchId: string,
  ): Promise<BranchRecord | null> {
    this.assertContext(context);
    const rows = await this.db.execute<BranchRecord>(sql`
      select id, tenant_id as "tenantId", slug, name, active
      from branches
      where id = ${branchId}
        and tenant_id = ${context.tenantId}
      limit 1
    `);
    return rows[0] ?? null;
  }

  public async findBySlug(
    context: TenantRepositoryContext,
    slug: string,
  ): Promise<BranchRecord | null> {
    this.assertContext(context);
    const rows = await this.db.execute<BranchRecord>(sql`
      select id, tenant_id as "tenantId", slug, name, active
      from branches
      where tenant_id = ${context.tenantId}
        and slug = ${slug}
      limit 1
    `);
    return rows[0] ?? null;
  }

  public async listForTenant(
    context: TenantRepositoryContext,
    options: PageOptions = {},
  ): Promise<BranchRecord[]> {
    this.assertContext(context);
    const limit = pageSize(options);
    const afterId = options.afterId ?? null;
    return this.db.execute<BranchRecord>(sql`
      select id, tenant_id as "tenantId", slug, name, active
      from branches
      where tenant_id = ${context.tenantId}
        and (
          ${afterId}::uuid is null
          or (created_at, id) < (
            select created_at, id from branches
            where id = ${afterId}::uuid and tenant_id = ${context.tenantId}
          )
        )
      order by created_at desc, id desc
      limit ${limit}
    `);
  }
}
