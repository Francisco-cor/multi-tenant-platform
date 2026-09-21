import { describe, expect, it } from 'vitest';
import { isRegisteredEventType } from './consumer.js';

describe('worker event registry', () => {
  it('covers events emitted by the API and payment jobs', () => {
    expect(isRegisteredEventType('file.created')).toBe(true);
    expect(isRegisteredEventType('payment.created')).toBe(true);
    expect(isRegisteredEventType('payment.reconciled_paid')).toBe(true);
    expect(isRegisteredEventType('webhook.replayed')).toBe(true);
  });

  it('rejects an event without an explicit handler/ack policy', () => {
    expect(isRegisteredEventType('inventory.rebuild_requested')).toBe(false);
    expect(isRegisteredEventType('unknown.event')).toBe(false);
  });
});
