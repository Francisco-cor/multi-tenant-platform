import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

interface SecurityOptions {
  baseDomain: string;
  webPublicUrl?: string;
  allowDevOrigins?: boolean;
}

function isAllowedOrigin(origin: string | undefined, options: SecurityOptions): boolean {
  if (!origin) return true; // curl, same-origin, server-to-server
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const base = options.baseDomain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  // Exact base domain treated as tenant? e.g. app.localhost is not tenant slug but allow for api.localhost
  // Allow: *.baseDomain and baseDomain itself and localhost variants
  if (hostname === base) return true;
  if (hostname.endsWith(`.${base}`)) return true;
  if (options.allowDevOrigins) {
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    // Allow ports on localhost
  }
  if (options.webPublicUrl) {
    try {
      const webHost = new URL(options.webPublicUrl).hostname.toLowerCase();
      if (hostname === webHost) return true;
      if (webHost.endsWith(`.${base}`) && hostname.endsWith(`.${base}`)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  void app.register(helmet, {
    // CSP: tight but not breaking JSON API. Report-only if you add frontend later.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // API returns JSON, not cross-origin isolation
    hsts:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
  });

  void app.register(cors, {
    // Reflect origin only if allowed; otherwise CORS preflight will be rejected
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin, options)) {
        callback(null, true);
      } else {
        callback(new Error('CORS origin not allowed'), false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials: true,
    maxAge: 600,
  });

  // Add request start time for latency metrics (observability helper can read)
  app.addHook('onRequest', async (request) => {
    (request as unknown as Record<string, unknown>).__requestStart = Date.now();
  });
}
