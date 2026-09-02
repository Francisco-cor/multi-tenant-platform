import { createHash, randomBytes } from 'node:crypto';
import { getCorrelation, runWithCorrelation, type CorrelationContext } from './correlation.js';
import { createLogger } from './logger.js';

const logger = createLogger({ service: 'tracing' });

export interface TracingOptions {
  serviceName?: string;
  exporterEndpoint?: string;
  sampleRatio?: number; // 0-1, default 0.1 prod 1 dev
}

let tracingInitialized = false;
let currentServiceName = 'api';

/**
 * Generate OTel-compatible traceId (32 hex chars)
 */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generate spanId (16 hex chars)
 */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Build W3C traceparent header from correlation
 */
export function buildTraceparent(traceId: string, spanId?: string, sampled = true): string {
  const tid = traceId.padStart(32, '0').slice(-32);
  const sid = (spanId ?? generateSpanId()).padStart(16, '0').slice(-16);
  const flags = sampled ? '01' : '00';
  return `00-${tid}-${sid}-${flags}`;
}

export function parseTraceparent(
  header: string,
): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = header.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return {
    traceId: m[1].toLowerCase(),
    spanId: m[2].toLowerCase(),
    sampled: m[3] === '01',
  };
}

/**
 * Initialize tracing SDK.
 * If OTEL_EXPORTER_OTLP_ENDPOINT is set, tries to load @opentelemetry/sdk-node dynamically.
 * Falls back to lightweight console instrumentation if not available.
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

  const sampleRatio =
    options.sampleRatio ??
    (process.env.OTEL_TRACES_SAMPLER_ARG
      ? Number(process.env.OTEL_TRACES_SAMPLER_ARG)
      : process.env.NODE_ENV === 'production'
        ? 0.1
        : 1);

  // If no endpoint, use lightweight logger tracing (still propagates correlation)
  if (!endpoint) {
    logger.info(
      {
        service: currentServiceName,
        sampling: sampleRatio,
        exporter: 'console',
      },
      'tracing initialized (console, no OTLP endpoint)',
    );
    return;
  }

  // Try to load OTel SDK dynamically; if not installed, fallback to console
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
        { endpoint },
        'OTEL SDK not installed, falling back to console tracing. Install @opentelemetry/sdk-node for full tracing',
      );
      return;
    }

    // Lazy load instrumentations if available
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
    });

    sdk.start();
    logger.info(
      { service: currentServiceName, endpoint, sampling: sampleRatio },
      'OTEL tracing initialized',
    );

    // graceful shutdown
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
    logger.error({ err: error, endpoint }, 'failed to init OTEL, fallback to console');
  }
}

/**
 * Execute fn within a span context, automatically creates traceId/spanId if missing.
 * For lightweight mode, just enriches correlation and logs start/end.
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

  const span = {
    traceId,
    spanId,
    end: (attrs?: Record<string, unknown>) => {
      const duration = Date.now() - start;
      logger.info(
        {
          span: name,
          traceId,
          spanId,
          durationMs: duration,
          tenantHash: parent?.tenantHash,
          ...(attrs ?? {}),
          ...opts.attributes,
        },
        `span ${name} completed`,
      );
    },
  };

  // run with correlation enriched
  const nextCtx: CorrelationContext = {
    requestId: parent?.requestId ?? traceId.slice(0, 8),
    traceId,
    ...(parent?.tenantId ? { tenantId: parent.tenantId } : {}),
    ...(parent?.userId ? { userId: parent.userId } : {}),
    parentSpanId: spanId,
  };

  return runWithCorrelation(nextCtx, async () => {
    logger.info(
      {
        span: name,
        traceId,
        spanId,
        parentTraceId: parent?.traceId,
        ...opts.attributes,
      },
      `span ${name} started`,
    );
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
