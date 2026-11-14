import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  codeChallengeS256,
  createJwksCache,
  createOidcAuthorizationRequest,
  createOidcStateStore,
  createPkcePair,
  discoverOidcProvider,
  exchangeOidcCode,
  InMemoryOidcStateStore,
  normalizeIssuer,
  RedisOidcStateStore,
  resolveTenantFromHost,
  timingSafeEqualStrings,
  validateOidcIdToken,
  verifyPkcePair,
  type OidcJsonWebKey,
  type OidcRedisClient,
} from './index.js';

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function makeKeys(kid = 'key-1') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid } as OidcJsonWebKey;
  return { jwk, privateKey };
}

function signToken(
  claims: Record<string, unknown>,
  privateKey: ReturnType<typeof makeKeys>['privateKey'],
  kid = 'key-1',
): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64Url(signature)}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://idp.example.com',
    aud: ['client-1'],
    exp: 2_000,
    iat: 1_000,
    nonce: 'nonce-1',
    sub: 'subject-1',
    email: 'user@example.com',
    email_verified: true,
    ...overrides,
  };
}

function fakeRedis(): OidcRedisClient & { store: Map<string, string>; calls: string[] } {
  const store = new Map<string, string>();
  const calls: string[] = [];
  return {
    store,
    calls,
    async set(key, value, mode, ttlMs, setMode) {
      calls.push(`set:${key}:${mode}:${ttlMs}:${setMode}`);
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async getdel(key) {
      calls.push(`getdel:${key}`);
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  };
}

describe('OIDC authorization request and PKCE', () => {
  it('creates an authorization request with independent state and nonce', () => {
    const request = createOidcAuthorizationRequest({
      issuer: 'http://localhost:5556/dex',
      clientId: 'platform-local',
      redirectUri: 'http://api.localhost:4000/v1/auth/callback',
    });
    const url = new URL(request.url);

    expect(request.state).not.toBe(request.nonce);
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge')).toBeNull();
  });

  it('adds an S256 code challenge when PKCE is enabled', () => {
    const request = createOidcAuthorizationRequest({
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      redirectUri: 'https://api.example.com/v1/auth/callback',
      usePkce: true,
    });
    const url = new URL(request.url);

    expect(request.codeVerifier).toBeDefined();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(request.codeChallenge);
    expect(verifyPkcePair(request.codeVerifier ?? '', request.codeChallenge ?? '')).toBe(true);
  });

  it('rejects a mismatched PKCE verifier and enforces verifier length', () => {
    const pair = createPkcePair();
    expect(verifyPkcePair(`${pair.verifier}x`, pair.challenge)).toBe(false);
    expect(() => codeChallengeS256('short')).toThrow('pkce_verifier_length_invalid');
    expect(codeChallengeS256(pair.verifier)).toBe(pair.challenge);
  });

  it('sends the code_verifier on token exchange', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')).toBe('verifier-1'.padEnd(43, 'x'));
      return new Response(JSON.stringify({ id_token: 'token' }), { status: 200 });
    }) as unknown as typeof fetch;
    await exchangeOidcCode({
      metadata: {
        issuer: 'https://idp.example.com',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        jwksUri: 'https://idp.example.com/jwks',
      },
      code: 'code-1',
      clientId: 'client-1',
      redirectUri: 'https://api.example.com/cb',
      codeVerifier: 'verifier-1'.padEnd(43, 'x'),
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('issuer normalization', () => {
  it('rejects empty and invalid issuers with package errors', () => {
    expect(() => normalizeIssuer('')).toThrow('oidc_issuer_missing');
    expect(() => normalizeIssuer('dex')).toThrow('oidc_issuer_invalid');
    expect(() => normalizeIssuer(undefined)).toThrow('oidc_issuer_missing');
  });

  it('strips a trailing slash so discovery and claims compare equal', () => {
    expect(normalizeIssuer('https://idp.example.com/')).toBe('https://idp.example.com');
    expect(normalizeIssuer('https://idp.example.com/?x=1#frag')).toBe('https://idp.example.com');
  });

  it('maps a discovery document without issuer to oidc_issuer_missing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(discoverOidcProvider('https://idp.example.com', fetchImpl)).rejects.toThrow(
      'oidc_issuer_missing',
    );
  });
});

describe('OIDC state store', () => {
  it('consumes state only once and rejects expired state', () => {
    const store = new InMemoryOidcStateStore(100);
    store.issue({
      state: 'state-1',
      nonce: 'nonce-1',
      redirectUri: 'http://localhost/cb',
      now: 1_000,
    });

    expect(store.consume('state-1', 1_099)?.nonce).toBe('nonce-1');
    expect(store.consume('state-1', 1_099)).toBeNull();

    store.issue({
      state: 'state-2',
      nonce: 'nonce-2',
      redirectUri: 'http://localhost/cb',
      now: 1_000,
    });
    expect(store.consume('state-2', 1_100)).toBeNull();
  });

  it('binds the record to its redirect URI and consumes on mismatch', () => {
    const store = new InMemoryOidcStateStore(1_000);
    store.issue({
      state: 'state-1',
      nonce: 'n',
      redirectUri: 'https://api.example.com/cb',
      now: 1_000,
    });
    expect(
      store.consume('state-1', { now: 1_001, redirectUri: 'https://evil.example/cb' }),
    ).toBeNull();
    expect(store.consume('state-1', 1_001)).toBeNull();
  });

  it('sweeps expired records and enforces a hard capacity cap', () => {
    const store = new InMemoryOidcStateStore(100, { maxRecords: 3 });
    store.issue({ state: 'expired-1', nonce: 'n', redirectUri: 'r', now: 0 });
    store.issue({ state: 'expired-2', nonce: 'n', redirectUri: 'r', now: 0 });
    expect(store.size).toBe(2);
    store.issue({ state: 'live-1', nonce: 'n', redirectUri: 'r', now: 500 });
    expect(store.size).toBe(1);
    for (let index = 0; index < 10; index += 1) {
      store.issue({ state: `s-${index}`, nonce: 'n', redirectUri: 'r', now: 500 });
    }
    expect(store.size).toBe(3);
  });

  it('accepts no more than the configured number of live records', () => {
    const store = new InMemoryOidcStateStore(10_000, { maxRecords: 2 });
    store.issue({ state: 'a', nonce: 'n', redirectUri: 'r', now: 0 });
    store.issue({ state: 'b', nonce: 'n', redirectUri: 'r', now: 0 });
    store.issue({ state: 'c', nonce: 'n', redirectUri: 'r', now: 0 });
    expect(store.size).toBe(2);
  });

  it('compares state and nonce in constant time', () => {
    expect(timingSafeEqualStrings('a', 'a')).toBe(true);
    expect(timingSafeEqualStrings('a', 'b')).toBe(false);
    expect(timingSafeEqualStrings('a', 'a ')).toBe(false);
  });

  it('shares state across instances through Redis and consumes it atomically', async () => {
    const redis = fakeRedis();
    const storeA = new RedisOidcStateStore({ client: redis, ttlMs: 60_000 });
    const storeB = new RedisOidcStateStore({ client: redis, ttlMs: 60_000 });
    await storeA.issue({
      state: 'state-1',
      nonce: 'nonce-1',
      redirectUri: 'https://api/cb',
      now: 1_000,
    });
    expect(redis.calls[0]).toBe('set:oidc:state:state-1:PX:60000:NX');
    const [first, second] = await Promise.all([
      storeB.consume('state-1', 1_001),
      storeB.consume('state-1', 1_001),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first?.nonce ?? second?.nonce).toBe('nonce-1');
  });

  it('rejects duplicate state keys and expired Redis records', async () => {
    const redis = fakeRedis();
    const store = new RedisOidcStateStore({ client: redis, ttlMs: 100 });
    await store.issue({ state: 'dupe', nonce: 'n', redirectUri: 'r', now: 0 });
    await expect(
      store.issue({ state: 'dupe', nonce: 'n', redirectUri: 'r', now: 0 }),
    ).rejects.toThrow('oidc_state_conflict');

    await store.issue({ state: 'expired', nonce: 'n', redirectUri: 'r', now: 0 });
    expect(await store.consume('expired', 101)).toBeNull();
  });

  it('requires a Redis getdel-capable client', () => {
    expect(
      () => new RedisOidcStateStore({ client: { set: vi.fn() } as unknown as OidcRedisClient }),
    ).toThrow('oidc_redis_getdel_required');
  });

  it('fails closed in production without Redis and falls back in development', async () => {
    await expect(createOidcStateStore({ nodeEnv: 'production' })).rejects.toThrow(
      'oidc_state_store_required',
    );
    const devStore = await createOidcStateStore({ nodeEnv: 'development' });
    expect(devStore).toBeInstanceOf(InMemoryOidcStateStore);
    const redis = fakeRedis();
    const prodStore = await createOidcStateStore({ nodeEnv: 'production', redisClient: redis });
    expect(prodStore).toBeInstanceOf(RedisOidcStateStore);
  });
});

describe('JWKS cache', () => {
  it('serves repeated lookups from one fetch', async () => {
    const { jwk } = makeKeys('key-1');
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }) as unknown as typeof fetch;
    const cache = createJwksCache({ jwksUri: 'https://idp/jwks', fetchImpl, now: () => 1_000 });
    for (let index = 0; index < 100; index += 1) {
      expect((await cache.getKey('key-1')).kid).toBe('key-1');
    }
    expect(fetches).toBe(1);
  });

  it('refetches once after TTL when a rotated kid appears', async () => {
    const v1 = makeKeys('key-1').jwk;
    const v2 = makeKeys('key-2').jwk;
    let clock = 0;
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys: fetches === 1 ? [v1] : [v1, v2] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cache = createJwksCache({
      jwksUri: 'https://idp/jwks',
      fetchImpl,
      ttlMs: 100,
      now: () => clock,
    });
    expect((await cache.getKey('key-1')).kid).toBe('key-1');
    clock = 150;
    expect((await cache.getKey('key-2')).kid).toBe('key-2');
    expect(fetches).toBe(2);
    // Unknown kid triggers exactly one refetch, then further misses are rate limited.
    clock = 160;
    await expect(cache.getKey('key-3')).rejects.toThrow('oidc_signing_key_not_found');
    expect(fetches).toBe(3);
    clock = 170;
    await expect(cache.getKey('key-4')).rejects.toThrow('oidc_signing_key_not_found');
    expect(fetches).toBe(3);
  });

  it('aborts a hanging fetch and surfaces oidc_timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;
    const cache = createJwksCache({
      jwksUri: 'https://idp/jwks',
      fetchImpl,
      timeoutMs: 5,
    });
    await expect(cache.getKey('key-1')).rejects.toThrow('oidc_timeout');
  });
});

describe('ID token validation', () => {
  it('accepts a valid token and normalizes a trailing-slash issuer claim', async () => {
    const { jwk, privateKey } = makeKeys();
    const token = signToken(validClaims({ iss: 'https://idp.example.com/' }), privateKey);
    const identity = await validateOidcIdToken(token, [jwk], {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      nonce: 'nonce-1',
      now: 1_500,
    });
    expect(identity.subject).toBe('subject-1');
    expect(identity.emailVerified).toBe(true);
  });

  it('rejects future nbf outside the allowed skew', async () => {
    const { jwk, privateKey } = makeKeys();
    const token = signToken(validClaims({ nbf: 1_620 }), privateKey);
    await expect(
      validateOidcIdToken(token, [jwk], {
        issuer: 'https://idp.example.com',
        clientId: 'client-1',
        nonce: 'nonce-1',
        now: 1_500,
        clockSkewSeconds: 60,
      }),
    ).rejects.toThrow('oidc_id_token_not_yet_valid');
  });

  it('applies clock skew to exp', async () => {
    const { jwk, privateKey } = makeKeys();
    const token = signToken(validClaims({ exp: 1_470 }), privateKey);
    const base = {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      nonce: 'nonce-1',
      now: 1_500,
    };
    await expect(
      validateOidcIdToken(token, [jwk], { ...base, clockSkewSeconds: 60 }),
    ).resolves.toMatchObject({ subject: 'subject-1' });
    await expect(
      validateOidcIdToken(token, [jwk], { ...base, clockSkewSeconds: 0 }),
    ).rejects.toThrow('oidc_id_token_expired');
  });

  it('requires azp for multi-audience tokens and rejects a foreign azp', async () => {
    const { jwk, privateKey } = makeKeys();
    const base = {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      nonce: 'nonce-1',
      now: 1_500,
    };
    const missing = signToken(validClaims({ aud: ['client-1', 'client-2'] }), privateKey);
    await expect(validateOidcIdToken(missing, [jwk], base)).rejects.toThrow(
      'oidc_id_token_azp_missing',
    );
    const foreign = signToken(
      validClaims({ aud: ['client-1', 'client-2'], azp: 'client-2' }),
      privateKey,
    );
    await expect(validateOidcIdToken(foreign, [jwk], base)).rejects.toThrow(
      'oidc_id_token_azp_invalid',
    );
  });

  it('enforces the email_verified policy hook', async () => {
    const { jwk, privateKey } = makeKeys();
    const token = signToken(validClaims({ email_verified: false }), privateKey);
    const base = {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      nonce: 'nonce-1',
      now: 1_500,
    };
    await expect(
      validateOidcIdToken(token, [jwk], { ...base, emailVerified: 'require' }),
    ).rejects.toThrow('oidc_email_not_verified');
    await expect(
      validateOidcIdToken(token, [jwk], {
        ...base,
        emailVerified: ({ emailVerified }) => emailVerified === false,
      }),
    ).resolves.toMatchObject({ emailVerified: false });
  });

  it('rejects a mismatched nonce and expired max token age', async () => {
    const { jwk, privateKey } = makeKeys();
    const base = {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      now: 1_500,
    };
    const wrongNonce = signToken(validClaims({ nonce: 'other' }), privateKey);
    await expect(
      validateOidcIdToken(wrongNonce, [jwk], { ...base, nonce: 'nonce-1' }),
    ).rejects.toThrow('oidc_id_token_nonce_invalid');
    const old = signToken(validClaims({ iat: 1_000 }), privateKey);
    await expect(
      validateOidcIdToken(old, [jwk], {
        ...base,
        nonce: 'nonce-1',
        maxTokenAgeSeconds: 100,
      }),
    ).rejects.toThrow('oidc_id_token_too_old');
  });

  it('rejects an invalid issuer claim without throwing a TypeError', async () => {
    const { jwk, privateKey } = makeKeys();
    const token = signToken(validClaims({ iss: 'not a url' }), privateKey);
    await expect(
      validateOidcIdToken(token, [jwk], {
        issuer: 'https://idp.example.com',
        clientId: 'client-1',
        nonce: 'nonce-1',
        now: 1_500,
      }),
    ).rejects.toThrow('oidc_id_token_issuer_invalid');
  });

  it('validates through a JWKS cache, refetching on unknown kid', async () => {
    const v1 = makeKeys('key-1');
    const v2 = makeKeys('key-2');
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys: [v1.jwk, v2.jwk] }), { status: 200 });
    }) as unknown as typeof fetch;
    const cache = createJwksCache({ jwksUri: 'https://idp/jwks', fetchImpl });
    const token = signToken(validClaims({ kid: 'key-2' }), v2.privateKey, 'key-2');
    const identity = await validateOidcIdToken(token, cache, {
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      nonce: 'nonce-1',
      now: 1_500,
    });
    expect(identity.subject).toBe('subject-1');
    expect(fetches).toBe(1);
  });
});

describe('tenant boundary primitives', () => {
  it('accepts only one tenant label under the configured base domain', () => {
    expect(
      resolveTenantFromHost('acme.app.localhost:4000', 'app.localhost', 'tenant-acme'),
    ).toEqual({
      host: 'acme.app.localhost',
      tenantSlug: 'acme',
      tenantId: 'tenant-acme',
    });
    expect(
      resolveTenantFromHost('acme.contoso.app.localhost', 'app.localhost', 'tenant-acme'),
    ).toBeNull();
    expect(resolveTenantFromHost('api.localhost:4000', 'app.localhost', 'tenant-acme')).toBeNull();
  });
});
