import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import type { OidcIdentity } from '@platform/auth';
import {
  createDatabase,
  withTenantTransaction,
  type DatabaseExecutor,
  type DatabaseHandle,
  type TenantRepositoryContext,
} from '@platform/db';
import type { MembershipStatus, OrganizationStatus, Role } from '@platform/domain';
import type {
  AcceptInvitationInput,
  AuditRecord,
  BranchRecord,
  CreateInvitationInput,
  CreateInvitationResult,
  CreateOrganizationInput,
  IdentityStore,
  InvitationRecord,
  MembershipRecord,
  OrganizationRecord,
  SessionRecord,
  StoreTenantContext,
  UserRecord,
} from './identity-store.js';

interface UserRow extends Record<string, unknown> {
  id: string;
  oidc_issuer: string;
  oidc_subject: string;
  email: string;
  display_name: string;
  active: boolean;
}

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  status: string;
}

interface MembershipRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
  active: boolean;
}

interface BranchRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  active: boolean;
}

interface SessionRow extends Record<string, unknown> {
  token_hash: string;
  user_id: string;
  expires_at: Date | string;
  selected_tenant_id: string | null;
}

interface InvitationRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  token_hash: string;
  expires_at: Date | string;
  invited_by: string;
  accepted_at: Date | string | null;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  tenant_id: string | null;
  actor_user_id: string;
  action: AuditRecord['action'];
  resource_id: string | null;
  request_id: string;
  created_at: Date | string;
  metadata: Record<string, string>;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function timestampToMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    subject: row.oidc_subject,
    issuer: row.oidc_issuer,
    email: row.email,
    displayName: row.display_name,
    status: row.active ? 'active' : 'suspended',
  };
}

function mapOrganization(row: OrganizationRow): OrganizationRecord {
  const status: OrganizationStatus =
    row.status === 'deleted' ? 'archived' : (row.status as OrganizationStatus);
  return { id: row.id, slug: row.slug, name: row.name, status };
}

function mapMembership(row: MembershipRow): MembershipRecord {
  const status: MembershipStatus = row.active ? 'active' : 'removed';
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.tenant_id,
    role: row.role as Role,
    status,
  };
}

function mapBranch(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    organizationId: row.tenant_id,
    slug: row.slug,
    name: row.name,
    status: row.active ? 'active' : 'archived',
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    expiresAt: timestampToMillis(row.expires_at),
    ...(row.selected_tenant_id ? { selectedTenantId: row.selected_tenant_id } : {}),
  };
}

function mapInvitation(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    organizationId: row.tenant_id,
    email: row.email,
    role: row.role as Role,
    tokenHash: row.token_hash,
    expiresAt: timestampToMillis(row.expires_at),
    invitedBy: row.invited_by,
    ...(row.accepted_at ? { acceptedAt: timestampToMillis(row.accepted_at) } : {}),
  };
}

function mapAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    action: row.action,
    actorUserId: row.actor_user_id,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    requestId: row.request_id,
    at: timestampToMillis(row.created_at),
    metadata: row.metadata,
  };
}

function toRepositoryContext(context: StoreTenantContext): TenantRepositoryContext {
  return context;
}

export class PersistentIdentityStore implements IdentityStore {
  public constructor(private readonly database: DatabaseHandle) {
    if (!database.role) throw new Error('database_role_required');
  }

  public static fromConnectionString(
    connectionString: string,
    role = 'platform_app',
  ): PersistentIdentityStore {
    return new PersistentIdentityStore(createDatabase(connectionString, { role }));
  }

  public close(): Promise<void> {
    return this.database.close();
  }

  private async withApplicationTransaction<T>(
    callback: (transaction: DatabaseExecutor) => Promise<T>,
  ): Promise<T> {
    const role = this.database.role;
    if (!role) throw new Error('database_role_required');
    return this.database.db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(`set local role "${role}"`));
      return callback(transaction);
    });
  }

  private withTenant<T>(
    context: StoreTenantContext,
    callback: (transaction: DatabaseExecutor) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.database, toRepositoryContext(context), callback);
  }

  public async getUser(userId: string): Promise<UserRecord | null> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<UserRow>(sql`
        select id, oidc_issuer, oidc_subject, email, display_name, active
        from users
        where id = ${userId}
        limit 1
      `);
      return rows[0] ? mapUser(rows[0]) : null;
    });
  }

  public async upsertOidcUser(identity: OidcIdentity): Promise<UserRecord> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<UserRow>(sql`
        insert into users (oidc_issuer, oidc_subject, email, display_name, active)
        values (${identity.issuer}, ${identity.subject}, ${normalizeEmail(identity.email)}, ${identity.displayName ?? identity.email}, true)
        on conflict (oidc_issuer, oidc_subject)
        do update set
          email = excluded.email,
          display_name = excluded.display_name,
          active = true,
          updated_at = now()
        returning id, oidc_issuer, oidc_subject, email, display_name, active
      `);
      const row = rows[0];
      if (!row) throw new Error('user_upsert_failed');
      return mapUser(row);
    });
  }

  public async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.withApplicationTransaction(async (transaction) => {
      await transaction.execute(sql`
        insert into sessions (token_hash, user_id, expires_at)
        values (${hashToken(token)}, ${userId}, ${new Date(Date.now() + SESSION_TTL_MS).toISOString()})
      `);
      return undefined;
    });
    return token;
  }

  public async getSession(token: string): Promise<SessionRecord | null> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<SessionRow>(sql`
        select token_hash, user_id, expires_at, selected_tenant_id
        from sessions
        where token_hash = ${hashToken(token)}
          and expires_at > now()
        limit 1
      `);
      return rows[0] ? mapSession(rows[0]) : null;
    });
  }

  public async revokeSession(token: string): Promise<void> {
    await this.withApplicationTransaction(async (transaction) => {
      await transaction.execute(sql`delete from sessions where token_hash = ${hashToken(token)}`);
      return undefined;
    });
  }

  public async refreshSession(token: string): Promise<SessionRecord | null> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<SessionRow>(sql`
        update sessions
        set expires_at = now() + interval '8 hours'
        where token_hash = ${hashToken(token)}
          and expires_at > now()
        returning token_hash, user_id, expires_at, selected_tenant_id
      `);
      return rows[0] ? mapSession(rows[0]) : null;
    });
  }

  public async selectTenant(token: string, tenantId: string): Promise<void> {
    await this.withApplicationTransaction(async (transaction) => {
      await transaction.execute(sql`
        update sessions
        set selected_tenant_id = ${tenantId}
        where token_hash = ${hashToken(token)}
          and expires_at > now()
      `);
      return undefined;
    });
  }

  public async getOrganizationBySlug(slug: string): Promise<OrganizationRecord | null> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<OrganizationRow>(sql`
        select id, slug, name, status
        from platform_resolve_organization_by_slug(${slug})
      `);
      return rows[0] ? mapOrganization(rows[0]) : null;
    });
  }

  public async getOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<OrganizationRow>(sql`
        select id, slug, name, status
        from platform_get_organization_by_id(${organizationId}::uuid)
      `);
      return rows[0] ? mapOrganization(rows[0]) : null;
    });
  }

  public async getActiveMembership(
    context: StoreTenantContext,
    userId: string,
  ): Promise<MembershipRecord | null> {
    return this.withTenant(context, async (transaction) => {
      const rows = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from memberships
        where tenant_id = ${context.tenantId}::uuid
          and user_id = ${userId}::uuid
          and active = true
        limit 1
      `);
      return rows[0] ? mapMembership(rows[0]) : null;
    });
  }

  public async listMembershipsForUser(userId: string): Promise<MembershipRecord[]> {
    return this.withApplicationTransaction(async (transaction) => {
      const rows = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from platform_list_memberships_for_user(${userId}::uuid)
      `);
      return rows.map(mapMembership);
    });
  }

  public async listMembershipsForOrganization(
    context: StoreTenantContext,
  ): Promise<MembershipRecord[]> {
    return this.withTenant(context, async (transaction) => {
      const rows = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from memberships
        where tenant_id = ${context.tenantId}::uuid
          and active = true
        order by created_at, id
      `);
      return rows.map(mapMembership);
    });
  }

  public async listBranches(context: StoreTenantContext): Promise<BranchRecord[]> {
    return this.withTenant(context, async (transaction) => {
      const rows = await transaction.execute<BranchRow>(sql`
        select id, tenant_id, slug, name, active
        from branches
        where tenant_id = ${context.tenantId}::uuid
        order by slug, id
      `);
      return rows.map(mapBranch);
    });
  }

  public async createOrganization(input: CreateOrganizationInput): Promise<OrganizationRecord> {
    const organizationId = randomUUID();
    const context: StoreTenantContext = {
      tenantId: organizationId,
      requestId: input.requestId ?? 'organization.create',
      userId: input.ownerUserId,
    };
    try {
      return await this.withTenant(context, async (transaction) => {
        const organizationRows = await transaction.execute<OrganizationRow>(sql`
          insert into organizations (id, slug, name, status, created_by)
          values (${organizationId}::uuid, ${input.slug}, ${input.name}, 'active', ${input.ownerUserId}::uuid)
          returning id, slug, name, status
        `);
        await transaction.execute(sql`
          insert into memberships (tenant_id, user_id, role, active, created_by)
          values (${organizationId}::uuid, ${input.ownerUserId}::uuid, 'owner', true, ${input.ownerUserId}::uuid)
        `);
        const organization = organizationRows[0];
        if (!organization) throw new Error('organization_create_failed');
        return mapOrganization(organization);
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) throw new Error('organization_slug_taken');
      throw error;
    }
  }

  public async createInvitation(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    const context = input.context ?? {
      tenantId: input.organizationId,
      requestId: 'invitation.create',
      userId: input.invitedBy,
    };
    if (context.tenantId !== input.organizationId) throw new Error('tenant_context_mismatch');
    return this.withTenant(context, async (transaction) => {
      const existing = await transaction.execute<{ id: string }>(sql`
        select m.id
        from memberships m
        join users u on u.id = m.user_id
        where m.tenant_id = ${input.organizationId}::uuid
          and m.active = true
          and lower(u.email) = ${normalizeEmail(input.email)}
        limit 1
      `);
      if (existing[0]) throw new Error('member_already_exists');

      const rawToken = randomBytes(32).toString('base64url');
      const invitationRows = await transaction.execute<InvitationRow>(sql`
        insert into invitations (tenant_id, email, role, token_hash, expires_at, invited_by)
        values (
          ${input.organizationId}::uuid,
          ${normalizeEmail(input.email)},
          ${input.role},
          ${hashToken(rawToken)},
          ${new Date(Date.now() + (input.expiresInMs ?? INVITATION_TTL_MS)).toISOString()},
          ${input.invitedBy}::uuid
        )
        returning id, tenant_id, email, role, token_hash, expires_at, invited_by, accepted_at
      `);
      const invitation = invitationRows[0];
      if (!invitation) throw new Error('invitation_create_failed');
      return { invitation: mapInvitation(invitation), rawToken };
    });
  }

  public async acceptInvitation(input: AcceptInvitationInput): Promise<InvitationRecord> {
    const context = input.context ?? {
      tenantId: input.expectedOrganizationId,
      requestId: 'invitation.accept',
      userId: input.userId,
    };
    if (context.tenantId !== input.expectedOrganizationId)
      throw new Error('tenant_context_mismatch');
    return this.withTenant(context, async (transaction) => {
      const rows = await transaction.execute<InvitationRow>(sql`
        select id, tenant_id, email, role, token_hash, expires_at, invited_by, accepted_at
        from invitations
        where tenant_id = ${input.expectedOrganizationId}::uuid
          and token_hash = ${hashToken(input.rawToken)}
        for update
      `);
      const invitation = rows[0];
      if (
        !invitation ||
        invitation.accepted_at ||
        timestampToMillis(invitation.expires_at) <= Date.now()
      ) {
        throw new Error('invitation_invalid');
      }
      if (invitation.email !== normalizeEmail(input.email)) {
        throw new Error('invitation_email_mismatch');
      }

      const existing = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from memberships
        where tenant_id = ${input.expectedOrganizationId}::uuid
          and user_id = ${input.userId}::uuid
          and active = true
        limit 1
      `);
      await transaction.execute(sql`
        update invitations set accepted_at = now() where id = ${invitation.id}::uuid
      `);
      if (!existing[0]) {
        await transaction.execute(sql`
          insert into memberships (tenant_id, user_id, role, active)
          values (${input.expectedOrganizationId}::uuid, ${input.userId}::uuid, ${invitation.role}, true)
        `);
      }
      return {
        ...mapInvitation(invitation),
        acceptedAt: Date.now(),
      };
    });
  }

  public async getMembership(
    context: StoreTenantContext,
    membershipId: string,
  ): Promise<MembershipRecord | null> {
    return this.withTenant(context, async (transaction) => {
      const rows = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from memberships
        where id = ${membershipId}::uuid
          and tenant_id = ${context.tenantId}::uuid
        limit 1
      `);
      return rows[0] ? mapMembership(rows[0]) : null;
    });
  }

  public async updateMembershipRole(
    context: StoreTenantContext,
    membershipId: string,
    role: Role,
  ): Promise<MembershipRecord> {
    return this.withTenant(context, async (transaction) => {
      const currentRows = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from memberships
        where id = ${membershipId}::uuid
          and tenant_id = ${context.tenantId}::uuid
        for update
      `);
      const current = currentRows[0];
      if (!current || !current.active) throw new Error('membership_not_found');
      if (current.role === 'owner' && role !== 'owner') {
        const owners = await transaction.execute<{ count: string }>(sql`
          select count(*)::text as count
          from memberships
          where tenant_id = ${context.tenantId}::uuid
            and active = true
            and role = 'owner'
            and id <> ${membershipId}::uuid
        `);
        if (owners[0]?.count === '0') throw new Error('last_owner');
      }
      const rows = await transaction.execute<MembershipRow>(sql`
        update memberships
        set role = ${role}, updated_at = now()
        where id = ${membershipId}::uuid
          and tenant_id = ${context.tenantId}::uuid
        returning id, tenant_id, user_id, role, active
      `);
      const updated = rows[0];
      if (!updated) throw new Error('membership_not_found');
      return mapMembership(updated);
    });
  }

  public async removeMembership(
    context: StoreTenantContext,
    membershipId: string,
  ): Promise<MembershipRecord> {
    return this.withTenant(context, async (transaction) => {
      const currentRows = await transaction.execute<MembershipRow>(sql`
        select id, tenant_id, user_id, role, active
        from memberships
        where id = ${membershipId}::uuid
          and tenant_id = ${context.tenantId}::uuid
        for update
      `);
      const current = currentRows[0];
      if (!current || !current.active) throw new Error('membership_not_found');
      if (current.role === 'owner') {
        const owners = await transaction.execute<{ count: string }>(sql`
          select count(*)::text as count
          from memberships
          where tenant_id = ${context.tenantId}::uuid
            and active = true
            and role = 'owner'
            and id <> ${membershipId}::uuid
        `);
        if (owners[0]?.count === '0') throw new Error('last_owner');
      }
      const rows = await transaction.execute<MembershipRow>(sql`
        update memberships
        set active = false, updated_at = now()
        where id = ${membershipId}::uuid
          and tenant_id = ${context.tenantId}::uuid
        returning id, tenant_id, user_id, role, active
      `);
      const removed = rows[0];
      if (!removed) throw new Error('membership_not_found');
      return mapMembership(removed);
    });
  }

  public async addAudit(record: Omit<AuditRecord, 'id' | 'at'>): Promise<AuditRecord> {
    const insert = async (transaction: DatabaseExecutor): Promise<AuditRecord> => {
      const rows = await transaction.execute<AuditRow>(sql`
        insert into audit_log (tenant_id, actor_user_id, action, resource_id, request_id, metadata)
        values (
          ${record.tenantId ? sql`${record.tenantId}::uuid` : sql`null`},
          ${record.actorUserId}::uuid,
          ${record.action},
          ${record.resourceId ? sql`${record.resourceId}::uuid` : sql`null`},
          ${record.requestId},
          ${JSON.stringify(record.metadata ?? {})}::jsonb
        )
        returning id, tenant_id, actor_user_id, action, resource_id, request_id, created_at, metadata
      `);
      const row = rows[0];
      if (!row) throw new Error('audit_create_failed');
      return mapAudit(row);
    };
    if (record.tenantId) {
      return this.withTenant(
        { tenantId: record.tenantId, requestId: record.requestId, userId: record.actorUserId },
        insert,
      );
    }
    return this.withApplicationTransaction(insert);
  }

  public async listAudit(context: StoreTenantContext): Promise<AuditRecord[]> {
    return this.withTenant(context, async (transaction) => {
      const rows = await transaction.execute<AuditRow>(sql`
        select id, tenant_id, actor_user_id, action, resource_id, request_id, created_at, metadata
        from audit_log
        where tenant_id = ${context.tenantId}::uuid
        order by created_at, id
      `);
      return rows.map(mapAudit);
    });
  }
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
