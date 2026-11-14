import type { FastifyServerOptions } from 'fastify';
import { redactRequestUrl } from './request-log.js';

type ApiLoggerOptions = NonNullable<Exclude<FastifyServerOptions['logger'], boolean>>;

/**
 * Fastify/Pino logger options shared by the API.
 *
 * Request serialization is replaced (not just censored) because Pino's
 * `redact` cannot mask part of a URL string, and the default request
 * serializer logs `req.url` verbatim — invitation tokens and OIDC
 * `code`/`state` would end up in logs.
 */
export function createApiLoggerOptions(level: string): ApiLoggerOptions {
  return {
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["x-webhook-signature"]',
        '*.secret',
        '*.password',
        '*.token',
        '*.authorization',
        '*.cookie',
        'headers.cookie',
        'headers.authorization',
      ],
      censor: '[REDACTED]',
      remove: false,
    },
    serializers: {
      req: (request: {
        method: string;
        url: string;
        ip?: string;
        headers?: Record<string, unknown>;
      }) => {
        const serialized: Record<string, unknown> = {
          method: request.method,
          url: redactRequestUrl(request.url),
        };
        if (request.ip !== undefined) serialized.remoteAddress = request.ip;
        if (typeof request.headers?.host === 'string') serialized.host = request.headers.host;
        return serialized;
      },
    },
  };
}
