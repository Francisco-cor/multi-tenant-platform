import { describe, expect, it } from 'vitest';
import {
  createOidcAuthorizationRequest,
  InMemoryOidcStateStore,
  resolveTenantFromHost,
} from './index.js';

describe('OIDC and tenant boundary primitives', () => {
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
  });

  it('consumes OIDC state only once and rejects expired state', () => {
    const store = new InMemoryOidcStateStore(100);
    store.issue({
      state: 'state-1',
      nonce: 'nonce-1',
      redirectUri: 'http://localhost/callback',
      now: 1_000,
    });

    expect(store.consume('state-1', 1_099)?.nonce).toBe('nonce-1');
    expect(store.consume('state-1', 1_099)).toBeNull();

    store.issue({
      state: 'state-2',
      nonce: 'nonce-2',
      redirectUri: 'http://localhost/callback',
      now: 1_000,
    });
    expect(store.consume('state-2', 1_100)).toBeNull();
  });

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
