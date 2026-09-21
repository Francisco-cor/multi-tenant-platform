import type { DatabaseHandle } from '@platform/db';
import { metrics } from '@platform/observability';
import { deliverWebhook } from './jobs/deliverWebhook.js';
import { processPayment } from './jobs/processPayment.js';
import { FakePaymentProvider } from './providers/fakePaymentProvider.js';
import { processJob } from './processor.js';
import type { JobPayload, QueueName, QueueProcessor } from './queues.js';

function payloadRecord(payload: JobPayload): Record<string, unknown> {
  return payload.payload && typeof payload.payload === 'object'
    ? (payload.payload as Record<string, unknown>)
    : {};
}

/** Build the single entrypoint used by every BullMQ consumer. */
export function createWorkerProcessor(db: DatabaseHandle): QueueProcessor {
  const paymentProvider =
    process.env.PAYMENT_PROVIDER === 'fake'
      ? new FakePaymentProvider({ mode: 'deterministic' })
      : null;

  return async (queue: QueueName, payload: JobPayload, jobId: string) =>
    processJob(db, jobId, payload, {
      queue,
      handler: async (jobPayload) => {
        const inner = payloadRecord(jobPayload);
        if (jobPayload.eventType === 'webhook.replayed') {
          const deliveryId = typeof inner.deliveryId === 'string' ? inner.deliveryId : null;
          if (!deliveryId) throw new Error('webhook_delivery_id_required');
          return deliverWebhook(db, deliveryId, jobPayload.tenantId);
        }
        if (jobPayload.eventType === 'payment.created') {
          if (!paymentProvider) throw new Error('payment_provider_not_configured');
          return processPayment(db, jobPayload, paymentProvider);
        }
        metrics.recordJobDuration(queue, 0);
        return { acknowledged: true, eventType: jobPayload.eventType };
      },
    });
}
