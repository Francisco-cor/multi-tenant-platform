import { describe, expect, it } from 'vitest';
import {
  correlationHeaders,
  extractCorrelation,
  getCorrelation,
  runWithCorrelation,
  sanitizeRequestId,
  setCorrelationPatch,
  enterCorrelation,
} from './correlation.js';
import { buildTraceparent, parseTraceparent } from './tracing.js';

const VALID_TRACE = '0123456789abcdef0123456789abcdef';
const VALID_SPAN = '0123456789abcdef';

describe('correlation hardening', () => {
  it('ignores oversized or non-hex client trace ids and mints a server trace id', () => {
    const ctx = extractCorrelation({ 'x-trace-id': 'z'.repeat(8_000) }, 'req-1');
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(ctx.requestId).toBe('req-1');
    expect(ctx.traceId).not.toBe('z'.repeat(32));
  });

  it('prefers traceparent over the custom x-trace-id header', () => {
    const ctx = extractCorrelation(
      {
        traceparent: `00-${VALID_TRACE}-${VALID_SPAN}-01`,
        'x-trace-id': 'f'.repeat(32),
      },
      'req-1',
    );
    expect(ctx.traceId).toBe(VALID_TRACE);
    expect(ctx.parentSpanId).toBe(VALID_SPAN);
    expect(ctx.sampled).toBe(true);
  });

  it('rejects malformed traceparent values', () => {
    for (const value of [
      `00-${'0'.repeat(32)}-${VALID_SPAN}-01`,
      `00-${VALID_TRACE}-${'0'.repeat(16)}-01`,
      '00-nothex-0000000000000000-01',
      'garbage',
    ]) {
      const ctx = extractCorrelation({ traceparent: value }, 'req-1');
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/u);
      expect(ctx.parentSpanId).toBeUndefined();
    }
  });

  it('sanitises request ids and caps their length', () => {
    expect(sanitizeRequestId('req-123:abc')).toBe('req-123:abc');
    expect(sanitizeRequestId('bad id with spaces')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(sanitizeRequestId('x'.repeat(1_000)).length).toBeLessThanOrEqual(128);
  });

  it('emits a valid traceparent with a non-zero span id and the sampled flag', () => {
    const headers = correlationHeaders({ requestId: 'req-1', traceId: VALID_TRACE });
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u);
    expect(headers.traceparent).not.toContain('0000000000000000-');
    expect(
      correlationHeaders({ requestId: 'req-1', traceId: VALID_TRACE, sampled: false }).traceparent,
    ).toMatch(/-00$/u);
  });

  it('rejects invalid ids when building traceparent', () => {
    expect(() => buildTraceparent('nothex')).toThrow('traceparent_invalid_trace_id');
    expect(() => buildTraceparent(VALID_TRACE, '0'.repeat(16))).toThrow(
      'traceparent_invalid_span_id',
    );
    expect(parseTraceparent(`00-${VALID_TRACE}-${VALID_SPAN}-01`)).not.toBeNull();
  });

  it('isolates concurrent correlation scopes', async () => {
    const observed: Array<{ tenantHash: string | undefined; traceId: string | undefined }> = [];
    await Promise.all(
      ['tenant-a', 'tenant-b'].map((tenantId, index) =>
        runWithCorrelation(
          { requestId: `req-${index}`, traceId: VALID_TRACE, tenantId },
          async () => {
            await Promise.resolve();
            const first = getCorrelation();
            await Promise.resolve();
            observed.push({
              tenantHash: first?.tenantHash,
              traceId: first?.traceId,
            });
            expect(getCorrelation()?.tenantId).toBe(tenantId);
          },
        ),
      ),
    );
    expect(observed).toHaveLength(2);
    expect(observed[0]?.tenantHash).not.toBe(observed[1]?.tenantHash);
  });

  it('never mutates a previously captured context when patching', async () => {
    await runWithCorrelation({ requestId: 'req-1', tenantId: 'tenant-a' }, async () => {
      const before = getCorrelation();
      expect(before?.tenantId).toBe('tenant-a');
      setCorrelationPatch({ tenantId: 'tenant-b' });
      expect(before?.tenantId).toBe('tenant-a');
      expect(getCorrelation()?.tenantId).toBe('tenant-b');
      expect(Object.isFrozen(before)).toBe(true);
    });
  });

  it('freezes contexts installed with enterCorrelation', () => {
    enterCorrelation({ requestId: 'req-enter', tenantId: 'tenant-a' });
    const ctx = getCorrelation();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as { tenantId?: string }).tenantId = 'tenant-b';
    }).toThrow();
  });
});
