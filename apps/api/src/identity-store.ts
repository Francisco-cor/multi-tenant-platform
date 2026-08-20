import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OidcIdentity } from '@platform/auth';
import type { MembershipStatus, OrganizationStatus, Role } from '@platform/domain';

export type UserStatus = 'active' | 'suspended';

export interface UserRecord {
  id: string;
  subject: string;
  issuer: string;
  email: string;
  displayName: string;
  status: UserStatus;
}

export interface OrganizationRecord {
  id: string;
  slug: string;
  name: string;
  status: OrganizationStatus;
}

export interface BranchRecord {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  status: 'active' | 'archived';
}

export interface MembershipRecord {
  id: string;
  userId: string;
  organizationId: string;
  role: Role;
  status: MembershipStatus;
}

export interface InvitationRecord {
  id: string;
  organizationId: string;
  email: string;
  role: Role;
  tokenHash: string;
  expiresAt: number;
  invitedBy: string;
  acceptedAt?: number;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  selectedTenantId?: string;
}

export interface StoreTenantContext {
  tenantId: string;
  requestId: string;
  userId?: string;
}

export interface AuditRecord {
  id: string;
  action:
    | 'login'
    | 'logout'
    | 'invitation.created'
    | 'invitation.accepted'
    | 'organization.created'
    | 'organization.switched'
    | 'membership.role_changed'
    | 'membership.removed';
  actorUserId: string;
  tenantId?: string;
  resourceId?: string;
  requestId: string;
  at: number;
  metadata?: Record<string, string>;
}

export interface CreateInvitationInput {
  organizationId: string;
  email: string;
  role: Role;
  invitedBy: string;
  expiresInMs?: number;
  context?: StoreTenantContext;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  ownerUserId: string;
  requestId?: string;
}

export interface AcceptInvitationInput {
  rawToken: string;
  userId: string;
  email: string;
  expectedOrganizationId: string;
  context?: StoreTenantContext;
}

export interface CreateInvitationResult {
  invitation: InvitationRecord;
  rawToken: string;
}

export interface IdentityStore {
  getUser(userId: string): UserRecord | PromiseLike<UserRecord | null> | null;
  upsertOidcUser(identity: OidcIdentity): UserRecord | PromiseLike<UserRecord>;
  createSession(userId: string): string | PromiseLike<string>;
  getSession(token: string): SessionRecord | PromiseLike<SessionRecord | null> | null;
  revokeSession(token: string): void | PromiseLike<void>;
  selectTenant(token: string, tenantId: string): void | PromiseLike<void>;
  getOrganizationBySlug(
    slug: string,
  ): OrganizationRecord | PromiseLike<OrganizationRecord | null> | null;
  getOrganization(
    organizationId: string,
  ): OrganizationRecord | PromiseLike<OrganizationRecord | null> | null;
  getActiveMembership(
    context: StoreTenantContext,
    userId: string,
  ): MembershipRecord | PromiseLike<MembershipRecord | null> | null;
  listMembershipsForUser(userId: string): MembershipRecord[] | PromiseLike<MembershipRecord[]>;
  listMembershipsForOrganization(
    context: StoreTenantContext,
  ): MembershipRecord[] | PromiseLike<MembershipRecord[]>;
  listBranches(context: StoreTenantContext): BranchRecord[] | PromiseLike<BranchRecord[]>;
  createOrganization(
    input: CreateOrganizationInput,
  ): OrganizationRecord | PromiseLike<OrganizationRecord>;
  createInvitation(
    input: CreateInvitationInput,
  ): CreateInvitationResult | PromiseLike<CreateInvitationResult>;
  acceptInvitation(input: AcceptInvitationInput): InvitationRecord | PromiseLike<InvitationRecord>;
  getMembership(
    context: StoreTenantContext,
    membershipId: string,
  ): MembershipRecord | PromiseLike<MembershipRecord | null> | null;
  updateMembershipRole(
    context: StoreTenantContext,
    membershipId: string,
    role: Role,
  ): MembershipRecord | PromiseLike<MembershipRecord>;
  removeMembership(
    context: StoreTenantContext,
    membershipId: string,
  ): MembershipRecord | PromiseLike<MembershipRecord>;
  addAudit(record: Omit<AuditRecord, 'id' | 'at'>): AuditRecord | PromiseLike<AuditRecord>;
  listAudit(context: StoreTenantContext): AuditRecord[] | PromiseLike<AuditRecord[]>;
  close?: () => void | PromiseLike<void>;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export class InMemoryIdentityStore {
  readonly users = new Map<string, UserRecord>();
  readonly organizations = new Map<string, OrganizationRecord>();
  readonly branches = new Map<string, BranchRecord>();
  readonly memberships = new Map<string, MembershipRecord>();
  readonly invitations = new Map<string, InvitationRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly auditLog: AuditRecord[] = [];

  constructor(seedDemoData = true) {
    if (seedDemoData) this.seedDemoData();
  }

  private seedDemoData(): void {
    const acme: OrganizationRecord = {
      id: 'tenant-acme',
      slug: 'acme',
      name: 'Acme Industries',
      status: 'active',
    };
    const contoso: OrganizationRecord = {
      id: 'tenant-contoso',
      slug: 'contoso',
      name: 'Contoso Retail',
      status: 'active',
    };
    this.organizations.set(acme.id, acme);
    this.organizations.set(contoso.id, contoso);

    this.addSeedUser('user-alice', 'alice', 'alice@example.test', 'Alice Owner');
    this.addSeedUser('user-acme-only', 'acme-only', 'acme-only@example.test', 'Acme Operator');
    this.addSeedUser(
      'user-contoso-only',
      'contoso-only',
      'contoso-only@example.test',
      'Contoso Owner',
    );
    this.addSeedMembership('membership-alice-acme', 'user-alice', acme.id, 'owner');
    this.addSeedMembership('membership-alice-contoso', 'user-alice', contoso.id, 'manager');
    this.addSeedMembership('membership-acme-only', 'user-acme-only', acme.id, 'operator');
    this.addSeedMembership('membership-contoso-only', 'user-contoso-only', contoso.id, 'owner');
    this.addSeedBranch('branch-acme-main', acme.id, 'main', 'Acme Main');
    this.addSeedBranch('branch-contoso-main', contoso.id, 'main', 'Contoso Main');
  }

  private addSeedUser(id: string, subject: string, email: string, displayName: string): void {
    this.users.set(id, {
      id,
      subject,
      issuer: 'http://localhost:5556/dex',
      email,
      displayName,
      status: 'active',
    });
  }

  private addSeedMembership(id: string, userId: string, organizationId: string, role: Role): void {
    this.memberships.set(id, { id, userId, organizationId, role, status: 'active' });
  }

  private addSeedBranch(id: string, organizationId: string, slug: string, name: string): void {
    this.branches.set(id, { id, organizationId, slug, name, status: 'active' });
  }

  upsertOidcUser(identity: OidcIdentity): UserRecord {
    const existing = [...this.users.values()].find(
      (user) => user.issuer === identity.issuer && user.subject === identity.subject,
    );
    if (existing) {
      existing.email = normalizeEmail(identity.email);
      existing.displayName = identity.displayName ?? existing.displayName;
      return existing;
    }
    const user: UserRecord = {
      id: newId('user'),
      subject: identity.subject,
      issuer: identity.issuer,
      email: normalizeEmail(identity.email),
      displayName: identity.displayName ?? identity.email,
      status: 'active',
    };
    this.users.set(user.id, user);
    return user;
  }

  getUser(userId: string): UserRecord | null {
    return this.users.get(userId) ?? null;
  }

  getUserByEmail(email: string): UserRecord | null {
    const normalizedEmail = normalizeEmail(email);
    return [...this.users.values()].find((user) => user.email === normalizedEmail) ?? null;
  }

  createSession(userId: string, now = Date.now()): string {
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = {
      tokenHash: hashToken(token),
      userId,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(record.tokenHash, record);
    return token;
  }

  getSession(token: string, now = Date.now()): SessionRecord | null {
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= now) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return session;
  }

  revokeSession(token: string): void {
    this.sessions.delete(hashToken(token));
  }

  selectTenant(token: string, tenantId: string): void {
    const session = this.getSession(token);
    if (!session) throw new Error('session_not_found');
    session.selectedTenantId = tenantId;
  }

  getOrganizationBySlug(slug: string): OrganizationRecord | null {
    return (
      [...this.organizations.values()].find((organization) => organization.slug === slug) ?? null
    );
  }

  getOrganization(organizationId: string): OrganizationRecord | null {
    return this.organizations.get(organizationId) ?? null;
  }

  getMembership(
    contextOrMembershipId: StoreTenantContext | string,
    maybeMembershipId?: string,
  ): MembershipRecord | null {
    const membershipId =
      typeof contextOrMembershipId === 'string' ? contextOrMembershipId : maybeMembershipId;
    return membershipId ? (this.memberships.get(membershipId) ?? null) : null;
  }

  getActiveMembership(
    contextOrUserId: StoreTenantContext | string,
    userIdOrOrganizationId: string,
  ): MembershipRecord | null {
    const userId = typeof contextOrUserId === 'string' ? contextOrUserId : userIdOrOrganizationId;
    const organizationId =
      typeof contextOrUserId === 'string' ? userIdOrOrganizationId : contextOrUserId.tenantId;
    return (
      [...this.memberships.values()].find(
        (membership) =>
          membership.userId === userId &&
          membership.organizationId === organizationId &&
          membership.status === 'active',
      ) ?? null
    );
  }

  listMembershipsForUser(userId: string): MembershipRecord[] {
    return [...this.memberships.values()].filter(
      (membership) => membership.userId === userId && membership.status === 'active',
    );
  }

  listMembershipsForOrganization(
    contextOrOrganizationId: StoreTenantContext | string,
  ): MembershipRecord[] {
    const organizationId =
      typeof contextOrOrganizationId === 'string'
        ? contextOrOrganizationId
        : contextOrOrganizationId.tenantId;
    return [...this.memberships.values()].filter(
      (membership) =>
        membership.organizationId === organizationId && membership.status !== 'removed',
    );
  }

  listBranches(contextOrOrganizationId: StoreTenantContext | string): BranchRecord[] {
    const organizationId =
      typeof contextOrOrganizationId === 'string'
        ? contextOrOrganizationId
        : contextOrOrganizationId.tenantId;
    return [...this.branches.values()].filter((branch) => branch.organizationId === organizationId);
  }

  createOrganization(input: CreateOrganizationInput): OrganizationRecord {
    if (this.getOrganizationBySlug(input.slug)) throw new Error('organization_slug_taken');
    const organization: OrganizationRecord = {
      id: newId('tenant'),
      slug: input.slug,
      name: input.name,
      status: 'active',
    };
    this.organizations.set(organization.id, organization);
    const membershipId = newId('membership');
    this.memberships.set(membershipId, {
      id: membershipId,
      userId: input.ownerUserId,
      organizationId: organization.id,
      role: 'owner',
      status: 'active',
    });
    return organization;
  }

  createInvitation(input: CreateInvitationInput): CreateInvitationResult {
    const email = normalizeEmail(input.email);
    const existing = [...this.memberships.values()].find((membership) => {
      const user = this.users.get(membership.userId);
      return (
        membership.organizationId === input.organizationId &&
        membership.status === 'active' &&
        user?.email === email
      );
    });
    if (existing) throw new Error('member_already_exists');

    const rawToken = randomBytes(32).toString('base64url');
    const invitation: InvitationRecord = {
      id: newId('invitation'),
      organizationId: input.organizationId,
      email,
      role: input.role,
      tokenHash: hashToken(rawToken),
      expiresAt: Date.now() + (input.expiresInMs ?? INVITATION_TTL_MS),
      invitedBy: input.invitedBy,
    };
    this.invitations.set(invitation.id, invitation);
    return { invitation, rawToken };
  }

  acceptInvitation(input: AcceptInvitationInput): InvitationRecord {
    const tokenHash = hashToken(input.rawToken);
    const invitation = [...this.invitations.values()].find(
      (candidate) => candidate.tokenHash === tokenHash,
    );
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= Date.now()) {
      throw new Error('invitation_invalid');
    }
    if (invitation.organizationId !== input.expectedOrganizationId)
      throw new Error('invitation_invalid');
    if (invitation.email !== normalizeEmail(input.email))
      throw new Error('invitation_email_mismatch');

    const existing = this.getActiveMembership(input.userId, invitation.organizationId);
    if (existing) {
      invitation.acceptedAt = Date.now();
      return invitation;
    }

    const membership: MembershipRecord = {
      id: newId('membership'),
      userId: input.userId,
      organizationId: invitation.organizationId,
      role: invitation.role,
      status: 'active',
    };
    this.memberships.set(membership.id, membership);
    invitation.acceptedAt = Date.now();
    return invitation;
  }

  updateMembershipRole(
    contextOrMembershipId: StoreTenantContext | string,
    membershipIdOrRole: string,
    maybeRole?: Role,
  ): MembershipRecord {
    const membershipId =
      typeof contextOrMembershipId === 'string' ? contextOrMembershipId : membershipIdOrRole;
    const role =
      typeof contextOrMembershipId === 'string' ? (membershipIdOrRole as Role) : maybeRole;
    if (!role) throw new Error('membership_role_required');
    const membership = this.memberships.get(membershipId);
    if (!membership || membership.status !== 'active') throw new Error('membership_not_found');
    if (membership.role === 'owner' && role !== 'owner') {
      const otherOwner = [...this.memberships.values()].some(
        (candidate) =>
          candidate.organizationId === membership.organizationId &&
          candidate.id !== membership.id &&
          candidate.role === 'owner' &&
          candidate.status === 'active',
      );
      if (!otherOwner) throw new Error('last_owner');
    }
    membership.role = role;
    return membership;
  }

  removeMembership(
    contextOrMembershipId: StoreTenantContext | string,
    maybeMembershipId?: string,
  ): MembershipRecord {
    const membershipId =
      typeof contextOrMembershipId === 'string' ? contextOrMembershipId : maybeMembershipId;
    if (!membershipId) throw new Error('membership_id_required');
    const membership = this.memberships.get(membershipId);
    if (!membership || membership.status !== 'active') throw new Error('membership_not_found');
    if (membership.role === 'owner') {
      const otherOwner = [...this.memberships.values()].some(
        (candidate) =>
          candidate.organizationId === membership.organizationId &&
          candidate.id !== membership.id &&
          candidate.role === 'owner' &&
          candidate.status === 'active',
      );
      if (!otherOwner) throw new Error('last_owner');
    }
    membership.status = 'removed';
    return membership;
  }

  addAudit(record: Omit<AuditRecord, 'id' | 'at'>): AuditRecord {
    const audit: AuditRecord = { ...record, id: newId('audit'), at: Date.now() };
    this.auditLog.push(audit);
    return audit;
  }

  listAudit(contextOrTenantId: StoreTenantContext | string): AuditRecord[] {
    const tenantId =
      typeof contextOrTenantId === 'string' ? contextOrTenantId : contextOrTenantId.tenantId;
    return this.auditLog.filter((record) => record.tenantId === tenantId);
  }
}
