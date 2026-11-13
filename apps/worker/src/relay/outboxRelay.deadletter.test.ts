import { describe, expect, it } from 'vitest';
import { OUTBOX_CHUNK_SIZE, redriveDeadLetterEvents, runOutboxRelayOnce } from './outboxRelay.js';
import type { JobPayload, QueueAdapter, QueueFactory } from '../queues.js';
import { createFakeDatabase } from '../testing/fakeDatabase.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const aggregateId = '22222222-2222-2222-2222-222222222222';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    tenant_id: tenantId,
    aggregate_type: 'order',
    aggregate_id: aggregateId,
    event_type: 'order.paid',
    payload_version: 1,
    payload: '{"orderId":"o-1"}',
    attempts: 0,
    correlation_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function rejectingQueue(): { factory: QueueFactory; added: JobPayload[] } {
  const added: JobPayload[] = [];
  const adapter: QueueAdapter = {
    name: 'orders',
    async add(payload) {
      added.push(payload);
      throw new Error('redis_connection_refused');
    },
    async remove() {
      return false;
    },
    async close() {
      return undefined;
    },
  };
  return {
    added,
    factory: {
      getQueue: () => adapter,
      closeAll: async () => undefined,
    },
  };
}

function acceptingQueue(): {
  factory: QueueFactory;
  added: JobPayload[];
  jobIds: string[];
} {
  const added: JobPayload[] = [];
  const jobIds: string[] = [];
  const adapter: QueueAdapter = {
    name: 'orders',
    async add(payload, opts) {
      added.push(payload);
      jobIds.push(opts?.jobId ?? 'missing');
      return { jobId: opts?.jobId ?? 'x', accepted: true };
    },
    async remove() {
      return false;
    },
    async close() {
      return undefined;
    },
  };
  return {
    added,
    jobIds,
    factory: { getQueue: () => adapter, closeAll: async () => undefined },
  };
}

function relayDatabase(rows: unknown[]) {
  let served = false;
  return createFakeDatabase(({ text }) => {
    if (text.includes('select') && text.includes('from outbox_events')) {
      if (served) return [];
      served = true;
      return rows;
    }
    return [];
  });
}

describe('outbox relay failure policy', () => {
  it('keeps retrying a young event during a Redis outage instead of dead-lettering it (P1-3)', async () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const fake = relayDatabase([
      event({
        attempts: 4,
        created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const queue = rejectingQueue();

    const result = await runOutboxRelayOnce(fake.handle, {
      queueFactory: queue.factory,
      now: () => now,
    });

    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
    const update = fake.queries.find((q) => q.includes('update outbox_events'));
    expect(update).toContain("status = 'pending'");
    expect(fake.queries.some((q) => q.includes('insert into dlq_jobs'))).toBe(false);
  });

  it('dead-letters only after the age threshold and repeated attempts', async () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const fake = relayDatabase([
      event({
        attempts: 5,
        created_at: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const queue = rejectingQueue();

    const result = await runOutboxRelayOnce(fake.handle, {
      queueFactory: queue.factory,
      now: () => now,
    });

    expect(result.deadLettered).toBe(1);
    expect(fake.queries.some((q) => q.includes("status = 'dead_letter'"))).toBe(true);
    expect(fake.queries.some((q) => q.includes('insert into dlq_jobs'))).toBe(true);
  });

  it('isolates a poison payload to its own row', async () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const fake = relayDatabase([
      event({ id: 'poison-event', payload: 'not-json' }),
      event({ id: 'good-event', payload: '{"orderId":"o-2"}' }),
    ]);
    const queue = acceptingQueue();

    const result = await runOutboxRelayOnce(fake.handle, {
      queueFactory: queue.factory,
      now: () => now,
    });

    expect(result.claimed).toBe(2);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(1);
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0]?.eventId).toBe('good-event');
    expect(OUTBOX_CHUNK_SIZE).toBeGreaterThan(0);
  });

  it('gives distinct events of the same aggregate and type distinct job ids (P2-3)', async () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const fake = relayDatabase([event({ id: 'event-a' }), event({ id: 'event-b' })]);
    const queue = acceptingQueue();

    await runOutboxRelayOnce(fake.handle, { queueFactory: queue.factory, now: () => now });
    expect(queue.added).toHaveLength(2);
    expect(queue.jobIds[0]).not.toBe(queue.jobIds[1]);
    expect(queue.added[0]?.eventId).not.toBe(queue.added[1]?.eventId);
  });

  it('re-drives dead-letter events back to pending and marks their DLQ rows (P1-3)', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('update outbox_events') && text.includes('returning')) {
        return [
          {
            id: 'event-dead',
            tenant_id: tenantId,
            aggregate_type: 'order',
            aggregate_id: aggregateId,
            event_type: 'order.paid',
          },
        ];
      }
      return [];
    });

    const result = await redriveDeadLetterEvents(fake.handle, {
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(result.redriven).toBe(1);
    expect(result.ids).toEqual(['event-dead']);
    const redrive = fake.queries.find((q) => q.includes('update outbox_events'));
    expect(redrive).toContain("status = 'pending'");
    expect(fake.queries.some((q) => q.includes('update dlq_jobs'))).toBe(true);
  });
});
