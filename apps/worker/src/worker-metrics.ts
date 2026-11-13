/**
 * Worker-local counters rendered next to `@platform/observability` metrics.
 *
 * The shared metrics package is platform-owned and has no slots for the
 * operational signals the worker needs (lease fencing, outbox re-drives, GC
 * failures, webhook timeouts). Keeping them here makes them exportable through
 * the existing `/metrics` endpoint without changing the shared package.
 */
export type WorkerCounterName =
  | 'job_lease_renewals_total'
  | 'job_lease_lost_total'
  | 'job_timeouts_total'
  | 'job_in_progress_total'
  | 'outbox_redriven_total'
  | 'outbox_publish_failures_total'
  | 'outbox_dead_letter_total'
  | 'webhook_preflight_failures_total'
  | 'webhook_timeouts_total'
  | 'webhook_response_too_large_total'
  | 'gc_delete_failures_total'
  | 'dlq_replay_enqueued_total'
  | 'reservation_order_link_fallback_total';

export type WorkerGaugeName = 'dlq_oldest_age_seconds' | 'outbox_dead_letter_pending';

const counters = new Map<WorkerCounterName, number>();
const gauges = new Map<WorkerGaugeName, number>();

export const workerMetrics = {
  increment(name: WorkerCounterName, amount = 1): void {
    counters.set(name, (counters.get(name) ?? 0) + amount);
  },
  set(name: WorkerGaugeName, value: number): void {
    gauges.set(name, value);
  },
  getCounter(name: WorkerCounterName): number {
    return counters.get(name) ?? 0;
  },
  getGauge(name: WorkerGaugeName): number {
    return gauges.get(name) ?? 0;
  },
  reset(): void {
    counters.clear();
    gauges.clear();
  },
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, value] of counters) lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    for (const [name, value] of gauges) lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    return lines.join('\n');
  },
};
