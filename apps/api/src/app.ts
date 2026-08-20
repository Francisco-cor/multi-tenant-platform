import Fastify, { type FastifyInstance } from 'fastify';
import { API_VERSION, metaResponse } from '@platform/contracts';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/health/live', async () => ({ status: 'ok', service: 'api' }));

  app.get('/health/ready', async () => ({ status: 'ok', service: 'api', dependencies: [] }));

  app.get('/v1/meta', async () => ({ ...metaResponse, apiVersion: API_VERSION }));

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, request_id: request.id }, 'unhandled_request_error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error',
        requestId: request.id,
      },
    });
  });

  return app;
}
