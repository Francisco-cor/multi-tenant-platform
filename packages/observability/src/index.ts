export interface CorrelationContext {
  requestId: string;
  traceId?: string;
  tenantId?: string;
  userId?: string;
}

export function correlationHeaders(context: CorrelationContext): Record<string, string> {
  return {
    'x-request-id': context.requestId,
    ...(context.traceId ? { 'x-trace-id': context.traceId } : {}),
  };
}

export * from './metrics.js';
