import { createLogger } from '@platform/observability';
import { GLOBAL_MAINTENANCE_TENANT_ID, type JobPayload, type QueueFactory } from './queues.js';

const logger = createLogger({ service: 'worker' });

export const MAINTENANCE_INTERVALS_MS = {
  expire_reservations: 60_000,
  deliver_pending_webhooks: 15_000,
  reconcile_payments: 60_000,
  gc_files: 5 * 60_000,
} as const;

export type MaintenanceTask = keyof typeof MAINTENANCE_INTERVALS_MS;

export interface MaintenanceSchedulerOptions {
  intervalsMs?: Partial<Record<MaintenanceTask, number>>;
  paymentProviderConfigured?: boolean;
  now?: () => number;
  startImmediately?: boolean;
}

export interface MaintenanceScheduler {
  runNow(): Promise<void>;
  stop(): void;
}

function maintenancePayload(task: MaintenanceTask, window: number): JobPayload {
  return {
    tenantId: GLOBAL_MAINTENANCE_TENANT_ID,
    aggregateId: `maintenance:${task}`,
    aggregateType: 'maintenance',
    eventType: `maintenance.${task}`,
    eventId: `maintenance:${task}:${window}`,
    scope: 'global',
    payload: { task, window },
  };
}

/**
 * Enqueues one deterministic BullMQ job per maintenance task and time window.
 * The job id is shared by all worker replicas, so the queue is the distributed
 * scheduler while the jobs themselves retain FOR UPDATE/SKIP LOCKED safety.
 */
export function startMaintenanceScheduler(
  queueFactory: QueueFactory,
  options: MaintenanceSchedulerOptions = {},
): MaintenanceScheduler {
  const now = options.now ?? Date.now;
  const intervals = { ...MAINTENANCE_INTERVALS_MS, ...options.intervalsMs };
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let running = false;

  const runNow = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const current = now();
      const tasks = (Object.keys(intervals) as MaintenanceTask[]).filter(
        (task) => task !== 'reconcile_payments' || options.paymentProviderConfigured === true,
      );
      await Promise.all(
        tasks.map(async (task) => {
          const interval = intervals[task];
          const window = Math.floor(current / interval);
          const payload = maintenancePayload(task, window);
          await queueFactory.getQueue('generic').add(payload, {
            // BullMQ reserves ':' in custom job ids for its internal keys.
            jobId: `maintenance-${task}-${window}`,
            attempts: task === 'deliver_pending_webhooks' ? 3 : 5,
          });
        }),
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'maintenance_schedule_failed',
      );
    } finally {
      running = false;
    }
  };

  if (options.startImmediately !== false) void runNow();
  const smallestInterval = Math.min(...Object.values(intervals));
  const timer = setInterval(() => void runNow(), smallestInterval);
  timer.unref?.();
  timers.push(timer);

  return {
    runNow,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const currentTimer of timers) clearInterval(currentTimer);
    },
  };
}
