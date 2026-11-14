import { initTracing } from '@platform/observability';
import {
  isProductionLike,
  loadEnvironment,
  type Environment,
} from '@platform/config';
import { createOidcStateStore, type OidcStateStore } from '@platform/auth';
import {
  createAdminDatabase,
  purgeExpiredSessionsUntilEmpty,
  withAuthBootstrapTransaction,
} from '@platform/db';
import { buildApp } from './app.js';
import { createCache } from './cache.js';
import { createRateLimiter } from './rate-limit.js';
import { PersistentIdentityStore } from './persistent-identity-store.js';

const environment: Environment = loadEnvironment();
const productionLike = isProductionLike(environment.NODE_ENV);

await initTracing({
  serviceName: environment.OTEL_SERVICE_NAME,
  ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { exporterEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});

type OidcRedisClient = {
  ping(): Promise<string>;
  quit(): Promise<void>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, setMode: 'NX'): Promise<'OK' | null>;
  getdel(key: string): Promise<string | null>;
};

async function connectOidcRedis(url: string): Promise<OidcRedisClient> {
  const mod = await import('ioredis');
  const Redis = (mod as unknown as { default: new (u: string, o: unknown) => OidcRedisClient })
    .default;
  const client = new Redis(url, {
    lazyConnect: false,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    retryStrategy: () => null,
  });
  await Promise.race([
    client.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timeout')), 1500)),
  ]);
  return client;
}

const cache = await createCache(environment.REDIS_URL);
const rateLimiter = await createRateLimiter(environment.REDIS_URL);

let oidcRedis: OidcRedisClient | undefined;
if (environment.REDIS_URL) {
  oidcRedis = await connectOidcRedis(environment.REDIS_URL);
}
const oidcStateStore: OidcStateStore = await createOidcStateStore({
  nodeEnv: environment.NODE_ENV,
  ...(oidcRedis ? { redisClient: oidcRedis } : {}),
});

const databaseUrl = environment.DATABASE_URL;
const persistentStore = databaseUrl
  ? PersistentIdentityStore.fromConnectionString(
      databaseUrl,
      environment.DATABASE_ROLE ?? 'platform_app',
    )
  : undefined;
const trustProxy =
  environment.TRUST_PROXY_CIDRS.length > 0
    ? environment.TRUST_PROXY_CIDRS
    : environment.TRUST_PROXY_HOPS
      ? environment.TRUST_PROXY_HOPS
      : environment.TRUST_PROXY === '1' && !productionLike
        ? true
        : false;
const app = buildApp({
  ...(persistentStore ? { store: persistentStore } : {}),
  baseDomain: environment.TENANT_BASE_DOMAIN,
  allowDevLogin: !productionLike && environment.ALLOW_DEV_LOGIN === '1',
  allowedOrigins: environment.WEB_ALLOWED_ORIGINS,
  ...(environment.SESSION_COOKIE_DOMAIN
    ? { sessionCookieDomain: environment.SESSION_COOKIE_DOMAIN }
    : {}),
  ...(environment.METRICS_TOKEN ? { metricsToken: environment.METRICS_TOKEN } : {}),
  trustProxy,
  cache,
  rateLimiter,
  oidcStateStore,
  oidcEmailVerified: environment.OIDC_EMAIL_VERIFIED,
  oidc: {
    issuer: environment.OIDC_ISSUER_URL ?? '',
    clientId: environment.OIDC_CLIENT_ID ?? '',
    ...(environment.OIDC_CLIENT_SECRET ? { clientSecret: environment.OIDC_CLIENT_SECRET } : {}),
    ...(environment.OIDC_REDIRECT_URI ? { redirectUri: environment.OIDC_REDIRECT_URI } : {}),
    ...(environment.OIDC_AUTHORIZATION_ENDPOINT
      ? { authorizationEndpoint: environment.OIDC_AUTHORIZATION_ENDPOINT }
      : {}),
  },
});

const purgeHandle = databaseUrl
  ? (() => {
      const admin = createAdminDatabase(databaseUrl, { maxConnections: 1 });
      const interval = setInterval(
        () => {
          void withAuthBootstrapTransaction(admin, { requestId: 'session-purge' }, (tx) =>
            purgeExpiredSessionsUntilEmpty(tx, { batchSize: 500, maxBatches: 5 }),
          ).catch((error: unknown) => {
            app.log.warn({ err: error }, 'session_purge_failed');
          });
        },
        15 * 60 * 1000,
      );
      interval.unref();
      return { interval, admin };
    })()
  : undefined;

const port = environment.API_PORT;
const host = environment.API_HOST;

await app.listen({ port, host });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'graceful_shutdown_started');
  if (purgeHandle) {
    clearInterval(purgeHandle.interval);
    await purgeHandle.admin.close().catch(() => undefined);
  }
  await oidcRedis?.quit().catch(() => undefined);
  await app.close();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
