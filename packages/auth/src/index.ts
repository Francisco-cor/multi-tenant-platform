import { createHash } from 'node:crypto';
import type { Role } from '@platform/domain';

export interface OidcIdentity {
  subject: string;
  email: string;
  displayName?: string;
  issuer: string;
  /** Whether the IdP asserted `email_verified: true`. */
  emailVerified?: boolean;
}

export interface AuthorizedMembership {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: readonly Role[];
}

export interface TenantResolution {
  host: string;
  tenantSlug: string;
  tenantId: string;
}

export interface OidcProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export interface OidcAuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  /** Present when PKCE (S256) is enabled; must be persisted with the state record. */
  codeVerifier?: string;
  codeChallenge?: string;
}

export interface OidcStateRecord {
  state: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
  /** PKCE verifier bound to this login attempt. */
  codeVerifier?: string;
}

export interface OidcStateIssueInput {
  state: string;
  nonce: string;
  redirectUri: string;
  now?: number;
  codeVerifier?: string;
}

export interface OidcStateConsumeOptions {
  now?: number;
  /** When supplied, the record is only returned if it was issued for this redirect URI. */
  redirectUri?: string;
}

/**
 * Login-state store contract.
 *
 * Implementations may be synchronous (in-memory, tests) or asynchronous
 * (Redis). Callers must `await` both methods so they work with either.
 */
export interface OidcStateStore {
  issue(input: OidcStateIssueInput): OidcStateRecord | Promise<OidcStateRecord>;
  consume(
    state: string,
    options?: number | OidcStateConsumeOptions,
  ): OidcStateRecord | null | Promise<OidcStateRecord | null>;
}

export interface OidcTokenValidationOptions {
  issuer: string;
  clientId: string;
  nonce: string;
  now?: number;
  /** Tolerance applied to `exp`, `nbf` and `iat`. Default: 60 seconds. */
  clockSkewSeconds?: number;
  /** Reject tokens issued longer ago than this. */
  maxTokenAgeSeconds?: number;
  /**
   * What to do with the `email_verified` claim.
   * - `'ignore'` (default): accept, but expose the value on the identity.
   * - `'require'`: reject tokens without `email_verified: true`.
   * - function: custom policy; return false to reject.
   */
  emailVerified?:
    | 'ignore'
    | 'require'
    | ((claims: { email: string; emailVerified: boolean | undefined }) => boolean);
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
}

export interface OidcJsonWebKey extends JsonWebKey {
  kid?: string;
}

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STATE_MAX_RECORDS = 10_000;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

function encodeBase64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Constant-time string comparison. Both sides are hashed first so the compared
 * buffers always have the same length and the length of the secret is not
 * exposed through early returns.
 */
export function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error('invalid_json');
  }
}

function decodeJwtPart<T>(value: string): T {
  return parseJson<T>(new TextDecoder().decode(decodeBase64Url(value)));
}

/**
 * Canonical issuer form used for discovery and claim comparison:
 * no trailing slash, no query, no fragment. Invalid input is mapped to a
 * package error instead of leaking a raw `TypeError: Invalid URL`.
 */
export function normalizeIssuer(issuer: unknown): string {
  if (typeof issuer !== 'string' || issuer.trim().length === 0) {
    throw new Error('oidc_issuer_missing');
  }
  let url: URL;
  try {
    url = new URL(issuer.trim());
  } catch {
    throw new Error('oidc_issuer_invalid');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('oidc_issuer_must_use_https');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/u, '');
}

function normalizeIssuerForComparison(issuer: unknown): string | null {
  try {
    return normalizeIssuer(issuer);
  } catch {
    return null;
  }
}

function assertEndpoint(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`oidc_${field}_missing`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`oidc_${field}_invalid`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`oidc_${field}_must_use_https`);
  }
  return url.toString();
}

function requestTimeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined || timeoutMs <= 0) return undefined;
  if (typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(timeoutMs);
}

async function readJsonWithLimit(
  response: Response,
  maxBodyBytes: number,
  errorCode: string,
): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    throw new Error(errorCode);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(errorCode);
  }
}

function mapFetchFailure(error: unknown, timeoutCode: string, fallbackCode: string): never {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    throw new Error(timeoutCode);
  }
  throw new Error(fallbackCode);
}

export interface OidcHttpOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

export async function discoverOidcProvider(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number; maxBodyBytes?: number } = {},
): Promise<OidcProviderMetadata> {
  const normalizedIssuer = normalizeIssuer(issuer);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const signal = requestTimeoutSignal(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${normalizedIssuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    mapFetchFailure(error, 'oidc_timeout', 'oidc_discovery_failed');
  }
  if (!response.ok) throw new Error('oidc_discovery_failed');
  const metadata = (await readJsonWithLimit(
    response,
    maxBodyBytes,
    'oidc_discovery_invalid',
  )) as Record<string, unknown>;
  if (typeof metadata.issuer !== 'string' || metadata.issuer.length === 0) {
    throw new Error('oidc_issuer_missing');
  }
  const discoveredIssuer = normalizeIssuer(metadata.issuer);
  if (discoveredIssuer !== normalizedIssuer) throw new Error('oidc_issuer_mismatch');
  return {
    issuer: discoveredIssuer,
    authorizationEndpoint: assertEndpoint(
      metadata.authorization_endpoint,
      'authorization_endpoint',
    ),
    tokenEndpoint: assertEndpoint(metadata.token_endpoint, 'token_endpoint'),
    jwksUri: assertEndpoint(metadata.jwks_uri, 'jwks_uri'),
  };
}

/** Derive an S256 PKCE challenge from a verifier (RFC 7636). */
export function codeChallengeS256(verifier: string): string {
  if (verifier.length < 43 || verifier.length > 128) {
    throw new Error('pkce_verifier_length_invalid');
  }
  return encodeBase64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function createPkcePair(verifier: string = randomToken(32)): {
  verifier: string;
  challenge: string;
  method: 'S256';
} {
  return { verifier, challenge: codeChallengeS256(verifier), method: 'S256' };
}

export function verifyPkcePair(verifier: string, challenge: string): boolean {
  try {
    return timingSafeEqualStrings(codeChallengeS256(verifier), challenge);
  } catch {
    return false;
  }
}

export function createOidcAuthorizationRequest(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  /**
   * Enable PKCE (S256). Opt-in for backward compatibility: callers must also
   * persist `codeVerifier` in the state record and send it on exchange.
   */
  usePkce?: boolean;
  codeVerifier?: string;
}): OidcAuthorizationRequest {
  const issuer = normalizeIssuer(input.issuer);
  let redirectUri: string;
  try {
    redirectUri = new URL(input.redirectUri).toString();
  } catch {
    throw new Error('oidc_redirect_uri_invalid');
  }
  const state = input.state ?? randomToken();
  const nonce = input.nonce ?? randomToken();
  const authorizationEndpoint = input.authorizationEndpoint
    ? assertEndpoint(input.authorizationEndpoint, 'authorization_endpoint')
    : `${issuer}/authorize`;
  const pkce = input.usePkce === true ? createPkcePair(input.codeVerifier) : null;
  const url = new URL(authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: input.scope ?? 'openid profile email',
    state,
    nonce,
    ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: 'S256' } : {}),
  }).toString();
  return {
    url: url.toString(),
    state,
    nonce,
    ...(pkce ? { codeVerifier: pkce.verifier, codeChallenge: pkce.challenge } : {}),
  };
}

function consumeOptions(
  options: number | OidcStateConsumeOptions | undefined,
  fallbackNow: () => number,
): { now: number; redirectUri?: string } {
  if (typeof options === 'number') return { now: options };
  return {
    now: options?.now ?? fallbackNow(),
    ...(options?.redirectUri ? { redirectUri: options.redirectUri } : {}),
  };
}

export class InMemoryOidcStateStore implements OidcStateStore {
  private readonly records = new Map<string, OidcStateRecord>();
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(ttlMs = DEFAULT_STATE_TTL_MS, options: { maxRecords?: number } = {}) {
    this.ttlMs = ttlMs;
    this.maxRecords = options.maxRecords ?? DEFAULT_STATE_MAX_RECORDS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('oidc_state_ttl_invalid');
    }
    if (!Number.isInteger(this.maxRecords) || this.maxRecords <= 0) {
      throw new Error('oidc_state_capacity_invalid');
    }
  }

  get size(): number {
    return this.records.size;
  }

  issue(input: OidcStateIssueInput): OidcStateRecord {
    const now = input.now ?? Date.now();
    this.sweep(now);
    if (this.records.size >= this.maxRecords) this.evictEarliestExpiry();
    const record: OidcStateRecord = {
      state: input.state,
      nonce: input.nonce,
      redirectUri: input.redirectUri,
      expiresAt: now + this.ttlMs,
      ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
    };
    this.records.set(record.state, record);
    return record;
  }

  consume(state: string, options?: number | OidcStateConsumeOptions): OidcStateRecord | null {
    const { now, redirectUri } = consumeOptions(options, () => Date.now());
    const record = this.records.get(state);
    if (!record) return null;
    const stateMatches = timingSafeEqualStrings(record.state, state);
    const redirectMatches =
      redirectUri === undefined || timingSafeEqualStrings(record.redirectUri, redirectUri);
    // Single-use: delete before any validation outcome so a mismatch cannot be retried.
    this.records.delete(state);
    if (!stateMatches || !redirectMatches) return null;
    return record.expiresAt > now ? record : null;
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.records.clear();
  }

  private evictEarliestExpiry(): void {
    let victim: string | undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.records) {
      if (record.expiresAt < earliest) {
        earliest = record.expiresAt;
        victim = key;
      }
    }
    if (victim !== undefined) this.records.delete(victim);
  }
}

/** Minimal Redis surface required by the state store (ioredis compatible). */
export interface OidcRedisClient {
  set(key: string, value: string, mode: 'PX', ttlMs: number, setMode: 'NX'): Promise<'OK' | null>;
  getdel(key: string): Promise<string | null>;
}

export interface RedisOidcStateStoreOptions {
  client: OidcRedisClient;
  ttlMs?: number;
  keyPrefix?: string;
  now?: () => number;
}

/**
 * Redis-backed store for multi-replica deployments.
 *
 * `issue` uses `SET key value PX ttl NX` (atomic, collision-safe) and
 * `consume` uses `GETDEL` (atomic single-use). Requires Redis >= 6.2.
 */
export class RedisOidcStateStore implements OidcStateStore {
  private readonly client: OidcRedisClient;
  private readonly ttlMs: number;
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(options: RedisOidcStateStoreOptions) {
    if (!options.client || typeof options.client.set !== 'function') {
      throw new Error('oidc_redis_client_invalid');
    }
    if (typeof options.client.getdel !== 'function') {
      throw new Error('oidc_redis_getdel_required');
    }
    this.client = options.client;
    this.ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS;
    this.keyPrefix = options.keyPrefix ?? 'oidc:state:';
    this.now = options.now ?? (() => Date.now());
  }

  private key(state: string): string {
    return `${this.keyPrefix}${state}`;
  }

  async issue(input: OidcStateIssueInput): Promise<OidcStateRecord> {
    const record: OidcStateRecord = {
      state: input.state,
      nonce: input.nonce,
      redirectUri: input.redirectUri,
      expiresAt: (input.now ?? this.now()) + this.ttlMs,
      ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
    };
    const result = await this.client.set(
      this.key(record.state),
      JSON.stringify(record),
      'PX',
      this.ttlMs,
      'NX',
    );
    if (result !== 'OK') throw new Error('oidc_state_conflict');
    return record;
  }

  async consume(
    state: string,
    options?: number | OidcStateConsumeOptions,
  ): Promise<OidcStateRecord | null> {
    const { now, redirectUri } = consumeOptions(options, this.now);
    const raw = await this.client.getdel(this.key(state));
    if (!raw) return null;
    let record: OidcStateRecord;
    try {
      record = JSON.parse(raw) as OidcStateRecord;
    } catch {
      return null;
    }
    if (!record || typeof record.state !== 'string' || typeof record.nonce !== 'string')
      return null;
    if (!timingSafeEqualStrings(record.state, state)) return null;
    if (redirectUri !== undefined && !timingSafeEqualStrings(record.redirectUri, redirectUri)) {
      return null;
    }
    return record.expiresAt > now ? record : null;
  }
}

export interface CreateOidcStateStoreOptions {
  redisClient?: OidcRedisClient | undefined;
  nodeEnv?: string | undefined;
  ttlMs?: number;
  maxRecords?: number;
  requirePersistent?: boolean;
  keyPrefix?: string;
}

/**
 * Select the state store for the current deployment.
 *
 * Production requires a Redis-backed store by default (fail closed) so a
 * multi-replica deployment cannot lose the login state on the second pod.
 */
export async function createOidcStateStore(
  options: CreateOidcStateStoreOptions = {},
): Promise<OidcStateStore> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const requirePersistent = options.requirePersistent ?? nodeEnv === 'production';
  if (options.redisClient) {
    return new RedisOidcStateStore({
      client: options.redisClient,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.keyPrefix !== undefined ? { keyPrefix: options.keyPrefix } : {}),
    });
  }
  if (requirePersistent) throw new Error('oidc_state_store_required');
  return new InMemoryOidcStateStore(
    options.ttlMs ?? DEFAULT_STATE_TTL_MS,
    options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {},
  );
}

export async function exchangeOidcCode(input: {
  metadata: OidcProviderMetadata;
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}): Promise<{ idToken: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const signal = requestTimeoutSignal(timeoutMs);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.metadata.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        redirect_uri: input.redirectUri,
        ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    mapFetchFailure(error, 'oidc_timeout', 'oidc_code_exchange_failed');
  }
  if (!response.ok) throw new Error('oidc_code_exchange_failed');
  const payload = (await readJsonWithLimit(
    response,
    maxBodyBytes,
    'oidc_token_response_invalid',
  )) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string') throw new Error('oidc_id_token_missing');
  return { idToken: payload.id_token };
}

export interface JwksCacheOptions {
  jwksUri: string;
  ttlMs?: number;
  /** Minimum interval between two refetches triggered by an unknown `kid`. */
  minRefetchIntervalMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface JwksCache {
  getKey(kid: string): Promise<OidcJsonWebKey>;
  getKeys(): Promise<readonly OidcJsonWebKey[]>;
  refresh(): Promise<readonly OidcJsonWebKey[]>;
  stats(): { fetches: number; lastFetchedAt: number | null; keys: number };
}

const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_JWKS_REFETCH_MS = 10 * 1000;

/**
 * JWKS cache with a TTL, single-flight refreshes and a rate limit for
 * unknown-`kid` refetches (key rotation). Every fetch has a timeout and a
 * response-size cap so a hanging IdP cannot pin the API worker.
 */
export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  const minRefetchIntervalMs = options.minRefetchIntervalMs ?? DEFAULT_JWKS_REFETCH_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  let keys: OidcJsonWebKey[] = [];
  let lastFetchedAt: number | null = null;
  let lastUnknownKidRefetchAt: number | null = null;
  let inFlight: Promise<OidcJsonWebKey[]> | null = null;
  let fetches = 0;

  const load = async (): Promise<OidcJsonWebKey[]> => {
    const signal = requestTimeoutSignal(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(options.jwksUri, {
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      mapFetchFailure(error, 'oidc_timeout', 'oidc_jwks_failed');
    }
    if (!response.ok) throw new Error('oidc_jwks_failed');
    const payload = (await readJsonWithLimit(response, maxBodyBytes, 'oidc_jwks_invalid')) as {
      keys?: unknown;
    };
    if (!Array.isArray(payload.keys)) throw new Error('oidc_jwks_invalid');
    const parsed = payload.keys.filter(
      (key): key is OidcJsonWebKey =>
        typeof key === 'object' &&
        key !== null &&
        typeof (key as { kid?: unknown }).kid === 'string',
    );
    if (parsed.length === 0) throw new Error('oidc_jwks_invalid');
    keys = parsed;
    lastFetchedAt = now();
    fetches += 1;
    return parsed;
  };

  const refresh = (): Promise<OidcJsonWebKey[]> => {
    if (inFlight) return inFlight;
    inFlight = load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const isFresh = (): boolean => lastFetchedAt !== null && now() - lastFetchedAt < ttlMs;

  const getKeys = async (): Promise<readonly OidcJsonWebKey[]> => {
    if (!isFresh()) return refresh();
    return keys;
  };

  const getKey = async (kid: string): Promise<OidcJsonWebKey> => {
    if (!isFresh()) {
      await refresh();
    }
    const cached = keys.find((candidate) => candidate.kid === kid);
    if (cached) return cached;
    // Unknown kid: likely rotation. Refetch at most once per interval.
    const last = lastUnknownKidRefetchAt;
    if (last === null || now() - last >= minRefetchIntervalMs) {
      lastUnknownKidRefetchAt = now();
      await refresh();
    }
    const rotated = keys.find((candidate) => candidate.kid === kid);
    if (!rotated) throw new Error('oidc_signing_key_not_found');
    return rotated;
  };

  return {
    getKey,
    getKeys,
    refresh: async () => refresh(),
    stats: () => ({ fetches, lastFetchedAt, keys: keys.length }),
  };
}

export type ValidateOidcIdTokenOptions = OidcTokenValidationOptions & {
  jwks?: readonly OidcJsonWebKey[] | JwksCache;
};

export async function validateOidcIdToken(
  idToken: string,
  jwks: readonly OidcJsonWebKey[] | JwksCache,
  options: OidcTokenValidationOptions,
): Promise<OidcIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('oidc_id_token_malformed');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedHeader || !encodedClaims || !encodedSignature)
    throw new Error('oidc_id_token_malformed');
  const header = decodeJwtPart<JwtHeader>(encodedHeader);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('oidc_id_token_algorithm_not_allowed');
  }
  const jwk = Array.isArray(jwks)
    ? (jwks.find((candidate) => candidate.kid === header.kid) ?? null)
    : await (jwks as JwksCache).getKey(header.kid);
  if (!jwk) throw new Error('oidc_signing_key_not_found');
  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signatureIsValid = await globalThis.crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    decodeBase64Url(encodedSignature).slice().buffer as ArrayBuffer,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  if (!signatureIsValid) throw new Error('oidc_id_token_signature_invalid');

  const claims = decodeJwtPart<JwtClaims>(encodedClaims);
  const expectedIssuer = normalizeIssuer(options.issuer);
  const claimIssuer = normalizeIssuerForComparison(claims.iss);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (claimIssuer === null || claimIssuer !== expectedIssuer)
    throw new Error('oidc_id_token_issuer_invalid');
  if (!audience.includes(options.clientId)) throw new Error('oidc_id_token_audience_invalid');
  if (audience.length > 1 || claims.azp !== undefined) {
    if (typeof claims.azp !== 'string' || claims.azp.length === 0) {
      throw new Error('oidc_id_token_azp_missing');
    }
    if (!timingSafeEqualStrings(claims.azp, options.clientId)) {
      throw new Error('oidc_id_token_azp_invalid');
    }
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now - skew)
    throw new Error('oidc_id_token_expired');
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || claims.nbf > now + skew)
      throw new Error('oidc_id_token_not_yet_valid');
  }
  if (typeof claims.iat !== 'number' || claims.iat > now + skew)
    throw new Error('oidc_id_token_iat_invalid');
  if (options.maxTokenAgeSeconds !== undefined) {
    if (now - claims.iat > options.maxTokenAgeSeconds + skew)
      throw new Error('oidc_id_token_too_old');
  }
  if (typeof claims.nonce !== 'string' || !timingSafeEqualStrings(claims.nonce, options.nonce))
    throw new Error('oidc_id_token_nonce_invalid');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0)
    throw new Error('oidc_subject_missing');
  if (typeof claims.email !== 'string' || claims.email.length === 0)
    throw new Error('oidc_email_missing');
  const emailVerified = claims.email_verified === true;
  const policy = options.emailVerified ?? 'ignore';
  if (policy === 'require' && !emailVerified) throw new Error('oidc_email_not_verified');
  if (
    typeof policy === 'function' &&
    !policy({ email: claims.email, emailVerified: claims.email_verified === true })
  ) {
    throw new Error('oidc_email_not_verified');
  }
  return {
    subject: claims.sub,
    email: claims.email,
    ...(typeof claims.name === 'string'
      ? { displayName: claims.name }
      : typeof claims.preferred_username === 'string'
        ? { displayName: claims.preferred_username }
        : {}),
    issuer: expectedIssuer,
    ...(typeof claims.email_verified === 'boolean' ? { emailVerified } : {}),
  };
}

export function resolveTenantFromHost(
  hostHeader: string | undefined,
  baseDomain: string,
  tenantId: string,
): TenantResolution | null {
  if (!hostHeader) return null;
  const normalizedBaseDomain = baseDomain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, '');
  if (!normalizedBaseDomain || normalizedBaseDomain.includes('/')) return null;
  const rawHost = hostHeader.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/u.test(rawHost)) return null;
  const host = rawHost.replace(/:\d{1,5}$/u, '');
  const suffix = `.${normalizedBaseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const tenantSlug = host.slice(0, -suffix.length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(tenantSlug) || tenantSlug.includes('.')) return null;
  return { host, tenantSlug, tenantId };
}
