import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface CorrelationContext {
  requestId: string;
  traceId?: string;
  tenantId?: string;
  userId?: string;
  /** short hash for logs/metrics to avoid PII cardinality */
  tenantHash?: string;
  parentSpanId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function hashTenant(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 8);
}

export function runWithCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  const enriched: CorrelationContext = {
    ...ctx,
    ...(ctx.tenantId ? { tenantHash: hashTenant(ctx.tenantId) } : {}),
  };
  return storage.run(enriched, fn);
}

export function getCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

export function enterCorrelation(ctx: CorrelationContext): void {
  const enriched: CorrelationContext = {
    ...ctx,
    ...(ctx.tenantId
      ? { tenantHash: hashTenant(ctx.tenantId) }
      : ctx.tenantHash
        ? { tenantHash: ctx.tenantHash }
        : {}),
  };
  storage.enterWith(enriched);
}

export function setCorrelationPatch(patch: Partial<CorrelationContext>): void {
  const existing = storage.getStore();
  if (!existing) return;
  Object.assign(existing, patch);
  if (patch.tenantId) {
    existing.tenantHash = hashTenant(patch.tenantId);
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  if (typeof direct === 'string') return direct;
  // also check case-insensitive
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : (v as string | undefined);
    }
  }
  return undefined;
}

function parseTraceparent(header: string): { traceId: string; parentId: string } | null {
  // 00-<32hex>-<16hex>-<2hex>
  const m = header.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!m || !m[1] || !m[2]) return null;
  return { traceId: m[1].toLowerCase(), parentId: m[2].toLowerCase() };
}

export function extractCorrelation(
  headers: Record<string, string | string[] | undefined>,
  fallbackRequestId: string,
): CorrelationContext {
  const requestId =
    headerValue(headers, 'x-request-id') ??
    headerValue(headers, 'x-correlation-id') ??
    fallbackRequestId;
  const traceparent = headerValue(headers, 'traceparent');
  const traceFromParent = traceparent ? parseTraceparent(traceparent) : null;
  const traceId = headerValue(headers, 'x-trace-id') ?? traceFromParent?.traceId ?? undefined;
  const parentSpanId = traceFromParent?.parentId;
  const tenantId = headerValue(headers, 'x-tenant-id') ?? undefined;
  const ctx: CorrelationContext = {
    requestId,
    ...(traceId ? { traceId } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
  };
  if (ctx.tenantId) ctx.tenantHash = hashTenant(ctx.tenantId);
  return ctx;
}

export function correlationHeaders(ctx: CorrelationContext): Record<string, string> {
  const headers: Record<string, string> = {
    'x-request-id': ctx.requestId,
  };
  if (ctx.traceId) {
    headers['x-trace-id'] = ctx.traceId;
    // also propagate W3C traceparent for downstream OTel services
    const parent = ctx.parentSpanId ?? '0000000000000000';
    // If traceId is shorter than 32, pad
    const tid = ctx.traceId.padStart(32, '0').slice(-32).toLowerCase();
    headers['traceparent'] = `00-${tid}-${parent}-01`;
  }
  if (ctx.tenantId) headers['x-tenant-id'] = ctx.tenantId;
  return headers;
}

// generateTraceId moved to tracing.ts to avoid duplicate export
