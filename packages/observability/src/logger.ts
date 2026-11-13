import { createHash } from 'node:crypto';
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

/**
 * Key normalisation: lower-case and strip separators so `api_key`, `apiKey`
 * and `API-KEY` all reduce to `apikey`.
 */
export function normalizeRedactionKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, '');
}

const EXACT_SENSITIVE_KEYS = new Set(
  [
    'password',
    'passwd',
    'pwd',
    'secret',
    'clientsecret',
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
    'apikey',
    'accesskey',
    'privatekey',
    'secretkey',
    'encryptionkey',
    'signingkey',
    'webhooksecret',
    'credential',
    'credentials',
    'dsn',
    'connectionstring',
    'databaseurl',
    'redisurl',
    'authorizationheader',
    'xapikey',
    'sig',
    'signature',
    'signingsecret',
  ].map(normalizeRedactionKey),
);

const SENSITIVE_SUFFIXES = ['key', 'token', 'secret', 'password', 'passwd', 'pwd', 'credential'];
const SENSITIVE_CONTAINS = [
  'secret',
  'password',
  'credential',
  'apikey',
  'privatekey',
  'accesskey',
];
const SENSITIVE_CONTAINERS = new Set([
  'config',
  'env',
  'environment',
  'secrets',
  'credentials',
  'settings',
]);

/** Keys whose values are structural and must not be entropy-redacted. */
const SAFE_VALUE_KEYS = new Set([
  'msg',
  'level',
  'time',
  'service',
  'requestid',
  'traceid',
  'spanid',
  'parentspanid',
  'tenanthash',
  'useridhash',
  'route',
  'method',
  'url',
  'statuscode',
  'durationms',
  'span',
  'event',
  'action',
  'queue',
  'errorname',
  'stack',
  'message',
  'code',
  'reason',
  'description',
  'svc',
]);

export function shouldRedactKey(key: string): boolean {
  const normalized = normalizeRedactionKey(key);
  if (normalized.length === 0) return false;
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  if (SENSITIVE_CONTAINS.some((fragment) => normalized.includes(fragment))) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/u.test(value)) classes += 1;
  if (/[A-Z]/u.test(value)) classes += 1;
  if (/[0-9]/u.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/u.test(value)) classes += 1;
  return classes;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/u;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const JWT_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;
const PREFIXED_SECRET_PATTERN = /^(?:sk|pk|rk|whsec|ghp|gho|xox[baprs])_[A-Za-z0-9_-]{8,}/iu;
const URL_WITH_CREDENTIALS_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/iu;

/**
 * A long, structured string that is likely to be a credential. UUIDs,
 * timestamps, emails and credential-free URLs are explicitly safe so that
 * normal request logs stay useful.
 */
export function looksLikeHighEntropySecret(value: string): boolean {
  if (value.length < 20 || value.length > 4_096) return false;
  if (UUID_PATTERN.test(value) || EMAIL_PATTERN.test(value) || ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  if (URL_PATTERN.test(value) && !URL_WITH_CREDENTIALS_PATTERN.test(value)) return false;
  if (JWT_PATTERN.test(value)) return true;
  if (PREFIXED_SECRET_PATTERN.test(value)) return true;
  if (URL_WITH_CREDENTIALS_PATTERN.test(value)) return true;
  if (characterClasses(value) < 3) return false;
  return shannonEntropy(value) >= 4;
}

function isSensitiveContainer(context: readonly string[]): boolean {
  return context.some((segment) => SENSITIVE_CONTAINERS.has(normalizeRedactionKey(segment)));
}

function redactValue(key: string, value: unknown, sensitiveContext = false): unknown {
  if (shouldRedactKey(key)) return '[REDACTED]';
  if (typeof value !== 'string') return value;
  const normalized = normalizeRedactionKey(key);
  if (SAFE_VALUE_KEYS.has(normalized)) return value;
  if (value.startsWith('Bearer ') || value.startsWith('Basic ')) return '[REDACTED]';
  if (looksLikeHighEntropySecret(value)) return '[REDACTED]';
  // Inside config/env/secrets containers an opaque 20+ char value is treated
  // as a credential even if it does not match a known prefix.
  if (sensitiveContext && value.length >= 20 && characterClasses(value) >= 2) {
    if (!URL_PATTERN.test(value) || URL_WITH_CREDENTIALS_PATTERN.test(value)) return '[REDACTED]';
  }
  return value;
}

function cloneAndRedact(obj: unknown, depth = 0, context: readonly string[] = []): unknown {
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
    return obj.map((value) => cloneAndRedact(value, depth + 1, context));
  }
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    const sensitiveContext = isSensitiveContainer(context);
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (shouldRedactKey(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = cloneAndRedact(redactValue(key, value, sensitiveContext), depth + 1, [
        ...context,
        key,
      ]);
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

  if (correlation) {
    if (correlation.requestId) obj.requestId = correlation.requestId;
    if (correlation.traceId) obj.traceId = correlation.traceId;
    if (correlation.tenantHash) obj.tenantHash = correlation.tenantHash;
    else if (correlation.tenantId) obj.tenantHash = hashTenant(correlation.tenantId);
    if (correlation.userId) obj.userIdHash = hashTenant(correlation.userId);
  }

  obj.service = service;

  if (typeof obj.tenantId === 'string' && !obj.tenantHash) {
    obj.tenantHash = hashTenant(obj.tenantId as string);
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

function write(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'fatal') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Stable, non-reversible fingerprint used for debugging without leaking data. */
export function redactionFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  const level: LogLevel =
    (options.level as LogLevel) ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
  const service = options.service ?? 'api';
  const baseBindings: Record<string, unknown> = {};

  const makeLogger = (bindings: Record<string, unknown>): StructuredLogger => {
    const emit = (lvl: LogLevel, a: Record<string, unknown> | string, b?: string) => {
      if (!shouldLog(level, lvl)) return;
      write(lvl, formatLog(lvl, service, bindings, a as never, b));
    };
    return {
      level,
      service,
      trace: (a, b) => emit('trace', a, b),
      debug: (a, b) => emit('debug', a, b),
      info: (a, b) => emit('info', a, b),
      warn: (a, b) => emit('warn', a, b),
      error: (a, b) => emit('error', a, b),
      fatal: (a, b) => emit('fatal', a, b),
      child: (childBindings) =>
        makeLogger({
          ...bindings,
          ...(cloneAndRedact(childBindings) as Record<string, unknown>),
        }),
    };
  };

  const logger = makeLogger(baseBindings);
  // expose pino-like interface for Fastify compatibility
  (logger as unknown as Record<string, unknown>).child = logger.child;
  return logger;
}

export const logger = createLogger({ service: process.env.OTEL_SERVICE_NAME ?? 'api' });

// Re-export hash for tests
export { hashTenant };
