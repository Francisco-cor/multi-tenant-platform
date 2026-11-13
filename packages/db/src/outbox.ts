import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from './database.js';

export interface OutboxEvent {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: string;
  payloadVersion: number;
  status: string;
  attempts: number;
  nextAttemptAt: number;
  correlationId: string | null;
  createdAt: number;
}

export interface OutboxWriteInput {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  correlationId?: string | undefined;
  payloadVersion?: number | undefined;
  /** Explicit producer idempotency key; defaults to deterministicDedupeKey(input). */
  dedupeKey?: string | undefined;
}

/**
 * BullMQ job id. The event id must be part of the identity: two legitimate
 * `inventory.adjusted` events for the same aggregate are distinct jobs, and a
 * job id derived only from (tenant, aggregate, type) makes BullMQ silently drop
 * the second one.
 *
 * The 3-argument form is kept for callers that genuinely have no event id;
 * pass `eventId` whenever the outbox row id is available.
 */
export function deterministicJobId(
  tenantId: string,
  aggregateId: string,
  eventType: string,
  eventId?: string,
): string {
  const identity = eventId
    ? `${tenantId}:${aggregateId}:${eventType}:${eventId}`
    : `${tenantId}:${aggregateId}:${eventType}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function deterministicEventId(
  tenantId: string,
  aggregateId: string,
  eventType: string,
  payload: unknown,
): string {
  const normalized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256')
    .update(`${tenantId}:${aggregateId}:${eventType}:${normalized}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Producer-side dedupe key stored on `outbox_events.dedupe_key`. Distinct from
 * the job id: it collapses retries of the *same* business event, not two
 * different events of the same type.
 */
export function deterministicDedupeKey(input: {
  tenantId: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}): string {
  return deterministicEventId(input.tenantId, input.aggregateId, input.eventType, input.payload);
}

export async function writeOutboxEvent(
  tx: DatabaseExecutor,
  input: OutboxWriteInput,
): Promise<string> {
  const payloadStr =
    typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
  const dedupeKey = input.dedupeKey ?? deterministicDedupeKey(input);
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into outbox_events (
      tenant_id, aggregate_type, aggregate_id, event_type, payload,
      payload_version, correlation_id, dedupe_key
    )
    values (
      ${input.tenantId}::uuid, ${input.aggregateType}, ${input.aggregateId}::uuid,
      ${input.eventType}, ${payloadStr}::jsonb, ${input.payloadVersion ?? 1},
      ${input.correlationId ?? null}, ${dedupeKey}
    )
    on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing
    returning id
  `);

  let eventId = inserted[0]?.id;
  if (!eventId) {
    // Retried producer call: the event already exists, so the fan-out below
    // already ran in the original transaction. Reuse its id.
    const existing = await tx.execute<{ id: string }>(sql`
      select id from outbox_events
      where tenant_id = ${input.tenantId}::uuid and dedupe_key = ${dedupeKey}
      limit 1
    `);
    eventId = existing[0]?.id;
    if (!eventId) throw new Error('outbox_write_failed');
    return eventId;
  }

  // Fan out while the business transaction is still open. This makes webhook
  // creation durable with the event itself and avoids relying on an
  // eventually-running worker to discover subscriptions after the fact.
  await tx.execute(sql`
    insert into webhook_deliveries (
      tenant_id, endpoint_id, delivery_key, event_id, event_type, payload, secret_version, status, attempts, next_attempt_at
    )
    select
      ${input.tenantId}::uuid,
      endpoint.id,
      ${eventId},
      ${eventId},
      ${input.eventType},
      ${payloadStr}::jsonb,
      endpoint.secret_version,
      'pending',
      0,
      now()
    from webhook_endpoints endpoint
    where endpoint.tenant_id=${input.tenantId}::uuid
      and endpoint.status='active'
      and (
        endpoint.events ? ${input.eventType}
        or endpoint.events ? '*'
        or endpoint.events ? 'generic'
      )
    on conflict (endpoint_id, delivery_key) do nothing
  `);
  return eventId;
}

export function nextAttemptDelayMs(
  attempts: number,
  baseMs = 1000,
  maxMs = 60000,
  jitter = 0.2,
): number {
  // attempts is 0-indexed: first retry after baseMs, second 2*baseMs, etc. Cap at maxMs.
  const exp = baseMs * Math.pow(2, attempts);
  const capped = Math.min(exp, maxMs);
  const jitterRange = capped * jitter;
  const delta = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + delta));
}

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
  durationMs: number;
}

export interface QueuePublisher {
  add(queue: string, jobId: string, data: unknown, opts?: { delay?: number }): Promise<void>;
}
