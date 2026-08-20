import type { Role } from '@platform/domain';

export interface OidcIdentity {
  subject: string;
  email: string;
  displayName?: string;
  issuer: string;
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
}

export interface OidcStateRecord {
  state: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

export interface OidcTokenValidationOptions {
  issuer: string;
  clientId: string;
  nonce: string;
  now?: number;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  preferred_username?: unknown;
}

export interface OidcJsonWebKey extends JsonWebKey {
  kid?: string;
}

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
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

function normalizeIssuer(issuer: string): string {
  const url = new URL(issuer);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('oidc_issuer_must_use_https');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/u, '');
}

function assertEndpoint(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`oidc_${field}_missing`);
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`oidc_${field}_must_use_https`);
  }
  return url.toString();
}

export async function discoverOidcProvider(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcProviderMetadata> {
  const normalizedIssuer = normalizeIssuer(issuer);
  const response = await fetchImpl(`${normalizedIssuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('oidc_discovery_failed');
  const metadata = (await response.json()) as Record<string, unknown>;
  const discoveredIssuer = normalizeIssuer(String(metadata.issuer ?? ''));
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

export function createOidcAuthorizationRequest(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint?: string;
  scope?: string;
  state?: string;
  nonce?: string;
}): OidcAuthorizationRequest {
  const issuer = normalizeIssuer(input.issuer);
  const redirectUri = new URL(input.redirectUri).toString();
  const state = input.state ?? randomToken();
  const nonce = input.nonce ?? randomToken();
  const authorizationEndpoint = input.authorizationEndpoint
    ? assertEndpoint(input.authorizationEndpoint, 'authorization_endpoint')
    : `${issuer}/authorize`;
  const url = new URL(authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: input.scope ?? 'openid profile email',
    state,
    nonce,
  }).toString();
  return { url: url.toString(), state, nonce };
}

export class InMemoryOidcStateStore {
  private readonly records = new Map<string, OidcStateRecord>();

  constructor(private readonly ttlMs = DEFAULT_STATE_TTL_MS) {}

  issue(input: {
    state: string;
    nonce: string;
    redirectUri: string;
    now?: number;
  }): OidcStateRecord {
    const record: OidcStateRecord = {
      state: input.state,
      nonce: input.nonce,
      redirectUri: input.redirectUri,
      expiresAt: (input.now ?? Date.now()) + this.ttlMs,
    };
    this.records.set(record.state, record);
    return record;
  }

  consume(state: string, now = Date.now()): OidcStateRecord | null {
    const record = this.records.get(state);
    this.records.delete(state);
    return record && record.expiresAt > now ? record : null;
  }
}

export async function exchangeOidcCode(input: {
  metadata: OidcProviderMetadata;
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ idToken: string }> {
  const response = await (input.fetchImpl ?? fetch)(input.metadata.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) throw new Error('oidc_code_exchange_failed');
  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string') throw new Error('oidc_id_token_missing');
  return { idToken: payload.id_token };
}

export async function validateOidcIdToken(
  idToken: string,
  jwks: readonly OidcJsonWebKey[],
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
  const jwk = jwks.find((candidate) => candidate.kid === header.kid);
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
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== expectedIssuer) throw new Error('oidc_id_token_issuer_invalid');
  if (!audience.includes(options.clientId)) throw new Error('oidc_id_token_audience_invalid');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('oidc_id_token_expired');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60)
    throw new Error('oidc_id_token_iat_invalid');
  if (claims.nonce !== options.nonce) throw new Error('oidc_id_token_nonce_invalid');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0)
    throw new Error('oidc_subject_missing');
  if (typeof claims.email !== 'string' || claims.email.length === 0)
    throw new Error('oidc_email_missing');
  return {
    subject: claims.sub,
    email: claims.email,
    ...(typeof claims.name === 'string'
      ? { displayName: claims.name }
      : typeof claims.preferred_username === 'string'
        ? { displayName: claims.preferred_username }
        : {}),
    issuer: expectedIssuer,
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
