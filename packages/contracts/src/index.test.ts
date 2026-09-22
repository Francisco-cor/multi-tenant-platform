import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  CursorPageQuerySchema,
  EventEnvelopeSchema,
  getEventContract,
  OrganizationSchema,
  supportsEventPayloadVersion,
  validateEventEnvelope,
} from './index.js';

describe('HTTP contracts', () => {
  it('applies a safe default and upper bound to cursor pagination', () => {
    expect(CursorPageQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(() => CursorPageQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it('rejects organization slugs that are not safe for subdomains', () => {
    expect(() =>
      OrganizationSchema.parse({ id: '1', slug: 'ACME', name: 'Acme', status: 'active' }),
    ).toThrow();
  });

  it('keeps request IDs in error responses', () => {
    expect(
      ApiErrorSchema.parse({
        error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req-123' },
      }).error.requestId,
    ).toBe('req-123');
  });

  it('keeps event versions explicit across API, relay and worker', () => {
    expect(getEventContract('payment.created')?.effect).toBe('process');
    expect(supportsEventPayloadVersion('order.paid', 1)).toBe(true);
    expect(supportsEventPayloadVersion('order.paid', 2)).toBe(false);
    expect(EventEnvelopeSchema.parse({ eventType: 'order.paid', payload: {} }).payloadVersion).toBe(
      1,
    );
    expect(() =>
      validateEventEnvelope({ eventType: 'order.paid', payloadVersion: 2, payload: {} }),
    ).toThrow('event_payload_version_unsupported');
    expect(getEventContract('unknown.event')).toBeNull();
  });
});
