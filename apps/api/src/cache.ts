import { createHash } from 'node:crypto';
import { metrics } from '@platform/observability';

/**
 * Cache-aside with stampede protection, tenant-scoped keys, TTL and invalidation.
 * - Keys are `tenant:{tenantId}:v1:{resource}:{hash16}` where hash is sha256(sorted params).
 * - Redis if REDIS_URL present (ioredis), otherwise InMemory fallback (deterministic tests).
 * - Fail-open: any Redis error returns miss (never throws to caller).
 * - Stampede: SET NX lock `${key}:lock` EX 5s, jitter, polls 10x50ms for winner to fill.
 * - Only reconstructible data (branches, inventory lists, webhooks endpoints) is cached.
 */

export const CACHE_VERSION = 'v1';
export const CACHE_TTLS = {
  branches: 60_000,
  inventory: 30_000,
  webhooks: 60_000,
  members: 30_000,
  files: 30_000,
} as const;

export type CacheResource = keyof typeof CACHE_TTLS;

export function buildCacheKey(
  tenantId: string,
  resource: string,
  params: Record<string, unknown> = {},
): string {
  const sortedKeys = Object.keys(params).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) normalized[k] = params[k];
  const raw = JSON.stringify(normalized);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `tenant:${tenantId}:${CACHE_VERSION}:${resource}:${hash}`;
}

export function buildCachePrefix(tenantId: string, resource: string): string {
  return `tenant:${tenantId}:${CACHE_VERSION}:${resource}:`;
}

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<number>;
  getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts?: { lockTtlMs?: number },
  ): Promise<{ value: T; hit: boolean; stale?: boolean }>;
  close?(): Promise<void>;
}

class InMemoryCache implements Cache {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly locks = new Map<string, number>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.map.get(key);
    if (!entry) {
      metrics.recordCacheMiss();
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      metrics.recordCacheMiss();
      return null;
    }
    metrics.recordCacheHit();
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        n++;
      }
    }
    if (n > 0) metrics.recordCacheInvalidation(n);
    return n;
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { lockTtlMs?: number } = {},
  ): Promise<{ value: T; hit: boolean }> {
    const hit = await this.get<T>(key);
    if (hit !== null) return { value: hit, hit: true };

    const lockKey = `${key}:lock`;
    const lockTtl = opts.lockTtlMs ?? 5_000;
    const now = Date.now();
    const existing = this.locks.get(lockKey);
    if (existing && existing > now) {
      // another loader holds lock — poll for winner
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const found = await this.get<T>(key);
        if (found !== null) return { value: found, hit: true };
      }
      // still miss -> fallback to loader (stampede degraded)
      metrics.recordCacheStampedeFallback();
    } else {
      this.locks.set(lockKey, now + lockTtl);
    }

    try {
      const value = await loader();
      await this.set(key, value, ttlMs);
      return { value, hit: false };
    } finally {
      this.locks.delete(lockKey);
    }
  }
}

class RedisCache implements Cache {
  private readonly client: {
    get(k: string): Promise<string | null>;
    set(k: string, v: string, mode: string, ttlSec: number): Promise<string | null>;
    set2(k: string, v: string, px: string, ttlMs: number): Promise<string | null>;
    del(...keys: string[]): Promise<number>;
    scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
    quit(): Promise<void>;
  };
  private readonly redisQuit: () => Promise<void>;

  constructor(
    client: {
      get(k: string): Promise<string | null>;
      set(k: string, v: string, mode: string, ttlSec: number): Promise<string | null>;
      set2(k: string, v: string, px: string, ttlMs: number): Promise<string | null>;
      del(...keys: string[]): Promise<number>;
      scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
      quit(): Promise<void>;
    },
    quit: () => Promise<void>,
  ) {
    this.client = client;
    this.redisQuit = quit;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) {
        metrics.recordCacheMiss();
        return null;
      }
      metrics.recordCacheHit();
      return JSON.parse(raw) as T;
    } catch {
      metrics.recordCacheMiss();
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      const raw = JSON.stringify(value);
      // Use PX for ms, NX not needed here
      // ioredis set signature varies: try PX
      await (
        this.client as unknown as {
          set(
            k: string,
            v: string,
            px: string,
            ttlMs: number,
            ex2?: string,
            ttlSec?: number,
          ): Promise<unknown>;
        }
      ).set(key, raw, 'PX', ttlMs);
    } catch {
      // fail-open
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // ignore
    }
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    try {
      let cursor = '0';
      let deleted = 0;
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '100');
        cursor = next;
        if (keys.length > 0) {
          deleted += await this.client.del(...keys);
        }
      } while (cursor !== '0');
      if (deleted > 0) metrics.recordCacheInvalidation(deleted);
      return deleted;
    } catch {
      return 0;
    }
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { lockTtlMs?: number } = {},
  ): Promise<{ value: T; hit: boolean }> {
    const hit = await this.get<T>(key);
    if (hit !== null) return { value: hit, hit: true };

    const lockKey = `${key}:lock`;
    const lockTtl = opts.lockTtlMs ?? 5_000;
    let locked = false;
    try {
      // SET NX PX
      const res = await (
        this.client as unknown as {
          set(k: string, v: string, nx: string, px: string, ttlMs: number): Promise<string | null>;
        }
      ).set(lockKey, '1', 'NX', 'PX', lockTtl);
      locked = res === 'OK';
    } catch {
      locked = false;
    }

    if (!locked) {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const found = await this.get<T>(key);
        if (found !== null) return { value: found, hit: true };
      }
      metrics.recordCacheStampedeFallback();
      const value = await loader();
      // best-effort set without lock
      await this.set(key, value, ttlMs);
      return { value, hit: false };
    }

    try {
      const value = await loader();
      await this.set(key, value, ttlMs);
      return { value, hit: false };
    } finally {
      try {
        await this.client.del(lockKey);
      } catch {
        // ignore
      }
    }
  }

  async close(): Promise<void> {
    await this.redisQuit().catch(() => undefined);
  }
}

export async function createCache(redisUrl?: string): Promise<Cache> {
  if (!redisUrl) return new InMemoryCache();
  try {
    const mod = await import('ioredis').catch(() => null);
    if (!mod) return new InMemoryCache();
    const Redis = (mod as unknown as { default: new (url: string, opts: unknown) => unknown })
      .default;
    const client = new Redis(redisUrl, {
      lazyConnect: false,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: () => null,
    }) as unknown as {
      get(k: string): Promise<string | null>;
      set(k: string, v: string, mode: string, ttlSec: number): Promise<string | null>;
      del(...keys: string[]): Promise<number>;
      scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
      quit(): Promise<void>;
      on(e: string, fn: (err: Error) => void): void;
    };
    // try ping with timeout 1s; if fails fallback to memory
    const ping = (client as unknown as { ping(): Promise<string> }).ping?.();
    if (ping) {
      await Promise.race([
        ping,
        new Promise((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 1000)),
      ]).catch(() => {
        throw new Error('redis unreachable');
      });
    }
    return new RedisCache(client as unknown as RedisCache['client'], async () => {
      await client.quit().catch(() => undefined);
    });
  } catch {
    return new InMemoryCache();
  }
}

export function createInMemoryCache(): Cache {
  return new InMemoryCache();
}
