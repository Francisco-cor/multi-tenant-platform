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
  cacheHits: number;
  cacheMisses: number;
  cacheInvalidations: number;
  cacheStampedeFallbacks: number;
  rateLimitHits: Map<string, number>;
  circuitOpens: Map<string, number>;
  circuitRejects: Map<string, number>;
  circuitState: Map<string, string>;
}

class InMemoryMetrics {
  public outboxLagSeconds = 0;
  public outboxPending = 0;
  public jobDurationMs = new Map<string, number[]>();
  public jobRetries = new Map<string, number>();
  public dlqSize = 0;
  public paymentUnknown = 0;
  public paymentPending = 0;
  public cacheHits = 0;
  public cacheMisses = 0;
  public cacheInvalidations = 0;
  public cacheStampedeFallbacks = 0;
  public rateLimitHits = new Map<string, number>();
  public circuitOpens = new Map<string, number>();
  public circuitRejects = new Map<string, number>();
  public circuitState = new Map<string, string>();

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

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  recordCacheMiss(): void {
    this.cacheMisses += 1;
  }

  recordCacheInvalidation(n: number): void {
    this.cacheInvalidations += n;
  }

  recordCacheStampedeFallback(): void {
    this.cacheStampedeFallbacks += 1;
  }

  recordRateLimitHit(key: string): void {
    this.rateLimitHits.set(key, (this.rateLimitHits.get(key) ?? 0) + 1);
  }

  recordCircuitOpen(name: string): void {
    this.circuitOpens.set(name, (this.circuitOpens.get(name) ?? 0) + 1);
  }

  recordCircuitRejected(name: string): void {
    this.circuitRejects.set(name, (this.circuitRejects.get(name) ?? 0) + 1);
  }

  recordCircuitState(name: string, state: string): void {
    this.circuitState.set(name, state);
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
    lines.push(`# HELP cache_hits_total cache hits`);
    lines.push(`# TYPE cache_hits_total counter`);
    lines.push(`cache_hits_total ${this.cacheHits}`);
    lines.push(`# HELP cache_misses_total cache misses`);
    lines.push(`# TYPE cache_misses_total counter`);
    lines.push(`cache_misses_total ${this.cacheMisses}`);
    lines.push(`# HELP cache_invalidations_total cache invalidations`);
    lines.push(`# TYPE cache_invalidations_total counter`);
    lines.push(`cache_invalidations_total ${this.cacheInvalidations}`);
    lines.push(`# HELP cache_stampede_fallback_total stampede fallbacks`);
    lines.push(`# TYPE cache_stampede_fallback_total counter`);
    lines.push(`cache_stampede_fallback_total ${this.cacheStampedeFallbacks}`);
    for (const [k, c] of this.rateLimitHits) {
      lines.push(`rate_limit_hits_total{key="${k}"} ${c}`);
    }
    for (const [k, c] of this.circuitOpens) {
      lines.push(`circuit_opens_total{breaker="${k}"} ${c}`);
    }
    for (const [k, c] of this.circuitRejects) {
      lines.push(`circuit_rejects_total{breaker="${k}"} ${c}`);
    }
    for (const [k, s] of this.circuitState) {
      const v = s === 'CLOSED' ? 0 : s === 'HALF_OPEN' ? 1 : 2;
      lines.push(`circuit_state{breaker="${k}"} ${v}`);
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
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheInvalidations = 0;
    this.cacheStampedeFallbacks = 0;
    this.rateLimitHits.clear();
    this.circuitOpens.clear();
    this.circuitRejects.clear();
    this.circuitState.clear();
  }
}

export const metrics = new InMemoryMetrics();
