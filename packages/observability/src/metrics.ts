/**
 * Simple in-memory metrics for outbox and queues.
 * In production these would be Prometheus counters/gauges/histograms via prom-client
 * and exposed on /metrics. For now we keep counters that can be asserted in tests
 * and scraped by Grafana via a /metrics endpoint stub.
 */

export interface Metrics {
  outboxLagSeconds: number;
  outboxPending: number;
  jobDurationMs: Map<string, number[]>;
  jobRetries: Map<string, number>;
  dlqSize: number;
  paymentUnknown: number;
  paymentPending: number;
}

class InMemoryMetrics {
  public outboxLagSeconds = 0;
  public outboxPending = 0;
  public jobDurationMs = new Map<string, number[]>();
  public jobRetries = new Map<string, number>();
  public dlqSize = 0;
  public paymentUnknown = 0;
  public paymentPending = 0;

  recordOutboxLag(lagSeconds: number, pending: number): void {
    this.outboxLagSeconds = lagSeconds;
    this.outboxPending = pending;
  }

  recordJobDuration(queue: string, ms: number): void {
    const arr = this.jobDurationMs.get(queue) ?? [];
    arr.push(ms);
    if (arr.length > 1000) arr.shift();
    this.jobDurationMs.set(queue, arr);
  }

  recordRetry(queue: string): void {
    this.jobRetries.set(queue, (this.jobRetries.get(queue) ?? 0) + 1);
  }

  recordDlq(size: number): void {
    this.dlqSize = size;
  }

  recordPaymentUnknown(count: number): void {
    this.paymentUnknown = count;
  }

  recordPaymentPending(count: number): void {
    this.paymentPending = count;
  }

  p95(queue: string): number {
    const arr = this.jobDurationMs.get(queue) ?? [];
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (sorted.length - 1));
    return sorted[idx] ?? 0;
  }

  toPrometheus(): string {
    const lines: string[] = [];
    lines.push(`# HELP outbox_lag_seconds Age of oldest pending outbox event`);
    lines.push(`# TYPE outbox_lag_seconds gauge`);
    lines.push(`outbox_lag_seconds ${this.outboxLagSeconds}`);
    lines.push(`# HELP outbox_pending events pending`);
    lines.push(`# TYPE outbox_pending gauge`);
    lines.push(`outbox_pending ${this.outboxPending}`);
    lines.push(`# HELP dlq_size jobs in dead letter`);
    lines.push(`# TYPE dlq_size gauge`);
    lines.push(`dlq_size ${this.dlqSize}`);
    lines.push(`# HELP payment_unknown payment_attempts in unknown state`);
    lines.push(`# TYPE payment_unknown gauge`);
    lines.push(`payment_unknown ${this.paymentUnknown}`);
    lines.push(`# HELP payment_pending payment_attempts in pending state`);
    lines.push(`# TYPE payment_pending gauge`);
    lines.push(`payment_pending ${this.paymentPending}`);
    for (const [q, c] of this.jobRetries) {
      lines.push(`job_retries_total{queue="${q}"} ${c}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.outboxLagSeconds = 0;
    this.outboxPending = 0;
    this.jobDurationMs.clear();
    this.jobRetries.clear();
    this.dlqSize = 0;
    this.paymentUnknown = 0;
    this.paymentPending = 0;
  }
}

export const metrics = new InMemoryMetrics();
