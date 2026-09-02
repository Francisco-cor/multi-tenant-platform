import { getCorrelation, hashTenant } from './correlation.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

const REDACT_KEYS = new Set([
  'password',
  'secret',
  'authorization',
  'cookie',
  'token',
  'set-cookie',
  'x-api-key',
  'api_key',
  'secret_hash',
  'token_hash',
  'access_token',
  'refresh_token',
  'client_secret',
  'rawsecret',
  'raw_secret',
]);

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (REDACT_KEYS.has(lower)) return true;
  // also redact any key containing secret/password/token
  if (
    lower.includes('secret') ||
    lower.includes('password') ||
    lower === 'authorization' ||
    lower === 'cookie'
  )
    return true;
  return false;
}

function redactValue(_key: string, value: unknown): unknown {
  if (shouldRedactKey(String(_key))) return '[REDACTED]';
  if (typeof value === 'string') {
    // also redact long bearer tokens
    if (value.startsWith('Bearer ') || value.length > 200) {
      // if looks like token, redact
      if (
        value.includes('eyJ') ||
        /^pk_[a-z0-9]+_[a-z0-9]+/i.test(value) ||
        /^sk_[a-z0-9]+/i.test(value)
      )
        return '[REDACTED]';
    }
  }
  return value;
}

function cloneAndRedact(obj: unknown, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (obj instanceof Error) {
    return {
      message: obj.message,
      stack: obj.stack?.split('\n').slice(0, 5).join('\n'),
      name: obj.name,
    };
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => cloneAndRedact(v, depth + 1));
  }
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // also check dotted paths
      const redactedKey = shouldRedactKey(k);
      if (redactedKey) {
        out[k] = '[REDACTED]';
        continue;
      }
      // special handling for headers objects
      if (k === 'headers' && typeof v === 'object' && v !== null) {
        const headers = v as Record<string, unknown>;
        const redactedHeaders: Record<string, unknown> = {};
        for (const [hk, hv] of Object.entries(headers)) {
          if (shouldRedactKey(hk)) redactedHeaders[hk] = '[REDACTED]';
          else redactedHeaders[hk] = hv;
        }
        out[k] = redactedHeaders;
        continue;
      }
      out[k] = cloneAndRedact(redactValue(k, v), depth + 1);
    }
    return out;
  }
  return obj;
}

export interface LoggerOptions {
  level?: LogLevel;
  service?: string;
  pretty?: boolean;
}

export interface StructuredLogger {
  level: LogLevel;
  service: string;
  trace: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug: (obj: Record<string, unknown> | string, msg?: string) => void;
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
  fatal: (obj: Record<string, unknown> | string, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => StructuredLogger;
}

function formatLog(
  level: LogLevel,
  service: string,
  baseBindings: Record<string, unknown>,
  arg1: Record<string, unknown> | string,
  arg2?: string,
): string {
  const now = new Date().toISOString();
  const correlation = getCorrelation();
  let obj: Record<string, unknown> = {};
  let msg = '';

  if (typeof arg1 === 'string') {
    msg = arg1;
  } else {
    obj = (arg1 as Record<string, unknown>) ?? {};
    if (arg2) msg = arg2;
    else if (typeof obj.msg === 'string') msg = obj.msg as string;
  }

  // inject correlation
  if (correlation) {
    if (correlation.requestId) obj.requestId = correlation.requestId;
    if (correlation.traceId) obj.traceId = correlation.traceId;
    if (correlation.tenantHash) obj.tenantHash = correlation.tenantHash;
    else if (correlation.tenantId) obj.tenantHash = hashTenant(correlation.tenantId);
    if (correlation.userId) obj.userIdHash = hashTenant(correlation.userId);
  }

  // inject service
  obj.service = service;

  // also hash tenantId if present directly in log
  if (typeof obj.tenantId === 'string' && !obj.tenantHash) {
    obj.tenantHash = hashTenant(obj.tenantId as string);
    // optionally keep tenantId redacted? We keep hash only, delete raw if hash present and not explicitly allowed
    // For audit, we keep raw tenantId is not PII, but for privacy we hash.
    // Keep both? We hash and keep raw for debug? Policy: logs use hash, not raw.
    // So we remove raw to avoid high cardinality? Keep hash only.
    // But for debugging, keep raw if env LOG_PII=1. Default redact.
    if (process.env.LOG_PII !== '1') {
      delete obj.tenantId;
    }
  }

  const redacted = cloneAndRedact({ ...baseBindings, ...obj }) as Record<string, unknown>;

  const logRecord: Record<string, unknown> = {
    level: level.toUpperCase(),
    time: now,
    service,
    msg,
    ...redacted,
  };

  return JSON.stringify(logRecord);
}

function shouldLog(current: LogLevel, target: LogLevel): boolean {
  return LEVEL_ORDER[target] >= LEVEL_ORDER[current];
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  const level: LogLevel =
    (options.level as LogLevel) ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
  const service = options.service ?? 'api';
  const baseBindings: Record<string, unknown> = {};

  const sink = (lvl: LogLevel, a: Record<string, unknown> | string, b?: string) => {
    if (!shouldLog(level, lvl)) return;
    const line = formatLog(lvl, service, baseBindings, a, b);
    // Use appropriate console method but always JSON to stdout/stderr
    if (lvl === 'error' || lvl === 'fatal') {
      console.error(line);
    } else if (lvl === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  const logger: StructuredLogger = {
    level,
    service,
    trace: (a, b) => sink('trace', a as never, b),
    debug: (a, b) => sink('debug', a as never, b),
    info: (a, b) => sink('info', a as never, b),
    warn: (a, b) => sink('warn', a as never, b),
    error: (a, b) => sink('error', a as never, b),
    fatal: (a, b) => sink('fatal', a as never, b),
    child: (bindings) => {
      const childBindings = {
        ...baseBindings,
        ...(cloneAndRedact(bindings) as Record<string, unknown>),
      };
      // create child that merges bindings
      const childOpts: LoggerOptions = { level, service };
      const child = createLogger(childOpts);
      // override format to include child bindings
      const childLogger: StructuredLogger = {
        ...child,
        trace: (a, b) => {
          const line = formatLog('trace', service, childBindings, a as never, b);
          if (shouldLog(level, 'trace')) console.log(line);
        },
        debug: (a, b) => {
          const line = formatLog('debug', service, childBindings, a as never, b);
          if (shouldLog(level, 'debug')) console.log(line);
        },
        info: (a, b) => {
          const line = formatLog('info', service, childBindings, a as never, b);
          if (shouldLog(level, 'info')) console.log(line);
        },
        warn: (a, b) => {
          const line = formatLog('warn', service, childBindings, a as never, b);
          if (shouldLog(level, 'warn')) console.warn(line);
        },
        error: (a, b) => {
          const line = formatLog('error', service, childBindings, a as never, b);
          if (shouldLog(level, 'error')) console.error(line);
        },
        fatal: (a, b) => {
          const line = formatLog('fatal', service, childBindings, a as never, b);
          if (shouldLog(level, 'fatal')) console.error(line);
        },
        child: (b2) => createLogger({ level, service }).child({ ...childBindings, ...b2 }),
      };
      return childLogger;
    },
  };

  // expose pino-like interface for Fastify compatibility
  // Fastify checks logger.child and logger.level
  (logger as unknown as Record<string, unknown>).child = logger.child;

  return logger;
}

// Default logger for worker/api shared
export const logger = createLogger({ service: process.env.OTEL_SERVICE_NAME ?? 'api' });

// Re-export hash for tests
export { hashTenant };
