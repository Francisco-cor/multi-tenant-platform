import { metrics } from '@platform/observability';

/**
 * Rate limiting per IP / tenant / user / endpoint with Redis + InMemory fallback.
 * - Fixed window counters (INCR + EXPIRE in Redis, Map in memory).
 * - Tenant-scoped keys: `rl:{kind}:{identifier}:{windowBucket}` where windowBucket = floor(now/windowMs).
 * - Fail-open with in-memory fallback: if Redis fails, use InMemory store (per-instance limit).
 * - Returns 429 with `X-RateLimit-*` + `Retry-After` when exceeded.
 */

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export const RATE_LIMITS = {
  // Global per-IP (abuse)
  ip: { windowMs: 60_000, max: 100 } as RateLimitConfig,
  // Per-tenant (hot tenant isolation)
  tenant: { windowMs: 60_000, max: 1000 } as RateLimitConfig,
  // Per-user
  user: { windowMs: 60_000, max: 200 } as RateLimitConfig,
  // Sensitive endpoints (per tenant or per IP)
  endpoints: {
    'POST /v1/orders': { windowMs: 60_000, max: 20, key: 'tenant' as const },
    'POST /v1/inventory/reserve': { windowMs: 60_000, max: 30, key: 'tenant' as const },
    'POST /v1/files/presigned-upload': { windowMs: 60_000, max: 20, key: 'tenant' as const },
    'POST /v1/files/presign': { windowMs: 60_000, max: 20, key: 'tenant' as const },
    'POST /v1/webhooks/endpoints': { windowMs: 60_000, max: 20, key: 'tenant' as const },
    'POST /v1/auth/dev-login': { windowMs: 60_000, max: 10, key: 'ip' as const },
  },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetMs: number;
  retryAfterSec?: number | undefined;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
  close?(): Promise<void>;
}

class InMemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    const now = Date.now();
    const entry = this.map.get(key);
    if (!entry || now >= entry.resetAt) {
      const resetAt = now + windowMs;
      this.map.set(key, { count: 1, resetAt });
      return { count: 1, resetMs: windowMs };
    }
    entry.count += 1;
    const resetMs = Math.max(0, entry.resetAt - now);
    return { count: entry.count, resetMs };
  }
}

class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: {
      incr(k: string): Promise<number>;
      pttl(k: string): Promise<number>;
      expire(k: string, sec: number): Promise<number>;
      quit(): Promise<void>;
    },
  ) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    const count = await this.client.incr(key);
    if (count === 1) {
      const ttlSec = Math.ceil(windowMs / 1000);
      await this.client.expire(key, ttlSec).catch(() => undefined);
      return { count, resetMs: windowMs };
    }
    const pttl = await this.client.pttl(key).catch(() => windowMs);
    const resetMs = pttl > 0 ? pttl : windowMs;
    return { count, resetMs };
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

export class RateLimiter {
  private readonly inMemoryFallback = new InMemoryRateLimitStore();
  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore = new InMemoryRateLimitStore(),
  ) {}

  async check(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const bucket = Math.floor(Date.now() / config.windowMs);
    const redisKey = `rl:${key}:${bucket}`;
    try {
      const { count, resetMs } = await this.primary.increment(redisKey, config.windowMs);
      const allowed = count <= config.max;
      if (!allowed) metrics.recordRateLimitHit(key);
      return {
        allowed,
        remaining: Math.max(0, config.max - count),
        limit: config.max,
        resetMs,
        retryAfterSec: allowed ? undefined : Math.ceil(resetMs / 1000),
      };
    } catch {
      // fail-open with fallback (per-instance) — still counts but not distributed
      const { count, resetMs } = await this.fallback.increment(redisKey, config.windowMs);
      const allowed = count <= config.max;
      if (!allowed) metrics.recordRateLimitHit(`${key}:fallback`);
      return {
        allowed,
        remaining: Math.max(0, config.max - count),
        limit: config.max,
        resetMs,
        retryAfterSec: allowed ? undefined : Math.ceil(resetMs / 1000),
      };
    }
  }

  // For testing / fallback path
  get inMemory(): InMemoryRateLimitStore {
    return this.inMemoryFallback;
  }
}

export async function createRateLimiter(redisUrl?: string): Promise<RateLimiter> {
  if (!redisUrl) return new RateLimiter(new InMemoryRateLimitStore());
  try {
    const mod = await import('ioredis').catch(() => null);
    if (!mod) return new RateLimiter(new InMemoryRateLimitStore());
    const Redis = (mod as unknown as { default: new (url: string, opts: unknown) => unknown })
      .default;
    const client = new Redis(redisUrl, {
      lazyConnect: false,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: () => null,
    }) as unknown as {
      incr(k: string): Promise<number>;
      pttl(k: string): Promise<number>;
      expire(k: string, sec: number): Promise<number>;
      ping(): Promise<string>;
      quit(): Promise<void>;
      on(e: string, fn: (err: Error) => void): void;
    };
    if (client.ping) {
      await Promise.race([
        client.ping(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 1000)),
      ]).catch(() => {
        throw new Error('redis unreachable');
      });
    }
    const store = new RedisRateLimitStore(client);
    return new RateLimiter(store, new InMemoryRateLimitStore());
  } catch {
    return new RateLimiter(new InMemoryRateLimitStore());
  }
}

export function createInMemoryRateLimiter(): RateLimiter {
  return new RateLimiter(new InMemoryRateLimitStore());
}

export function rateLimitKeyForIp(ip: string): string {
  return `ip:${ip}`;
}
export function rateLimitKeyForTenant(tenantId: string): string {
  return `tenant:${tenantId}`;
}
export function rateLimitKeyForUser(userId: string): string {
  return `user:${userId}`;
}
export function rateLimitKeyForEndpoint(endpoint: string, identifier: string): string {
  return `ep:${endpoint}:${identifier}`;
}
