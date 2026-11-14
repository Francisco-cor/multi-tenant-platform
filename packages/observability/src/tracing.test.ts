import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTraceparent,
  configureTracer,
  createTraceSampler,
  getActiveTraceId,
  parseTraceparent,
  resolveSampleRatio,
  withSpan,
} from './tracing.js';
import { getCorrelation } from './correlation.js';

interface FakeSpan {
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: number;
}

function fakeTracer() {
  const spans: FakeSpan[] = [];
  return {
    spans,
    tracer: {
      startActiveSpan: (
        _name: string,
        options: { attributes?: Record<string, unknown> },
        fn: (span: unknown) => void,
      ) => {
        const span: FakeSpan = { attributes: { ...(options.attributes ?? {}) }, ended: 0 };
        spans.push(span);
        fn({
          setAttribute: (key: string, value: unknown) => {
            span.attributes[key] = value;
          },
          setStatus: (status: { code: number; message?: string }) => {
            span.status = status;
          },
          recordException: () => undefined,
          end: () => {
            span.ended += 1;
          },
        });
      },
    },
  };
}

describe('tracing', () => {
  afterEach(() => configureTracer(null));

  it('resolves and clamps the sampling ratio', () => {
    expect(resolveSampleRatio(0)).toBe(0);
    expect(resolveSampleRatio(0.25)).toBe(0.25);
    expect(resolveSampleRatio(2)).toBe(1);
    expect(resolveSampleRatio(-1)).toBe(0);
    expect(resolveSampleRatio(Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('passes the effective ratio to the sampler factory', async () => {
    const factory = vi.fn((ratio: number) => ({ ratio }));
    const sampler = await createTraceSampler(0.1, factory);
    expect(sampler).toEqual({ ratio: 0.1 });
    expect(factory).toHaveBeenCalledWith(0.1);
  });

  it('builds and parses a valid traceparent', () => {
    const header = buildTraceparent('0123456789abcdef0123456789abcdef', undefined, false);
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/u);
    expect(header).not.toContain('-0000000000000000-');
    expect(parseTraceparent(header)?.sampled).toBe(false);
    expect(() => buildTraceparent('nothex')).toThrow('traceparent_invalid_trace_id');
  });

  it('creates exactly one real span and ends it with attributes', async () => {
    const { spans, tracer } = fakeTracer();
    configureTracer(tracer as never);
    const result = await withSpan(
      'orders.read',
      async (span) => {
        expect(span.traceId).toMatch(/^[0-9a-f]{32}$/u);
        expect(getCorrelation()?.traceId).toBe(span.traceId);
        return 'ok';
      },
      { attributes: { 'db.system': 'postgresql', rows: 3 } },
    );

    expect(result).toBe('ok');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.ended).toBe(1);
    expect(spans[0]?.attributes['db.system']).toBe('postgresql');
    expect(spans[0]?.attributes.rows).toBe(3);
    expect(spans[0]?.attributes['span.outcome']).toBe('ok');
  });

  it('records errors on the span and rethrows', async () => {
    const { spans, tracer } = fakeTracer();
    configureTracer(tracer as never);
    await expect(
      withSpan('orders.write', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status?.code).toBe(2);
    expect(spans[0]?.ended).toBe(1);
  });

  it('propagates correlation and returns values without an OTel SDK', async () => {
    configureTracer(null);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await withSpan(
      'fallback',
      async () => {
        expect(getActiveTraceId()).toMatch(/^[0-9a-f]{32}$/u);
        return 42;
      },
      { attributes: { queue: 'orders' } },
    );
    expect(result).toBe(42);
    spy.mockRestore();
  });
});
