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

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, { count: number; resetAt: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.map) {
      if (now >= entry.resetAt) this.map.delete(key);
    }
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    const now = Date.now();
    if (this.map.size >= this.maxEntries) this.sweep(now);
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

/**
 * INCR + PEXPIRE must be atomic: with two round trips a crash (or a failed
 * EXPIRE) between them leaves a counter with no TTL — a permanently blocked
 * IP/tenant. The script also repairs a legacy key whose TTL is missing, so an
 * immortal key from an earlier deployment heals on the next request.
 */
export const RATE_LIMIT_INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`.trim();

interface RedisEvalClient {
  eval(script: string, numKeys: number, key: string, arg: number): Promise<unknown>;
  quit(): Promise<void>;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly client: RedisEvalClient) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    const result = (await this.client.eval(RATE_LIMIT_INCREMENT_SCRIPT, 1, key, windowMs)) as
      [number | string, number | string] | null;
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('rate_limit_script_failed');
    }
    const count = Number(result[0]);
    const ttl = Number(result[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttl) || ttl <= 0) {
      throw new Error('rate_limit_script_failed');
    }
    return { count, resetMs: Math.min(ttl, windowMs) };
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

  async close(): Promise<void> {
    await this.primary.close?.();
  }
}

export async function createRateLimiter(redisUrl?: string): Promise<RateLimiter> {
  if (!redisUrl) return new RateLimiter(new InMemoryRateLimitStore());
  const mod = await import('ioredis').catch(() => null);
  if (!mod) throw new Error('redis_client_unavailable');
  const Redis = (mod as unknown as { default: new (url: string, opts: unknown) => unknown })
    .default;
  const client = new Redis(redisUrl, {
    lazyConnect: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    retryStrategy: () => null,
  }) as unknown as {
    eval(script: string, numKeys: number, key: string, arg: number): Promise<unknown>;
    ping(): Promise<string>;
    quit(): Promise<void>;
    on(e: string, fn: (err: Error) => void): void;
  };
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 1000)),
    ]);
  } catch (error) {
    await client.quit().catch(() => undefined);
    throw new Error('redis_unreachable', { cause: error });
  }
  const store = new RedisRateLimitStore(client);
  return new RateLimiter(store, new InMemoryRateLimitStore());
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
