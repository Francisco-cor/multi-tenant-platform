export {
  type CorrelationContext,
  runWithCorrelation,
  getCorrelation,
  enterCorrelation,
  setCorrelationPatch,
  extractCorrelation,
  correlationHeaders,
  hashTenant,
} from './correlation.js';
export * from './logger.js';
export * from './metrics.js';
export {
  generateTraceId,
  generateSpanId,
  buildTraceparent,
  parseTraceparent,
  initTracing,
  withSpan,
  getActiveTraceId,
  spanHash,
} from './tracing.js';

import { correlationHeaders } from './correlation.js';
import type { CorrelationContext } from './correlation.js';

export function legacyCorrelationHeaders(context: CorrelationContext): Record<string, string> {
  return correlationHeaders(context);
}
