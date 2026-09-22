/**
 * In-memory metrics with Prometheus exposition.
 * RED (Rate/Errors/Duration) + business metrics.
 * Labels are low-cardinality: method, route, status. Tenant hashed not used as label to avoid cardinality explosion.
 */

export interface HttpMetric {
  count: number;
  errors: number;
  durations: number[]; // ms
}

export interface MetricsSnapshot {
  outboxLagSeconds: number;
  outboxPending: number;
  jobDurationMs: Map<string, number[]>;
  jobRetries: Map<string, number>;
  jobFinalFailures: Map<string, number>;
  dlqReplays: Map<string, number>;
  webhookLeaseRenewals: number;
  webhookLeaseLosses: number;
  webhookEgressDenials: Map<string, number>;
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
  httpRequests: Map<string, HttpMetric>;
}

class InMemoryMetrics {
  public outboxLagSeconds = 0;
  public outboxPending = 0;
  public jobDurationMs = new Map<string, number[]>();
  public jobRetries = new Map<string, number>();
  public jobFinalFailures = new Map<string, number>();
  public dlqReplays = new Map<string, number>();
  public webhookLeaseRenewals = 0;
  public webhookLeaseLosses = 0;
  public webhookEgressDenials = new Map<string, number>();
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
  // RED metrics: key = `${method}:${route}:${status}`
  public httpRequests = new Map<string, HttpMetric>();
  // tenant isolation violations (should always be 0)
  public isolationViolations = 0;
  // audit events
  public auditEvents = new Map<string, number>();

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

  recordFinalFailure(queue: string): void {
    this.jobFinalFailures.set(queue, (this.jobFinalFailures.get(queue) ?? 0) + 1);
  }

  recordDlqReplay(queue: string): void {
    this.dlqReplays.set(queue, (this.dlqReplays.get(queue) ?? 0) + 1);
  }

  recordWebhookLeaseRenewal(): void {
    this.webhookLeaseRenewals += 1;
  }

  recordWebhookLeaseLoss(): void {
    this.webhookLeaseLosses += 1;
  }

  recordWebhookEgressDenied(reason: string): void {
    this.webhookEgressDenials.set(reason, (this.webhookEgressDenials.get(reason) ?? 0) + 1);
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

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = `${method}:${route}:${statusCode}`;
    const existing = this.httpRequests.get(key) ?? {
      count: 0,
      errors: 0,
      durations: [],
    };
    existing.count += 1;
    if (statusCode >= 500) existing.errors += 1;
    existing.durations.push(durationMs);
    if (existing.durations.length > 1000) existing.durations.shift();
    this.httpRequests.set(key, existing);
    // also aggregate by class for alerting
    const classKey = `${method}:${route}:${statusClass}`;
    if (classKey !== key) {
      const classMetric = this.httpRequests.get(classKey) ?? {
        count: 0,
        errors: 0,
        durations: [],
      };
      classMetric.count += 1;
      if (statusCode >= 500) classMetric.errors += 1;
      this.httpRequests.set(classKey, classMetric);
    }
  }

  recordIsolationViolation(): void {
    this.isolationViolations += 1;
  }

  recordAudit(action: string): void {
    this.auditEvents.set(action, (this.auditEvents.get(action) ?? 0) + 1);
  }

  p95(queue: string): number {
    const arr = this.jobDurationMs.get(queue) ?? [];
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (sorted.length - 1));
    return sorted[idx] ?? 0;
  }

  httpP95(route: string): number {
    // aggregate durations across methods/status for route
    const all: number[] = [];
    for (const [k, v] of this.httpRequests) {
      if (k.includes(`:${route}:`)) all.push(...v.durations);
    }
    if (all.length === 0) return 0;
    const sorted = [...all].sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (sorted.length - 1));
    return sorted[idx] ?? 0;
  }

  toPrometheus(): string {
    const lines: string[] = [];
    // RED
    lines.push(`# HELP http_requests_total Total HTTP requests`);
    lines.push(`# TYPE http_requests_total counter`);
    for (const [k, v] of this.httpRequests) {
      const [method, route, status] = k.split(':');
      // only expose detailed status, not class
      if (status?.endsWith('xx')) continue;
      lines.push(
        `http_requests_total{method="${method}",route="${route}",status="${status}"} ${v.count}`,
      );
    }
    lines.push(`# HELP http_errors_total Total HTTP 5xx`);
    lines.push(`# TYPE http_errors_total counter`);
    for (const [k, v] of this.httpRequests) {
      const [method, route, status] = k.split(':');
      if (status?.endsWith('xx')) continue;
      if (v.errors === 0) continue;
      lines.push(
        `http_errors_total{method="${method}",route="${route}",status="${status}"} ${v.errors}`,
      );
    }
    lines.push(`# HELP http_request_duration_seconds HTTP request duration`);
    lines.push(`# TYPE http_request_duration_seconds histogram`);
    // Expose p95 as gauge
    lines.push(`# HELP http_request_duration_p95_seconds P95 duration per route`);
    lines.push(`# TYPE http_request_duration_p95_seconds gauge`);
    const routes = new Set<string>();
    for (const k of this.httpRequests.keys()) {
      const [, route] = k.split(':');
      if (route) routes.add(route);
    }
    for (const route of routes) {
      const p95 = this.httpP95(route);
      lines.push(`http_request_duration_p95_seconds{route="${route}"} ${(p95 / 1000).toFixed(3)}`);
    }
    // existing business metrics
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
    lines.push(`# HELP isolation_violations_total tenant isolation violations (must be 0)`);
    lines.push(`# TYPE isolation_violations_total counter`);
    lines.push(`isolation_violations_total ${this.isolationViolations}`);
    for (const [q, c] of this.jobRetries) {
      lines.push(`job_retries_total{queue="${q}"} ${c}`);
    }
    for (const [q, c] of this.jobFinalFailures) {
      lines.push(`job_final_failures_total{queue="${q}"} ${c}`);
    }
    for (const [q, c] of this.dlqReplays) {
      lines.push(`dlq_replays_total{queue="${q}"} ${c}`);
    }
    lines.push(`webhook_lease_renewals_total ${this.webhookLeaseRenewals}`);
    lines.push(`webhook_lease_losses_total ${this.webhookLeaseLosses}`);
    lines.push(`# HELP webhook_egress_denials_total Webhook egress requests denied by policy`);
    lines.push(`# TYPE webhook_egress_denials_total counter`);
    for (const [reason, count] of this.webhookEgressDenials) {
      lines.push(`webhook_egress_denials_total{reason="${reason}"} ${count}`);
    }
    for (const [q] of this.jobDurationMs) {
      const p95 = this.p95(q);
      lines.push(`job_duration_p95_seconds{queue="${q}"} ${(p95 / 1000).toFixed(3)}`);
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
    for (const [action, c] of this.auditEvents) {
      lines.push(`audit_events_total{action="${action}"} ${c}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.outboxLagSeconds = 0;
    this.outboxPending = 0;
    this.jobDurationMs.clear();
    this.jobRetries.clear();
    this.jobFinalFailures.clear();
    this.dlqReplays.clear();
    this.webhookLeaseRenewals = 0;
    this.webhookLeaseLosses = 0;
    this.webhookEgressDenials.clear();
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
    this.httpRequests.clear();
    this.isolationViolations = 0;
    this.auditEvents.clear();
  }

  snapshot(): MetricsSnapshot {
    return {
      outboxLagSeconds: this.outboxLagSeconds,
      outboxPending: this.outboxPending,
      jobDurationMs: new Map(this.jobDurationMs),
      jobRetries: new Map(this.jobRetries),
      jobFinalFailures: new Map(this.jobFinalFailures),
      dlqReplays: new Map(this.dlqReplays),
      webhookLeaseRenewals: this.webhookLeaseRenewals,
      webhookLeaseLosses: this.webhookLeaseLosses,
      webhookEgressDenials: new Map(this.webhookEgressDenials),
      dlqSize: this.dlqSize,
      paymentUnknown: this.paymentUnknown,
      paymentPending: this.paymentPending,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheInvalidations: this.cacheInvalidations,
      cacheStampedeFallbacks: this.cacheStampedeFallbacks,
      rateLimitHits: new Map(this.rateLimitHits),
      circuitOpens: new Map(this.circuitOpens),
      circuitRejects: new Map(this.circuitRejects),
      circuitState: new Map(this.circuitState),
      httpRequests: new Map(this.httpRequests),
    };
  }
}

export const metrics = new InMemoryMetrics();
