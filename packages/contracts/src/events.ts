import { z } from 'zod';

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
  'webhook.created': { payloadVersions: [1], effect: 'ack' },
  'webhook.secret_rotated': { payloadVersions: [1], effect: 'ack' },
  'webhook.replayed': { payloadVersions: [1], effect: 'process' },
} as const;

export type PlatformEventType = keyof typeof EVENT_CONTRACTS;
export type EventContract = (typeof EVENT_CONTRACTS)[PlatformEventType];

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
  return envelope;
}
