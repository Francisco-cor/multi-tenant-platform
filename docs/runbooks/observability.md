# Runbook — Observabilidad y diagnóstico (Fase 12)

- Estado: aceptado
- Fecha: 2026-09-02
- Alcance: `api`, `db`, `redis`, `BullMQ`, `outbox`, `pagos`, `webhooks`, `s3`
- Señales: `traceId`, `requestId`, `tenantHash`, `x-request-id`, `traceparent`, `/metrics`, `pg_stat_activity`, Grafana, Prometheus alerts

## 1. Qué revisar primero durante un incidente

### Prioridad 1 — 0-2 min: ¿Qué está rojo?

1. **Grafana → API RED** (`infra/grafana/provisioning/dashboards/api-red.json`):
   - `Error Rate 5xx >1%` (alerta `ErrorRateHigh`, `prometheus/alerts.yml:6`) → owner `platform-api`, runbook este archivo `#error-rate`.
   - `P95 /v1/orders >300ms` (alerta `P95High`) → revisar DB pool, cache, Redis.
   - `Circuit OPEN` (`circuit_state==2`) → `apps/api/src/circuit-breaker.ts:1` s3/oidc/payment 5 fails 30s.
   - `RateLimit hot tenant` → `Fase 10` bucket por tenant 1000/min.

2. **Grafana → Payments/Outbox** (`payments.json`):
   - `Outbox lag >30s` (`alert OutboxLag`) → `SELECT extract(epoch from now()-min(created_at)) FROM outbox_events WHERE status='pending'`. Si >30s, relay caído o BullMQ/Redis down. Ver `worker` logs `traceId`.
   - `DLQ size >0` → `GET /v1/dlq` + `POST /replay` (owner/admin). Ver `docs/runbooks/dlq-replay.md`.
   - `payment_unknown >0 10m` (`alert PaymentUnknown`) → `worker/jobs/reconcilePayments.ts:1` + `GET /metrics` `payment_unknown`. Ver `docs/runbooks/payment-unknown.md`.

3. **Prometheus alerts** (`infra/prometheus/alerts.yml`):
   - Cada alerta tiene `severity`, `owner`, `runbook`. Ver `http://localhost:9090/alerts` y `http://localhost:3001` (Grafana anon Viewer).

### Prioridad 2 — 2-10 min: Correlación request → trace → job → DB

Cada request genera:

- `x-request-id` (Fastify `genReqId` o header entrante) → `requestId` en log JSON + `audit_log.request_id` + `outbox_events.correlation_id` (`requestId:traceId`).
- `x-trace-id` / `traceparent` (`00-<32hex>-<16hex>-01` W3C) → `traceId` en log + DB `application_name` (`requestId:tenantHash`) + `outbox_events.correlation_id` + `BullMQ job payload.correlationId` + `webhook` `X-Trace-Id`.
- `tenantHash = sha256(tenantId).slice(0,8)` en logs (nunca `email`, `secret`, `token`, `cookie`, `authorization`). Ver `packages/observability/src/logger.ts:1` redact `['cookie','authorization','*.secret']`.

**Cómo correlacionar:**

```bash
# 1. Tomar requestId/traceId de respuesta
curl -i http://localhost:4000/v1/orders -H 'host: acme.app.localhost' -H 'cookie: ...'
# <- x-request-id: 06b4f983-...  x-trace-id: 2c70ad7d...

# 2. Buscar en logs (JSON)
docker compose logs api | grep -F '2c70ad7d35a54f5709c1e2f681ed5ecb'
# -> {"level":"INFO","service":"api","requestId":"06b4f983...","traceId":"2c70...","tenantHash":"9332cc3f","route":"/v1/orders","statusCode":201}
# -> {"span":"order.created","traceId":"2c70...","durationMs":12} (tracing.ts)

# 3. Buscar en outbox (misma tx)
psql $DATABASE_URL -c "SELECT id, event_type, correlation_id, payload->>'orderId' FROM outbox_events WHERE correlation_id LIKE '06b4f983%';"
# -> correlation_id = 06b4f983:2c70...

# 4. Buscar en worker (mismo traceId)
docker compose logs worker | grep -F '2c70ad7d35a54f5709c1e2f681ed5ecb'
# -> {"service":"worker","jobId":"abc...","queue":"orders","traceId":"2c70...","tenantHash":"9332cc3f","durationMs":45,"eventType":"order.created"}

# 5. Buscar en pg_stat_activity
psql -c "SELECT pid, application_name, state, query FROM pg_stat_activity WHERE application_name LIKE '06b4f983%';"
# -> application_name = 06b4f983:9332cc3f (database.ts withTenantTransaction)

# 6. Buscar en Grafana Tempo/Jaeger (si OTLP endpoint configurado)
# traceId 2c70... aparece en otel-collector traces pipeline (infra/otel/otel-collector-config.yaml:24)

# 7. Buscar en audit
curl -s http://localhost:4000/v1/audit?limit=5 -H 'host: acme.app.localhost' -H 'cookie: ...' | jq '.data[] | select(.requestId=="06b4f983-...")'
# -> {action:"order.created", traceId:"2c70...", ip:"127.0.0.1", result:"success"}
```

### Prioridad 3 — 10-30 min: Profundizar por capa

| Capa              | Señal                                                                                               | Logs/Metrics                                                                                                                                                   | Acción                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Fastify**   | `http_requests_total` `http_request_duration_p95_seconds` `rate_limit_hits_total` `circuit_state`   | `packages/observability/src/metrics.ts:111` `toPrometheus()` scrape `api:4000/metrics` cada 10s (`prometheus.yml:10`)                                          | Si 5xx >1% → `request.log.error` + `traceId`. Si P95 >300ms → `cache_misses_total`↑? `inventory` query sin índice? Ver `pg_stat_statements`.                                           |
| **Cache**         | `cache_hits_total` `cache_misses_total` `cache_stampede_fallback_total` `cache_invalidations_total` | `apps/api/src/cache.ts:1` `getOrLoad` lock `SET NX PX 5s`                                                                                                      | Si fallback ↑ → hot key sin TTL. Si invalidations 0 tras write → `invalidateCache` no llamó `deleteByPrefix`.                                                                          |
| **DB Postgres**   | `application_name` + `app.tenant_id` + `pg_stat_activity` + `pg_stat_statements`                    | `packages/db/src/database.ts:53` `set_config` `application_name` + `statement_timeout 5s` `idle_in_transaction 5s` (`migrations/schema/0005_db_hardening.sql`) | Si `idle_in_transaction` ↑ → long tx. Si `lock` → `FOR UPDATE SKIP LOCKED` en `inventory` y `outbox` relay.                                                                            |
| **Redis**         | `up{job="redis"}==0` `redis_memory_used_bytes`                                                      | `infra/prometheus/alerts.yml` `RedisDown`                                                                                                                      | Fail-open: cache `get→miss` → DB fallback, rate limiter InMemory, `health degraded` pero `liveness ok`. Ver `apps/api/src/health.ts:56` `checkRedis` fail → degraded, no fail startup. |
| **BullMQ/outbox** | `outbox_lag_seconds` `outbox_pending` `job_retries_total` `job_duration_p95_seconds` `dlq_size`     | `infra/grafana/provisioning/dashboards/worker.json` `outbox lag` + `payments.json`                                                                             | Si lag ↑ → `relay` no publicó: `OutboxRelay:runOutboxRelayOnce` `FOR UPDATE SKIP LOCKED LIMIT 100` + `deterministicJobId` dedupe. Si `dlq_size` ↑ → `POST /v1/dlq/:id/replay`.         |
| **Pagos**         | `payment_pending` `payment_unknown` `PaymentUnknown` alert                                          | `migrations/schema/0009_payments.sql` `payment_attempts` + `worker/jobs/reconcilePayments.ts` `SKIP LOCKED` pending>5m → `getStatus`                           | Si `unknown` >30m → `health.ts:129` degraded. Reconciler consulta provider.                                                                                                            |
| **Webhooks**      | `http_requests_total{route="/v1/webhooks/*"}` + `webhook_deliveries` status                         | `apps/worker/src/jobs/deliverWebhook.ts` HMAC `v1,hmac` + `backoff 10s→10m` + dedupe `(tenant,event_id)`                                                       | Si 5xx/timeout → retry 5xx/429, `dead_letter` tras 8. Si SSRF → `validateUrl` `private_blocked` 400, no `fetch`.                                                                       |
| **S3**            | `circuit_state{breaker="s3"}==2` `presigned 503`                                                    | `apps/api/src/circuit-breaker.ts:1` `CLOSED→OPEN 5 fails 30s→HALF_OPEN 2 ok` `requestTimeout 2s`                                                               | Si OPEN → `503 DEPENDENCY_UNAVAILABLE` + `circuit_opens_total`. Check MinIO `http://localhost:9001`.                                                                                   |

## 2. Alertas y owner

Ver `infra/prometheus/alerts.yml` completo (13 alertas). Cada una tiene `severity`, `owner`, `threshold`, `runbook`:

- `ErrorRateHigh` (critical, platform-api, 5m, `rate(5xx)/rate(total)>0.01`) → `docs/runbooks/observability.md#error-rate` + `docs/threat-model.md`.
- `P95High` (warning, platform-api, 5m, `p95>0.3s`) → `docs/runbooks/cache.md`.
- `OutboxLag` (critical, platform-worker, 2m, `lag>30s`) → `docs/runbooks/dlq-replay.md`.
- `DLQNonEmpty` (warning, platform-worker, 5m, `dlq_size>0`).
- `PaymentUnknown` (critical, platform-payments, 10m, `payment_unknown>0`).
- `RedisDown`, `DiskSpaceLow`, `CircuitOpen`, etc.

## 3. Health checks (liveness/readiness/startup)

`apps/api/src/health.ts:167` `getReadiness()` chequea con timeout 2s:

- `postgres` `SELECT 1` → fail → degraded (no traffic).
- `redis` `PING` → fail → degraded pero opcional (no bloquea startup si `REDIS_URL` no set).
- `outbox` `lag>30s` → fail → degraded.
- `payments` `unknown>0 oldest>30m` → fail → degraded.

Liveness `GET /health/live` siempre `ok` si proceso vivo (no chequea deps).
Startup `GET /health/startup` = readiness (orchestrator no enruta hasta ok).

Worker `apps/worker/src/main.ts:10` `shutdown` 30s `SIGTERM` → `await relay.stop()` + `queueFactory.closeAll()` (graceful). Ver `docs/runbooks/worker-failure.md`.

## 4. Qué no loggear

`packages/observability/src/logger.ts:10` `REDACT_KEYS` = `cookie`, `authorization`, `secret`, `password`, `token`, `x-api-key`. `SECURITY.md:28` `secret_hash` sha256, `rawSecret` solo 201. Verificar con test:

```bash
pnpm --filter @platform/api test src/observability.test.ts
# verifica que log JSON no contiene "secret" raw, solo "[REDACTED]", y que tenantId aparece como tenantHash
```

Ver `docs/security/exceptions.md` para falsos positivos `gitleaks`.

## 5. E2E correlación demostrable

`docs/failure-scenarios/observability-trace.md` contiene experimento:

1. `POST /v1/orders` → capturar `x-request-id`, `x-trace-id`, `traceparent`.
2. Verificar `audit_log` mismo `requestId/traceId/ip`.
3. Verificar `outbox_events.correlation_id = requestId:traceId` y `application_name = requestId:tenantHash`.
4. Verificar `worker` log mismo `traceId` con `jobDuration`.
5. Verificar `GET /metrics` contiene `http_requests_total{route="/v1/orders"}` con `traceId` no como label (baja cardinalidad) sino en logs.

Verificable con:

```bash
curl -i -X POST http://localhost:4000/v1/orders \
  -H 'host: acme.app.localhost' -H 'content-type: application/json' \
  -H 'x-request-id: test-123' -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -b "platform_session=$COOKIE" -d '{"branchId":"branch-acme-main","amountCents":1999}'
# -> x-trace-id: 4bf92f3577b34da6a3ce929d0e0e4736 (propagado)

curl -s http://localhost:4000/metrics | grep http_requests_total
# -> http_requests_total{method="POST",route="/v1/orders",status="201"} 1
```

## 6. Costo y sampling

`infra/otel/otel-collector-config.yaml:10` `probabilistic_sampler 10%` en prod (`sampleRatio 0.1`), `1` en dev. Atributo `tenantHash` hashed, no `tenantId` raw en metrics labels (evita cardinalidad). Ver `packages/observability/src/metrics.ts:111` `httpRequests` key es `method:route:status` sin tenant.

## 7. Referencias

- `packages/observability/src/correlation.ts:1` `AsyncLocalStorage` + `hashTenant`.
- `packages/observability/src/tracing.ts:1` `initTracing` OTLP + `withSpan`.
- `packages/observability/src/logger.ts:1` `createLogger` redact + tenantHash.
- `packages/observability/src/metrics.ts:111` `toPrometheus()` RED + business.
- `infra/otel/otel-collector-config.yaml:1` batch/memory_limiter/redact.
- `infra/prometheus/prometheus.yml:1` scrape `api:4000/metrics` 10s + `alerts.yml`.
- `infra/grafana/provisioning/dashboards/*.json` 5 dashboards (api-red, payments, isolation, db-redis, worker).
- `apps/api/src/app.ts:505` `onRequest` correlation + `onResponse` RED.
- `packages/db/src/database.ts:53` `application_name` tenantHash.
- `apps/worker/src/processor.ts:24` `runWithCorrelation` per job.
