import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface CorrelationContext {
  requestId: string;
  traceId?: string;
  tenantId?: string;
  userId?: string;
  /** short hash for logs/metrics to avoid PII cardinality */
  tenantHash?: string;
  parentSpanId?: string;
  /** W3C traceparent sampled flag, when known. */
  sampled?: boolean;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;
const LEGACY_TRACE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function hashTenant(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 8);
}

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  let spanId = randomBytes(8).toString('hex');
  while (spanId === '0'.repeat(16)) spanId = randomBytes(8).toString('hex');
  return spanId;
}

export function isValidTraceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TRACE_ID_PATTERN.test(value) &&
    value.toLowerCase() !== '0'.repeat(32)
  );
}

export function isValidSpanId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SPAN_ID_PATTERN.test(value) &&
    value.toLowerCase() !== '0'.repeat(16)
  );
}

/** Accept only bounded, printable request identifiers; otherwise mint one server-side. */
export function sanitizeRequestId(value: unknown): string {
  if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) return value;
  return randomUUID();
}

export function runWithCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  const enriched: CorrelationContext = Object.freeze({
    ...ctx,
    ...(ctx.tenantId ? { tenantHash: hashTenant(ctx.tenantId) } : {}),
  });
  return storage.run(enriched, fn);
}

export function getCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/**
 * Install a correlation context for the remainder of the current async
 * execution.
 *
 * Prefer `runWithCorrelation` where the scope can be expressed as a callback.
 * Contexts are frozen snapshots, so a later `setCorrelationPatch` can never
 * mutate the context observed by another request.
 *
 * @deprecated Prefer `runWithCorrelation` (or an explicit request-scoped run).
 */
export function enterCorrelation(ctx: CorrelationContext): void {
  const enriched: CorrelationContext = Object.freeze({
    ...ctx,
    ...(ctx.tenantId
      ? { tenantHash: hashTenant(ctx.tenantId) }
      : ctx.tenantHash
        ? { tenantHash: ctx.tenantHash }
        : {}),
  });
  storage.enterWith(enriched);
}

/**
 * Replace the current context with a new immutable snapshot. Because the old
 * object is never mutated, patching in one request cannot rewrite a context
 * captured by another.
 */
export function setCorrelationPatch(patch: Partial<CorrelationContext>): void {
  const existing = storage.getStore();
  if (!existing) return;
  const next: CorrelationContext = Object.freeze({
    ...existing,
    ...patch,
    ...(patch.tenantId ? { tenantHash: hashTenant(patch.tenantId) } : {}),
  });
  storage.enterWith(next);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  if (typeof direct === 'string') return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : (v as string | undefined);
    }
  }
  return undefined;
}

function parseTraceparent(
  header: string,
): { traceId: string; parentId: string; sampled: boolean } | null {
  const match = header.match(TRACEPARENT_PATTERN);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  if (!isValidTraceId(match[1]) || !isValidSpanId(match[2])) return null;
  return {
    traceId: match[1].toLowerCase(),
    parentId: match[2].toLowerCase(),
    sampled: match[3] === '01',
  };
}

export function extractCorrelation(
  headers: Record<string, string | string[] | undefined>,
  fallbackRequestId: string,
): CorrelationContext {
  const requestId = sanitizeRequestId(
    headerValue(headers, 'x-request-id') ??
      headerValue(headers, 'x-correlation-id') ??
      fallbackRequestId,
  );
  const traceparent = headerValue(headers, 'traceparent');
  const traceFromParent = traceparent ? parseTraceparent(traceparent) : null;
  const clientTraceId = headerValue(headers, 'x-trace-id');
  // W3C ids stay canonical; bounded legacy ids (e.g. pre-traceparent clients,
  // smoke tests) are preserved so audit/log correlation is not silently broken.
  const traceId =
    traceFromParent?.traceId ??
    (isValidTraceId(clientTraceId)
      ? clientTraceId.toLowerCase()
      : typeof clientTraceId === 'string' && LEGACY_TRACE_PATTERN.test(clientTraceId)
        ? clientTraceId
        : undefined);
  const parentSpanId = traceFromParent?.parentId;
  const rawTenantId = headerValue(headers, 'x-tenant-id');
  const tenantId =
    typeof rawTenantId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(rawTenantId)
      ? rawTenantId
      : undefined;
  const ctx: CorrelationContext = {
    // Always server-generated or validated; never an arbitrary client string.
    requestId,
    traceId: traceId ?? generateTraceId(),
    ...(tenantId ? { tenantId } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(traceFromParent ? { sampled: traceFromParent.sampled } : {}),
  };
  if (ctx.tenantId) ctx.tenantHash = hashTenant(ctx.tenantId);
  return ctx;
}

export function correlationHeaders(ctx: CorrelationContext): Record<string, string> {
  const headers: Record<string, string> = {
    'x-request-id': sanitizeRequestId(ctx.requestId),
  };
  const traceId = isValidTraceId(ctx.traceId) ? ctx.traceId.toLowerCase() : generateTraceId();
  const parent = isValidSpanId(ctx.parentSpanId)
    ? ctx.parentSpanId.toLowerCase()
    : generateSpanId();
  headers['x-trace-id'] = traceId;
  headers['traceparent'] = `00-${traceId}-${parent}-${ctx.sampled === false ? '00' : '01'}`;
  if (ctx.tenantId) headers['x-tenant-id'] = ctx.tenantId;
  return headers;
}
