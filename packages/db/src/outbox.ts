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
}

export function deterministicJobId(
  tenantId: string,
  aggregateId: string,
  eventType: string,
): string {
  return createHash('sha256')
    .update(`${tenantId}:${aggregateId}:${eventType}`)
    .digest('hex')
    .slice(0, 32);
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

export async function writeOutboxEvent(
  tx: DatabaseExecutor,
  input: OutboxWriteInput,
): Promise<string> {
  const payloadStr =
    typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
  const rows = await tx.execute<{ id: string }>(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, payload_version, correlation_id)
    values (${input.tenantId}::uuid, ${input.aggregateType}, ${input.aggregateId}::uuid, ${input.eventType}, ${payloadStr}::jsonb, ${input.payloadVersion ?? 1}, ${input.correlationId ?? null})
    returning id
  `);
  const row = rows[0];
  if (!row) throw new Error('outbox_write_failed');

  // Fan out while the business transaction is still open. This makes webhook
  // creation durable with the event itself and avoids relying on an
  // eventually-running worker to discover subscriptions after the fact.
  await tx.execute(sql`
    insert into webhook_deliveries (
      tenant_id, endpoint_id, event_id, event_type, payload, status, attempts, next_attempt_at
    )
    select
      ${input.tenantId}::uuid,
      endpoint.id,
      ${row.id},
      ${input.eventType},
      ${payloadStr}::jsonb,
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
    on conflict (endpoint_id, event_id) do nothing
  `);
  return row.id;
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
