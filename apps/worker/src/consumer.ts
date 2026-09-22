import type { DatabaseHandle } from '@platform/db';
import {
  EVENT_CONTRACTS,
  getEventContract,
  supportsEventPayloadVersion,
} from '@platform/contracts';
import { metrics } from '@platform/observability';
import { deliverWebhook } from './jobs/deliverWebhook.js';
import { deliverPendingWebhooks } from './jobs/deliverWebhook.js';
import { expireReservations } from './jobs/expireReservations.js';
import { gcFiles } from './jobs/gcFiles.js';
import { processPayment } from './jobs/processPayment.js';
import { reconcilePayments } from './jobs/reconcilePayments.js';
import { createPaymentProvider } from './providers/createPaymentProvider.js';
import type { PaymentProvider } from './providers/paymentProvider.js';
import { createWorkerObjectStore } from './s3-delete.js';
import { processJob } from './processor.js';
import type { JobPayload, QueueName, QueueProcessor } from './queues.js';

/**
 * Events produced by the API and worker today. Events whose business effect is
 * already committed in the originating transaction are intentionally explicit
 * acknowledgements below; an event outside this registry must fail and be
 * retried/DLQ'd instead of being silently discarded.
 */
export const REGISTERED_EVENT_TYPES = new Set(Object.keys(EVENT_CONTRACTS));

export function isRegisteredEventType(eventType: string): boolean {
  return REGISTERED_EVENT_TYPES.has(eventType);
}

function payloadRecord(payload: JobPayload): Record<string, unknown> {
  return payload.payload && typeof payload.payload === 'object'
    ? (payload.payload as Record<string, unknown>)
    : {};
}

/** Build the single entrypoint used by every BullMQ consumer. */
async function processGlobalMaintenance(
  db: DatabaseHandle,
  payload: JobPayload,
  paymentProvider: PaymentProvider | null,
): Promise<unknown> {
  switch (payload.eventType) {
    case 'maintenance.expire_reservations':
      return expireReservations(db);
    case 'maintenance.deliver_pending_webhooks':
      return deliverPendingWebhooks(db);
    case 'maintenance.reconcile_payments':
      if (!paymentProvider) throw new Error('payment_provider_not_configured');
      return reconcilePayments(db, paymentProvider);
    case 'maintenance.gc_files':
      return gcFiles(db, createWorkerObjectStore());
    default:
      throw new Error(`maintenance_task_not_registered:${payload.eventType}`);
  }
}

/** Build the single entrypoint used by every BullMQ consumer. */
export function createWorkerProcessor(
  db: DatabaseHandle,
  globalDb: DatabaseHandle = db,
): QueueProcessor {
  const paymentProvider = createPaymentProvider();

  return async (
    queue: QueueName,
    payload: JobPayload,
    jobId: string,
    attempt?: { attemptsMade: number; maxAttempts: number } | undefined,
  ) => {
    if (payload.scope === 'global') {
      const start = Date.now();
      const result = await processGlobalMaintenance(globalDb, payload, paymentProvider);
      metrics.recordJobDuration(queue, Date.now() - start);
      return { deduped: false, result };
    }
    return processJob(db, jobId, payload, {
      queue,
      ...(attempt ? { attemptsMade: attempt.attemptsMade, maxAttempts: attempt.maxAttempts } : {}),
      handler: async (jobPayload) => {
        const inner = payloadRecord(jobPayload);
        const contract = getEventContract(jobPayload.eventType);
        if (!contract || !isRegisteredEventType(jobPayload.eventType)) {
          throw new Error(`event_handler_not_registered:${jobPayload.eventType}`);
        }
        const payloadVersion = jobPayload.payloadVersion ?? 1;
        if (!supportsEventPayloadVersion(jobPayload.eventType, payloadVersion)) {
          throw new Error(
            `event_payload_version_unsupported:${jobPayload.eventType}:${payloadVersion}`,
          );
        }
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
        return {
          acknowledged: true,
          eventType: jobPayload.eventType,
          reason: 'effect_already_committed',
        };
      },
    });
  };
}
