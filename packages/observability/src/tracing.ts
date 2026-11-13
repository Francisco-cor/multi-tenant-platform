import { createHash, randomBytes } from 'node:crypto';
import {
  getCorrelation,
  isValidSpanId,
  isValidTraceId,
  runWithCorrelation,
  type CorrelationContext,
} from './correlation.js';
import { createLogger } from './logger.js';

const logger = createLogger({ service: 'tracing' });

export interface TracingOptions {
  serviceName?: string;
  exporterEndpoint?: string;
  sampleRatio?: number; // 0-1, default 0.1 prod 1 dev
  /** Test seam: wraps the OTel sampler constructor. */
  samplerFactory?: (ratio: number) => unknown;
}

interface OtelSpanLike {
  setAttribute?: (key: string, value: unknown) => void;
  setStatus?: (status: { code: number; message?: string }) => void;
  recordException?: (error: unknown) => void;
  end: () => void;
}

interface OtelTracerLike {
  startActiveSpan: (
    name: string,
    options: { attributes?: Record<string, unknown> },
    fn: (span: OtelSpanLike) => void,
  ) => void;
}

let tracingInitialized = false;
let currentServiceName = 'api';
let activeTracer: OtelTracerLike | null = null;
let effectiveSampleRatio = 1;

/**
 * Generate OTel-compatible traceId (32 hex chars, never all zeros).
 */
export function generateTraceId(): string {
  let traceId = randomBytes(16).toString('hex');
  while (traceId === '0'.repeat(32)) traceId = randomBytes(16).toString('hex');
  return traceId;
}

/** Generate spanId (16 hex chars, never all zeros). */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

function assertValidTraceId(traceId: string): string {
  if (!isValidTraceId(traceId)) throw new Error('traceparent_invalid_trace_id');
  return traceId.toLowerCase();
}

function assertValidSpanId(spanId: string): string {
  if (!isValidSpanId(spanId)) throw new Error('traceparent_invalid_span_id');
  return spanId.toLowerCase();
}

/**
 * Build a valid W3C traceparent header. Invalid ids are rejected instead of
 * being padded into a forged/zero identifier.
 */
export function buildTraceparent(traceId: string, spanId?: string, sampled = true): string {
  const tid = assertValidTraceId(traceId);
  const sid = spanId ? assertValidSpanId(spanId) : generateSpanId();
  const flags = sampled ? '01' : '00';
  return `00-${tid}-${sid}-${flags}`;
}

export function parseTraceparent(
  header: string,
): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = header.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  if (!isValidTraceId(m[1]) || !isValidSpanId(m[2])) return null;
  return {
    traceId: m[1].toLowerCase(),
    spanId: m[2].toLowerCase(),
    sampled: m[3] === '01',
  };
}

/** Effective trace sampling ratio, validated and clamped to [0, 1]. */
export function resolveSampleRatio(explicit?: number): number {
  const raw =
    explicit ??
    (process.env.OTEL_TRACES_SAMPLER_ARG
      ? Number(process.env.OTEL_TRACES_SAMPLER_ARG)
      : process.env.NODE_ENV === 'production'
        ? 0.1
        : 1);
  if (!Number.isFinite(raw)) return process.env.NODE_ENV === 'production' ? 0.1 : 1;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Create the OTel sampler for the effective ratio. Returns `undefined` when
 * the SDK package is not installed (the caller then keeps the SDK default, and
 * logs that no local sampler was applied).
 */
export async function createTraceSampler(
  ratio: number,
  factory?: (ratio: number) => unknown,
): Promise<unknown> {
  if (factory) return factory(ratio);
  try {
    const mod = (await import('@opentelemetry/sdk-trace-base' as string).catch(
      () => null,
    )) as unknown as { TraceIdRatioBasedSampler?: new (ratio: number) => unknown } | null;
    if (mod?.TraceIdRatioBasedSampler) return new mod.TraceIdRatioBasedSampler(ratio);
  } catch {
    // ignore: SDK not installed
  }
  return undefined;
}

/** Test seam / integration point: install a tracer that creates real spans. */
export function configureTracer(tracer: OtelTracerLike | null): void {
  activeTracer = tracer;
}

export function getEffectiveSampleRatio(): number {
  return effectiveSampleRatio;
}

/**
 * Initialize tracing SDK.
 * If OTEL_EXPORTER_OTLP_ENDPOINT is set, tries to load @opentelemetry/sdk-node
 * dynamically. Falls back to correlation-only logging when not installed.
 */
export async function initTracing(options: TracingOptions = {}): Promise<void> {
  if (tracingInitialized) return;
  tracingInitialized = true;
  currentServiceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'api';

  const endpoint =
    options.exporterEndpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    '';

  const sampleRatio = resolveSampleRatio(options.sampleRatio);
  effectiveSampleRatio = sampleRatio;
  const sampler = await createTraceSampler(sampleRatio, options.samplerFactory);

  if (!endpoint) {
    logger.info(
      {
        service: currentServiceName,
        sampling: sampleRatio,
        sampler: sampler ? 'ratio' : 'none',
        exporter: 'console',
      },
      'tracing initialized (correlation only, no OTLP endpoint)',
    );
    return;
  }

  try {
    const sdkModule = (await import('@opentelemetry/sdk-node' as string).catch(
      () => null,
    )) as unknown as {
      NodeSDK: new (opts: unknown) => {
        start: () => void;
        shutdown: () => Promise<void>;
      };
    } | null;

    if (!sdkModule) {
      logger.warn(
        { endpoint, sampling: sampleRatio },
        'OTEL SDK not installed; spans fall back to structured logs',
      );
      return;
    }

    let instrumentations: unknown[] = [];
    try {
      const autoMod = (await import('@opentelemetry/auto-instrumentations-node' as string).catch(
        () => null,
      )) as unknown as {
        getNodeAutoInstrumentations: (opts: unknown) => unknown[];
      } | null;
      if (autoMod?.getNodeAutoInstrumentations) {
        instrumentations = autoMod.getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-http': { enabled: true },
          '@opentelemetry/instrumentation-pg': { enabled: true },
          '@opentelemetry/instrumentation-ioredis': { enabled: true },
          '@opentelemetry/instrumentation-fastify': { enabled: true },
        });
      }
    } catch {
      // ignore
    }

    let traceExporter: unknown = undefined;
    try {
      const expMod = (await import('@opentelemetry/exporter-trace-otlp-http' as string).catch(
        () => null,
      )) as unknown as {
        OTLPTraceExporter: new (opts: unknown) => unknown;
      } | null;
      if (expMod?.OTLPTraceExporter) {
        traceExporter = new expMod.OTLPTraceExporter({
          url: endpoint.endsWith('/v1/traces')
            ? endpoint
            : `${endpoint.replace(/\/$/, '')}/v1/traces`,
        });
      }
    } catch {
      // ignore
    }

    const { Resource } = (await import('@opentelemetry/resources' as string).catch(() => ({
      Resource: null,
    }))) as unknown as {
      Resource: new (opts: unknown) => unknown;
    };
    const semconv = (await import('@opentelemetry/semantic-conventions' as string).catch(
      () => null,
    )) as unknown as {
      SEMRESATTRS_SERVICE_NAME?: string;
    } | null;

    const resource =
      Resource && semconv?.SEMRESATTRS_SERVICE_NAME
        ? new Resource({ [semconv.SEMRESATTRS_SERVICE_NAME]: currentServiceName })
        : undefined;

    const sdk = new sdkModule.NodeSDK({
      ...(resource ? { resource } : {}),
      traceExporter: traceExporter as never,
      instrumentations,
      // The sampler is only passed when the SDK package is present; otherwise
      // the OTel default (ParentBased AlwaysOn) would silently override us.
      ...(sampler ? { sampler } : {}),
    });

    sdk.start();
    try {
      const api = (await import('@opentelemetry/api' as string).catch(() => null)) as unknown as {
        trace?: { getTracer: (name: string) => OtelTracerLike };
      } | null;
      if (api?.trace?.getTracer) configureTracer(api.trace.getTracer(currentServiceName));
    } catch {
      // ignore
    }
    logger.info(
      {
        service: currentServiceName,
        endpoint,
        sampling: sampleRatio,
        sampler: sampler ? 'ratio' : 'none',
      },
      'OTEL tracing initialized',
    );

    const shutdown = async () => {
      try {
        await sdk.shutdown();
        logger.info('OTEL tracing shutdown');
      } catch (e) {
        logger.error({ err: e }, 'OTEL shutdown error');
      }
    };
    globalThis.process?.once?.('SIGTERM', () => void shutdown());
    globalThis.process?.once?.('SIGINT', () => void shutdown());
  } catch (error) {
    logger.error({ err: error, endpoint, sampling: sampleRatio }, 'failed to init OTEL');
  }
}

function emitFallbackSpanLog(level: 'debug', data: Record<string, unknown>, message: string): void {
  logger[level](data, message);
}

/**
 * Execute `fn` inside a span. When an OTel tracer is configured this creates a
 * real span (parent/child, attributes and status). Without the SDK it degrades
 * to correlation propagation plus debug-level logs; it never pretends to
 * create a span.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: {
    traceId: string;
    spanId: string;
    end: (attrs?: Record<string, unknown>) => void;
  }) => Promise<T>,
  opts: { attributes?: Record<string, unknown>; parentContext?: CorrelationContext } = {},
): Promise<T> {
  const parent = opts.parentContext ?? getCorrelation();
  const traceId = parent?.traceId ?? generateTraceId();
  const spanId = generateSpanId();
  const start = Date.now();

  const nextCtx: CorrelationContext = {
    requestId: parent?.requestId ?? traceId.slice(0, 8),
    traceId,
    ...(parent?.tenantId ? { tenantId: parent.tenantId } : {}),
    ...(parent?.userId ? { userId: parent.userId } : {}),
    ...(parent?.sampled !== undefined ? { sampled: parent.sampled } : {}),
    parentSpanId: spanId,
  };

  return runWithCorrelation(nextCtx, async () => {
    const attributes = { ...(opts.attributes ?? {}) };
    if (activeTracer) {
      return new Promise<T>((resolve, reject) => {
        activeTracer?.startActiveSpan(name, { attributes }, (otelSpan) => {
          let ended = false;
          const end = (attrs?: Record<string, unknown>) => {
            if (ended) return;
            ended = true;
            for (const [key, value] of Object.entries(attrs ?? {})) {
              otelSpan.setAttribute?.(key, value as never);
            }
            otelSpan.end();
          };
          const span = { traceId, spanId, end };
          fn(span)
            .then((result) => {
              end({ 'span.outcome': 'ok' });
              resolve(result);
            })
            .catch((error: unknown) => {
              try {
                otelSpan.recordException?.(error);
                otelSpan.setStatus?.({
                  code: 2,
                  message: error instanceof Error ? error.message : String(error),
                });
              } catch {
                // ignore instrumentation failures
              }
              end({ 'span.outcome': 'error' });
              reject(error);
            });
        });
      });
    }

    const span = {
      traceId,
      spanId,
      end: (attrs?: Record<string, unknown>) => {
        emitFallbackSpanLog(
          'debug',
          {
            span: name,
            traceId,
            spanId,
            durationMs: Date.now() - start,
            otel: false,
            ...attributes,
            ...(attrs ?? {}),
          },
          `span ${name} completed (no OTel SDK)`,
        );
      },
    };
    try {
      const result = await fn(span);
      span.end({ status: 'ok' });
      return result;
    } catch (error) {
      span.end({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

/**
 * Get active traceId for correlation (for logs/metrics)
 */
export function getActiveTraceId(): string | undefined {
  return getCorrelation()?.traceId;
}

/**
 * Hash helper for tests
 */
export function spanHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
