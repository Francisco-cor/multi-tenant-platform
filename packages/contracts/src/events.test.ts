import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@platform/domain';
import {
  AUTOMATION_TRIGGER_EVENT_ALIASES,
  EVENT_CONTRACTS,
  EVENT_CONTRACT_VERSION,
  EVENT_PAYLOAD_SCHEMAS,
  EventEnvelopeSchema,
  ORDER_STATUS_EVENTS,
  PLATFORM_EVENT_TYPES,
  getEventPayloadSchema,
  isAutomationTriggerForEvent,
  orderEventForStatus,
  resolveAutomationEventType,
  supportsEventPayloadVersion,
  validateEventEnvelope,
} from './index.js';

/** Minimal valid payload per event, mirroring what API/worker actually emit. */
const MINIMAL_PAYLOADS: Record<string, unknown> = {
  'file.created': { fileId: 'file-1' },
  'inventory.reserved': { reservationId: 'res-1', productId: 'prod-1', quantity: 1 },
  'order.created': { orderId: 'order-1', amountCents: 1000 },
  'order.paid': { orderId: 'order-1', attemptId: 'attempt-1' },
  'order.failed': { orderId: 'order-1' },
  'order.reconciled_paid': { orderId: 'order-1' },
  'payment.created': { attemptId: 'attempt-1', orderId: 'order-1', amountCents: 1000 },
  'payment.paid': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.failed': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.unknown': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.webhook_paid': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.webhook_failed': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.webhook_unknown': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.reconciled_paid': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.reconciled_failed': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.reconciled_unknown': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.paid_after_failure': { attemptId: 'attempt-1', orderId: 'order-1' },
  'payment.reconciliation_required': {
    attemptId: 'attempt-1',
    orderId: 'order-1',
    reason: 'invalid_transition',
  },
  'order.paid_after_failure': { orderId: 'order-1', attemptId: 'attempt-1' },
  'webhook.created': { endpointId: 'endpoint-1', url: 'https://example.test/hook' },
  'webhook.secret_rotated': { endpointId: 'endpoint-1', version: 2 },
  'webhook.replayed': { deliveryId: 'delivery-1' },
};

describe('event catalog compatibility', () => {
  it('declares exactly one payload schema per supported version', () => {
    expect(Object.keys(MINIMAL_PAYLOADS).sort()).toEqual([...PLATFORM_EVENT_TYPES].sort());
    for (const eventType of PLATFORM_EVENT_TYPES) {
      const contract = EVENT_CONTRACTS[eventType];
      const schemas = EVENT_PAYLOAD_SCHEMAS[eventType];
      expect(Object.keys(schemas).map(Number).sort()).toEqual([...contract.payloadVersions].sort());
      for (const version of contract.payloadVersions) {
        expect(getEventPayloadSchema(eventType, version)).not.toBeNull();
      }
    }
  });

  it('accepts a minimal envelope for every event and version', () => {
    expect(EVENT_CONTRACT_VERSION).toBe(1);
    for (const eventType of PLATFORM_EVENT_TYPES) {
      const envelope = validateEventEnvelope({
        eventType,
        payloadVersion: 1,
        payload: MINIMAL_PAYLOADS[eventType],
      });
      expect(envelope.eventType).toBe(eventType);
      expect(envelope.payloadVersion).toBe(1);
    }
  });

  it('is additive-only: unknown fields survive at payload level', () => {
    const parsed = validateEventEnvelope({
      eventType: 'order.paid',
      payload: { orderId: 'order-1', attemptId: 'attempt-1', futureField: 'kept' },
    });
    expect((parsed.payload as Record<string, unknown>).futureField).toBe('kept');
  });

  it('rejects unsupported envelope fields, versions and unknown handlers', () => {
    expect(() =>
      EventEnvelopeSchema.parse({ eventType: 'order.paid', payload: {}, extra: true }),
    ).toThrow();
    expect(() =>
      validateEventEnvelope({ eventType: 'order.paid', payloadVersion: 2, payload: {} }),
    ).toThrow('event_payload_version_unsupported');
    expect(() => validateEventEnvelope({ eventType: 'not.registered', payload: {} })).toThrow(
      'event_handler_not_registered',
    );
    expect(supportsEventPayloadVersion('order.paid', 1)).toBe(true);
    expect(supportsEventPayloadVersion('order.paid', 99)).toBe(false);
    expect(getEventPayloadSchema('order.paid', 99)).toBeNull();
  });

  it('rejects payloads that drop required fields or break units', () => {
    expect(() => validateEventEnvelope({ eventType: 'order.paid', payload: {} })).toThrow(
      'event_payload_invalid',
    );
    expect(() =>
      validateEventEnvelope({
        eventType: 'inventory.reserved',
        payload: { reservationId: 'r', productId: 'p', quantity: 1.5 },
      }),
    ).toThrow('event_payload_invalid');
    expect(() =>
      validateEventEnvelope({
        eventType: 'order.created',
        payload: { orderId: 'o', amountCents: -1 },
      }),
    ).toThrow('event_payload_invalid');
    expect(() =>
      validateEventEnvelope({
        eventType: 'order.created',
        payload: { orderId: 'o', amountCents: 1, currency: 'usd' },
      }),
    ).toThrow('event_payload_invalid');
  });

  it('accepts the payload shapes emitted by the API and worker', () => {
    const emitted: Array<[string, Record<string, unknown>]> = [
      [
        'file.created',
        { fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 },
      ],
      ['inventory.reserved', { reservationId: 'r1', productId: 'p1', quantity: 2 }],
      [
        'order.created',
        {
          orderId: 'o1',
          branchId: 'b1',
          amountCents: 1500,
          currency: 'USD',
          paymentAttemptId: 'a1',
          providerKey: 'fake',
        },
      ],
      ['order.paid', { orderId: 'o1', attemptId: 'a1', providerRef: 'ref' }],
      [
        'payment.created',
        { attemptId: 'a1', orderId: 'o1', providerKey: 'fake', amountCents: 1500 },
      ],
      [
        'payment.reconciled_paid',
        { attemptId: 'a1', orderId: 'o1', providerKey: 'fake', providerRef: 'ref', status: 'paid' },
      ],
      ['order.reconciled_paid', { orderId: 'o1', attemptId: 'a1' }],
      [
        'webhook.created',
        { endpointId: 'e1', url: 'https://example.test/hook', events: ['file.created'] },
      ],
    ];
    for (const [eventType, payload] of emitted) {
      expect(() => validateEventEnvelope({ eventType, payload })).not.toThrow();
    }
  });
});

describe('automation trigger compatibility', () => {
  it('maps the legacy file.ready trigger to the emitted file.created event', () => {
    expect(AUTOMATION_TRIGGER_EVENT_ALIASES['file.ready']).toBe('file.created');
    expect(resolveAutomationEventType('file.ready')).toBe('file.created');
    expect(isAutomationTriggerForEvent('file.ready', 'file.created')).toBe(true);
    expect(isAutomationTriggerForEvent('file.ready', 'file.ready')).toBe(false);
  });

  it('keeps canonical triggers and rejects unknown ones', () => {
    expect(resolveAutomationEventType('order.paid')).toBe('order.paid');
    expect(resolveAutomationEventType('file.created')).toBe('file.created');
    expect(resolveAutomationEventType('made.up')).toBeNull();
  });
});

describe('order state contract', () => {
  it('covers every domain order status exactly once', () => {
    expect(Object.keys(ORDER_STATUS_EVENTS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('only maps states to events declared in the catalog', () => {
    for (const eventType of Object.values(ORDER_STATUS_EVENTS)) {
      if (eventType === null) continue;
      expect(EVENT_CONTRACTS[eventType]).toBeDefined();
    }
    expect(orderEventForStatus('paid')).toBe('order.paid');
    expect(orderEventForStatus('failed')).toBe('order.failed');
    expect(orderEventForStatus('pending_payment')).toBe('order.created');
    expect(orderEventForStatus('completed')).toBeNull();
  });
});
