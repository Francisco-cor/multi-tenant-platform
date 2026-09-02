# Failure Scenario — Observabilidad correlacionada (Fase 12)

- Fecha: 2026-09-02
- Versión: `git rev-parse --short HEAD` (local)
- Hipótesis: un `POST /v1/orders` debe ser rastreable desde `x-request-id`/`traceparent` → log JSON → `audit_log` → `outbox_events.correlation_id` → `pg_stat_activity.application_name` → `worker` job → `GET /metrics` sin filtrar secretos.

## 1. Preparación

```bash
pnpm install --ignore-scripts
cp .env.example .env  # LOG_LEVEL=info, OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces (opcional)
docker compose up -d postgres redis minio otel-collector prometheus grafana
pnpm dev  # api:4000 worker
curl -s -X POST http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-alice"}' -c /tmp/c
COOKIE=$(grep platform_session /tmp/c | awk '{print $7}')
```

## 2. Inyección — request con correlation explícita

```bash
REQ_ID=test-trace-123
TRACE_ID=4bf92f3577b34da6a3ce929d0e0e4736
PARENT_ID=00f067aa0ba902b7

curl -i -X POST http://localhost:4000/v1/orders \
  -H 'host: acme.app.localhost' -H 'content-type: application/json' \
  -H "x-request-id: $REQ_ID" -H "traceparent: 00-$TRACE_ID-$PARENT_ID-01" \
  -H "cookie: platform_session=$COOKIE" \
  -d '{"branchId":"branch-acme-main","amountCents":1999,"currency":"USD"}' \
  | tee /tmp/resp

# Esperado:
# <- HTTP 201
# <- x-request-id: test-trace-123
# <- x-trace-id: 4bf92f3577b34da6a3ce929d0e0e4736
# <- traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01
# Body: {"order":{"id":"...","tenantId":"tenant-acme"},"paymentAttempt":{"providerKey":"..."}}
```

## 3. Señal esperada

### 3.1 Logs API estructurados JSON (no PII, tenantHash)

```bash
docker compose logs api 2>&1 | grep -F "$TRACE_ID" | head -5
```

Esperado (ejemplo real de `apps/api/src/app.ts:540` `structuredLogger.info`):

```json
{
  "level": "INFO",
  "time": "2026-09-02T01:38:57.237Z",
  "service": "api",
  "msg": "request completed",
  "requestId": "test-trace-123",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "tenantHash": "9332cc3f",
  "method": "POST",
  "url": "/v1/orders",
  "route": "/v1/orders",
  "statusCode": 201,
  "durationMs": 12,
  "userIdHash": "06ac6b26"
}
```

Verificar **redacción**: ningún log debe contener `platform_session` raw, `secret`, `authorization`, `cookie` raw, `password`:

```bash
docker compose logs api 2>&1 | grep -qi 'REDACTED' && echo "redact ok" || echo "redact missing"
docker compose logs api 2>&1 | grep -E 'secret[^_]|authorization: Bearer|platform_session=' && echo "FAIL leaked" || echo "PASS no leak"
# Debe mostrar PASS no leak; los headers se censuran a [REDACTED] vía packages/observability/src/logger.ts:10 + Fastify redact.
```

### 3.2 Fastify request log (pino) también con redact

```bash
docker compose logs api 2>&1 | grep -F 'test-trace-123'
# {"level":30,"time":...,"reqId":"test-trace-123","req":{"method":"POST","url":"/v1/orders"},"res":{"statusCode":201},"responseTime":12}
# Verificar que req.headers.cookie no aparece raw: debe estar [REDACTED] (apps/api/src/app.ts:502 redact paths)
```

### 3.3 Audit log con mismo traceId

```bash
curl -s "http://localhost:4000/v1/audit?limit=5" -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | jq ".data[] | select(.requestId==\"$REQ_ID\")"
# -> {"id":"...","action":"order.created","actorUserId":"user-alice","tenantId":"tenant-acme","requestId":"test-trace-123","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","ip":"127.0.0.1","result":"success","at":...}
```

Esperado: `audit_log` `trace_id` coincide con `x-trace-id` ( `apps/api/src/app.ts:685` `auditBase` usa `getCorrelation().traceId`).

### 3.4 Outbox + DB application_name

```bash
psql $DATABASE_URL -c "SELECT id, aggregate_type, event_type, correlation_id, payload->>'orderId' as orderId
FROM outbox_events WHERE correlation_id LIKE '${REQ_ID}%' ORDER BY created_at DESC LIMIT 1;"
# -> correlation_id = test-trace-123:4bf92f3577b34da6a3ce929d0e0e4736
#    tenant_id = tenant-acme
#    event_type = order.created

psql $DATABASE_URL -c "SELECT pid, application_name, state, query FROM pg_stat_activity WHERE application_name LIKE '${REQ_ID:0:16}%';"
# -> application_name = test-trac:9332cc3f  (requestId:tenantHash)  packages/db/src/database.ts:73
```

### 3.5 Worker job con mismo traceId

```bash
docker compose logs worker 2>&1 | grep -F "$TRACE_ID"
# {"level":"INFO","service":"worker","jobId":"abc...","queue":"orders","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","tenantHash":"9332cc3f","requestId":"test-trace-123","durationMs":45,"eventType":"order.created","msg":"job processed"}
# + deduplication: apps/worker/src/processor.ts:24 runWithCorrelation
```

### 3.6 Prometheus metrics (RED sin alta cardinalidad)

```bash
curl -s http://localhost:4000/metrics | grep http_requests_total
# -> http_requests_total{method="POST",route="/v1/orders",status="201"} 1
# No debe contener tenantId raw, solo method/route/status. Tenant solo como tenantHash en logs, no label.

curl -s http://localhost:4000/metrics | grep outbox_lag
# -> outbox_lag_seconds 0.12

curl -s http://localhost:4000/metrics | grep -i secret && echo "FAIL secret in metrics" || echo "PASS no secret in metrics"
```

### 3.7 Grafana dashboards y alertas

- Abrir `http://localhost:3001` (anon Viewer, `infra/grafana/provisioning/datasources/prometheus.yaml`).
- Dashboards: `API RED` (`api-red.json`) muestra `P95 /v1/orders`, `ErrorRate`, `Cache HIT/MISS`, `Circuit state`.
- `Payments/Outbox` (`payments.json`) muestra `outbox_lag_seconds`, `dlq_size`, `payment_unknown`.
- `Tenant Isolation` (`isolation.json`) muestra `application_name` por `tenantHash`.
- Ver `http://localhost:9090/alerts` (Prometheus) → `OutboxLag`, `ErrorRateHigh`, etc. en verde (no firing) tras la prueba.

## 4. Recuperación / verificaciones negativas

- Repetir request sin `traceparent` → debe generar `traceId` nuevo (`generateTraceId()` `packages/observability/src/tracing.ts:14`), 32 hex, y propagarlo en `x-trace-id` de respuesta.
- Enviar `secret` en payload → verificar que log no lo expone: `POST /v1/api-keys` con `secret` debe aparecer como `[REDACTED]` en log ( `logger.ts` `REDACT_KEYS`).
- Enviar `x-tenant-id` falso → `requireTenantContext` 403 pero log debe mostrar `tenantHash` del header entrante sin leak.

## 5. Evidencia

Guardar:

```bash
date -u +%Y%m%d > /tmp/date
echo $TRACE_ID > /tmp/trace
docker compose logs api > /tmp/api.log
docker compose logs worker > /tmp/worker.log
psql -c "SELECT correlation_id FROM outbox_events WHERE correlation_id LIKE 'test-trace-123%'" > /tmp/outbox.txt
curl -s http://localhost:4000/metrics > /tmp/metrics.txt
# Adjuntar screenshots de Grafana API RED + Payments con outbox_lag
```

## 6. Aprendizaje

- **Propagación**: 6 capas (header → `AsyncLocalStorage` → `application_name` → `outbox.correlation_id` → `job payload` → `worker` log) es necesaria; una capa sin propagate rompe la cadena. `storage.enterWith` en `onRequest` + `setCorrelationPatch` en `requireTenantContext` (tenant/user) asegura que incluso `DB` vea el hash correcto sin `findById` global.
- **Redacción**: `Fastify redact` + `logger.ts` doble capa evita leak de `cookie`/`authorization`. Sin redact, `pino` loguea headers raw.
- **Cardinalidad**: no usar `tenantId` como label Prometheus (explota). Solo `tenantHash` en logs (8 hex) es suficiente para filtrar sin exponer PII.
- **Sampling**: `probabilistic_sampler 10%` (`otel-collector-config.yaml:23`) reduce costo; traceId sigue propagado aunque no se exporte.

## 7. Criterio de salida Fase 12

- [x] `curl` con `traceparent` → `audit_log`, `outbox`, `application_name`, `worker` comparten `traceId`.
- [x] `GET /metrics` expone `http_requests_total`, `http_request_duration_p95_seconds`, `outbox_lag_seconds`, `payment_unknown` sin secretos.
- [x] Logs JSON no contienen `secret`, `cookie`, `authorization` raw.
- [x] Dashboards `api-red`, `payments`, `isolation` cargan en Grafana.
- [x] Alertas `OutboxLag`, `ErrorRateHigh`, `DLQNonEmpty` visibles en `http://localhost:9090/alerts` con `severity` y `runbook`.
