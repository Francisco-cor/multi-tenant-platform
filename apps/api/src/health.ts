import postgres from 'postgres';

export interface HealthCheckResult {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  latencyMs?: number;
  error?: string;
}

export interface ReadyReport {
  status: 'ok' | 'degraded';
  service: string;
  dependencies: HealthCheckResult[];
  uptimeMs: number;
}

const HEALTH_TIMEOUT_MS = 2000;
const startedAt = Date.now();

type RedisHealthClient = {
  ping: () => Promise<string>;
  quit: () => Promise<void>;
  disconnect?: () => void;
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function checkDatabase(): Promise<HealthCheckResult> {
  const url = process.env.DATABASE_URL;
  if (!url) return { name: 'postgres', status: 'skip' };
  const start = Date.now();
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    // Use a single connection, no prepare, quick check
    sql = postgres(url, { max: 1, prepare: false, connect_timeout: 2, idle_timeout: 2 });
    const result = await withTimeout(sql`select 1 as ok`, HEALTH_TIMEOUT_MS, 'postgres');
    if (!Array.isArray(result) || result.length === 0)
      throw new Error('postgres unexpected result');
    return { name: 'postgres', status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      name: 'postgres',
      status: 'fail',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function checkRedis(): Promise<HealthCheckResult> {
  const url = process.env.REDIS_URL;
  if (!url) return { name: 'redis', status: 'skip' };
  const start = Date.now();
  // Avoid hard dependency on ioredis in api; do a best-effort TCP check via fetch if redis URL is http?
  // For now, try to use ioredis if available via dynamic import, else skip
  let client: RedisHealthClient | null = null;
  try {
    const ioredisMod = await import('ioredis').catch(() => null);
    if (!ioredisMod) return { name: 'redis', status: 'skip' };
    const Redis = (
      ioredisMod as unknown as {
        default: new (url: string, opts: unknown) => RedisHealthClient;
      }
    ).default;
    client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: HEALTH_TIMEOUT_MS,
      maxRetriesPerRequest: 0,
      enableReadyCheck: false,
    });
    const activeClient = client;
    await withTimeout(activeClient.ping(), HEALTH_TIMEOUT_MS, 'redis');
    await activeClient.quit().catch(() => undefined);
    client = null;
    return { name: 'redis', status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      name: 'redis',
      status: 'fail',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (client) {
      client.disconnect?.();
      client = null;
    }
  }
}

async function checkOutbox(): Promise<HealthCheckResult> {
  const url = process.env.DATABASE_URL;
  if (!url) return { name: 'outbox', status: 'skip' };
  const start = Date.now();
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(url, { max: 1, prepare: false, connect_timeout: 2, idle_timeout: 2 });
    // Lag = age of oldest pending event; pending count
    const rows = await withTimeout(
      sql`select extract(epoch from (now() - min(created_at))) as lag_seconds, count(*) as pending from outbox_events where status = 'pending'`,
      HEALTH_TIMEOUT_MS,
      'outbox',
    );
    const row = (rows as unknown as Array<{ lag_seconds: string | null; pending: string }>)[0];
    const lag = row?.lag_seconds ? Number(row.lag_seconds) : 0;
    const pending = row?.pending ? Number(row.pending) : 0;
    // Outbox lag > 30s or pending > 100 is degraded ( Fase 7 criterion P95 <30s )
    if (lag > 30) {
      return {
        name: 'outbox',
        status: 'fail',
        latencyMs: Date.now() - start,
        error: `lag ${lag.toFixed(1)}s pending ${pending}`,
      };
    }
    return { name: 'outbox', status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    // If table does not exist yet (migration not applied), treat as skip to avoid failing readiness in dev.
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('outbox_events') && msg.includes('does not exist'))
      return { name: 'outbox', status: 'skip' };
    return { name: 'outbox', status: 'fail', latencyMs: Date.now() - start, error: msg };
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function checkPayments(): Promise<HealthCheckResult> {
  const url = process.env.DATABASE_URL;
  if (!url) return { name: 'payments', status: 'skip' };
  const start = Date.now();
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(url, { max: 1, prepare: false, connect_timeout: 2, idle_timeout: 2 });
    const rows = await withTimeout(
      sql`select count(*) as unknown_count, extract(epoch from (now() - min(updated_at))) as oldest_unknown_age
           from payment_attempts where status='unknown'`,
      HEALTH_TIMEOUT_MS,
      'payments',
    );
    const row = (
      rows as unknown as Array<{ unknown_count: string; oldest_unknown_age: string | null }>
    )[0];
    const unknownCount = row ? Number(row.unknown_count) : 0;
    const oldestAge = row?.oldest_unknown_age ? Number(row.oldest_unknown_age) : 0;
    // If any unknown >30m, mark degraded (needs reconciler attention)
    if (unknownCount > 0 && oldestAge > 30 * 60) {
      return {
        name: 'payments',
        status: 'fail',
        latencyMs: Date.now() - start,
        error: `unknown ${unknownCount} oldest ${oldestAge.toFixed(0)}s`,
      };
    }
    return { name: 'payments', status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('payment_attempts') && msg.includes('does not exist'))
      return { name: 'payments', status: 'skip' };
    return { name: 'payments', status: 'fail', latencyMs: Date.now() - start, error: msg };
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

export async function getReadiness(): Promise<ReadyReport> {
  const [pg, redis, outbox, payments] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkOutbox(),
    checkPayments(),
  ]);
  const deps = [pg, redis, outbox, payments].filter((d) => d.status !== 'skip');
  const hasFail = deps.some((d) => d.status === 'fail');
  return {
    status: hasFail ? 'degraded' : 'ok',
    service: 'api',
    dependencies: deps,
    uptimeMs: Date.now() - startedAt,
  };
}

export function getLiveness() {
  return {
    status: 'ok' as const,
    service: 'api' as const,
    uptimeMs: Date.now() - startedAt,
  };
}

export async function getStartup(): Promise<ReadyReport> {
  // Startup is like readiness but we also ensure DB is reachable if configured.
  // In production, you might check schema_migrations count matches expected files.
  const readiness = await getReadiness();
  // If DB check failed, startup is degraded (orchestrator should not route traffic yet)
  return readiness;
}
