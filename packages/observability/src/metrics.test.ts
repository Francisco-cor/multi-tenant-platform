import { beforeEach, describe, expect, it } from 'vitest';
import {
  HTTP_DURATION_BUCKETS_MS,
  CRITICAL_METRICS,
  escapeLabelValue,
  isMetricsRequestAuthorized,
  metrics,
  metricsAuthTokenFromEnv,
  rateLimitLabel,
  sanitizeLabelValue,
} from './metrics.js';

function histogramNames(exposition: string): string[] {
  return [...exposition.matchAll(/^# TYPE (\S+) histogram$/gmu)].map((match) => match[1] ?? '');
}

function bucketNames(exposition: string): Set<string> {
  return new Set([...exposition.matchAll(/^(\S+)_bucket\{/gmu)].map((match) => match[1] ?? ''));
}

describe('Prometheus exposition', () => {
  beforeEach(() => metrics.reset());

  it('emits real histogram samples for every declared histogram', () => {
    metrics.recordHttpRequest('GET', '/v1/orders', 200, 12);
    metrics.recordHttpRequest('GET', '/v1/orders', 200, 300);
    metrics.recordJobDuration('orders', 25);

    const exposition = metrics.toPrometheus();
    const names = histogramNames(exposition);
    const buckets = bucketNames(exposition);

    expect(names).toContain('http_request_duration_seconds');
    expect(names).toContain('job_duration_seconds');
    for (const name of names) expect(buckets.has(name)).toBe(true);
    expect(exposition).toContain('http_request_duration_seconds_count{');
    expect(exposition).toContain('http_request_duration_seconds_sum{');
    expect(exposition).toContain('job_duration_seconds_bucket{queue="orders",le="0.025"} 1');
    expect(exposition).toContain('job_duration_seconds_bucket{queue="orders",le="+Inf"} 1');
    expect(exposition).toContain(
      'http_request_duration_seconds_count{method="GET",route="/v1/orders",status="200"} 2',
    );
  });

  it('uses cumulative bucket counts', () => {
    for (const duration of [1, 10, 100]) {
      metrics.recordHttpRequest('GET', '/v1/x', 200, duration);
    }
    const exposition = metrics.toPrometheus();
    const lines = exposition.split('\n');
    const bucket = (le: string) =>
      Number(
        lines
          .find(
            (line) =>
              line.startsWith(`http_request_duration_seconds_bucket{`) &&
              line.includes(`le="${le}"`),
          )
          ?.split(' ')
          .at(-1),
      );
    expect(bucket('0.005')).toBe(1);
    expect(bucket('0.010')).toBe(2);
    expect(bucket('0.100')).toBe(3);
    expect(bucket('+Inf')).toBe(3);
    expect(HTTP_DURATION_BUCKETS_MS.at(-1)).toBe(5_000);
  });

  it('escapes label values so forged samples cannot be injected', () => {
    metrics.recordWebhookEgressDenied('a"\n metric{x="1');
    const exposition = metrics.toPrometheus();
    const sample = exposition
      .split('\n')
      .find((line) => line.startsWith('webhook_egress_denials_total{reason='));
    expect(sample).toBeDefined();
    expect(sample).toContain('\\"');
    // Control characters are normalised to spaces before escaping.
    expect(sample).not.toContain('\n');
    // The injected metric must not appear as a separate sample.
    expect(exposition.split('\n').filter((line) => line.startsWith('metric{'))).toHaveLength(0);
    expect(sample?.match(/(?<!\\)"/gu)?.length).toBe(2);
  });

  it('bounds label values and normalises control characters', () => {
    expect(sanitizeLabelValue('a'.repeat(500)).length).toBeLessThanOrEqual(128);
    expect(sanitizeLabelValue('a\u0000b')).toBe('a b');
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it('hashes rate-limit keys instead of exposing tenant identifiers', () => {
    metrics.recordRateLimitHit('tenant-acme:tenant-acme');
    const exposition = metrics.toPrometheus();
    expect(exposition).not.toContain('tenant-acme');
    expect(exposition).toContain(
      `rate_limit_hits_total{key="${rateLimitLabel('tenant-acme:tenant-acme')}"}`,
    );
  });

  it('exposes the critical security metrics and denial counter', () => {
    metrics.recordIsolationViolation();
    metrics.recordMetricsScrapeDenied();
    const exposition = metrics.toPrometheus();
    for (const name of CRITICAL_METRICS) expect(exposition).toContain(`# TYPE ${name} counter`);
    expect(exposition).toContain('isolation_violations_total 1');
    expect(exposition).toContain('metrics_scrape_denied_total 1');
  });

  it('gates the metrics endpoint behind a bearer token', () => {
    const token = 'metrics-token-0123456789';
    expect(metricsAuthTokenFromEnv({ METRICS_AUTH_TOKEN: token })).toBe(token);
    expect(metricsAuthTokenFromEnv({ METRICS_AUTH_TOKEN: 'short' })).toBeUndefined();
    expect(isMetricsRequestAuthorized({ authorization: `Bearer ${token}` }, token)).toBe(true);
    expect(isMetricsRequestAuthorized({ 'x-metrics-token': token }, token)).toBe(true);
    expect(isMetricsRequestAuthorized({ authorization: 'Bearer nope' }, token)).toBe(false);
    expect(isMetricsRequestAuthorized({}, token)).toBe(false);
    expect(isMetricsRequestAuthorized({ authorization: `Bearer ${token}` }, undefined)).toBe(false);
  });
});
