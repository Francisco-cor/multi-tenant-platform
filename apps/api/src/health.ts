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

export interface HealthProbe {
  readiness(): Promise<ReadyReport>;
  startup(): Promise<ReadyReport>;
  close(): Promise<void>;
}

const HEALTH_TIMEOUT_MS = 2000;
const READINESS_TTL_MS = 1500;
const startedAt = Date.now();

type SqlClient = ReturnType<typeof postgres>;

type RedisHealthClient = {
  ping: () => Promise<string>;
  quit: () => Promise<void>;
  disconnect?: () => void;
};

let sharedSql: SqlClient | null = null;
let sharedRedis: RedisHealthClient | null = null;

function getSharedSql(): SqlClient | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!sharedSql) {
    // Two connections are enough: readiness is single-flight, so concurrent
    // probes share one check instead of opening a pool per request.
    sharedSql = postgres(url, { max: 2, prepare: false, connect_timeout: 2, idle_timeout: 10 });
  }
  return sharedSql;
}

async function getSharedRedis(): Promise<RedisHealthClient | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (sharedRedis) return sharedRedis;
  const ioredisMod = await import('ioredis').catch(() => null);
  if (!ioredisMod) return null;
  const Redis = (
    ioredisMod as unknown as {
      default: new (url: string, opts: unknown) => RedisHealthClient;
    }
  ).default;
  const client = new Redis(url, {
    lazyConnect: false,
    connectTimeout: HEALTH_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    retryStrategy: () => null,
  });
  sharedRedis = client;
  return client;
}

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
  const sql = getSharedSql();
  if (!sql) return { name: 'postgres', status: 'skip' };
  const start = Date.now();
  try {
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
  }
}

async function checkRedis(): Promise<HealthCheckResult> {
  const url = process.env.REDIS_URL;
  if (!url) return { name: 'redis', status: 'skip' };
  const start = Date.now();
  try {
    const client = await getSharedRedis();
    if (!client) return { name: 'redis', status: 'skip' };
    await withTimeout(client.ping(), HEALTH_TIMEOUT_MS, 'redis');
    return { name: 'redis', status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      name: 'redis',
      status: 'fail',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkOutbox(): Promise<HealthCheckResult> {
  const sql = getSharedSql();
  if (!sql) return { name: 'outbox', status: 'skip' };
  const start = Date.now();
  try {
    const rows = await withTimeout(
      sql`select extract(epoch from (now() - min(created_at))) as lag_seconds, count(*) as pending from outbox_events where status = 'pending'`,
      HEALTH_TIMEOUT_MS,
      'outbox',
    );
    const row = (rows as unknown as Array<{ lag_seconds: string | null; pending: string }>)[0];
    const lag = row?.lag_seconds ? Number(row.lag_seconds) : 0;
    const pending = row?.pending ? Number(row.pending) : 0;
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
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('outbox_events') && msg.includes('does not exist'))
      return { name: 'outbox', status: 'skip' };
    return { name: 'outbox', status: 'fail', latencyMs: Date.now() - start, error: msg };
  }
}

async function checkPayments(): Promise<HealthCheckResult> {
  const sql = getSharedSql();
  if (!sql) return { name: 'payments', status: 'skip' };
  const start = Date.now();
  try {
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
  }
}

async function checkRls(): Promise<HealthCheckResult> {
  const sql = getSharedSql();
  if (!sql) return { name: 'rls', status: 'skip' };
  const role = process.env.DATABASE_ROLE ?? 'platform_app';
  if (!/^[a-z_][a-z0-9_]*$/i.test(role))
    return { name: 'rls', status: 'fail', error: 'role_invalid' };
  const start = Date.now();
  try {
    const rows = await withTimeout(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role "${role}"`);
        return tx.unsafe(
          `select app_tenant_id() is null as no_tenant, (select count(*) from organizations)::text as visible_tenants`,
        );
      }) as unknown as Promise<Array<{ no_tenant: boolean; visible_tenants: string }>>,
      HEALTH_TIMEOUT_MS,
      'rls',
    );
    const row = rows[0];
    if (!row?.no_tenant) {
      return {
        name: 'rls',
        status: 'fail',
        latencyMs: Date.now() - start,
        error: 'tenant_guc_not_null',
      };
    }
    if (Number(row.visible_tenants) !== 0) {
      return {
        name: 'rls',
        status: 'fail',
        latencyMs: Date.now() - start,
        error: 'rls_visible_without_tenant',
      };
    }
    return { name: 'rls', status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      name: 'rls',
      status: 'fail',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runReadiness(): Promise<ReadyReport> {
  const [pg, redis, outbox, payments, rls] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkOutbox(),
    checkPayments(),
    checkRls(),
  ]);
  const deps = [pg, redis, outbox, payments, rls].filter((d) => d.status !== 'skip');
  const hasFail = deps.some((d) => d.status === 'fail');
  return {
    status: hasFail ? 'degraded' : 'ok',
    service: 'api',
    dependencies: deps,
    uptimeMs: Date.now() - startedAt,
  };
}

let cachedReadiness: { value: ReadyReport; expiresAt: number } | null = null;
let inFlightReadiness: Promise<ReadyReport> | null = null;

export async function getReadiness(): Promise<ReadyReport> {
  const now = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAt > now) return cachedReadiness.value;
  if (inFlightReadiness) return inFlightReadiness;
  inFlightReadiness = runReadiness()
    .then((value) => {
      cachedReadiness = { value, expiresAt: Date.now() + READINESS_TTL_MS };
      return value;
    })
    .finally(() => {
      inFlightReadiness = null;
    });
  return inFlightReadiness;
}

export function getLiveness() {
  return {
    status: 'ok' as const,
    service: 'api' as const,
    uptimeMs: Date.now() - startedAt,
  };
}

export async function getStartup(): Promise<ReadyReport> {
  return getReadiness();
}

export async function closeHealthProbe(): Promise<void> {
  cachedReadiness = null;
  inFlightReadiness = null;
  if (sharedSql) {
    await sharedSql.end({ timeout: 2 }).catch(() => undefined);
    sharedSql = null;
  }
  if (sharedRedis) {
    await sharedRedis.quit().catch(() => undefined);
    sharedRedis = null;
  }
}

export function createHealthProbe(): HealthProbe {
  return {
    readiness: getReadiness,
    startup: getStartup,
    close: closeHealthProbe,
  };
}
