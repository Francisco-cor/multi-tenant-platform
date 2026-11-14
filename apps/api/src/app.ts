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
  type OidcStateStore,
} from '@platform/auth';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { API_VERSION, metaResponse } from '@platform/contracts';
import {
  PERMISSIONS,
  canAssignRole,
  requiresOwnerApproval,
  rolesHavePermission,
  type Permission,
  type Role,
} from '@platform/domain';
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
  type StoreTenantContext,
  type UserRecord,
} from './identity-store.js';
import { createHealthProbe, getLiveness, type HealthProbe } from './health.js';
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
import {
  metrics,
  createLogger,
  enterCorrelation,
  extractCorrelation,
  generateTraceId,
  getCorrelation,
  setCorrelationPatch,
} from '@platform/observability';
import {
  buildCacheKey,
  buildCachePrefix,
  CACHE_TTLS,
  createInMemoryCache,
  type Cache,
} from './cache.js';
import {
  createInMemoryRateLimiter,
  RATE_LIMITS,
  rateLimitKeyForEndpoint,
  rateLimitKeyForIp,
  rateLimitKeyForTenant,
  rateLimitKeyForUser,
  type RateLimiter,
} from './rate-limit.js';
import { createCircuitBreaker, type CircuitBreaker } from './circuit-breaker.js';
import { InMemoryDlqStore, PersistentDlqStore, type DlqStore } from './dlq-store.js';
import {
  InMemoryPaymentStore,
  PersistentPaymentStore,
  validateIdempotencyKey,
  type PaymentStore,
} from './payment-store.js';
import { verifyStripeWebhookSignature, verifyWebhookSignature } from './webhook-payment.js';
import { sql, createDatabase, withTenantTransaction } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import {
  InMemoryWebhookStore,
  PersistentWebhookStore,
  type WebhookStore,
} from './webhook-store.js';
import { InMemoryApiKeyStore, PersistentApiKeyStore, type ApiKeyStore } from './api-key-store.js';
import { ProviderSecretStore, type InboundProvider } from './provider-secret-store.js';
import { validateAutomation } from '@platform/domain';
import {
  InMemoryFeatureFlagStore,
  PersistentFeatureFlagStore,
  type FeatureFlagStore,
} from './feature-flag-store.js';
import { redactRequestUrl } from './request-log.js';
import { createApiLoggerOptions } from './logging.js';

const SESSION_COOKIE = 'platform_session';
const CSRF_COOKIE = 'platform_csrf';
const OIDC_STATE_COOKIE = 'oidc_state';
const DEFAULT_BASE_DOMAIN = 'app.localhost';
const DEFAULT_OIDC_REDIRECT_URI = 'http://api.localhost:4000/v1/auth/callback';
const SMALL_BODY_LIMIT = 256 * 1024;
const GLOBAL_BODY_LIMIT = 1024 * 1024;
const SESSION_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;
const CSRF_TOKEN_BYTES = 32;
const METRICS_SCRAPE_RATE_LIMIT = { windowMs: 60_000, max: 1000 };
const CSRF_EXEMPT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Audit actor for provider callbacks, which have no authenticated user. */
const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Bounded, self-expiring set for in-memory webhook dedupe. The previous
 * module-global Set grew without limit for the lifetime of the process.
 */
class BoundedDedupeSet {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  has(key: string): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    if (this.entries.size >= this.maxEntries) this.sweep();
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, Date.now() + this.ttlMs);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}
// Keep the exact bytes received on the wire for signed webhook verification.
// Fastify parses JSON before route handlers run, so JSON.stringify(request.body)
// is not a safe representation of the signed payload (whitespace and key order
// are significant).
const rawBodyByRequest = new WeakMap<FastifyRequest, Buffer>();

const DevLoginSchema = z.object({ userId: z.string().min(1) }).strict();
const OrganizationCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(63),
  })
  .strict();
const InvitationCreateSchema = z
  .object({
    email: z.string().email().max(320),
    role: z.enum(['owner', 'admin', 'manager', 'operator', 'auditor']),
  })
  .strict();
const RoleUpdateSchema = z
  .object({
    role: z.enum(['owner', 'admin', 'manager', 'operator', 'auditor']),
  })
  .strict();
const TenantSwitchSchema = z.object({ slug: z.string().min(1).max(63) }).strict();
const ReserveSchema = z
  .object({
    branchId: z.string().min(1).max(100),
    productId: z.string().min(1).max(100),
    quantity: z.number().int().min(1).max(1000),
  })
  .strict();
const InventoryListQuery = z
  .object({
    branchId: z.string().min(1).max(100),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();
const FilePresignSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (v) => !v.includes('/') && !v.includes('\\') && !v.includes('..'),
        'filename_invalid',
      ),
    contentType: z.string().min(3).max(127),
    size: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024),
  })
  .strict();
const FileFinalizeSchema = z
  .object({
    sizeActual: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024)
      .optional(),
    checksum: z.string().max(128).optional(),
  })
  .strict();
const CallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .strict();
const OrderCreateSchema = z
  .object({
    branchId: z.string().min(1).max(100),
    amountCents: z.number().int().min(1).max(100000000),
    currency: z.string().min(3).max(10).default('USD').optional(),
    paymentMethodId: z.string().min(3).max(128).optional(),
    idempotencyKey: z.string().min(16).max(255).optional(),
  })
  .strict();
const PaymentWebhookSchema = z
  .object({
    eventId: z.string().min(8).max(128),
    providerRef: z.string().min(3).max(128),
    status: z.enum(['paid', 'failed', 'unknown']),
    providerKey: z.string().min(8).max(128).optional(),
    amountCents: z.number().int().min(1).optional(),
    currency: z.string().min(3).max(10).optional(),
    tenantId: z.string().min(1).max(128).optional(),
  })
  .strict();
const WebhookEndpointCreateSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((v) => v.startsWith('https://'), 'must be https'),
    secret: z.string().min(8).max(128).optional(),
    events: z.array(z.string().min(3).max(80)).min(1).max(20),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();
const WebhookEndpointUpdateSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((v) => v.startsWith('https://'), 'must be https')
      .optional(),
    events: z.array(z.string().min(3).max(80)).min(1).max(20).optional(),
    status: z.enum(['active', 'disabled', 'dead_letter']).optional(),
  })
  .strict();
const ApiKeyCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.string().min(1).max(40)).min(1).max(10),
    expiresInMs: z
      .number()
      .int()
      .min(60000)
      .max(365 * 24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict();
const AutomationCreateSchema = z
  .object({
    trigger: z.enum([
      'order.created',
      'order.paid',
      'order.failed',
      'payment.paid',
      'payment.failed',
      'file.ready',
      'inventory.reserved',
    ]),
    action: z
      .object({
        type: z.enum(['webhook', 'log', 'noop']),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    version: z.number().int().min(1).max(10).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const InboundWebhookSchema = z
  .object({
    eventId: z.string().min(8).max(128),
    source: z.string().min(2).max(40).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    tenantId: z.string().min(1).max(128).optional(),
  })
  .strict();
const FlagUpdateSchema = z
  .object({
    enabled: z.boolean(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const BranchCreateSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(63),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).optional(),
  })
  .strict();
const BranchUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

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
  authType: 'session' | 'api_key';
  requestId: string;
  tenantId: string;
  organization: OrganizationRecord;
  membership: MembershipRecord;
  roles: readonly Role[];
  apiKeyScopes?: readonly string[];
  apiKeyId?: string;
}

interface AppOptions {
  store?: IdentityStore;
  inventoryStore?: InventoryStore;
  fileStore?: FileStore;
  dlqStore?: DlqStore;
  paymentStore?: PaymentStore;
  webhookStore?: WebhookStore;
  providerSecretStore?: ProviderSecretStore;
  apiKeyStore?: ApiKeyStore;
  featureFlagStore?: FeatureFlagStore;
  cache?: Cache;
  rateLimiter?: RateLimiter;
  health?: HealthProbe;
  persistentAdapters?: boolean;
  circuitBreakers?: {
    s3?: CircuitBreaker;
    payment?: CircuitBreaker;
    oidc?: CircuitBreaker;
  };
  baseDomain?: string;
  allowDevLogin?: boolean;
  allowedOrigins?: string[];
  sessionCookieDomain?: string;
  metricsToken?: string;
  trustProxy?: boolean | number | string[];
  oidcStateStore?: OidcStateStore;
  oidcEmailVerified?: 'ignore' | 'require';
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
function cookieAttributes(input: {
  secure: boolean;
  domain?: string | undefined;
  maxAgeSeconds: number;
  path?: string;
  sameSite?: 'Lax' | 'Strict';
  httpOnly?: boolean;
}): string {
  const parts = [
    `Path=${input.path ?? '/'}`,
    `SameSite=${input.sameSite ?? 'Lax'}`,
    `Max-Age=${input.maxAgeSeconds}`,
  ];
  if (input.httpOnly !== false) parts.unshift('HttpOnly');
  if (input.secure) parts.push('Secure');
  if (input.domain) parts.push(`Domain=${input.domain}`);
  return parts.join('; ');
}

function sessionCookie(token: string, secure: boolean, domain?: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes({ secure, domain, maxAgeSeconds: SESSION_ABSOLUTE_TTL_SECONDS })}`;
}

function clearSessionCookie(secure: boolean, domain?: string): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes({ secure, domain, maxAgeSeconds: 0 })}`;
}

function csrfCookie(token: string, secure: boolean, domain?: string): string {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes({ secure, domain, maxAgeSeconds: SESSION_ABSOLUTE_TTL_SECONDS, httpOnly: false })}`;
}

function clearCsrfCookie(secure: boolean, domain?: string): string {
  return `${CSRF_COOKIE}=; ${cookieAttributes({ secure, domain, maxAgeSeconds: 0, httpOnly: false })}`;
}

function stateCookie(state: string, secure: boolean, domain?: string): string {
  return `${OIDC_STATE_COOKIE}=${encodeURIComponent(state)}; ${cookieAttributes({ secure, domain, maxAgeSeconds: 600, path: '/v1/auth' })}`;
}

function clearStateCookie(secure: boolean, domain?: string): string {
  return `${OIDC_STATE_COOKIE}=; ${cookieAttributes({ secure, domain, maxAgeSeconds: 0, path: '/v1/auth' })}`;
}

function newCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requestToken(request: FastifyRequest): string | null {
  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
}

function requestApiKey(request: FastifyRequest): string | null {
  const value = request.headers['x-api-key'];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireUuid(value: string | undefined, label: string): string {
  if (!isUuid(value)) throw new RequestProblem(400, 'BAD_REQUEST', `${label} must be a UUID`);
  return value;
}

const DOMAIN_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  organization_slug_taken: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  branch_slug_taken: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  member_already_exists: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  last_owner: { status: 409, code: 'CONFLICT', message: 'An organization must keep an owner' },
  idempotency_conflict: { status: 409, code: 'CONFLICT', message: 'Idempotency key conflict' },
  order_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  payment_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  attempt_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  membership_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  file_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  webhook_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  delivery_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  dlq_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  api_key_not_found: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  amount_invalid: { status: 400, code: 'BAD_REQUEST', message: 'Invalid amount' },
  quantity_invalid: { status: 400, code: 'BAD_REQUEST', message: 'Invalid quantity' },
  tenant_context_mismatch: { status: 400, code: 'BAD_REQUEST', message: 'Tenant context mismatch' },
  reference_invalid: { status: 400, code: 'BAD_REQUEST', message: 'Invalid reference' },
  invitation_invalid: { status: 400, code: 'BAD_REQUEST', message: 'Invitation is invalid' },
  invitation_email_mismatch: {
    status: 400,
    code: 'BAD_REQUEST',
    message: 'Invitation is invalid for this user',
  },
  session_not_found: { status: 401, code: 'UNAUTHORIZED', message: 'Authentication required' },
  out_of_stock: { status: 409, code: 'CONFLICT', message: 'Insufficient stock' },
};

function mapDomainError(message: string): { status: number; code: string; message: string } | null {
  if (DOMAIN_ERRORS[message]) return DOMAIN_ERRORS[message];
  if (message.endsWith('_not_found')) {
    return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
  }
  if (message.endsWith('_invalid') || message.endsWith('_required')) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Invalid request' };
  }
  return null;
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
  const productionLike =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  if (productionLike && !options.store && !process.env.DATABASE_URL) {
    throw new Error('database_required_in_production_like');
  }
  if (productionLike && !options.cache && !process.env.REDIS_URL) {
    throw new Error('redis_cache_required_in_production_like');
  }
  if (productionLike && !options.rateLimiter && !process.env.REDIS_URL) {
    throw new Error('redis_rate_limiter_required_in_production_like');
  }
  const store: IdentityStore = options.store ?? new InMemoryIdentityStore(true);
  const inventoryStore: InventoryStore =
    options.inventoryStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentInventoryStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryInventoryStore(true));
  const fileStore: FileStore =
    options.fileStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentFileStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryFileStore());
  const dlqStore: DlqStore =
    options.dlqStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentDlqStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryDlqStore());
  const paymentStore: PaymentStore =
    options.paymentStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentPaymentStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryPaymentStore());
  const webhookStore: WebhookStore =
    options.webhookStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentWebhookStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryWebhookStore());
  const apiKeyStore: ApiKeyStore =
    options.apiKeyStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentApiKeyStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryApiKeyStore());
  const featureFlagStore: FeatureFlagStore =
    options.featureFlagStore ??
    (options.persistentAdapters && process.env.DATABASE_URL
      ? PersistentFeatureFlagStore.fromConnectionString(
          process.env.DATABASE_URL,
          process.env.DATABASE_ROLE ?? 'platform_app',
        )
      : new InMemoryFeatureFlagStore());
  const cache: Cache = options.cache ?? createInMemoryCache();
  const rateLimiter: RateLimiter = options.rateLimiter ?? createInMemoryRateLimiter();
  const health: HealthProbe = options.health ?? createHealthProbe();
  const sessionCookieDomain =
    options.sessionCookieDomain ?? process.env.SESSION_COOKIE_DOMAIN ?? undefined;
  const metricsToken = options.metricsToken ?? process.env.METRICS_TOKEN ?? undefined;
  const oidcEmailVerified =
    options.oidcEmailVerified ??
    (process.env.OIDC_EMAIL_VERIFIED === 'require'
      ? 'require'
      : productionLike
        ? 'require'
        : 'ignore');
  const allowedOrigins = (
    options.allowedOrigins && options.allowedOrigins.length > 0
      ? options.allowedOrigins
      : process.env.WEB_ALLOWED_ORIGINS
        ? process.env.WEB_ALLOWED_ORIGINS.split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
        : [process.env.WEB_PUBLIC_URL ?? 'http://app.localhost:3000']
  ).map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      return origin;
    }
  });
  const trustProxy = (() => {
    if (options.trustProxy !== undefined) return options.trustProxy;
    if (process.env.TRUST_PROXY_CIDRS) {
      return process.env.TRUST_PROXY_CIDRS.split(',')
        .map((cidr) => cidr.trim())
        .filter(Boolean);
    }
    if (process.env.TRUST_PROXY_HOPS) return Number(process.env.TRUST_PROXY_HOPS);
    if (process.env.TRUST_PROXY === '1') {
      if (productionLike) throw new Error('trust_proxy_unsafe_in_production_like');
      return true;
    }
    return false;
  })();
  // Direct-SQL paths (payment webhook, automations) must reuse one pool instead
  // of opening a connection pool per request.
  const directDatabase: DatabaseHandle | undefined =
    options.persistentAdapters && process.env.DATABASE_URL
      ? createDatabase(process.env.DATABASE_URL, {
          role: process.env.DATABASE_ROLE ?? 'platform_app',
          maxConnections: 4,
        })
      : undefined;
  const providerSecretStore: ProviderSecretStore =
    options.providerSecretStore ?? new ProviderSecretStore(directDatabase ?? null);
  const s3Breaker: CircuitBreaker =
    options.circuitBreakers?.s3 ??
    createCircuitBreaker('s3', { failureThreshold: 5, timeoutMs: 30_000, requestTimeoutMs: 2000 });
  // paymentBreaker reserved for worker payment provider; keep for metrics even if not used directly in API order saga
  const paymentBreaker: CircuitBreaker =
    options.circuitBreakers?.payment ??
    createCircuitBreaker('payment', {
      failureThreshold: 5,
      timeoutMs: 30_000,
      requestTimeoutMs: 3000,
    });
  void paymentBreaker;
  const oidcBreaker: CircuitBreaker =
    options.circuitBreakers?.oidc ??
    createCircuitBreaker('oidc', {
      failureThreshold: 3,
      timeoutMs: 60_000,
      requestTimeoutMs: 2000,
    });
  if (productionLike && !options.oidcStateStore) {
    throw new Error('oidc_state_store_required_in_production_like');
  }
  const stateStore: OidcStateStore = options.oidcStateStore ?? new InMemoryOidcStateStore();
  const baseDomain = options.baseDomain ?? process.env.TENANT_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN;
  const allowDevLogin =
    !productionLike && (options.allowDevLogin ?? process.env.ALLOW_DEV_LOGIN === '1');
  const oidc = options.oidc ?? {
    issuer: process.env.OIDC_ISSUER_URL ?? '',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    ...(process.env.OIDC_CLIENT_SECRET ? { clientSecret: process.env.OIDC_CLIENT_SECRET } : {}),
    redirectUri: process.env.OIDC_REDIRECT_URI ?? DEFAULT_OIDC_REDIRECT_URI,
    ...(process.env.OIDC_AUTHORIZATION_ENDPOINT
      ? { authorizationEndpoint: process.env.OIDC_AUTHORIZATION_ENDPOINT }
      : {}),
  };
  const secureCookies = productionLike;

  const listOrganizationsForUser = async (userId: string): Promise<OrganizationRecord[]> => {
    const memberships = await store.listMembershipsForUser(userId);
    return (
      await Promise.all(
        memberships.map(async (membership) => store.getOrganization(membership.organizationId)),
      )
    ).filter((organization): organization is OrganizationRecord => organization !== null);
  };

  const issueSessionCookies = (token: string): string[] => [
    sessionCookie(token, secureCookies, sessionCookieDomain),
    csrfCookie(newCsrfToken(), secureCookies, sessionCookieDomain),
  ];

  const inboundDedupe = new BoundedDedupeSet();

  const structuredLogger = createLogger({
    level: (process.env.LOG_LEVEL as never) ?? 'info',
    service: process.env.OTEL_SERVICE_NAME ?? 'api',
  });

  const app = Fastify({
    logger: createApiLoggerOptions((process.env.LOG_LEVEL as string) ?? 'info'),
    bodyLimit: GLOBAL_BODY_LIMIT,
    // Only trust forwarded client IP/host headers when the process is behind
    // an explicitly configured reverse proxy. Boolean `true` is rejected in
    // production-like environments because any peer could spoof the source IP.
    trustProxy: trustProxy as unknown as boolean | string[],
    genReqId: (req) =>
      (req.headers['x-request-id'] as string) ??
      (req.headers['x-correlation-id'] as string) ??
      randomUUID(),
  });

  registerSecurity(app, {
    baseDomain,
    webPublicUrl: process.env.WEB_PUBLIC_URL ?? 'http://app.localhost:3000',
    allowedOrigins,
    requireHttps: productionLike,
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    const routeOptions = request.routeOptions as { bodyLimit?: number; config?: unknown };
    const limit =
      typeof routeOptions.bodyLimit === 'number' ? routeOptions.bodyLimit : GLOBAL_BODY_LIMIT;
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      payload.destroy();
      throw new RequestProblem(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    const rawBodyRequired =
      (routeOptions.config as { rawBody?: boolean } | undefined)?.rawBody === true;
    // Fastify enforces bodyLimit for parsed routes; only signed webhook routes
    // need the exact bytes replayed, so avoid buffering everything else.
    if (!rawBodyRequired) return payload;
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of payload) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > limit) {
        payload.destroy();
        throw new RequestProblem(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
      }
      chunks.push(buffer);
    }
    const rawBody = Buffer.concat(chunks);
    rawBodyByRequest.set(request, rawBody);

    // Re-feed the consumed stream to Fastify's JSON parser. Fastify uses this
    // property to enforce body limits after a preParsing hook replaces payload.
    const replay = Readable.from([rawBody]);
    Object.defineProperty(replay, 'receivedEncodedLength', {
      configurable: true,
      enumerable: false,
      value: rawBody.length,
      writable: false,
    });
    return replay;
  });

  app.addHook('onClose', async () => {
    await Promise.all([
      store.close?.(),
      inventoryStore.close?.(),
      fileStore.close?.(),
      dlqStore.close?.(),
      paymentStore.close?.(),
      webhookStore.close?.(),
      apiKeyStore.close?.(),
      featureFlagStore.close?.(),
      cache.close?.(),
      (rateLimiter as unknown as { close?: () => Promise<void> }).close?.(),
      health.close?.(),
      directDatabase?.close?.(),
    ]);
  });

  // --- Observability: correlation propagation + RED metrics + structured logs ---
  const requestStart = new Map<string, number>();
  app.addHook('onRequest', async (request, reply) => {
    const start = Date.now();
    requestStart.set(request.id, start);
    const ctx = extractCorrelation(
      request.headers as unknown as Record<string, string | string[] | undefined>,
      request.id,
    );
    if (!ctx.traceId) {
      ctx.traceId = generateTraceId();
    }
    enterCorrelation(ctx);
    reply.header('x-request-id', ctx.requestId);
    reply.header('x-trace-id', ctx.traceId);
    reply.header(
      'traceparent',
      `00-${ctx.traceId.padStart(32, '0').slice(-32)}-0000000000000000-01`,
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    const start = requestStart.get(request.id);
    const duration = start !== undefined ? Date.now() - start : (reply.elapsedTime ?? 0);
    requestStart.delete(request.id);
    const route = (request.routeOptions.url as string) ?? request.url.split('?')[0] ?? 'unknown';
    metrics.recordHttpRequest(request.method, route, reply.statusCode, duration);
    const corr = getCorrelation();
    if (corr?.traceId) reply.header('x-trace-id', corr.traceId);
    if (corr?.requestId) reply.header('x-request-id', corr.requestId);
    // Structured log with correlation (Fastify already logs, but we enrich with tenantHash)
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    // Use structuredLogger directly; Fastify's request.log already emitted, but we emit OTel-style
    const logFn = (
      structuredLogger as unknown as Record<string, (obj: unknown, msg: string) => void>
    )[level];
    if (typeof logFn === 'function') {
      logFn.call(
        structuredLogger,
        {
          requestId: request.id,
          traceId: corr?.traceId,
          tenantHash: corr?.tenantHash,
          method: request.method,
          url: redactRequestUrl(request.url),
          route,
          statusCode: reply.statusCode,
          durationMs: duration,
        },
        'request completed',
      );
    }
  });

  // --- Rate limiting: per-IP global (fail-open with in-memory fallback) ---
  const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== '0';
  if (RATE_LIMIT_ENABLED) {
    app.addHook('onRequest', async (request, reply) => {
      const isPublicProbe = request.url.startsWith('/health') || request.url === '/metrics';
      const config = isPublicProbe ? METRICS_SCRAPE_RATE_LIMIT : RATE_LIMITS.ip;
      const ip = request.ip;
      const res = await rateLimiter.check(rateLimitKeyForIp(ip), config);
      reply.header('x-ratelimit-limit', String(res.limit));
      reply.header('x-ratelimit-remaining', String(res.remaining));
      reply.header('x-ratelimit-reset', String(Math.ceil(res.resetMs / 1000)));
      if (!res.allowed) {
        reply.header('retry-after', String(res.retryAfterSec ?? 60));
        throw new RequestProblem(429, 'RATE_LIMITED', 'Too many requests', {
          retryAfter: res.retryAfterSec,
        });
      }
    });
  }

  const enforceTenantRateLimit = async (
    request: FastifyRequest,
    reply: import('fastify').FastifyReply,
    context: TenantContext,
  ): Promise<void> => {
    if (!RATE_LIMIT_ENABLED) return;
    const res = await rateLimiter.check(
      rateLimitKeyForTenant(context.tenantId),
      RATE_LIMITS.tenant,
    );
    reply.header('x-ratelimit-tenant-limit', String(res.limit));
    reply.header('x-ratelimit-tenant-remaining', String(res.remaining));
    if (!res.allowed) {
      reply.header('retry-after', String(res.retryAfterSec ?? 60));
      throw new RequestProblem(429, 'RATE_LIMITED', 'Tenant rate limit exceeded', {
        retryAfter: res.retryAfterSec,
      });
    }
    // also per-user within tenant
    const userRes = await rateLimiter.check(rateLimitKeyForUser(context.user.id), RATE_LIMITS.user);
    if (!userRes.allowed) {
      reply.header('retry-after', String(userRes.retryAfterSec ?? 60));
      throw new RequestProblem(429, 'RATE_LIMITED', 'User rate limit exceeded', {
        retryAfter: userRes.retryAfterSec,
      });
    }
  };

  const enforceEndpointRateLimit = async (
    request: FastifyRequest,
    reply: import('fastify').FastifyReply,
    endpointKey: string,
    identifier: string,
  ): Promise<void> => {
    if (!RATE_LIMIT_ENABLED) return;
    const cfg = (
      RATE_LIMITS.endpoints as Record<string, { windowMs: number; max: number; key: string }>
    )[endpointKey];
    if (!cfg) return;
    const res = await rateLimiter.check(rateLimitKeyForEndpoint(endpointKey, identifier), cfg);
    reply.header('x-ratelimit-endpoint-limit', String(res.limit));
    reply.header('x-ratelimit-endpoint-remaining', String(res.remaining));
    if (!res.allowed) {
      reply.header('retry-after', String(res.retryAfterSec ?? 60));
      throw new RequestProblem(429, 'RATE_LIMITED', `Rate limit exceeded for ${endpointKey}`, {
        retryAfter: res.retryAfterSec,
      });
    }
  };

  const getTraceId = (request: FastifyRequest): string | undefined => {
    const corr = getCorrelation();
    if (corr?.traceId) return corr.traceId;
    return (
      (request.headers['x-trace-id'] as string) ||
      (request.headers['traceparent'] as string) ||
      (request.headers['x-request-id'] as string) ||
      undefined
    );
  };
  const getClientIp = (request: FastifyRequest): string | undefined => request.ip;

  const getCorrelationId = (request: FastifyRequest): string => {
    const corr = getCorrelation();
    return corr?.traceId ? `${request.id}:${corr.traceId}` : request.id;
  };

  const auditBase = (
    request: FastifyRequest,
    fields: Omit<AuditRecord, 'id' | 'at' | 'requestId' | 'traceId' | 'ip' | 'result'> & {
      result?: 'success' | 'failure';
    },
  ): Omit<AuditRecord, 'id' | 'at'> => {
    const corr = getCorrelation();
    const base: Omit<AuditRecord, 'id' | 'at'> = {
      ...fields,
      requestId: request.id,
      result: fields.result ?? 'success',
    };
    const tid = corr?.traceId ?? getTraceId(request);
    if (tid !== undefined) (base as Record<string, unknown>).traceId = tid;
    const ip = getClientIp(request);
    if (ip !== undefined) (base as Record<string, unknown>).ip = ip;
    // also record audit metric
    try {
      metrics.recordAudit(fields.action);
    } catch {
      // ignore
    }
    return base;
  };

  const enforceCsrf = (request: FastifyRequest): void => {
    if (CSRF_EXEMPT_METHODS.has(request.method)) return;
    const cookies = parseCookieHeader(request.headers.cookie);
    if (!cookies[SESSION_COOKIE]) return;
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') || requestApiKey(request)) return;

    const origin = request.headers.origin;
    const secFetchSite = request.headers['sec-fetch-site'];
    const browserRequest = Boolean(origin || secFetchSite);
    if (!browserRequest) {
      // Non-browser clients (inject, curl, service-to-service) do not send
      // Origin. Production-like environments still refuse cookie mutations
      // without a browser signal; explicit CSRF_STRICT does the same in dev.
      if (productionLike || process.env.CSRF_STRICT === '1') {
        throw new RequestProblem(403, 'CSRF_REQUIRED', 'Missing Origin or Sec-Fetch-Site');
      }
      return;
    }
    if (origin) {
      if (!allowedOrigins.includes(origin)) {
        throw new RequestProblem(403, 'CSRF_ORIGIN_DENIED', 'Origin is not allowed');
      }
    } else if (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
      throw new RequestProblem(403, 'CSRF_ORIGIN_DENIED', 'Cross-site request denied');
    }
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = request.headers['x-csrf-token'];
    const presented = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!cookieToken || !presented || !safeEqual(cookieToken, presented)) {
      throw new RequestProblem(403, 'CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token');
    }
  };

  const requireSession = async (request: FastifyRequest): Promise<SessionAuth> => {
    const token = requestToken(request);
    if (!token) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const session = await store.getSession(token);
    if (!session) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const user = await store.getUser(session.userId);
    if (!user) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    // Enrich correlation with user for observability
    setCorrelationPatch({ userId: user.id });
    if (user.status !== 'active') {
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    }
    return { token, user, session };
  };

  const revokeApiKeyQuietly = async (
    apiKeyId: string,
    tenantId: string,
    userId: string | null,
  ): Promise<void> => {
    try {
      await apiKeyStore.revoke(
        {
          tenantId,
          requestId: 'api-key-owner-check',
          ...(userId ? { userId } : {}),
        },
        apiKeyId,
      );
    } catch {
      // The key is already invalid; revocation is best-effort self-healing.
    }
  };

  const revokeMemberApiKeys = async (
    context: StoreTenantContext,
    userId: string,
  ): Promise<void> => {
    try {
      const keys = await apiKeyStore.list(context);
      await Promise.all(
        keys
          .filter((key) => key.createdBy === userId && !key.revokedAt)
          .map((key) => revokeApiKeyQuietly(key.id, context.tenantId, context.userId ?? null)),
      );
    } catch {
      // Persistent removal already revokes keys inside the membership transaction.
    }
  };

  const requireTenantContext = async (request: FastifyRequest): Promise<TenantContext> => {
    const rawApiKey = requestApiKey(request);
    if (rawApiKey) {
      const resolution = resolveTenantFromHost(request.headers.host, baseDomain, '');
      if (!resolution) {
        throw new RequestProblem(400, 'TENANT_REQUIRED', 'A valid tenant host is required');
      }
      const organization = await store.getOrganizationBySlug(resolution.tenantSlug);
      if (!organization || organization.status !== 'active') {
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      }
      if (!rawApiKey.startsWith('pk_') || rawApiKey.length < 12) {
        throw new RequestProblem(401, 'UNAUTHORIZED', 'Invalid API key');
      }
      const record = await apiKeyStore.verify(rawApiKey.slice(0, 8), rawApiKey, organization.id);
      if (!record || record.tenantId !== organization.id) {
        throw new RequestProblem(401, 'UNAUTHORIZED', 'Invalid API key');
      }
      const creator = record.createdBy ? await store.getUser(record.createdBy) : null;
      if (!creator || creator.status !== 'active') {
        await revokeApiKeyQuietly(record.id, organization.id, record.createdBy);
        throw new RequestProblem(401, 'UNAUTHORIZED', 'API key owner is inactive');
      }
      const membership = await store.getActiveMembership(
        { tenantId: organization.id, requestId: request.id, userId: creator.id },
        creator.id,
      );
      if (!membership || membership.status !== 'active') {
        await revokeApiKeyQuietly(record.id, organization.id, creator.id);
        throw new RequestProblem(403, 'FORBIDDEN', 'API key owner is not an active member');
      }
      const principal = creator;
      setCorrelationPatch({ tenantId: organization.id, userId: principal.id });
      return {
        token: `api-key:${record.id}`,
        user: principal,
        session: {
          tokenHash: `api-key:${record.id}`,
          userId: principal.id,
          expiresAt: record.expiresAt ?? Number.MAX_SAFE_INTEGER,
          selectedTenantId: organization.id,
        },
        authType: 'api_key',
        requestId: request.id,
        tenantId: organization.id,
        organization,
        membership,
        roles: [membership.role],
        apiKeyScopes: record.scopes,
        apiKeyId: record.id,
      };
    }

    const auth = await requireSession(request);
    const resolution = resolveTenantFromHost(request.headers.host, baseDomain, '');
    if (!resolution) {
      throw new RequestProblem(400, 'TENANT_REQUIRED', 'A valid tenant host is required');
    }
    const organization = await store.getOrganizationBySlug(resolution.tenantSlug);
    if (!organization || organization.status !== 'active') {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    // Propagate tenant to correlation (for logs/metrics/DB application_name)
    setCorrelationPatch({ tenantId: organization.id, userId: auth.user.id });
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
      authType: 'session',
      requestId: request.id,
      tenantId: organization.id,
      organization,
      membership,
      roles: [membership.role],
    };
  };

  const requirePermission = (context: TenantContext, permission: Permission): void => {
    if (context.authType === 'api_key') {
      if (!context.apiKeyScopes?.includes(permission)) {
        throw new RequestProblem(403, 'FORBIDDEN', 'API key scope is insufficient');
      }
      return;
    }
    if (!rolesHavePermission(context.roles, permission)) {
      throw new RequestProblem(403, 'FORBIDDEN', 'You do not have permission for this action');
    }
  };

  const requireHumanAuth = (context: TenantContext): void => {
    if (context.authType === 'api_key') {
      throw new RequestProblem(403, 'FORBIDDEN', 'A user session is required for this action');
    }
  };

  const invalidateCache = async (tenantId: string, resource: string): Promise<void> => {
    try {
      await cache.deleteByPrefix(buildCachePrefix(tenantId, resource));
    } catch {
      // fail-open
    }
  };

  /** Public file projection: never expose tenantId, ownerId or the raw S3 key. */
  const fileView = (file: {
    id: string;
    filename: string;
    contentType: string;
    sizeExpected: number;
    sizeActual: number | null;
    status: string;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
  }): Record<string, unknown> => ({
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    sizeExpected: file.sizeExpected,
    sizeActual: file.sizeActual,
    status: file.status,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    expiresAt: file.expiresAt,
  });

  /**
   * A pending upload past its TTL still owns an S3 object. Delete first; only
   * mark the row expired after the delete succeeds. A failed delete leaves the
   * row pending so GC retries instead of leaking the object.
   */
  const expirePendingFile = async (
    context: { tenantId: string; requestId: string; userId: string },
    file: { id: string; key: string; status: string; expiresAt: number },
  ): Promise<void> => {
    if (file.status !== 'pending' || file.expiresAt > Date.now()) return;
    try {
      await s3Breaker.execute(() => getDefaultS3Service().deleteObject(file.key));
    } catch (error) {
      if (
        error instanceof Error &&
        (error as unknown as { code?: string }).code === 'CIRCUIT_OPEN'
      ) {
        throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Storage temporarily unavailable');
      }
      throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Could not expire upload');
    }
    await fileStore.markExpired(context, file.id);
  };

  const jwksCache = new Map<string, { keys: OidcJsonWebKey[]; fetchedAt: number }>();
  const JWKS_TTL_MS = 5 * 60 * 1000;

  const getJwks = async (jwksUri: string): Promise<OidcJsonWebKey[]> => {
    const cached = jwksCache.get(jwksUri);
    if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
    const keyResponse = await fetch(jwksUri, { headers: { accept: 'application/json' } });
    if (!keyResponse.ok) throw new Error('oidc_jwks_failed');
    const keyPayload = (await keyResponse.json()) as { keys?: unknown };
    if (!Array.isArray(keyPayload.keys)) throw new Error('oidc_jwks_invalid');
    const keys = keyPayload.keys as OidcJsonWebKey[];
    jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
    return keys;
  };

  const createOidcIdentity = async (
    code: string,
    state: OidcStateRecord,
  ): Promise<OidcIdentity> => {
    if (options.oidcAuthenticator) return options.oidcAuthenticator({ code, state });
    if (!oidc.issuer || !oidc.clientId) {
      throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'OIDC is not configured');
    }
    const metadata = await oidcBreaker.execute(() => discoverOidcProvider(oidc.issuer));
    const { idToken } = await exchangeOidcCode({
      metadata,
      code,
      clientId: oidc.clientId,
      ...(oidc.clientSecret ? { clientSecret: oidc.clientSecret } : {}),
      redirectUri: state.redirectUri,
      ...(state.codeVerifier ? { codeVerifier: state.codeVerifier } : {}),
    });
    const keys = await getJwks(metadata.jwksUri);
    return validateOidcIdToken(idToken, keys, {
      issuer: metadata.issuer,
      clientId: oidc.clientId,
      nonce: state.nonce,
      emailVerified: oidcEmailVerified,
    });
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    enforceCsrf(request);
    if (request.url.startsWith('/v1/auth')) {
      reply.header('cache-control', 'no-store');
    }
  });

  app.get('/health/live', async () => getLiveness());
  app.get('/health/ready', async (_request, reply) => {
    const report = await health.readiness();
    if (report.status !== 'ok') {
      return reply.status(503).send(report);
    }
    return report;
  });
  app.get('/health/startup', async (_request, reply) => {
    const report = await health.startup();
    if (report.status !== 'ok') {
      return reply.status(503).send(report);
    }
    return report;
  });
  app.get('/metrics', async (request, reply) => {
    if (metricsToken) {
      const authorization = request.headers.authorization;
      const presented = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';
      if (!presented || !safeEqual(presented, metricsToken)) {
        metrics.recordMetricsScrapeDenied();
        return reply.status(403).send(errorBody(request.id, 'FORBIDDEN', 'Metrics token required'));
      }
    } else if (productionLike) {
      metrics.recordMetricsScrapeDenied();
      return reply
        .status(503)
        .send(errorBody(request.id, 'METRICS_NOT_CONFIGURED', 'Metrics token is not configured'));
    }
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
      usePkce: true,
    });
    await stateStore.issue({
      state: request.state,
      nonce: request.nonce,
      redirectUri: oidc.redirectUri ?? DEFAULT_OIDC_REDIRECT_URI,
      ...(request.codeVerifier ? { codeVerifier: request.codeVerifier } : {}),
    });
    reply.header('set-cookie', stateCookie(request.state, secureCookies, sessionCookieDomain));
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
    const state = await stateStore.consume(query.state, {
      redirectUri: oidc.redirectUri ?? DEFAULT_OIDC_REDIRECT_URI,
    });
    if (!state) throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid or expired OIDC state');

    const identity = await createOidcIdentity(query.code, state);
    if (identity.emailVerified === false) {
      throw new RequestProblem(403, 'FORBIDDEN', 'Email address is not verified');
    }
    const user = await store.upsertOidcUser(identity);
    if (user.status !== 'active')
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    // Never mint a session from a stale in-memory object: re-read the row so a
    // concurrent suspension cannot be masked by the upsert result.
    const current = await store.getUser(user.id);
    if (!current || current.status !== 'active') {
      throw new RequestProblem(403, 'FORBIDDEN', 'User access is suspended');
    }
    const token = await store.createSession(current.id);
    await store.addAudit(
      auditBase(request, {
        action: 'login',
        actorUserId: current.id,
        metadata: { issuer: identity.issuer },
      }),
    );
    reply.header('set-cookie', [
      ...issueSessionCookies(token),
      clearStateCookie(secureCookies, sessionCookieDomain),
    ]);
    return reply.redirect(process.env.WEB_PUBLIC_URL ?? 'http://app.localhost:3000');
  });

  app.post('/v1/auth/dev-login', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    if (!allowDevLogin) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    await enforceEndpointRateLimit(request, reply, 'POST /v1/auth/dev-login', request.ip);
    const body = parseOrThrow(DevLoginSchema, request.body);
    const user = await store.getUser(body.userId);
    if (!user || user.status !== 'active')
      throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    const token = await store.createSession(user.id);
    await store.addAudit(auditBase(request, { action: 'login', actorUserId: user.id }));
    reply.header('set-cookie', issueSessionCookies(token));
    const organizations = await listOrganizationsForUser(user.id);
    return {
      user: userView(user),
      organizations: organizations.map(organizationView),
    };
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const auth = await requireSession(request);
    const cookies = parseCookieHeader(request.headers.cookie);
    if (!cookies[CSRF_COOKIE]) {
      reply.header('set-cookie', csrfCookie(newCsrfToken(), secureCookies, sessionCookieDomain));
    }
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
        await store.addAudit(auditBase(request, { action: 'logout', actorUserId: session.userId }));
        await store.revokeSession(token);
      }
    }
    reply.header('set-cookie', [
      clearSessionCookie(secureCookies, sessionCookieDomain),
      clearCsrfCookie(secureCookies, sessionCookieDomain),
    ]);
    return { status: 'ok' };
  });

  app.delete('/v1/auth/sessions', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const auth = await requireSession(request);
    const revoked = await store.revokeAllSessions(auth.user.id);
    await store.addAudit(
      auditBase(request, {
        action: 'logout',
        actorUserId: auth.user.id,
        metadata: { scope: 'all_sessions', revoked: String(revoked) },
      }),
    );
    reply.header('set-cookie', [
      clearSessionCookie(secureCookies, sessionCookieDomain),
      clearCsrfCookie(secureCookies, sessionCookieDomain),
    ]);
    return { status: 'ok', revoked };
  });

  app.post('/v1/auth/refresh', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const auth = await requireSession(request);
    const refreshed = await store.refreshSession(auth.token);
    if (!refreshed) throw new RequestProblem(401, 'UNAUTHORIZED', 'Authentication required');
    reply.header('set-cookie', issueSessionCookies(refreshed.token));
    return { status: 'ok', expiresAt: refreshed.session.expiresAt };
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
    await store.addAudit(
      auditBase(request, {
        action: 'organization.switched',
        actorUserId: auth.user.id,
        tenantId: organization.id,
        resourceId: organization.id,
      }),
    );
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
    await store.addAudit(
      auditBase(request, {
        action: 'organization.created',
        actorUserId: auth.user.id,
        tenantId: organization.id,
        resourceId: organization.id,
      }),
    );
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

  app.get('/v1/branches', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    requirePermission(context, 'branches:read');
    const cacheKey = buildCacheKey(context.tenantId, 'branches', {});
    const { value, hit } = await cache.getOrLoad(cacheKey, CACHE_TTLS.branches, async () => {
      const branches = await store.listBranches(context);
      return {
        data: branches.map((branch: BranchRecord) => ({
          id: branch.id,
          slug: branch.slug,
          name: branch.name,
          ...(branch.description !== undefined ? { description: branch.description ?? '' } : {}),
          status: branch.status,
        })),
      };
    });
    reply.header('x-cache', hit ? 'HIT' : 'MISS');
    reply.header('cache-control', `private, max-age=${CACHE_TTLS.branches / 1000}`);
    return value;
  });

  // Expand-contract branch create: supports description (nullable expand), old clients without description still 201
  app.post('/v1/branches', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    requirePermission(context, 'branches:create');
    const body = parseOrThrow(BranchCreateSchema, request.body);
    // Try persistent path with description, fallback without if column missing
    if (
      'createBranch' in store &&
      typeof (store as unknown as { createBranch: unknown }).createBranch === 'function'
    ) {
      const ps = store as unknown as {
        createBranch: (
          ctx: StoreTenantContext,
          input: { slug: string; name: string; description?: string | null },
        ) => Promise<BranchRecord>;
      };
      try {
        const created = await ps.createBranch(context, {
          slug: body.slug,
          name: body.name,
          description: body.description ?? null,
        });
        await invalidateCache(context.tenantId, 'branches');
        await store.addAudit(
          auditBase(request, {
            action: 'organization.created',
            actorUserId: context.user.id,
            tenantId: context.tenantId,
            resourceId: created.id,
            metadata: { branch: created.slug },
          }),
        );
        return reply.status(201).send({
          branch: {
            id: created.id,
            slug: created.slug,
            name: created.name,
            description: created.description ?? '',
            status: created.status,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('description') && msg.includes('does not exist')) {
          // fallback: create without description (vN compat)
          const fallback = await (
            store as unknown as {
              createBranch: (
                ctx: StoreTenantContext,
                input: { slug: string; name: string },
              ) => Promise<BranchRecord>;
            }
          ).createBranch(context, { slug: body.slug, name: body.name });
          await invalidateCache(context.tenantId, 'branches');
          return reply.status(201).send({
            branch: {
              id: fallback.id,
              slug: fallback.slug,
              name: fallback.name,
              status: fallback.status,
            },
          });
        }
        if (
          msg === 'organization_slug_taken' ||
          msg.includes('branch_slug_taken') ||
          msg.includes('duplicate key')
        )
          throw new RequestProblem(409, 'CONFLICT', 'Branch slug already exists');
        throw error;
      }
    }
    // InMemory path: direct map write tenant-scoped
    const memStore = store as unknown as InMemoryIdentityStore;
    try {
      // Check duplicate slug for tenant
      const existing = (memStore as unknown as { branches: Map<string, BranchRecord> }).branches
        ? [
            ...(memStore as unknown as { branches: Map<string, BranchRecord> }).branches.values(),
          ].find((b) => b.organizationId === context.tenantId && b.slug === body.slug)
        : null;
      if (existing) throw new RequestProblem(409, 'CONFLICT', 'Branch slug already exists');
      const id = `branch_${body.slug}_${Math.random().toString(36).slice(2, 8)}`;
      const record: BranchRecord = {
        id,
        organizationId: context.tenantId,
        slug: body.slug,
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        status: 'active',
      };
      (memStore as unknown as { branches: Map<string, BranchRecord> }).branches.set(id, record);
      await invalidateCache(context.tenantId, 'branches');
      return reply.status(201).send({
        branch: {
          id: record.id,
          slug: record.slug,
          name: record.name,
          description: record.description ?? '',
          status: record.status,
        },
      });
    } catch (e) {
      if (e instanceof RequestProblem) throw e;
      throw e;
    }
  });

  app.patch('/v1/branches/:id', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'branches:update');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Branch id required');
    const body = parseOrThrow(BranchUpdateSchema, request.body ?? {});
    // Try persistent
    if (
      'updateBranch' in store &&
      typeof (store as unknown as { updateBranch: unknown }).updateBranch === 'function'
    ) {
      const ps = store as unknown as {
        updateBranch: (
          ctx: StoreTenantContext,
          id: string,
          patch: { name?: string; description?: string | null },
        ) => Promise<BranchRecord | null>;
      };
      const updated = await ps.updateBranch(context, params.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
      if (!updated) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      await invalidateCache(context.tenantId, 'branches');
      return {
        branch: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          description: updated.description ?? '',
          status: updated.status,
        },
      };
    }
    // InMemory
    const memStore = store as unknown as InMemoryIdentityStore;
    const map = (memStore as unknown as { branches: Map<string, BranchRecord> }).branches;
    const existing = map.get(params.id);
    if (!existing || existing.organizationId !== context.tenantId)
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    if (body.name !== undefined) existing.name = body.name;
    if (body.description !== undefined) existing.description = body.description;
    await invalidateCache(context.tenantId, 'branches');
    return {
      branch: {
        id: existing.id,
        slug: existing.slug,
        name: existing.name,
        description: existing.description ?? '',
        status: existing.status,
      },
    };
  });

  app.get('/v1/members', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    requirePermission(context, 'members:read');
    const cacheKey = buildCacheKey(context.tenantId, 'members', {});
    const { value, hit } = await cache.getOrLoad(cacheKey, CACHE_TTLS.members, async () => ({
      data: await Promise.all(
        (await store.listMembershipsForOrganization(context)).map((m) => membershipView(m, store)),
      ),
    }));
    reply.header('x-cache', hit ? 'HIT' : 'MISS');
    reply.header('cache-control', `private, max-age=${CACHE_TTLS.members / 1000}`);
    return value;
  });

  app.post('/v1/members/invitations', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    requirePermission(context, 'members:invite');
    const body = parseOrThrow(InvitationCreateSchema, request.body);
    if (!canAssignRole(context.membership.role, body.role)) {
      throw new RequestProblem(403, 'FORBIDDEN', 'You cannot invite a member with that role');
    }
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
    await store.addAudit(
      auditBase(request, {
        action: 'invitation.created',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: created.invitation.id,
        metadata: { role: body.role },
      }),
    );
    await invalidateCache(context.tenantId, 'members');
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
      if (auth.user.emailVerified === false) {
        throw new RequestProblem(403, 'FORBIDDEN', 'Email address is not verified');
      }
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
      await store.addAudit(
        auditBase(request, {
          action: 'invitation.accepted',
          actorUserId: auth.user.id,
          tenantId: organization.id,
          resourceId: invitation.id,
        }),
      );
      return { membership: membership ? await membershipView(membership, store) : null };
    },
  );

  app.patch(
    '/v1/members/:membershipId',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request, reply) => {
      const context = await requireTenantContext(request);
      await enforceTenantRateLimit(request, reply as never, context);
      requirePermission(context, 'members:update_role');
      const params = request.params as { membershipId?: string };
      const body = parseOrThrow(RoleUpdateSchema, request.body);
      const membership = params.membershipId
        ? await store.getMembership(context, params.membershipId)
        : null;
      if (!membership || membership.organizationId !== context.tenantId) {
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      }
      if (membership.userId === context.user.id) {
        throw new RequestProblem(403, 'FORBIDDEN', 'You cannot change your own role');
      }
      if (requiresOwnerApproval(membership.role, body.role)) {
        requirePermission(context, 'members:assign_owner');
        if (context.membership.role !== 'owner') {
          throw new RequestProblem(403, 'FORBIDDEN', 'Only an owner can manage owners');
        }
      }
      if (!canAssignRole(context.membership.role, body.role)) {
        throw new RequestProblem(403, 'FORBIDDEN', 'You cannot assign that role');
      }
      try {
        const updated = await store.updateMembershipRole(context, membership.id, body.role);
        await store.addAudit(
          auditBase(request, {
            action: 'membership.role_changed',
            actorUserId: context.user.id,
            tenantId: context.tenantId,
            resourceId: updated.id,
            metadata: { role: updated.role },
          }),
        );
        await invalidateCache(context.tenantId, 'members');
        return { membership: await membershipView(updated, store) };
      } catch (error) {
        if (error instanceof Error && error.message === 'last_owner') {
          throw new RequestProblem(409, 'CONFLICT', 'An organization must keep an active owner');
        }
        throw error;
      }
    },
  );

  app.delete('/v1/members/:membershipId', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'members:remove');
    const params = request.params as { membershipId?: string };
    const membership = params.membershipId
      ? await store.getMembership(context, params.membershipId)
      : null;
    if (!membership || membership.organizationId !== context.tenantId) {
      throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    }
    if (membership.role === 'owner' && context.membership.role !== 'owner') {
      throw new RequestProblem(403, 'FORBIDDEN', 'Only an owner can remove an owner');
    }
    try {
      const removed = await store.removeMembership(context, membership.id);
      await store.addAudit(
        auditBase(request, {
          action: 'membership.removed',
          actorUserId: context.user.id,
          tenantId: context.tenantId,
          resourceId: removed.id,
        }),
      );
      await invalidateCache(context.tenantId, 'members');
      await revokeMemberApiKeys(context, removed.userId);
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
    await enforceTenantRateLimit(request, reply, context);
    await enforceEndpointRateLimit(request, reply, 'POST /v1/inventory/reserve', context.tenantId);
    requirePermission(context, 'inventory:reserve');
    const body = parseOrThrow(ReserveSchema, request.body);
    try {
      const reservation = await inventoryStore.reserve(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        {
          branchId: body.branchId,
          productId: body.productId,
          quantity: body.quantity,
          correlationId: getCorrelationId(request),
          createdBy: context.user.id,
        },
      );
      await invalidateCache(context.tenantId, 'inventory');
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

  app.get('/v1/inventory/reservations', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'inventory:read');
    const reservations = await inventoryStore.listReservations({
      tenantId: context.tenantId,
      requestId: request.id,
      userId: context.user.id,
    });
    return { data: reservations };
  });

  app.get('/v1/inventory', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    requirePermission(context, 'inventory:read');
    const query = parseOrThrow(InventoryListQuery, request.query);
    const cacheKey = buildCacheKey(context.tenantId, 'inventory', {
      branchId: query.branchId,
      q: query.q ?? '',
      limit: query.limit,
      cursor: query.cursor ?? '',
    });
    const { value, hit } = await cache.getOrLoad(cacheKey, CACHE_TTLS.inventory, async () =>
      inventoryStore.listStock(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        query.branchId,
        { q: query.q, limit: query.limit, cursor: query.cursor },
      ),
    );
    reply.header('x-cache', hit ? 'HIT' : 'MISS');
    reply.header('cache-control', `private, max-age=${CACHE_TTLS.inventory / 1000}`);
    return value;
  });

  // --- Orders + Payments saga (tenant-isolation 6 capas + RLS) ---
  app.post('/v1/orders', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    await enforceEndpointRateLimit(request, reply, 'POST /v1/orders', context.tenantId);
    requirePermission(context, 'orders:create');
    // Kill switch per tenant (Fase 14): if kill_orders_write enabled, reject with 503 without touching DB
    try {
      const killed = await featureFlagStore.isEnabled(context, 'kill_orders_write');
      if (killed)
        throw new RequestProblem(503, 'KILL_SWITCH', 'Orders write disabled by kill switch');
    } catch (e) {
      if (e instanceof RequestProblem) throw e;
    }
    const body = parseOrThrow(OrderCreateSchema, request.body);
    const idempotencyHeader = request.headers['idempotency-key'];
    const rawIdempotencyKey = Array.isArray(idempotencyHeader)
      ? idempotencyHeader[0]
      : (idempotencyHeader ?? body.idempotencyKey);
    let idempotencyKey: string;
    try {
      idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    } catch (error) {
      throw new RequestProblem(
        400,
        'BAD_REQUEST',
        error instanceof Error && error.message === 'idempotency_key_required'
          ? 'Idempotency-Key header is required'
          : 'Idempotency-Key is invalid',
      );
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          branchId: body.branchId,
          amountCents: body.amountCents,
          currency: body.currency ?? 'USD',
          paymentMethodId: body.paymentMethodId ?? null,
        }),
      )
      .digest('hex');
    const persistentOrders = Boolean(directDatabase);
    if (persistentOrders) requireUuid(body.branchId, 'branchId');
    // branch must belong to tenant: check via store.listBranches
    const branches = await store.listBranches(context);
    if (!branches.some((b) => b.id === body.branchId)) {
      if (branches.length > 0 || persistentOrders) {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid branch');
      }
    }
    try {
      const result = await paymentStore.createOrderWithPayment(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        {
          branchId: body.branchId,
          amountCents: body.amountCents,
          currency: body.currency ?? 'USD',
          ...(body.paymentMethodId ? { paymentMethodId: body.paymentMethodId } : {}),
          correlationId: getCorrelationId(request),
          createdBy: context.user.id,
          idempotencyKey,
          requestHash,
        },
      );
      if (!result.idempotentReplay) {
        await store.addAudit(
          auditBase(request, {
            action: 'order.created',
            actorUserId: context.user.id,
            tenantId: context.tenantId,
            resourceId: result.order.id,
            metadata: {
              amountCents: String(result.order.amountCents),
              providerKey: result.paymentAttempt.providerKey,
            },
          }),
        );
      }
      if (result.idempotentReplay) reply.header('idempotent-replayed', 'true');
      return reply.status(201).send({ order: result.order, paymentAttempt: result.paymentAttempt });
    } catch (error) {
      if (error instanceof Error && error.message === 'amount_invalid') {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Invalid amount');
      }
      if (error instanceof Error && error.message === 'idempotency_key_reused') {
        throw new RequestProblem(
          409,
          'CONFLICT',
          'Idempotency-Key was already used with a different request body',
        );
      }
      if (error instanceof Error && error.message === 'idempotency_in_progress') {
        throw new RequestProblem(
          409,
          'CONFLICT',
          'Request with this Idempotency-Key is in progress',
        );
      }
      throw error;
    }
  });

  app.get('/v1/orders', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'orders:read');
    const orders = await paymentStore.listOrders(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      { limit: 25 },
    );
    return { data: orders };
  });

  app.get('/v1/orders/:id', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'orders:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Order id required');
    if (directDatabase) requireUuid(params.id, 'order id');
    const order = await paymentStore.getOrder(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!order) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    return { order };
  });

  app.get('/v1/payments/:id', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'orders:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Payment id required');
    if (directDatabase) requireUuid(params.id, 'payment id');
    const attempt = await paymentStore.getPaymentAttempt(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!attempt) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    return { paymentAttempt: attempt };
  });

  app.get('/v1/orders/:id/payments', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'orders:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Order id required');
    if (directDatabase) requireUuid(params.id, 'order id');
    const order = await paymentStore.getOrder(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!order) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    const attempts = await paymentStore.listPaymentAttempts(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    return { data: attempts };
  });

  // Webhook inbound — no session auth, HMAC + dedupe per tenant.
  //
  // Tenant selection comes from an untrusted header/query selector and is only
  // used to choose the key ring. The signed body must name the same tenant.
  // Events either apply atomically in one transaction or are stored as
  // unprocessed and handed to the reconciler; a no-op is never ACKed as 200.
  app.post(
    '/v1/webhooks/payments',
    { bodyLimit: SMALL_BODY_LIMIT, config: { rawBody: true } },
    async (request, reply) => {
      const rawBody =
        rawBodyByRequest.get(request) ?? Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
      const providerIsStripe = process.env.PAYMENT_PROVIDER === 'stripe';
      const provider: InboundProvider = providerIsStripe ? 'stripe' : 'generic';
      const stripeSignature = request.headers['stripe-signature'] as string | undefined;
      const timestamp =
        (request.headers['x-webhook-timestamp'] as string) ??
        (request.headers['x-timestamp'] as string) ??
        '';
      const signatureHeader =
        (request.headers['x-webhook-signature'] as string) ??
        (request.headers['x-signature'] as string) ??
        '';

      const query = request.query as { tenantId?: string } | undefined;
      const selectorTenantId =
        (request.headers['x-tenant-id'] as string | undefined) ?? query?.tenantId ?? null;

      let candidates: Array<{ version: number; secret: string }> = [];
      if (selectorTenantId && UUID_PATTERN.test(selectorTenantId) && providerSecretStore.enabled) {
        candidates = await providerSecretStore.verificationSecrets(
          { tenantId: selectorTenantId, requestId: request.id },
          provider,
        );
      }
      if (candidates.length === 0) {
        // Single shared env secret is a local/development fallback only. It is
        // never silently used in production-like environments.
        if (productionLike) {
          throw new RequestProblem(
            503,
            'WEBHOOK_NOT_CONFIGURED',
            'Provider webhook secret is not configured for this tenant',
          );
        }
        const envSecret = providerIsStripe
          ? process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET
          : process.env.PAYMENT_WEBHOOK_SECRET;
        candidates = [{ version: 0, secret: envSecret ?? 'test_webhook_secret' }];
      }

      const verification = candidates.map((candidate) =>
        providerIsStripe
          ? verifyStripeWebhookSignature({
              secret: candidate.secret,
              rawBody,
              signatureHeader: stripeSignature,
            })
          : verifyWebhookSignature({
              secret: candidate.secret,
              timestamp,
              rawBody,
              signatureHeader,
            }),
      );
      const verified = verification.find((result) => result.valid);
      if (!verified) {
        const reason = verification[0]?.reason ?? 'signature_missing';
        throw new RequestProblem(401, 'UNAUTHORIZED', `Webhook signature invalid: ${reason}`);
      }

      let body: z.infer<typeof PaymentWebhookSchema>;
      if (providerIsStripe) {
        const stripeEvent = request.body as {
          id?: unknown;
          type?: unknown;
          data?: { object?: Record<string, unknown> };
        };
        const eventId = typeof stripeEvent.id === 'string' ? stripeEvent.id : null;
        const eventType = typeof stripeEvent.type === 'string' ? stripeEvent.type : null;
        const paymentIntent = stripeEvent.data?.object;
        const providerRef = typeof paymentIntent?.id === 'string' ? paymentIntent.id : null;
        if (!eventId || !eventType || !paymentIntent || !providerRef) {
          throw new RequestProblem(400, 'BAD_REQUEST', 'Stripe payment event is malformed');
        }
        const status =
          eventType === 'payment_intent.succeeded'
            ? 'paid'
            : eventType === 'payment_intent.payment_failed' ||
                eventType === 'payment_intent.canceled'
              ? 'failed'
              : eventType === 'payment_intent.processing' ||
                  eventType === 'payment_intent.requires_action'
                ? 'unknown'
                : null;
        if (!status) return reply.status(200).send({ status: 'ignored', eventId });
        const metadata: Record<string, unknown> =
          paymentIntent.metadata && typeof paymentIntent.metadata === 'object'
            ? (paymentIntent.metadata as Record<string, unknown>)
            : {};
        body = parseOrThrow(PaymentWebhookSchema, {
          eventId,
          providerRef,
          status,
          ...(typeof metadata.provider_key === 'string'
            ? { providerKey: metadata.provider_key }
            : {}),
          ...(typeof metadata.tenant_id === 'string' ? { tenantId: metadata.tenant_id } : {}),
          ...(typeof paymentIntent.amount === 'number'
            ? { amountCents: paymentIntent.amount }
            : {}),
          ...(typeof paymentIntent.currency === 'string'
            ? { currency: paymentIntent.currency.toUpperCase() }
            : {}),
        });
      } else {
        body = parseOrThrow(PaymentWebhookSchema, request.body);
      }

      // Tenant identity must come from the normalized (signed) body, never
      // from request.body directly: Stripe's tenant is in metadata.
      if (!body.tenantId) {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Signed tenantId is required in webhook body');
      }
      if (selectorTenantId && selectorTenantId !== body.tenantId) {
        throw new RequestProblem(401, 'UNAUTHORIZED', 'Webhook tenant mismatch');
      }
      const tenantId = body.tenantId;
      if (directDatabase && !UUID_PATTERN.test(tenantId)) {
        throw new RequestProblem(400, 'BAD_REQUEST', 'Persistent webhook tenantId must be a UUID');
      }

      const outcome = await paymentStore.applyPaymentWebhook(
        { tenantId, requestId: request.id },
        {
          eventId: body.eventId,
          providerRef: body.providerRef,
          ...(body.providerKey ? { providerKey: body.providerKey } : {}),
          status: body.status,
          ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
          ...(body.currency !== undefined ? { currency: body.currency } : {}),
          correlationId: getCorrelationId(request),
        },
      );

      if (outcome.outcome === 'duplicate') {
        return { status: 'already_processed', eventId: body.eventId };
      }
      if (outcome.outcome === 'not_found') {
        // Retryable: the provider may deliver before the order row is visible.
        reply.header('retry-after', '5');
        throw new RequestProblem(
          404,
          'NOT_FOUND',
          'No payment attempt matches this provider reference for this tenant',
        );
      }
      if (outcome.outcome === 'mismatch') {
        metrics.recordAudit('payment.webhook_mismatch');
        const actorUserId = outcome.actorUserId ?? (directDatabase ? null : SYSTEM_ACTOR_ID);
        if (actorUserId) {
          await store.addAudit(
            auditBase(request, {
              action: 'payment.webhook_rejected',
              actorUserId,
              tenantId,
              result: 'failure',
              metadata: {
                reason: `amount_or_currency_${outcome.reason}_mismatch`,
                expectedAmountCents: String(outcome.expectedAmountCents),
                expectedCurrency: outcome.expectedCurrency,
                eventId: body.eventId,
                providerRef: body.providerRef,
              },
            }),
          );
        }
        throw new RequestProblem(
          409,
          'CONFLICT',
          `Payment ${outcome.reason} does not match the order`,
          {
            expectedAmountCents: outcome.expectedAmountCents,
            expectedCurrency: outcome.expectedCurrency,
          },
        );
      }
      if (outcome.outcome === 'unresolved') {
        metrics.recordAudit('payment.webhook_unresolved');
        const actorUserId = outcome.actorUserId ?? (directDatabase ? null : SYSTEM_ACTOR_ID);
        if (actorUserId) {
          await store.addAudit(
            auditBase(request, {
              action: 'payment.webhook_unresolved',
              actorUserId,
              tenantId,
              resourceId: outcome.attempt.id,
              result: 'failure',
              metadata: {
                reason: outcome.reason,
                eventId: body.eventId,
                status: body.status,
              },
            }),
          );
        }
        return reply
          .status(202)
          .send({ status: 'unresolved', eventId: body.eventId, reason: outcome.reason });
      }

      metrics.recordAudit(
        outcome.compensating ? 'payment.paid_after_failure' : `payment.webhook_${body.status}`,
      );
      const actorUserId = outcome.actorUserId ?? (directDatabase ? null : SYSTEM_ACTOR_ID);
      if (actorUserId) {
        await store.addAudit(
          auditBase(request, {
            action: 'payment.webhook',
            actorUserId,
            tenantId,
            resourceId: outcome.attempt.id,
            metadata: {
              eventId: body.eventId,
              status: body.status,
              providerRef: body.providerRef,
              compensating: String(outcome.compensating),
            },
          }),
        );
      }
      return reply.status(200).send({ status: 'processed', eventId: body.eventId });
    },
  );

  // --- Webhooks outbound (tenant-scoped) ---
  app.post('/v1/webhooks/endpoints', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    await enforceEndpointRateLimit(request, reply, 'POST /v1/webhooks/endpoints', context.tenantId);
    requirePermission(context, 'webhooks:manage');
    const body = parseOrThrow(WebhookEndpointCreateSchema, request.body);
    try {
      const { endpoint, rawSecret } = await webhookStore.createEndpoint(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        { url: body.url, secret: body.secret, events: body.events, createdBy: context.user.id },
      );
      await store.addAudit(
        auditBase(request, {
          action: 'webhook.created',
          actorUserId: context.user.id,
          tenantId: context.tenantId,
          resourceId: endpoint.id,
          metadata: { webhookCreated: endpoint.id },
        }),
      );
      await invalidateCache(context.tenantId, 'webhooks:endpoints');
      return reply.status(201).send({
        endpoint: {
          id: endpoint.id,
          url: endpoint.url,
          events: endpoint.events,
          status: endpoint.status,
          version: endpoint.version,
        },
        secret: rawSecret,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'webhook_url_taken')
        throw new RequestProblem(409, 'CONFLICT', 'Webhook URL already exists for this tenant');
      if (e instanceof Error && e.message.startsWith('webhook_'))
        throw new RequestProblem(400, 'BAD_REQUEST', e.message);
      throw e;
    }
  });

  app.get('/v1/webhooks/endpoints', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'webhooks:read');
    const cacheKey = buildCacheKey(context.tenantId, 'webhooks:endpoints', {});
    const { value, hit } = await cache.getOrLoad(cacheKey, CACHE_TTLS.webhooks, async () => {
      const eps = await webhookStore.listEndpoints({
        tenantId: context.tenantId,
        requestId: request.id,
        userId: context.user.id,
      });
      return {
        data: eps.map((e) => ({
          id: e.id,
          url: e.url,
          events: e.events,
          status: e.status,
          version: e.version,
        })),
      };
    });
    reply.header('x-cache', hit ? 'HIT' : 'MISS');
    reply.header('cache-control', `private, max-age=${CACHE_TTLS.webhooks / 1000}`);
    return value;
  });

  app.get('/v1/webhooks/endpoints/:id', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'webhooks:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Webhook id required');
    const ep = await webhookStore.getEndpoint(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!ep) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    return {
      endpoint: {
        id: ep.id,
        url: ep.url,
        events: ep.events,
        status: ep.status,
        version: ep.version,
      },
    };
  });

  app.patch(
    '/v1/webhooks/endpoints/:id',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request, reply) => {
      const context = await requireTenantContext(request);
      await enforceTenantRateLimit(request, reply as never, context);
      requirePermission(context, 'webhooks:manage');
      const params = request.params as { id?: string };
      if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Webhook id required');
      const body = parseOrThrow(WebhookEndpointUpdateSchema, request.body);
      try {
        const ep = await webhookStore.updateEndpoint(
          { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
          params.id,
          body,
        );
        await invalidateCache(context.tenantId, 'webhooks:endpoints');
        await store.addAudit(
          auditBase(request, {
            action: 'webhook.updated',
            actorUserId: context.user.id,
            tenantId: context.tenantId,
            resourceId: ep.id,
            metadata: { webhookUpdated: ep.id },
          }),
        );
        return {
          endpoint: {
            id: ep.id,
            url: ep.url,
            events: ep.events,
            status: ep.status,
            version: ep.version,
          },
        };
      } catch (e) {
        if (e instanceof Error && e.message === 'webhook_not_found')
          throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
        if (e instanceof Error && e.message.startsWith('webhook_'))
          throw new RequestProblem(400, 'BAD_REQUEST', e.message);
        throw e;
      }
    },
  );

  app.delete('/v1/webhooks/endpoints/:id', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'webhooks:manage');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Webhook id required');
    try {
      await webhookStore.deleteEndpoint(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
      );
      await invalidateCache(context.tenantId, 'webhooks:endpoints');
      await store.addAudit(
        auditBase(request, {
          action: 'webhook.deleted',
          actorUserId: context.user.id,
          tenantId: context.tenantId,
          resourceId: params.id,
        }),
      );
      return { status: 'deleted' };
    } catch (e) {
      if (e instanceof Error && e.message === 'webhook_not_found')
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      throw e;
    }
  });

  app.post(
    '/v1/webhooks/endpoints/:id/rotate-secret',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request, reply) => {
      const context = await requireTenantContext(request);
      await enforceTenantRateLimit(request, reply as never, context);
      requirePermission(context, 'webhooks:manage');
      if (!['owner', 'admin'].includes(context.membership.role))
        throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
      const params = request.params as { id?: string };
      if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Webhook id required');
      try {
        const { endpoint, rawSecret } = await webhookStore.rotateSecret(
          { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
          params.id,
        );
        await invalidateCache(context.tenantId, 'webhooks:endpoints');
        await store.addAudit(
          auditBase(request, {
            action: 'webhook.secret_rotated',
            actorUserId: context.user.id,
            tenantId: context.tenantId,
            resourceId: endpoint.id,
            metadata: { version: String(endpoint.version) },
          }),
        );
        return reply
          .status(201)
          .send({ endpoint: { id: endpoint.id, version: endpoint.version }, secret: rawSecret });
      } catch (e) {
        if (e instanceof Error && e.message === 'webhook_not_found')
          throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
        throw e;
      }
    },
  );

  app.get('/v1/webhooks/deliveries', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'webhooks:read');
    const query = parseOrThrow(
      z
        .object({
          endpointId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict(),
      request.query,
    );
    const deliveries = await webhookStore.listDeliveries(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      { endpointId: query.endpointId, limit: query.limit },
    );
    return {
      data: deliveries.map((d) => ({
        id: d.id,
        endpointId: d.endpointId,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.nextAttemptAt,
      })),
    };
  });

  app.get('/v1/webhooks/deliveries/:id', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'webhooks:read');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Delivery id required');
    const d = await webhookStore.getDelivery(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      params.id,
    );
    if (!d) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    // Never expose secret or raw payload secrets; payload is safe (no secret)
    return {
      delivery: {
        id: d.id,
        endpointId: d.endpointId,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
      },
    };
  });

  app.post(
    '/v1/webhooks/deliveries/:id/replay',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request) => {
      const context = await requireTenantContext(request);
      requirePermission(context, 'webhooks:replay');
      const params = request.params as { id?: string };
      if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'Delivery id required');
      try {
        const replay = await webhookStore.replayDelivery(
          { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
          params.id,
        );
        await store.addAudit(
          auditBase(request, {
            action: 'webhook.replayed',
            actorUserId: context.user.id,
            tenantId: context.tenantId,
            resourceId: replay.id,
            metadata: { webhookReplay: replay.id },
          }),
        );
        return { delivery: { id: replay.id, eventId: replay.eventId, status: replay.status } };
      } catch (e) {
        if (e instanceof Error && e.message === 'delivery_not_found')
          throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
        throw e;
      }
    },
  );

  // Generic inbound webhook (tenant-scoped via x-tenant-id header, HMAC before parse, dedupe)
  app.post(
    '/v1/webhooks/inbound',
    { bodyLimit: SMALL_BODY_LIMIT, config: { rawBody: true } },
    async (request, reply) => {
      const rawBody =
        rawBodyByRequest.get(request) ?? Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
      const timestamp =
        (request.headers['x-webhook-timestamp'] as string) ??
        (request.headers['x-timestamp'] as string) ??
        '';
      const signatureHeader =
        (request.headers['x-webhook-signature'] as string) ??
        (request.headers['x-signature'] as string) ??
        '';
      // The selector header/path only chooses the tenant key ring. The signed
      // body must name the same tenant.
      const query = request.query as { tenantId?: string } | undefined;
      const selectorTenantId =
        (request.headers['x-tenant-id'] as string | undefined) ?? query?.tenantId ?? null;
      let candidates: Array<{ version: number; secret: string }> = [];
      if (selectorTenantId && UUID_PATTERN.test(selectorTenantId) && providerSecretStore.enabled) {
        candidates = await providerSecretStore.verificationSecrets(
          { tenantId: selectorTenantId, requestId: request.id },
          'inbound',
        );
      }
      if (candidates.length === 0) {
        if (productionLike) {
          throw new RequestProblem(
            503,
            'WEBHOOK_NOT_CONFIGURED',
            'Inbound webhook secret is not configured for this tenant',
          );
        }
        const configuredSecret =
          process.env.WEBHOOK_INBOUND_SECRET ?? process.env.PAYMENT_WEBHOOK_SECRET;
        candidates = [{ version: 0, secret: configuredSecret ?? 'test_webhook_secret' }];
      }
      const verification = candidates.map((candidate) =>
        verifyWebhookSignature({
          secret: candidate.secret,
          timestamp,
          rawBody,
          signatureHeader,
        }),
      );
      if (!verification.some((result) => result.valid)) {
        throw new RequestProblem(
          401,
          'UNAUTHORIZED',
          `Webhook signature invalid: ${verification[0]?.reason ?? 'signature_missing'}`,
        );
      }
      const body = parseOrThrow(InboundWebhookSchema, request.body);
      const headerTenantId = selectorTenantId;
      const bodyTenantId = body.tenantId ?? null;
      if (!bodyTenantId)
        throw new RequestProblem(400, 'BAD_REQUEST', 'Signed tenantId is required in webhook body');
      if (headerTenantId && headerTenantId !== bodyTenantId) {
        throw new RequestProblem(401, 'UNAUTHORIZED', 'Webhook tenant mismatch');
      }
      const tenantId = bodyTenantId;
      const dedupeKey = `${tenantId}:${body.eventId}`;
      if (inboundDedupe.has(dedupeKey)) {
        return { status: 'already_processed', eventId: body.eventId };
      }
      // Persistent dedupe if DB available
      if (directDatabase) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            tenantId,
          )
        ) {
          throw new RequestProblem(
            400,
            'BAD_REQUEST',
            'Persistent webhook tenantId must be a UUID',
          );
        }
        const db = directDatabase;
        if (!db)
          throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Database is not configured');
        {
          const inserted = await withTenantTransaction(
            db,
            { tenantId, requestId: request.id },
            (tx) =>
              tx.execute<{ id: string }>(sql`
              insert into inbound_webhook_events (tenant_id, event_id, source, payload)
              values (${tenantId}::uuid, ${body.eventId}, ${body.source ?? 'external'}, ${JSON.stringify(body.payload ?? body)}::jsonb)
              on conflict (tenant_id, event_id) do nothing returning id
            `),
          );
          if (inserted.length === 0) {
            inboundDedupe.add(dedupeKey);
            return { status: 'already_processed', eventId: body.eventId };
          }
        }
      }
      inboundDedupe.add(dedupeKey);
      // For demo, we just ack; automations could be triggered here via outbox
      return reply.status(200).send({ status: 'processed', eventId: body.eventId });
    },
  );

  // --- API Keys M2M (tenant-scoped) ---
  app.post('/v1/api-keys', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    requireHumanAuth(context);
    requirePermission(context, 'webhooks:manage');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const body = parseOrThrow(ApiKeyCreateSchema, request.body);
    const { record, raw } = await apiKeyStore.create(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      {
        name: body.name,
        scopes: body.scopes,
        expiresInMs: body.expiresInMs,
        createdBy: context.user.id,
      },
    );
    await store.addAudit(
      auditBase(request, {
        action: 'api_key.created',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: record.id,
        metadata: { apiKeyCreated: record.id },
      }),
    );
    return reply.status(201).send({
      apiKey: { id: record.id, prefix: record.prefix, name: record.name, scopes: record.scopes },
      raw,
    });
  });

  app.get('/v1/api-keys', async (request) => {
    const context = await requireTenantContext(request);
    requireHumanAuth(context);
    requirePermission(context, 'webhooks:read');
    const keys = await apiKeyStore.list({
      tenantId: context.tenantId,
      requestId: request.id,
      userId: context.user.id,
    });
    return {
      data: keys.map((k) => ({
        id: k.id,
        prefix: k.prefix,
        name: k.name,
        scopes: k.scopes,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      })),
    };
  });

  app.delete('/v1/api-keys/:id', async (request) => {
    const context = await requireTenantContext(request);
    requireHumanAuth(context);
    requirePermission(context, 'webhooks:manage');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'ApiKey id required');
    try {
      await apiKeyStore.revoke(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
      );
      await store.addAudit(
        auditBase(request, {
          action: 'api_key.revoked',
          actorUserId: context.user.id,
          tenantId: context.tenantId,
          resourceId: params.id,
        }),
      );
      return { status: 'revoked' };
    } catch (e) {
      if (e instanceof Error && e.message === 'api_key_not_found')
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      throw e;
    }
  });

  app.post('/v1/api-keys/:id/rotate', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    requireHumanAuth(context);
    requirePermission(context, 'webhooks:manage');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'ApiKey id required');
    try {
      const { record, raw } = await apiKeyStore.rotate(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
      );
      await store.addAudit(
        auditBase(request, {
          action: 'api_key.rotated',
          actorUserId: context.user.id,
          tenantId: context.tenantId,
          resourceId: record.id,
          metadata: { rotatedFrom: params.id, newPrefix: record.prefix },
        }),
      );
      return reply.status(201).send({
        apiKey: {
          id: record.id,
          prefix: record.prefix,
          name: record.name,
          scopes: record.scopes,
        },
        raw,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'api_key_not_found')
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      throw e;
    }
  });

  // --- Automations (versioned commands, tenant-scoped) ---
  const automationsMem = new Map<
    string,
    Map<
      string,
      {
        id: string;
        tenantId: string;
        trigger: string;
        action: unknown;
        version: number;
        enabled: boolean;
      }
    >
  >();
  app.post('/v1/automations', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'automations:manage');
    const body = parseOrThrow(AutomationCreateSchema, request.body);
    const validated = validateAutomation({
      trigger: body.trigger,
      action: body.action,
      version: body.version,
    });
    const id = randomUUID();
    // Persistent if DB available, else memory
    if (directDatabase) {
      const db = directDatabase;
      if (!db)
        throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Database is not configured');
      {
        const rows = await withTenantTransaction(
          db,
          { tenantId: context.tenantId, requestId: request.id },
          async (tx) => {
            const r = await tx.execute<{ id: string }>(sql`
            insert into automations (id, tenant_id, trigger, action, version, enabled, created_by)
            values (${id}::uuid, ${context.tenantId}::uuid, ${validated.trigger}, ${JSON.stringify(validated.action)}::jsonb, ${validated.action.version}, ${body.enabled ?? true}, ${context.user.id}::uuid)
            returning id
          `);
            return r;
          },
        );
        if (rows.length === 0) throw new Error('automation_create_failed');
      }
    } else {
      if (!automationsMem.has(context.tenantId)) automationsMem.set(context.tenantId, new Map());
      automationsMem.get(context.tenantId)!.set(id, {
        id,
        tenantId: context.tenantId,
        trigger: validated.trigger,
        action: validated.action,
        version: validated.action.version,
        enabled: body.enabled ?? true,
      });
    }
    await store.addAudit(
      auditBase(request, {
        action: 'automation.created',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: id,
        metadata: { trigger: validated.trigger },
      }),
    );
    return reply.status(201).send({
      automation: {
        id,
        trigger: validated.trigger,
        action: validated.action,
        version: validated.action.version,
      },
    });
  });

  app.get('/v1/automations', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'automations:read');
    if (directDatabase) {
      const db = directDatabase;
      if (!db)
        throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Database is not configured');
      {
        const rows = await withTenantTransaction(
          db,
          { tenantId: context.tenantId, requestId: request.id },
          async (tx) => {
            return tx.execute<{
              id: string;
              trigger: string;
              action: string;
              version: number;
              enabled: boolean;
            }>(sql`
            select id, trigger, action::text as action, version, enabled from automations where tenant_id=${context.tenantId}::uuid order by created_at desc
          `);
          },
        );
        return {
          data: rows.map((r) => ({
            id: r.id,
            trigger: r.trigger,
            action: JSON.parse(r.action),
            version: r.version,
            enabled: r.enabled,
          })),
        };
      }
    }
    const map = automationsMem.get(context.tenantId);
    const data = map ? [...map.values()] : [];
    return { data };
  });

  // --- Files: presigned S3 flow tenant-scoped ---
  app.post(
    '/v1/files/presigned-upload',
    { bodyLimit: SMALL_BODY_LIMIT },
    async (request, reply) => {
      const context = await requireTenantContext(request);
      await enforceTenantRateLimit(request, reply, context);
      await enforceEndpointRateLimit(
        request,
        reply,
        'POST /v1/files/presigned-upload',
        context.tenantId,
      );
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
        let upload: { url: string; expiresAt: number; headers: Record<string, string> };
        try {
          upload = await s3Breaker.execute(() =>
            s3.generateUploadUrl({
              key: file.key,
              contentType: file.contentType,
              sizeExpected: file.sizeExpected,
              expiresSeconds: UPLOAD_TTL_SECONDS,
            }),
          );
        } catch (e) {
          if (e instanceof Error && (e as unknown as { code?: string }).code === 'CIRCUIT_OPEN') {
            throw new RequestProblem(
              503,
              'DEPENDENCY_UNAVAILABLE',
              'Storage temporarily unavailable',
            );
          }
          throw e;
        }
        // Never log full presigned URL / tokens. The object key stays internal:
        // the client only needs the URL and required headers.
        return reply.status(201).send({
          file: fileView(file),
          upload: {
            url: upload.url,
            expiresAt: upload.expiresAt,
            headers: upload.headers,
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
          if (
            error.message.includes('CIRCUIT_OPEN') ||
            (error as unknown as { code?: string }).code === 'CIRCUIT_OPEN'
          ) {
            throw new RequestProblem(
              503,
              'DEPENDENCY_UNAVAILABLE',
              'Storage temporarily unavailable',
            );
          }
        }
        throw error;
      }
    },
  );

  // Legacy alias for OpenAPI compatibility: /v1/files/presign
  app.post('/v1/files/presign', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply, context);
    await enforceEndpointRateLimit(request, reply, 'POST /v1/files/presign', context.tenantId);
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
    let upload: { url: string; expiresAt: number; headers: Record<string, string> };
    try {
      upload = await s3Breaker.execute(() =>
        s3.generateUploadUrl({
          key: file.key,
          contentType: file.contentType,
          sizeExpected: file.sizeExpected,
          expiresSeconds: UPLOAD_TTL_SECONDS,
        }),
      );
    } catch (e) {
      if (e instanceof Error && (e as unknown as { code?: string }).code === 'CIRCUIT_OPEN')
        throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Storage temporarily unavailable');
      throw e;
    }
    return reply.status(201).send({ file: fileView(file), upload });
  });

  app.post('/v1/files/:id/finalize', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'files:upload');
    const params = request.params as { id?: string };
    if (!params.id) throw new RequestProblem(400, 'BAD_REQUEST', 'File id required');
    const body = parseOrThrow(FileFinalizeSchema, request.body ?? {});
    const contextRef = {
      tenantId: context.tenantId,
      requestId: request.id,
      userId: context.user.id,
    };
    const fileBefore = await fileStore.getById(contextRef, params.id);
    if (!fileBefore) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    await expirePendingFile(contextRef, fileBefore);
    if (fileBefore.status === 'expired') throw new RequestProblem(410, 'GONE', 'Upload expired');
    if (fileBefore.status !== 'pending' && fileBefore.status !== 'ready')
      throw new RequestProblem(409, 'CONFLICT', 'File not in pending state');

    // HEAD is authoritative. `content-length` supplied by the caller and any
    // presigned PUT headers are untrusted; only object storage knows what was
    // actually written.
    let head: { contentLength: number; contentType?: string | undefined } | null;
    try {
      head = await s3Breaker.execute(() => getDefaultS3Service().headObject(fileBefore.key));
    } catch (error) {
      if (error instanceof Error && (error as unknown as { code?: string }).code === 'CIRCUIT_OPEN')
        throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Storage temporarily unavailable');
      throw new RequestProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Could not verify upload');
    }
    if (!head) {
      throw new RequestProblem(409, 'CONFLICT', 'Uploaded object not found');
    }
    if (head.contentLength !== fileBefore.sizeExpected) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'Uploaded object size does not match presign');
    }
    if (body.sizeActual !== undefined && body.sizeActual !== head.contentLength) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'Size mismatch with uploaded object');
    }
    if (head.contentType && head.contentType !== fileBefore.contentType) {
      throw new RequestProblem(400, 'BAD_REQUEST', 'Uploaded object content-type does not match');
    }

    try {
      const finalized = await fileStore.finalize(contextRef, params.id, {
        sizeActual: head.contentLength,
        ...(body.checksum !== undefined ? { checksum: body.checksum } : {}),
      });
      return { file: fileView(finalized) };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'file_not_found')
          throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
        if (error.message === 'file_expired')
          throw new RequestProblem(410, 'GONE', 'Upload expired');
        if (error.message === 'file_not_pending')
          throw new RequestProblem(409, 'CONFLICT', 'File not pending');
        if (error.message === 'size_invalid' || error.message === 'size_mismatch')
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
    await expirePendingFile(
      { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
      file,
    );
    if (file.status === 'expired') throw new RequestProblem(410, 'GONE', 'Upload expired');
    return { file: fileView(file) };
  });

  app.get('/v1/files', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
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
    const contextRef = {
      tenantId: context.tenantId,
      requestId: request.id,
      userId: context.user.id,
    };
    const before = await fileStore.getById(contextRef, params.id);
    if (!before) throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
    await expirePendingFile(contextRef, before);
    if (before.status === 'expired') throw new RequestProblem(410, 'GONE', 'Upload expired');
    try {
      const { file, key } = await fileStore.getDownloadKey(contextRef, params.id);
      const s3 = getDefaultS3Service();
      let download: { url: string; expiresAt: number };
      try {
        download = await s3Breaker.execute(() =>
          s3.generateDownloadUrl({ key, expiresSeconds: DOWNLOAD_TTL_SECONDS }),
        );
      } catch (e) {
        if (e instanceof Error && (e as unknown as { code?: string }).code === 'CIRCUIT_OPEN')
          throw new RequestProblem(
            503,
            'DEPENDENCY_UNAVAILABLE',
            'Storage temporarily unavailable',
          );
        throw e;
      }
      // Avoid logging download.url
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
      await store.addAudit(
        auditBase(request, {
          action: 'dlq.replayed',
          actorUserId: context.user.id,
          tenantId: context.tenantId,
          resourceId: params.id,
          metadata: { dlqReplay: result.jobId },
        }),
      );
      return { jobId: result.jobId, status: 'replayed' };
    } catch (error) {
      if (error instanceof Error && error.message === 'dlq_not_found')
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      if (error instanceof Error && error.message === 'dlq_state_conflict')
        throw new RequestProblem(409, 'CONFLICT', 'DLQ job is not pending');
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
    try {
      await dlqStore.discard(
        { tenantId: context.tenantId, requestId: request.id, userId: context.user.id },
        params.id,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'dlq_not_found')
        throw new RequestProblem(404, 'NOT_FOUND', 'Resource not found');
      if (error instanceof Error && error.message === 'dlq_state_conflict')
        throw new RequestProblem(409, 'CONFLICT', 'DLQ job is not pending');
      throw error;
    }
    await store.addAudit(
      auditBase(request, {
        action: 'dlq.discarded',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: params.id,
      }),
    );
    return { status: 'discarded' };
  });

  // --- Feature flags + kill switches (Fase 14) tenant-scoped ---
  app.get('/v1/flags', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'organization:read');
    const flags = await featureFlagStore.list(context);
    return {
      data: flags.map((f) => ({
        flag: f.flag,
        enabled: f.enabled,
        payload: f.payload,
        updatedAt: f.updatedAt,
      })),
    };
  });

  app.get('/v1/flags/:flag', async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'organization:read');
    const params = request.params as { flag?: string };
    if (!params.flag) throw new RequestProblem(400, 'BAD_REQUEST', 'Flag name required');
    if (!/^[a-z0-9_]{3,64}$/.test(params.flag))
      throw new RequestProblem(400, 'BAD_REQUEST', 'Flag name invalid');
    const rec = await featureFlagStore.get(context, params.flag);
    if (!rec) return { flag: params.flag, enabled: false, payload: {}, updatedAt: null };
    return { flag: rec.flag, enabled: rec.enabled, payload: rec.payload, updatedAt: rec.updatedAt };
  });

  app.put('/v1/flags/:flag', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
    const context = await requireTenantContext(request);
    requirePermission(context, 'audit:read');
    if (!['owner', 'admin'].includes(context.membership.role))
      throw new RequestProblem(403, 'FORBIDDEN', 'Requires owner or admin');
    const params = request.params as { flag?: string };
    if (!params.flag) throw new RequestProblem(400, 'BAD_REQUEST', 'Flag name required');
    if (!/^[a-z0-9_]{3,64}$/.test(params.flag))
      throw new RequestProblem(400, 'BAD_REQUEST', 'Flag name invalid');
    const body = parseOrThrow(FlagUpdateSchema, request.body ?? {});
    const rec = await featureFlagStore.set(
      context,
      params.flag,
      body.enabled,
      body.payload ?? {},
      context.user.id,
    );
    await store.addAudit(
      auditBase(request, {
        action: 'flag.updated',
        actorUserId: context.user.id,
        tenantId: context.tenantId,
        resourceId: params.flag,
        metadata: { flag: params.flag, enabled: String(body.enabled) },
      }),
    );
    // Invalidate any cached flag-derived state: for now no cache, but metrics
    metrics.recordAudit('flag.updated');
    return { flag: rec.flag, enabled: rec.enabled, payload: rec.payload, updatedAt: rec.updatedAt };
  });

  app.get('/v1/audit', async (request, reply) => {
    const context = await requireTenantContext(request);
    await enforceTenantRateLimit(request, reply as never, context);
    requirePermission(context, 'audit:read');
    const query = parseOrThrow(
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).optional(),
          action: z.string().min(1).optional(),
        })
        .strict(),
      request.query,
    );
    const audit: AuditRecord[] = await store.listAudit(context, {
      limit: query.limit,
      cursor: query.cursor,
      action: query.action,
    });
    const nextCursor =
      audit.length === query.limit && audit.length > 0
        ? Buffer.from(
            `${new Date(audit[audit.length - 1]!.at).toISOString()}|${audit[audit.length - 1]!.id}`,
          ).toString('base64url')
        : null;
    return {
      data: audit.map((record) => ({
        id: record.id,
        action: record.action,
        actorUserId: record.actorUserId,
        tenantId: record.tenantId,
        resourceId: record.resourceId,
        requestId: record.requestId,
        traceId: record.traceId,
        ip: record.ip,
        result: record.result,
        at: record.at,
        metadata: record.metadata,
      })),
      nextCursor,
    };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RequestProblem) {
      return reply
        .status(error.statusCode)
        .send(errorBody(request.id, error.code, error.message, error.details));
    }
    const fastifyError = error as Error & { statusCode?: number; code?: string };
    if (fastifyError.statusCode === 413 || fastifyError.code?.includes('BODY_TOO_LARGE')) {
      return reply
        .status(413)
        .send(errorBody(request.id, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
    }
    if (
      fastifyError.statusCode &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      return reply
        .status(fastifyError.statusCode)
        .send(
          errorBody(
            request.id,
            fastifyError.code ?? 'BAD_REQUEST',
            fastifyError.statusCode === 403 ? 'Request denied' : 'Invalid request',
          ),
        );
    }
    const mapped = mapDomainError(error instanceof Error ? error.message : '');
    if (mapped) {
      return reply.status(mapped.status).send(errorBody(request.id, mapped.code, mapped.message));
    }
    const dbCode = (error as { code?: string }).code;
    if (dbCode === '22P02') {
      return reply.status(400).send(errorBody(request.id, 'BAD_REQUEST', 'Invalid identifier'));
    }
    if (dbCode === '23505') {
      return reply.status(409).send(errorBody(request.id, 'CONFLICT', 'Resource already exists'));
    }
    if (dbCode === '42501') {
      return reply.status(403).send(errorBody(request.id, 'FORBIDDEN', 'Request denied'));
    }
    request.log.error({ err: error, request_id: request.id }, 'unhandled_request_error');
    return reply
      .status(500)
      .send(errorBody(request.id, 'INTERNAL_ERROR', 'Unexpected server error'));
  });

  return app;
}
