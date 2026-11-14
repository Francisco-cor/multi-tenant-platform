import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryRateLimitStore,
  RATE_LIMIT_INCREMENT_SCRIPT,
  RateLimiter,
  RedisRateLimitStore,
} from './rate-limit.js';

function fakeEvalClient(result: unknown) {
  return {
    eval: vi.fn(async () => result),
    quit: vi.fn(async () => undefined),
  };
}

describe('Redis rate limiter atomicity (S-11)', () => {
  it('increments and expires in a single atomic script call', async () => {
    const client = fakeEvalClient([1, 60_000]);
    const store = new RedisRateLimitStore(client);

    const result = await store.increment('rl:ip:1.2.3.4:1', 60_000);

    expect(result).toEqual({ count: 1, resetMs: 60_000 });
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledWith(
      RATE_LIMIT_INCREMENT_SCRIPT,
      1,
      'rl:ip:1.2.3.4:1',
      60_000,
    );
    // The script must set the TTL whenever the counter is new or has none;
    // two separate INCR/EXPIRE round trips can leave an immortal key.
    expect(RATE_LIMIT_INCREMENT_SCRIPT).toContain("redis.call('INCR'");
    expect(RATE_LIMIT_INCREMENT_SCRIPT).toContain("redis.call('PEXPIRE'");
    expect(RATE_LIMIT_INCREMENT_SCRIPT).toContain('ttl < 0');
  });

  it('uses the TTL reported by Redis for the reset window', async () => {
    const store = new RedisRateLimitStore(fakeEvalClient([3, 12_345]));
    await expect(store.increment('k', 60_000)).resolves.toEqual({ count: 3, resetMs: 12_345 });
  });

  it('fails the primary store when the script cannot report a TTL', async () => {
    const store = new RedisRateLimitStore(fakeEvalClient([1, -1]));
    await expect(store.increment('k', 60_000)).rejects.toThrow('rate_limit_script_failed');
  });

  it('falls back to the bounded in-memory limiter when Redis fails', async () => {
    const primary = {
      increment: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const limiter = new RateLimiter(primary as never);
    const result = await limiter.check('ip:fallback', { windowMs: 60_000, max: 2 });
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(2);
  });

  it('keeps in-memory buckets bounded under key cardinality pressure', async () => {
    const store = new InMemoryRateLimitStore(100);
    for (let i = 0; i < 5_000; i++) {
      await store.increment(`tenant:noise-${i}`, 60_000);
    }
    const size = (store as unknown as { map: Map<string, unknown> }).map.size;
    expect(size).toBeLessThanOrEqual(100);
  });
});
