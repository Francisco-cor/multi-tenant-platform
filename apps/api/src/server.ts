import { buildApp } from './app.js';
import { PersistentIdentityStore } from './persistent-identity-store.js';

const databaseUrl = process.env.DATABASE_URL;
const persistentStore = databaseUrl
  ? PersistentIdentityStore.fromConnectionString(
      databaseUrl,
      process.env.DATABASE_ROLE ?? 'platform_app',
    )
  : undefined;
const app = buildApp(persistentStore ? { store: persistentStore } : {});
const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '0.0.0.0';

await app.listen({ port, host });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'graceful_shutdown_started');
  await app.close();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
