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
    if (!Array.isArray(result) || result.length === 0) throw new Error('postgres unexpected result');
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
  try {
    const ioredisMod = await import('ioredis').catch(() => null);
    if (!ioredisMod) return { name: 'redis', status: 'skip' };
    const Redis = (ioredisMod as unknown as { default: new (url: string, opts: unknown) => { ping: () => Promise<string>; quit: () => Promise<void> } }).default;
    const client = new Redis(url, { lazyConnect: true, connectTimeout: HEALTH_TIMEOUT_MS, maxRetriesPerRequest: 0, enableReadyCheck: false });
    await withTimeout(client.ping(), HEALTH_TIMEOUT_MS, 'redis');
    await client.quit().catch(() => undefined);
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

export async function getReadiness(): Promise<ReadyReport> {
  const [pg, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const deps = [pg, redis].filter((d) => d.status !== 'skip');
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
