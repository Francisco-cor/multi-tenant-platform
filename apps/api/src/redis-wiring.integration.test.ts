import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCache } from './cache.js';
import { createRateLimiter } from './rate-limit.js';
import { buildApp } from './app.js';
import { InMemoryIdentityStore } from './identity-store.js';

const enabled = process.env.RUN_API_INTEGRATION === '1' && Boolean(process.env.REDIS_URL);
const suite = enabled ? describe : describe.skip;

suite('F-07/F-16 Redis wiring across replicas', () => {
  it('shares cache entries and invalidation between two replicas', async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL required');
    const cacheA = await createCache(redisUrl);
    const cacheB = await createCache(redisUrl);
    const key = `tenant:${randomUUID()}:v1:branches:test`;
    await cacheA.set(key, { data: [{ id: 'b1' }] }, 30_000);
    expect(await cacheB.get(key)).toEqual({ data: [{ id: 'b1' }] });
    const prefix = key.slice(0, key.lastIndexOf(':') + 1);
    await cacheA.deleteByPrefix(prefix);
    expect(await cacheB.get(key)).toBeNull();
    await cacheA.close?.();
    await cacheB.close?.();
  });

  it('enforces one rate-limit counter across replicas', async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL required');
    const limiterA = await createRateLimiter(redisUrl);
    const limiterB = await createRateLimiter(redisUrl);
    const key = `ip:replica-${randomUUID()}`;
    const config = { windowMs: 60_000, max: 1 };
    expect((await limiterA.check(key, config)).allowed).toBe(true);
    expect((await limiterB.check(key, config)).allowed).toBe(false);
    await (limiterA as unknown as { close?: () => Promise<void> }).close?.();
    await (limiterB as unknown as { close?: () => Promise<void> }).close?.();
  });

  it('sets a TTL atomically and repairs an immortal rate-limit key', async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL required');
    const { default: Redis } = await import('ioredis');
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const limiter = await createRateLimiter(redisUrl);
    const key = `ip:ttl-${randomUUID()}`;
    const bucket = Math.floor(Date.now() / 60_000);
    const redisKey = `rl:${key}:${bucket}`;

    expect((await limiter.check(key, { windowMs: 60_000, max: 100 })).allowed).toBe(true);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);

    // A key left behind by the old INCR-then-EXPIRE code path has no TTL.
    await client.set(redisKey, '7');
    const repaired = await limiter.check(key, { windowMs: 60_000, max: 100 });
    expect(repaired.allowed).toBe(true);
    expect(repaired.remaining).toBe(92);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);

    // Concurrent requests must all be counted and the key must never be
    // left without an expiry, even under a burst.
    await client.del(redisKey);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.check(key, { windowMs: 60_000, max: 100 })),
    );
    expect(results.every((result) => result.allowed)).toBe(true);
    expect(Number(await client.get(redisKey))).toBe(25);
    expect(await client.pttl(redisKey)).toBeGreaterThan(0);

    await client.del(redisKey);
    await client.quit();
    await limiter.close();
  });

  it('invalidates a warm tenant cache on another app replica', async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL required');
    const cache = await createCache(redisUrl);
    const rateLimiter = await createRateLimiter(redisUrl);
    const store = new InMemoryIdentityStore(true);
    store.users.set('user-replica-owner', {
      id: 'user-replica-owner',
      subject: 'user-replica-owner',
      issuer: 'http://localhost:5556/dex',
      email: 'replica-owner@example.test',
      displayName: 'Replica Owner',
      status: 'active',
      emailVerified: true,
    });
    store.memberships.set('membership-replica-owner', {
      id: 'membership-replica-owner',
      userId: 'user-replica-owner',
      organizationId: 'tenant-acme',
      role: 'owner',
      status: 'active',
    });
    const appA = buildApp({ store, cache, rateLimiter, allowDevLogin: true });
    const appB = buildApp({ store, cache, rateLimiter, allowDevLogin: true });
    const login = await appB.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-replica-owner' },
    });
    const raw = login.headers['set-cookie'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') throw new Error('session_cookie_missing');
    const cookie = value.split(';', 1)[0] ?? '';
    const warm = await appB.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(warm.statusCode).toBe(200);

    const created = await appA.inject({
      method: 'POST',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { slug: 'replica-two', name: 'Replica Two' },
    });
    expect(created.statusCode).toBe(201);
    const fresh = await appB.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: 'replica-two' })]),
    );
    expect(fresh.headers['x-cache']).toBe('MISS');
    await appA.close();
    await appB.close();
  });
});
