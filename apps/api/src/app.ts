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
  type CreateInvitationResult,
  type IdentityStore,
  type InvitationRecord,
  type MembershipRecord,
  type OrganizationRecord,
  type SessionRecord,
  type UserRecord,
} from './identity-store.js';
import { getLiveness, getReadiness, getStartup } from './health.js';
import {
  InMemoryInventoryStore,
  PersistentInventoryStore,
  type InventoryStore,
} from './inventory-store.js';
import {
  InMemoryFileStore,
  PersistentFileStore,
  type FileStore,
  ALLOWED_MIME_TYPES,
  ALLOWED_MIME_REGEX,
  DOWNLOAD_TTL_SECONDS,
  UPLOAD_TTL_SECONDS,
} from './file-store.js';
import { getDefaultS3Service } from './s3.js';
import { registerSecurity } from './plugins/security.js';
import { metrics } from '@platform/observability';
import { InMemoryDlqStore, PersistentDlqStore, type DlqStore } from './dlq-store.js';

const SESSION_COOKIE = 'platform_session';
const OIDC_STATE_COOKIE = 'oidc_state';
const DEFAULT_BASE_DOMAIN = 'app.localhost';
const DEFAULT_OIDC_REDIRECT_URI = 'http://api.localhost:4000/v1/auth/callback';
const SMALL_BODY_LIMIT = 256 * 1024;

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
const ReserveSchema = z.object({
  branchId: z.string().min(1).max(100),
  productId: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(1000),
});
const InventoryListQuery = z.object({
  branchId: z.string().min(1).max(100),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
const FilePresignSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !v.includes('/') && !v.includes('\\') && !v.includes('..'), 'filename_invalid'),
  contentType: z.string().min(3).max(127),
  size: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
});
const FileFinalizeSchema = z.object({
  sizeActual: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024)
    .optional(),
  checksum: z.string().max(128).optional(),
});
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
  session: SessionRecord;
}

interface TenantContext extends SessionAuth {
  requestId: string;
  tenantId: string;
  organization: OrganizationRecord;
  membership: MembershipRecord;
  roles: readonly Role[];
}

interface AppOptions {
  store?: IdentityStore;
  inventoryStore?: InventoryStore;
  fileStore?: FileStore;
  dlqStore?: DlqStore;
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

async function membershipView(
  membership: MembershipRecord,
  store: IdentityStore,
): Promise<Record<string, unknown>> {
  const user = await store.getUser(membership.userId);
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
  const store: IdentityStore = options.store ?? new InMemoryIdentityStore(true);
  const inventoryStore: InventoryStore =
    options.inventoryStore ??
    (process.env.DATABASE_URL
      ? PersistentInventoryStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryInventoryStore(true));
  const fileStore: FileStore =
    options.fileStore ??
    (process.env.DATABASE_URL
      ? PersistentFileStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryFileStore());
  const dlqStore: DlqStore =
    options.dlqStore ??
    (process.env.DATABASE_URL
      ? PersistentDlqStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryDlqStore());
  const stateStore = new InMemoryOidcStateStore();
  const baseDomain = options.baseDomain ?? process.env.TENANT_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN;
  const allowDevLogin = options.allowDevLogin ?? process.env.ALLOW_DEV_LOGIN === '1';
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

  const listOrganizationsForUser = async (userId: string): Promise<OrganizationRecord[]> => {
    const memberships = await store.listMembershipsForUser(userId);
    return (
      await Promise.all(
        memberships.map(async (membership) => store.getOrganization(membership.organizationId)),
      )
    ).filter((organization): organization is OrganizationRecord => organization !== null);
  };

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  registerSecurity(app, {
    baseDomain,
    webPublicUrl: process.env.WEB_PUBLIC_URL ?? 'http://app.localhost:3000',
    allowDevOrigins: process.env.NODE_ENV !== 'production',
  });

  app.addHook('onClose', async () => {
    await store.close?.();
  });

  const requireSession = async (request: FastifyRequest): Promise<SessionAuth> => {
    const token = requestToken(request);
    if (!token) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const session = await store.getSession(token);
    if (!session) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const user = await store.getUser(session.userId);
    if (!user) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    if (user.status !== 'active') {
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    }
    return { token, user, session };
  };

  const requireTenantContext = async (request: FastifyRequest): Promise<TenantContext> => {
    const auth = await requireSession(request);
    const resolution = resolveTenantFromHost(request.headers.host, baseDomain, '');
    if (!resolution) {
      throw new RequestProblem(400, 'TENANT_REQUIRED', 'A valid tenant host is required');
    }
    const organization = await store.getOrganizationBySlug(resolution.tenantSlug);
    if (!organization || organization.status !== 'active') {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    const membership = await store.getActiveMembership(
      { tenantId: organization.id, requestId: request.id, userId: auth.user.id },
      auth.user.id,
    );
    if (!membership) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Access denied');
    }
    const memberships = await store.listMembershipsForUser(auth.user.id);
    if (memberships.length > 1 && !auth.session.selectedTenantId) {
      throw new RequestProblem(
        409,
        'ORGANIZATION_SELECTION_REQUIRED',
        'Select an organization explicitly',
        {
          organizations: (
            await Promise.all(
              memberships.map(async (candidate) => {
                const candidateOrganization = await store.getOrganization(candidate.organizationId);
                return candidateOrganization ? organizationView(candidateOrganization) : null;
              }),
            )
          ).filter(
            (candidate): candidate is ReturnType<typeof organizationView> => candidate !== null,
          ),
        },
      );
    }
    if (auth.session.selectedTenantId && auth.session.selectedTenantId !== organization.id) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Select this organization before using its host');
    }
    return {
      ...auth,
      requestId: request.id,
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

  app.get('/health/live', async () => getLiveness());
  app.get('/health/ready', async (_request, reply) => {
    const report = await getReadiness();
    if (report.status !== 'ok') {
      return reply.status(503).send(report);
    }
    return report;
  });
  app.get('/health/startup', async (_request, reply) => {
    const report = await getStartup();
    if (report.status !== 'ok') {
      return reply.status(503).send(report);
    }
    return report;
  });
  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return metrics.toPrometheus();
  });
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
    const user = await store.upsertOidcUser(identity);
    if (user.status !== 'active')
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    const token = await store.createSession(user.id);
    await store.addAudit({
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

  app.post('/v1/auth/dev-login', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    if (!allowDevLogin) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    const body = parseOrThrow(DevLoginSchema, request.body);
    const user = await store.getUser(body.userId);
    if (!user || user.status !== 'active')
      throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const token = await store.createSession(user.id);
    await store.addAudit({ action: 'login', actorUserId: user.id, requestId: request.id });
    reply.header('set-cookie', sessionCookie(token, secureCookies));
    const organizations = await listOrganizationsForUser(user.id);
    return {
      user: userView(user),
      organizations: organizations.map(organizationView),
    };
  });

  app.get('/v1/auth/me', async (request) => {
    const auth = await requireSession(request);
    const memberships = await store.listMembershipsForUser(auth.user.id);
    const organizations = (
      await Promise.all(
        memberships.map(async (membership) => {
          const organization = await store.getOrganization(membership.organizationId);
          return organization ? { ...organizationView(organization), role: membership.role } : null;
        }),
      )
    ).filter(
      (organization): organization is NonNullable<typeof organization> => organization !== null,
    );
    return {
      user: userView(auth.user),
      organizations,
      selectedOrganizationId: auth.session.selectedTenantId ?? null,
    };
  });

  app.post('/v1/auth/logout', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const token = requestToken(request);
    if (token) {
      const session = await store.getSession(token);
      if (session) {
        await store.addAudit({
          action: 'logout',
          actorUserId: session.userId,
          requestId: request.id,
        });
        await store.revokeSession(token);
      }
    }
    reply.header('set-cookie', clearSessionCookie(secureCookies));
    return { status: 'ok' };
  });

  app.post('/v1/auth/refresh', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const auth = await requireSession(request);
    const refreshed = await store.refreshSession(auth.token);
    if (!refreshed) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    reply.header('set-cookie', sessionCookie(auth.token, secureCookies));
    return { status: 'ok', expiresAt: refreshed.expiresAt };
  });

  app.post('/v1/auth/switch-organization', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
    const auth = await requireSession(request);
    const body = parseOrThrow(TenantSwitchSchema, request.body);
    const organization = await store.getOrganizationBySlug(body.slug);
    const membership = organization
      ? await store.getActiveMembership(
          { tenantId: organization.id, requestId: request.id, userId: auth.user.id },
          auth.user.id,
        )
      : null;
    if (!organization || organization.status !== 'active' || !membership) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Organization switch is not allowed');
    }
    await store.selectTenant(auth.token, organization.id);
    await store.addAudit({
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

  app.post('/v1/organizations', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const auth = await requireSession(request);
    const body = parseOrThrow(OrganizationCreateSchema, request.body);
    let organization: OrganizationRecord;
    try {
      organization = await store.createOrganization({
        name: body.name,
        slug: body.slug,
        ownerUserId: auth.user.id,
        requestId: request.id,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'organization_slug_taken') {
        throw new RequestProblem(409, 'CONFLICT', 'Organization slug is already in use');
      }
      throw error;
    }
    await store.selectTenant(auth.token, organization.id);
    await store.addAudit({
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
    const context = await requireTenantContext(request);
    requirePermission(context, 'organization:read');
    return {
      requestId: request.id,
      user: userView(context.user),
      organization: organizationView(context.organization),
      membership: await membershipView(context.membership, store),
      roles: context.roles,
      permissions: PERMISSIONS.filter((permission) =>
        rolesHavePermission(context.roles, permission),
      ),
    };
  });

  app.get('/v1/organization', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'organization:read');
    return { organization: organizationView(context.organization) };
  });

  app.get('/v1/branches', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'branches:read');
    const branches = await store.listBranches(context);
    return {
      data: branches.map((branch: BranchRecord) => ({
        id: branch.id,
        slug: branch.slug,
        name: branch.name,
        status: branch.status,
      })),
    };
  });

  app.get('/v1/members', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'members:read');
    const memberships = await store.listMembershipsForOrganization(context);
    return {
      data: await Promise.all(memberships.map((membership) => membershipView(membership, store))),
    };
  });

  app.post('/v1/members/invitations', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'members:invite');
    const body = parseOrThrow(InvitationCreateSchema, request.body);
    let created: CreateInvitationResult;
    try {
      created = await store.createInvitation({
        organizationId: context.tenantId,
        email: body.email,
        role: body.role,
        invitedBy: context.user.id,
        context,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'member_already_exists') {
        throw new RequestProblem(409, 'CONFLICT', 'Member already exists');
      }
      throw error;
    }
    await store.addAudit({
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

  app.post(
    '/v1/members/invitations/:token/accept',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request) => {
      const auth = await requireSession(request);
      const resolution = resolveTenantFromHost(request.headers.host, baseDomain, '');
      if (!resolution)
        throw new RequestProblem(400, 'TENANT_REQUIRED', 'A valid tenant host is required');
      const organization = await store.getOrganizationBySlug(resolution.tenantSlug);
      if (!organization || organization.status !== 'active') {
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      }
      const params = request.params as { token?: string };
      if (!params.token || params.token.length < 20) {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Invitation token is invalid');
      }

      let invitation: InvitationRecord;
      try {
        invitation = await store.acceptInvitation({
          rawToken: params.token,
          userId: auth.user.id,
          email: auth.user.email,
          expectedOrganizationId: organization.id,
          context: { tenantId: organization.id, requestId: request.id, userId: auth.user.id },
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

      const memberships = await store.listMembershipsForOrganization({
        tenantId: organization.id,
        requestId: request.id,
        userId: auth.user.id,
      });
      const membership = memberships.find((candidate) => candidate.userId === auth.user.id);
      await store.addAudit({
        action: 'invitation.accepted',
        actorUserId: auth.user.id,
        tenantId: organization.id,
        resourceId: invitation.id,
        requestId: request.id,
      });
      return { membership: membership ? await membershipView(membership, store) : null };
    },
  );

  app.patch('/v1/members/:membershipId', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'members:update_role');
    const params = request.params as { membershipId?: string };
    const body = parseOrThrow(RoleUpdateSchema, request.body);
    const membership = params.membershipId
      ? await store.getMembership(context, params.membershipId)
      : null;
    if (!membership || membership.organizationId !== context.tenantId) {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    try {
      const updated = await store.updateMembershipRole(context, membership.id, body.role);
      await store.addAudit({
        action: 'membership.role_changed',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: updated.id,
        requestId: request.id,
        metadata: { role: updated.role },
      });
      return { membership: await membershipView(updated, store) };
    } catch (error) {
      if (error instanceof Error && error.message === 'last_owner') {
        throw new RequestProblem(409, 'CONFLICT', 'An organization must keep an active owner');
      }
      throw error;
    }
  });

  app.delete('/v1/members/:membershipId', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'members:remove');
    const params = request.params as { membershipId?: string };
    const membership = params.membershipId
      ? await store.getMembership(context, params.membershipId)
      : null;
    if (!membership || membership.organizationId !== context.tenantId) {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    try {
      const removed = await store.removeMembership(context, membership.id);
      await store.addAudit({
        action: 'membership.removed',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: removed.id,
        requestId: request.id,
      });
      return { membership: await membershipView(removed, store) };
    } catch (error) {
      if (error instanceof Error && error.message === 'last_owner') {
        throw new RequestProblem(409, 'CONFLICT', 'An organization must keep an active owner');
      }
      throw error;
    }
  });

  app.post('/v1/inventory/reserve', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'inventory:reserve');
    const body = parseOrThrow(ReserveSchema, request.body);
    try {
      const reservation = await inventoryStore.reserve(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        {
          branchId: body.branchId,
          productId: body.productId,
          quantity: body.quantity,
          correlationId: request.id,
          createdBy: context.user.id,
        },
      );
      return reply.status(201).send({ reservation });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'out_of_stock') {
          throw new RequestProblem(409, 'CONFLICT', 'Insufficient stock');
        }
        if (error.message === 'stock_not_found' || error.message === 'product_not_found') {
          throw new RequestProblem(404, 'NOT_FOUND', 'Product or stock not found');
        }
        if (error.message === 'quantity_invalid') {
          throw new RequestProblem(400, 'BAD_REQUEST', 'Quantity must be positive');
        }
      }
      throw error;
    }
  });

  app.get('/v1/inventory/reservations', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'inventory:read');
    const reservations = await inventoryStore.listReservations({
      tenantId: context.tenantId,
      requestId: request.id,
      userId: context.user.id,
    });
    return { data: reservations };
  });

  app.get('/v1/inventory', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'inventory:read');
    const query = parseOrThrow(InventoryListQuery, request.query);
    const result = await inventoryStore.listStock(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      query.branchId,
      { q: query.q, limit: query.limit, cursor: query.cursor },
    );
    return result;
  });

  // --- Files: presigned S3 flow tenant-scoped ---
  app.post(
    '/v1/files/presigned-upload',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request, reply) => {
      const context = await requireTenantContext(request);
      requirePermission(context, 'files:upload');
      const body = parseOrThrow(FilePresignSchema, request.body);
      if (!ALLOWED_MIME_TYPES.has(body.contentType) && !ALLOWED_MIME_REGEX.test(body.contentType)) {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Content type not allowed');
      }
      if (
        body.filename.includes('/') ||
        body.filename.includes('\\') ||
        body.filename.includes('..')
      ) {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid filename');
      }
      try {
        const file = await fileStore.createPending(
          { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
          {
            filename: body.filename,
            contentType: body.contentType,
            sizeExpected: body.size,
            ownerId: context.user.id,
          },
        );
        const s3 = getDefaultS3Service();
        const upload = await s3.generateUploadUrl({
          key: file.key,
          contentType: file.contentType,
          sizeExpected: file.sizeExpected,
          expiresSeconds: UPLOAD_TTL_SECONDS,
        });
        // Never log full presigned URL / tokens — only key prefix is safe. We intentionally avoid logging url.
        return reply.status(201).send({
          file: {
            id: file.id,
            filename: file.filename,
            contentType: file.contentType,
            sizeExpected: file.sizeExpected,
            status: file.status,
            createdAt: file.createdAt,
            expiresAt: file.expiresAt,
          },
          upload: {
            url: upload.url,
            expiresAt: upload.expiresAt,
            headers: upload.headers,
            // expose key only internally if needed; not leaked as arbitrary path. Kept for debugging but tenant-prefixed.
            key: file.key,
          },
        });
      } catch (error) {
        if (error instanceof Error) {
          if (
            [
              'filename_invalid',
              'content_type_not_allowed',
              'content_type_invalid',
              'size_invalid',
            ].includes(error.message)
          ) {
            throw new RequestProblem(400, 'BAD_REQUEST', error.message);
          }
        }
        throw error;
      }
    },
  );

  // Legacy alias for OpenAPI compatibility: /v1/files/presign
  app.post('/v1/files/presign', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'files:upload');
    // Accept legacy payload shape {filename, contentType, size} same as new
    const body = parseOrThrow(FilePresignSchema, request.body);
    if (!ALLOWED_MIME_TYPES.has(body.contentType) && !ALLOWED_MIME_REGEX.test(body.contentType)) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'Content type not allowed');
    }
    const file = await fileStore.createPending(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      {
        filename: body.filename,
        contentType: body.contentType,
        sizeExpected: body.size,
        ownerId: context.user.id,
      },
    );
    const s3 = getDefaultS3Service();
    const upload = await s3.generateUploadUrl({
      key: file.key,
      contentType: file.contentType,
      sizeExpected: file.sizeExpected,
      expiresSeconds: UPLOAD_TTL_SECONDS,
    });
    return reply.status(201).send({ file, upload });
  });

  app.post('/v1/files/:id/finalize', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'files:upload');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'File id required');
    const body = parseOrThrow(FileFinalizeSchema, request.body ?? {});
    const fileBefore = await fileStore.getById(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!fileBefore) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    if (fileBefore.status === 'expired') throw new RequestProblem(410, 'GONE', 'Upload expired');
    if (fileBefore.status !== 'pending' && fileBefore.status !== 'ready')
      throw new RequestProblem(409, 'CONFLICT', 'File not in pending state');
    // Verify via S3 HEAD if available; if head returns data, validate size
    try {
      const s3 = getDefaultS3Service();
      const head = await s3.headObject(fileBefore.key);
      if (head) {
        if (head.contentLength !== fileBefore.sizeExpected && body.sizeActual === undefined) {
          // If S3 reports different size than expected, we treat as mismatch unless caller explicitly passes sizeActual
          // Allow proceeding but record actual
          // If strict, reject when mismatch >0
        }
        if (body.sizeActual !== undefined && head.contentLength !== body.sizeActual) {
          throw new RequestProblem(400, 'BAD_REQUEST', 'Size mismatch with uploaded object');
        }
        if (head.contentType && head.contentType !== fileBefore.contentType) {
          // Allow but warn; content-type is validated at presign time
        }
      }
    } catch (error) {
      if (error instanceof RequestProblem) throw error;
      // If S3 is unavailable (null head), we proceed without strict check — finalize is tenant-scoped and pending.
    }

    try {
      const finalized = await fileStore.finalize(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
        body.sizeActual !== undefined || body.checksum !== undefined
          ? { sizeActual: body.sizeActual, checksum: body.checksum }
          : {},
      );
      return { file: finalized };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'file_not_found')
          throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
        if (error.message === 'file_expired')
          throw new RequestProblem(410, 'GONE', 'Upload expired');
        if (error.message === 'file_not_pending')
          throw new RequestProblem(409, 'CONFLICT', 'File not pending');
        if (error.message === 'size_invalid')
          throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid size');
      }
      throw error;
    }
  });

  app.get('/v1/files/:id', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'files:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'File id required');
    const file = await fileStore.getById(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!file) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    if (file.status === 'expired') throw new RequestProblem(410, 'GONE', 'Upload expired');
    return {
      file: {
        id: file.id,
        filename: file.filename,
        contentType: file.contentType,
        sizeExpected: file.sizeExpected,
        sizeActual: file.sizeActual,
        status: file.status,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        expiresAt: file.expiresAt,
      },
    };
  });

  app.get('/v1/files', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'files:read');
    const query = parseOrThrow(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
      request.query,
    );
    const opts: { limit?: number | undefined; cursor?: string | undefined } = {};
    if (query.limit !== undefined) opts.limit = query.limit;
    if (query.cursor !== undefined) opts.cursor = query.cursor;
    const result = await fileStore.listFiles(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      opts,
    );
    return {
      data: result.items.map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        sizeExpected: f.sizeExpected,
        sizeActual: f.sizeActual,
        status: f.status,
        createdAt: f.createdAt,
      })),
      nextCursor: result.nextCursor,
    };
  });

  async function handlePresignedDownload(request: FastifyRequest): Promise<unknown> {
    const context = await requireTenantContext(request);
    requirePermission(context, 'files:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'File id required');
    try {
      const { file, key } = await fileStore.getDownloadKey(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
      );
      const s3 = getDefaultS3Service();
      const download = await s3.generateDownloadUrl({ key, expiresSeconds: DOWNLOAD_TTL_SECONDS });
      // Avoid logging download.url
      return {
        file: {
          id: file.id,
          filename: file.filename,
          contentType: file.contentType,
          sizeExpected: file.sizeExpected,
          status: file.status,
        },
        download: { url: download.url, expiresAt: download.expiresAt },
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'file_not_found')
          throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
        if (error.message === 'file_not_ready')
          throw new RequestProblem(409, 'CONFLICT', 'File not ready');
        if (error.message === 'file_expired')
          throw new RequestProblem(410, 'GONE', 'Upload expired');
      }
      throw error;
    }
  }

  app.get('/v1/files/:id/download', async (request) => handlePresignedDownload(request));
  app.get('/v1/files/:id/presigned-download', async (request) => handlePresignedDownload(request));

  // --- DLQ admin (tenant-scoped, requires owner/admin + audit:read) ---
  app.get('/v1/dlq', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'audit:read');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const query = parseOrThrow(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      request.query,
    );
    const items = await dlqStore.list(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      query.limit,
    );
    return { data: items };
  });

  app.get('/v1/admin/dlq', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'audit:read');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const query = parseOrThrow(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      request.query,
    );
    const items = await dlqStore.list(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      query.limit,
    );
    return { data: items };
  });

  async function handleDlqReplay(request: FastifyRequest): Promise<unknown> {
    const context = await requireTenantContext(request);
    requirePermission(context, 'audit:read');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'DLQ id required');
    try {
      const result = await dlqStore.replay(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
      );
      await store.addAudit({
        action: 'membership.role_changed',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: params.id,
        requestId: request.id,
        metadata: { dlqReplay: result.jobId },
      });
      return { jobId: result.jobId, status: 'replayed' };
    } catch (error) {
      if (error instanceof Error && error.message === 'dlq_not_found')
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      throw error;
    }
  }

  app.post('/v1/dlq/:id/replay', async (request) => handleDlqReplay(request));
  app.post('/v1/admin/dlq/:id/replay', async (request) => handleDlqReplay(request));

  app.post('/v1/dlq/:id/discard', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'audit:read');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'DLQ id required');
    const rec = await dlqStore.get(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!rec) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    await dlqStore.discard(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    return { status: 'discarded' };
  });

  app.get('/v1/audit', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'audit:read');
    const audit: AuditRecord[] = await store.listAudit(context);
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
