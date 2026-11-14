import { z } from 'zod';
import type { OrderStatus } from '@platform/domain';

export const EVENT_CONTRACT_VERSION = 1 as const;

export const EVENT_CONTRACTS = {
  'file.created': { payloadVersions: [1], effect: 'ack' },
  'inventory.reserved': { payloadVersions: [1], effect: 'ack' },
  'order.created': { payloadVersions: [1], effect: 'ack' },
  'order.paid': { payloadVersions: [1], effect: 'ack' },
  'order.failed': { payloadVersions: [1], effect: 'ack' },
  'order.reconciled_paid': { payloadVersions: [1], effect: 'ack' },
  'payment.created': { payloadVersions: [1], effect: 'process' },
  'payment.paid': { payloadVersions: [1], effect: 'ack' },
  'payment.failed': { payloadVersions: [1], effect: 'ack' },
  'payment.unknown': { payloadVersions: [1], effect: 'ack' },
  'payment.webhook_paid': { payloadVersions: [1], effect: 'ack' },
  'payment.webhook_failed': { payloadVersions: [1], effect: 'ack' },
  'payment.webhook_unknown': { payloadVersions: [1], effect: 'ack' },
  'payment.reconciled_paid': { payloadVersions: [1], effect: 'ack' },
  'payment.reconciled_failed': { payloadVersions: [1], effect: 'ack' },
  'payment.reconciled_unknown': { payloadVersions: [1], effect: 'ack' },
  'payment.paid_after_failure': { payloadVersions: [1], effect: 'ack' },
  'payment.reconciliation_required': { payloadVersions: [1], effect: 'process' },
  'order.paid_after_failure': { payloadVersions: [1], effect: 'ack' },
  'webhook.created': { payloadVersions: [1], effect: 'ack' },
  'webhook.secret_rotated': { payloadVersions: [1], effect: 'ack' },
  'webhook.replayed': { payloadVersions: [1], effect: 'process' },
} as const;

export type PlatformEventType = keyof typeof EVENT_CONTRACTS;
export type EventContract = (typeof EVENT_CONTRACTS)[PlatformEventType];

const id = z.string().min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const amountCents = z.number().int().nonnegative();

/** Payload objects stay open to additive fields, but required fields and units are enforced. */
function loose<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, 'passthrough'> {
  return z.object(shape).passthrough();
}

const ORDER_ID = { orderId: id };
const ATTEMPT_ID = { attemptId: id };

export const EVENT_PAYLOAD_SCHEMAS: {
  [K in PlatformEventType]: Record<EventContract['payloadVersions'][number], z.ZodTypeAny>;
} = {
  'file.created': {
    1: loose({
      fileId: id,
      filename: z.string().min(1).max(512).optional(),
      contentType: z.string().min(1).max(255).optional(),
      size: z.number().int().nonnegative().optional(),
    }),
  },
  'inventory.reserved': {
    1: loose({
      reservationId: id,
      productId: id,
      quantity: z.number().int().positive(),
    }),
  },
  'order.created': {
    1: loose({
      ...ORDER_ID,
      branchId: id.optional(),
      amountCents,
      currency: currency.optional(),
      paymentAttemptId: id.optional(),
      providerKey: z.string().min(1).max(64).optional(),
    }),
  },
  'order.paid': {
    1: loose({
      ...ORDER_ID,
      ...ATTEMPT_ID,
      providerRef: z.string().min(1).max(255).optional(),
      amountCents: amountCents.optional(),
    }),
  },
  'order.failed': {
    1: loose({
      ...ORDER_ID,
      attemptId: id.optional(),
      reason: z.string().max(2_000).optional(),
    }),
  },
  'order.reconciled_paid': {
    1: loose({
      ...ORDER_ID,
      attemptId: id.optional(),
      amountCents: amountCents.optional(),
    }),
  },
  'payment.created': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerKey: z.string().min(1).max(64).optional(),
      amountCents,
    }),
  },
  'payment.paid': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      amountCents: amountCents.optional(),
    }),
  },
  'payment.failed': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      reason: z.string().max(2_000).optional(),
    }),
  },
  'payment.unknown': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
    }),
  },
  'payment.webhook_paid': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      eventId: id.optional(),
    }),
  },
  'payment.webhook_failed': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      eventId: id.optional(),
    }),
  },
  'payment.webhook_unknown': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      eventId: id.optional(),
    }),
  },
  'payment.reconciled_paid': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerKey: z.string().min(1).max(64).optional(),
      providerRef: z.string().min(1).max(255).optional(),
      status: z.string().min(1).max(40).optional(),
    }),
  },
  'payment.reconciled_failed': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerKey: z.string().min(1).max(64).optional(),
      providerRef: z.string().min(1).max(255).optional(),
      status: z.string().min(1).max(40).optional(),
    }),
  },
  'payment.reconciled_unknown': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerKey: z.string().min(1).max(64).optional(),
      status: z.string().min(1).max(40).optional(),
    }),
  },
  'payment.paid_after_failure': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      compensating: z.boolean().optional(),
    }),
  },
  'payment.reconciliation_required': {
    1: loose({
      ...ATTEMPT_ID,
      ...ORDER_ID,
      providerRef: z.string().min(1).max(255).optional(),
      reason: z.string().min(1).max(200),
    }),
  },
  'order.paid_after_failure': {
    1: loose({
      ...ORDER_ID,
      ...ATTEMPT_ID,
      providerRef: z.string().min(1).max(255).optional(),
      compensating: z.boolean().optional(),
    }),
  },
  'webhook.created': {
    1: loose({
      endpointId: id,
      url: z.string().url().max(2_048),
      events: z.array(z.string().min(1).max(80)).max(100).optional(),
    }),
  },
  'webhook.secret_rotated': {
    1: loose({
      endpointId: id,
      version: z.number().int().positive(),
    }),
  },
  'webhook.replayed': {
    1: loose({
      deliveryId: id,
      endpointId: id.optional(),
      eventId: id.optional(),
    }),
  },
};

export const EventEnvelopeSchema = z
  .object({
    eventType: z.string().min(3).max(80),
    payloadVersion: z.number().int().positive().default(EVENT_CONTRACT_VERSION),
    payload: z.unknown(),
  })
  .strict();

export function getEventContract(eventType: string): EventContract | null {
  return (EVENT_CONTRACTS as Record<string, EventContract>)[eventType] ?? null;
}

export function getEventPayloadSchema(
  eventType: string,
  payloadVersion: number,
): z.ZodTypeAny | null {
  const schemas = (EVENT_PAYLOAD_SCHEMAS as Record<string, Record<number, z.ZodTypeAny>>)[
    eventType
  ];
  return schemas?.[payloadVersion] ?? null;
}

export function supportsEventPayloadVersion(eventType: string, payloadVersion: number): boolean {
  const contract = getEventContract(eventType);
  return contract?.payloadVersions.includes(payloadVersion as never) ?? false;
}

export function validateEventEnvelope(input: unknown): z.infer<typeof EventEnvelopeSchema> {
  const envelope = EventEnvelopeSchema.parse(input);
  if (!getEventContract(envelope.eventType)) {
    throw new Error(`event_handler_not_registered:${envelope.eventType}`);
  }
  if (!supportsEventPayloadVersion(envelope.eventType, envelope.payloadVersion)) {
    throw new Error(
      `event_payload_version_unsupported:${envelope.eventType}:${envelope.payloadVersion}`,
    );
  }
  const payloadSchema = getEventPayloadSchema(envelope.eventType, envelope.payloadVersion);
  if (!payloadSchema) {
    throw new Error(
      `event_payload_schema_missing:${envelope.eventType}:${envelope.payloadVersion}`,
    );
  }
  const result = payloadSchema.safeParse(envelope.payload);
  if (!result.success) {
    throw new Error(
      `event_payload_invalid:${envelope.eventType}:${envelope.payloadVersion}:${result.error.issues[0]?.path.join('.') ?? 'payload'}`,
    );
  }
  return envelope;
}

export const PLATFORM_EVENT_TYPES = Object.keys(EVENT_CONTRACTS) as PlatformEventType[];

/**
 * Automation triggers were historically a separate catalogue. `file.ready` is
 * still accepted from stored automations but maps to the only event that is
 * actually emitted (`file.created`); unknown triggers resolve to `null`.
 */
export const AUTOMATION_TRIGGER_EVENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'file.ready': 'file.created',
});

export function resolveAutomationEventType(trigger: string): PlatformEventType | null {
  const canonical = AUTOMATION_TRIGGER_EVENT_ALIASES[trigger] ?? trigger;
  return getEventContract(canonical) ? (canonical as PlatformEventType) : null;
}

export function isAutomationTriggerForEvent(trigger: string, eventType: string): boolean {
  return resolveAutomationEventType(trigger) === eventType;
}

/**
 * Canonical order state -> emitted outbox event. `null` means the state is
 * terminal/internal and intentionally emits no domain event. Kept here so the
 * wire contract and the domain state machine cannot drift silently.
 *
 * Domain follow-up: `ORDER_STATUSES` currently has no `refunded`/`expired`
 * state, and `order.created` doubles as the `pending_payment` transition.
 * Adding those states requires updating `packages/domain` first.
 */
export const ORDER_STATUS_EVENTS: Readonly<Record<OrderStatus, PlatformEventType | null>> =
  Object.freeze({
    draft: null,
    pending_payment: 'order.created',
    paid: 'order.paid',
    processing: null,
    completed: null,
    cancelled: null,
    failed: 'order.failed',
  });

export function orderEventForStatus(status: OrderStatus): PlatformEventType | null {
  return ORDER_STATUS_EVENTS[status];
}
