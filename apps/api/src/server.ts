import { buildApp } from './app.js';

const app = buildApp();
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
