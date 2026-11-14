import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

interface SecurityOptions {
  baseDomain?: string;
  webPublicUrl?: string;
  /** Exact browser origins allowed to call the API with credentials. */
  allowedOrigins: string[];
  /** Production-like deployments must not accept plaintext browser origins. */
  requireHttps?: boolean;
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  requireHttps: boolean,
): boolean {
  if (!origin) return true; // curl, same-origin server calls and health probes
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (requireHttps && new URL(normalized).protocol !== 'https:') return false;
  return allowedOrigins.has(normalized);
}

export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const requireHttps = options.requireHttps === true;
  const allowedOrigins = new Set(
    options.allowedOrigins
      .map((origin) => normalizeOrigin(origin))
      .filter((origin): origin is string => origin !== null),
  );

  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    noSniff: true,
    xssFilter: true,
    hsts: requireHttps ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  void app.register(cors, {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin, allowedOrigins, requireHttps)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'Idempotency-Key',
      'X-Csrf-Token',
      'X-Request-Id',
      'X-Correlation-Id',
      'X-Trace-Id',
      'Traceparent',
      'X-Tenant-Id',
      'X-Webhook-Timestamp',
      'X-Webhook-Signature',
      'X-Signature',
      'X-Timestamp',
      'X-Requested-With',
      'Origin',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-RateLimit-Tenant-Limit',
      'X-RateLimit-Tenant-Remaining',
      'Retry-After',
      'X-Cache',
      'Cache-Control',
    ],
    credentials: true,
    maxAge: 600,
  });

  // CORS only controls response headers. Reject a disallowed Origin before the
  // route handler runs so a credentialed mutation can never execute even if a
  // proxy strips CORS headers.
  app.addHook('onRequest', async (request) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, allowedOrigins, requireHttps)) {
      const error = new Error('Origin is not allowed') as Error & {
        statusCode: number;
        code: string;
      };
      error.statusCode = 403;
      error.code = 'CORS_ORIGIN_DENIED';
      throw error;
    }
    (request as unknown as Record<string, unknown>).__requestStart = Date.now();
  });
}
