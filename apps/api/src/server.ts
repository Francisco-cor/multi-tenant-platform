import { initTracing } from '@platform/observability';
import { loadEnvironment } from '@platform/config';
import { buildApp } from './app.js';
import { PersistentIdentityStore } from './persistent-identity-store.js';

const environment = loadEnvironment();

await initTracing({
  serviceName: environment.OTEL_SERVICE_NAME,
  ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { exporterEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});

const databaseUrl = environment.DATABASE_URL;
const persistentStore = databaseUrl
  ? PersistentIdentityStore.fromConnectionString(
      databaseUrl,
      environment.DATABASE_ROLE ?? 'platform_app',
    )
  : undefined;
const app = buildApp({
  ...(persistentStore ? { store: persistentStore } : {}),
  baseDomain: environment.TENANT_BASE_DOMAIN,
  allowDevLogin: environment.NODE_ENV !== 'production' && environment.ALLOW_DEV_LOGIN === '1',
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
const port = environment.API_PORT;
const host = environment.API_HOST;

await app.listen({ port, host });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'graceful_shutdown_started');
  await app.close();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
