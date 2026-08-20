import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  createOidcAuthorizationRequest,
  discoverOidcProvider,
  exchangeOidcCode,
  InMemoryOidcStateStore,
  resolveTenantFromHost,
  validateOidcIdToken,
  type OidcIdentity,
  type OidcJsonWebKey,
  type OidcStateRecord,
} from '@platform/auth';
import { API_VERSION, metaResponse } from '@platform/contracts';
import { PERMISSIONS, rolesHavePermission, type Permission, type Role } from '@platform/domain';
import { z } from 'zod';
import {
  InMemoryIdentityStore,
  type AuditRecord,
  type BranchRecord,
  type MembershipRecord,
  type OrganizationRecord,
  type UserRecord,
} from './identity-store.js';

const SESSION_COOKIE = 'platform_session';
const OIDC_STATE_COOKIE = 'oidc_state';
const DEFAULT_BASE_DOMAIN = 'app.localhost';
const DEFAULT_OIDC_REDIRECT_URI = 'http://api.localhost:4000/v1/auth/callback';

const DevLoginSchema = z.object({ userId: z.string().min(1) });
const OrganizationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(63),
});
const InvitationCreateSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['owner', 'admin', 'manager', 'operator', 'auditor']),
});
const RoleUpdateSchema = z.object({
  role: z.enum(['owner', 'admin', 'manager', 'operator', 'auditor']),
});
const TenantSwitchSchema = z.object({ slug: z.string().min(1).max(63) });
const CallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

class RequestProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface SessionAuth {
  token: string;
  user: UserRecord;
  session: NonNullable<ReturnType<InMemoryIdentityStore['getSession']>>;
}

interface TenantContext extends SessionAuth {
  tenantId: string;
  organization: OrganizationRecord;
  membership: MembershipRecord;
  roles: readonly Role[];
}

interface AppOptions {
  store?: InMemoryIdentityStore;
  baseDomain?: string;
  allowDevLogin?: boolean;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    redirectUri?: string;
    authorizationEndpoint?: string;
  };
  oidcAuthenticator?: (input: { code: string; state: OidcStateRecord }) => Promise<OidcIdentity>;
}

function errorBody(
  requestId: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details ? { details } : {}),
    },
  };
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) return [];
      const name = part.slice(0, separator).trim();
      try {
        return [[name, decodeURIComponent(part.slice(separator + 1).trim())]];
      } catch {
        return [];
      }
    }),
  );
}
function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function stateCookie(state: string, secure: boolean): string {
  return `${OIDC_STATE_COOKIE}=${encodeURIComponent(state)}; HttpOnly; Path=/v1/auth; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}

function clearStateCookie(secure: boolean): string {
  return `${OIDC_STATE_COOKIE}=; HttpOnly; Path=/v1/auth; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function requestToken(request: FastifyRequest): string | null {
  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestProblem(400, 'VALIDATION_ERROR', 'Request validation failed', {
      issues: result.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    });
  }
  return result.data;
}

function userView(user: UserRecord) {
  return { id: user.id, email: user.email, displayName: user.displayName, status: user.status };
}

function organizationView(organization: OrganizationRecord) {
  return {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    status: organization.status,
  };
}

function membershipView(
  membership: MembershipRecord,
  store: InMemoryIdentityStore,
): Record<string, unknown> {
  const user = store.getUser(membership.userId);
  return {
    id: membership.id,
    userId: membership.userId,
    email: user?.email,
    displayName: user?.displayName,
    role: membership.role,
    status: membership.status,
  };
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const store = options.store ?? new InMemoryIdentityStore(true);
  const stateStore = new InMemoryOidcStateStore();
  const baseDomain = options.baseDomain ?? process.env.TENANT_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN;
  const allowDevLogin = options.allowDevLogin ?? process.env.NODE_ENV !== 'production';
  const oidc = options.oidc ?? {
    issuer: process.env.OIDC_ISSUER_URL ?? '',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    ...(process.env.OIDC_CLIENT_SECRET ? { clientSecret: process.env.OIDC_CLIENT_SECRET } : {}),
    redirectUri: process.env.OIDC_REDIRECT_URI ?? DEFAULT_OIDC_REDIRECT_URI,
    ...(process.env.OIDC_AUTHORIZATION_ENDPOINT
      ? { authorizationEndpoint: process.env.OIDC_AUTHORIZATION_ENDPOINT }
      : {}),
  };
  const secureCookies = process.env.NODE_ENV === 'production';

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1024 * 1024,
  });

  const requireSession = (request: FastifyRequest): SessionAuth => {
    const token = requestToken(request);
    if (!token) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const session = store.getSession(token);
    if (!session) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const user = store.getUser(session.userId);
    if (!user) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    if (user.status !== 'active') {
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    }
    return { token, user, session };
  };

  const requireTenantContext = (request: FastifyRequest): TenantContext => {
    const auth = requireSession(request);
    const resolution = resolveTenantFromHost(request.headers.host, baseDomain, '');
    if (!resolution) {
      throw new RequestProblem(400, 'TENANT_REQUIRED', 'A valid tenant host is required');
    }
    const organization = store.getOrganizationBySlug(resolution.tenantSlug);
    if (!organization || organization.status !== 'active') {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    const membership = store.getActiveMembership(auth.user.id, organization.id);
    if (!membership) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Access denied');
    }
    const memberships = store.listMembershipsForUser(auth.user.id);
    if (memberships.length > 1 && !auth.session.selectedTenantId) {
      throw new RequestProblem(
        409,
        'ORGANIZATION_SELECTION_REQUIRED',
        'Select an organization explicitly',
        {
          organizations: memberships.flatMap((candidate) => {
            const candidateOrganization = store.getOrganization(candidate.organizationId);
            return candidateOrganization ? [organizationView(candidateOrganization)] : [];
          }),
        },
      );
    }
    if (auth.session.selectedTenantId && auth.session.selectedTenantId !== organization.id) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Select this organization before using its host');
    }
    return {
      ...auth,
      tenantId: organization.id,
      organization,
      membership,
      roles: [membership.role],
    };
  };

  const requirePermission = (context: TenantContext, permission: Permission): void => {
    if (!rolesHavePermission(context.roles, permission)) {
      throw new RequestProblem(403, 'FORBIDDEN', 'You do not have permission for this action');
    }
  };

  const createOidcIdentity = async (
    code: string,
    state: OidcStateRecord,
  ): Promise<OidcIdentity> => {
    if (options.oidcAuthenticator) return options.oidcAuthenticator({ code, state });
    if (!oidc.issuer || !oidc.clientId) {
      throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'OIDC is not configured');
    }
    const metadata = await discoverOidcProvider(oidc.issuer);
    const { idToken } = await exchangeOidcCode({
      metadata,
      code,
      clientId: oidc.clientId,
      ...(oidc.clientSecret ? { clientSecret: oidc.clientSecret } : {}),
      redirectUri: state.redirectUri,
    });
    const keyResponse = await fetch(metadata.jwksUri, { headers: { accept: 'application/json' } });
    if (!keyResponse.ok) throw new Error('oidc_jwks_failed');
    const keyPayload = (await keyResponse.json()) as { keys?: unknown };
    if (!Array.isArray(keyPayload.keys)) throw new Error('oidc_jwks_invalid');
    return validateOidcIdToken(idToken, keyPayload.keys as OidcJsonWebKey[], {
      issuer: metadata.issuer,
      clientId: oidc.clientId,
      nonce: state.nonce,
    });
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/health/live', async () => ({ status: 'ok', service: 'api' }));
  app.get('/health/ready', async () => ({ status: 'ok', service: 'api', dependencies: [] }));
  app.get('/v1/meta', async () => ({ ...metaResponse, apiVersion: API_VERSION }));

  app.get('/v1/auth/login', async (_request, reply) => {
    if (!oidc.issuer || !oidc.clientId) {
      throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'OIDC is not configured');
    }
    const authorizationEndpoint =
      oidc.authorizationEndpoint ?? (await discoverOidcProvider(oidc.issuer)).authorizationEndpoint;
    const request = createOidcAuthorizationRequest({
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      redirectUri: oidc.redirectUri ?? DEFAULT_OIDC_REDIRECT_URI,
      authorizationEndpoint,
    });
    stateStore.issue({
      state: request.state,
      nonce: request.nonce,
      redirectUri: oidc.redirectUri ?? DEFAULT_OIDC_REDIRECT_URI,
    });
    reply.header('set-cookie', stateCookie(request.state, secureCookies));
    return reply.redirect(request.url);
  });

  app.get('/v1/auth/callback', async (request, reply) => {
    const query = parseOrThrow(CallbackQuerySchema, request.query);
    if (query.error || !query.code || !query.state) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'OIDC callback was not completed');
    }
    const cookies = parseCookieHeader(request.headers.cookie);
    if (cookies[OIDC_STATE_COOKIE] !== query.state) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid OIDC state');
    }
    const state = stateStore.consume(query.state);
    if (!state) throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid or expired OIDC state');

    const identity = await createOidcIdentity(query.code, state);
    const user = store.upsertOidcUser(identity);
    if (user.status !== 'active')
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    const token = store.createSession(user.id);
    store.addAudit({
      action: 'login',
      actorUserId: user.id,
      requestId: request.id,
      metadata: { issuer: identity.issuer },
    });
    reply.header('set-cookie', [
      sessionCookie(token, secureCookies),
      clearStateCookie(secureCookies),
    ]);
    return reply.redirect(process.env.WEB_PUBLIC_URL ?? 'http://app.localhost:3000');
  });

  app.post('/v1/auth/dev-login', async (request, reply) => {
    if (!allowDevLogin) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    const body = parseOrThrow(DevLoginSchema, request.body);
    const user = store.getUser(body.userId);
    if (!user || user.status !== 'active')
      throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const token = store.createSession(user.id);
    store.addAudit({ action: 'login', actorUserId: user.id, requestId: request.id });
    reply.header('set-cookie', sessionCookie(token, secureCookies));
    return {
      user: userView(user),
      organizations: store.listMembershipsForUser(user.id).flatMap((membership) => {
        const organization = store.getOrganization(membership.organizationId);
        return organization ? [organizationView(organization)] : [];
      }),
    };
  });

  app.get('/v1/auth/me', async (request) => {
    const auth = requireSession(request);
    return {
      user: userView(auth.user),
      organizations: store.listMembershipsForUser(auth.user.id).flatMap((membership) => {
        const organization = store.getOrganization(membership.organizationId);
        return organization ? [{ ...organizationView(organization), role: membership.role }] : [];
      }),
      selectedOrganizationId: auth.session.selectedTenantId ?? null,
    };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = requestToken(request);
    if (token) {
      const session = store.getSession(token);
      if (session) {
        store.addAudit({ action: 'logout', actorUserId: session.userId, requestId: request.id });
        store.revokeSession(token);
      }
    }
    reply.header('set-cookie', clearSessionCookie(secureCookies));
    return { status: 'ok' };
  });

  app.post('/v1/auth/switch-organization', async (request) => {
    const auth = requireSession(request);
    const body = parseOrThrow(TenantSwitchSchema, request.body);
    const organization = store.getOrganizationBySlug(body.slug);
    const membership = organization
      ? store.getActiveMembership(auth.user.id, organization.id)
      : null;
    if (!organization || organization.status !== 'active' || !membership) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Organization switch is not allowed');
    }
    store.selectTenant(auth.token, organization.id);
    store.addAudit({
      action: 'organization.switched',
      actorUserId: auth.user.id,
      tenantId: organization.id,
      resourceId: organization.id,
      requestId: request.id,
    });
    return {
      organization: organizationView(organization),
      host: `${organization.slug}.${baseDomain}`,
    };
  });

  app.post('/v1/organizations', async (request, reply) => {
    const auth = requireSession(request);
    const body = parseOrThrow(OrganizationCreateSchema, request.body);
    let organization: OrganizationRecord;
    try {
      organization = store.createOrganization({
        name: body.name,
        slug: body.slug,
        ownerUserId: auth.user.id,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'organization_slug_taken') {
        throw new RequestProblem(409, 'CONFLICT', 'Organization slug is already in use');
      }
      throw error;
    }
    store.selectTenant(auth.token, organization.id);
    store.addAudit({
      action: 'organization.created',
      actorUserId: auth.user.id,
      tenantId: organization.id,
      resourceId: organization.id,
      requestId: request.id,
    });
    return reply.status(201).send({
      organization: organizationView(organization),
      host: `${organization.slug}.${baseDomain}`,
    });
  });

  app.get('/v1/context', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'organization:read');
    return {
      requestId: request.id,
      user: userView(context.user),
      organization: organizationView(context.organization),
      membership: membershipView(context.membership, store),
      roles: context.roles,
      permissions: PERMISSIONS.filter((permission) =>
        rolesHavePermission(context.roles, permission),
      ),
    };
  });

  app.get('/v1/organization', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'organization:read');
    return { organization: organizationView(context.organization) };
  });

  app.get('/v1/branches', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'branches:read');
    return {
      data: store.listBranches(context.tenantId).map((branch: BranchRecord) => ({
        id: branch.id,
        slug: branch.slug,
        name: branch.name,
        status: branch.status,
      })),
    };
  });

  app.get('/v1/members', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'members:read');
    return {
      data: store
        .listMembershipsForOrganization(context.tenantId)
        .map((membership) => membershipView(membership, store)),
    };
  });

  app.post('/v1/members/invitations', async (request, reply) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'members:invite');
    const body = parseOrThrow(InvitationCreateSchema, request.body);
    let created: ReturnType<InMemoryIdentityStore['createInvitation']>;
    try {
      created = store.createInvitation({
        organizationId: context.tenantId,
        email: body.email,
        role: body.role,
        invitedBy: context.user.id,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'member_already_exists') {
        throw new RequestProblem(409, 'CONFLICT', 'Member already exists');
      }
      throw error;
    }
    store.addAudit({
      action: 'invitation.created',
      actorUserId: context.user.id,
      tenantId: context.tenantId,
      resourceId: created.invitation.id,
      requestId: request.id,
      metadata: { role: body.role },
    });
    return reply.status(201).send({
      invitation: {
        id: created.invitation.id,
        email: created.invitation.email,
        role: created.invitation.role,
        expiresAt: created.invitation.expiresAt,
      },
      ...(allowDevLogin ? { token: created.rawToken } : {}),
    });
  });

  app.post('/v1/members/invitations/:token/accept', async (request) => {
    const auth = requireSession(request);
    const resolution = resolveTenantFromHost(request.headers.host, baseDomain, '');
    if (!resolution)
      throw new RequestProblem(400, 'TENANT_REQUIRED', 'A valid tenant host is required');
    const organization = store.getOrganizationBySlug(resolution.tenantSlug);
    if (!organization || organization.status !== 'active') {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    const params = request.params as { token?: string };
    if (!params.token || params.token.length < 20) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'Invitation token is invalid');
    }

    let invitation: ReturnType<InMemoryIdentityStore['acceptInvitation']>;
    try {
      invitation = store.acceptInvitation({
        rawToken: params.token,
        userId: auth.user.id,
        email: auth.user.email,
        expectedOrganizationId: organization.id,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ['invitation_invalid', 'invitation_email_mismatch'].includes(error.message)
      ) {
        throw new RequestProblem(
          400,
          'BAD_REQUEST',
          'Invitation is invalid or does not belong to this user',
        );
      }
      throw error;
    }

    const membership = store
      .listMembershipsForOrganization(organization.id)
      .find((candidate) => candidate.userId === auth.user.id);
    store.addAudit({
      action: 'invitation.accepted',
      actorUserId: auth.user.id,
      tenantId: organization.id,
      resourceId: invitation.id,
      requestId: request.id,
    });
    return { membership: membership ? membershipView(membership, store) : null };
  });

  app.patch('/v1/members/:membershipId', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'members:update_role');
    const params = request.params as { membershipId?: string };
    const body = parseOrThrow(RoleUpdateSchema, request.body);
    const membership = params.membershipId ? store.getMembership(params.membershipId) : null;
    if (!membership || membership.organizationId !== context.tenantId) {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    try {
      const updated = store.updateMembershipRole(membership.id, body.role);
      store.addAudit({
        action: 'membership.role_changed',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: updated.id,
        requestId: request.id,
        metadata: { role: updated.role },
      });
      return { membership: membershipView(updated, store) };
    } catch (error) {
      if (error instanceof Error && error.message === 'last_owner') {
        throw new RequestProblem(409, 'CONFLICT', 'An organization must keep an active owner');
      }
      throw error;
    }
  });

  app.delete('/v1/members/:membershipId', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'members:remove');
    const params = request.params as { membershipId?: string };
    const membership = params.membershipId ? store.getMembership(params.membershipId) : null;
    if (!membership || membership.organizationId !== context.tenantId) {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    try {
      const removed = store.removeMembership(membership.id);
      store.addAudit({
        action: 'membership.removed',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: removed.id,
        requestId: request.id,
      });
      return { membership: membershipView(removed, store) };
    } catch (error) {
      if (error instanceof Error && error.message === 'last_owner') {
        throw new RequestProblem(409, 'CONFLICT', 'An organization must keep an active owner');
      }
      throw error;
    }
  });

  app.get('/v1/audit', async (request) => {
    const context = requireTenantContext(request);
    requirePermission(context, 'audit:read');
    const audit: AuditRecord[] = store.listAudit(context.tenantId);
    return {
      data: audit.map((record) => ({
        id: record.id,
        action: record.action,
        actorUserId: record.actorUserId,
        tenantId: record.tenantId,
        resourceId: record.resourceId,
        requestId: record.requestId,
        at: record.at,
        metadata: record.metadata,
      })),
    };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RequestProblem) {
      return reply
        .status(error.statusCode)
        .send(errorBody(request.id, error.code, error.message, error.details));
    }
    request.log.error({ err: error, request_id: request.id }, 'unhandled_request_error');
    return reply
      .status(500)
      .send(errorBody(request.id, 'INTERNAL_ERROR', 'Unexpected server error'));
  });

  return app;
}
