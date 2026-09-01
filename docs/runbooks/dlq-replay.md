# Runbook — DLQ y replay (Fase 7)

## Objetivo

Inspeccionar y reintentar jobs muertos sin duplicar efectos ni perder trazabilidad, y sin exponer datos de otro tenant.

## Contratos

- `GET /v1/dlq?limit=25` y `GET /v1/admin/dlq?limit=25` → listas tenant-scoped `dlq_jobs` (`id, jobId, queue, cause, attempts, status pending|replayed|discarded`). Requiere `audit:read` + `owner` o `admin` (403 para `operator`/`auditor`).
- `POST /v1/dlq/:id/replay` y `POST /v1/admin/dlq/:id/replay` → marca `dlq status='replayed'`, borra `processed_jobs` para ese `jobId` (permite re-ejecución), y re-encola un nuevo `outbox_events` con mismo `payload`. Audit: `membership.role_changed` con `dlqReplay=jobId`.
- `POST /v1/dlq/:id/discard` → `status='discarded'` (no reintento).

## Verificación rápida

```bash
# login como owner/admin de acme
curl -s http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-alice"}' -c /tmp/cookie | jq

# listar DLQ (vacía al inicio)
curl -s http://localhost:4000/v1/dlq -H 'host: acme.app.localhost' -b /tmp/cookie | jq

# Si hay un job muerto (ej. forzado matando worker mid-job), reintentar:
DLQ_ID=$(curl -s http://localhost:4000/v1/dlq -H 'host: acme.app.localhost' -b /tmp/cookie | jq -r '.data[0].id')
curl -s -X POST http://localhost:4000/v1/dlq/$DLQ_ID/replay -H 'host: acme.app.localhost' -b /tmp/cookie | jq
# -> {jobId, status:'replayed'}

# Ver outbox recibió nuevo evento:
curl -s http://localhost:4000/metrics | grep outbox_pending
```

Cross-tenant: `user-acme` no ve DLQ de `contoso` aunque adivine `id` (404). `operator` recibe 403 en `/v1/dlq`.

## Flujo outbox → queue → worker → dedupe

1. API escribe `files` + `outbox_events` en una transacción (`file-store.ts:273`).
2. Relay (`outboxRelay.ts:24`) cada 2s reclama `LIMIT 100 FOR UPDATE SKIP LOCKED` pendientes, publica a `Queue` con `jobId=sha256(tenantId:aggregateId:eventType)` y marca `done` o `next_attempt_at` con jitter.
3. Worker `processJob` (`processor.ts:1`) hace `withDedup` (`dedup.ts:1` `SELECT processed_jobs WHERE job_id` → hit skip, miss run handler → `INSERT processed_jobs ON CONFLICT DO NOTHING`).
4. Tras 5 fallos consecutivos, relay marca `dead_letter` y escribe `dlq_jobs` con `cause`. Métrica `dlq_size` sube y `GET /metrics` expone `dlq_size`.

## Fallos y recuperación

| Señal                                          | Causa                                    | Recuperación                                                                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbox_lag_seconds >30` (health degraded 503) | Relay caído o Redis caído                | `docker compose logs worker`, reiniciar relay; DB es fuente de verdad, eventos no se pierden. `checkOutbox` en `/health/ready` falla hasta que lag baje.                                                        |
| `job_timeout 10s`                              | Handler colgado                          | Worker corta con `job_timeout` y reintenta con backoff exponencial 1s→60s jitter 0.2.                                                                                                                           |
| `DLQ non-empty`                                | Handler lanzó error 5 veces              | Inspeccionar `cause`, corregir código/datos, `POST /v1/dlq/:id/replay`. Replay es idempotente si `processed_jobs` aún existe (se borra antes de re-encolar).                                                    |
| `Worker SIGTERM mid-job`                       | Deploy o `kill`                          | `main.ts:10` espera 30s, cierra relay y queues con `await`. Job no confirmado queda `pending` o `claimed` → relay lo re-reclama tras `next_attempt_at` y se re-ejecuta sin duplicar gracias a `processed_jobs`. |
| `Redis caído`                                  | BullMQ no disponible                     | Relay cae a `InMemoryQueueFactory` (tests) o falla el `queue.add` y reprograma con backoff. API sigue aceptando writes porque outbox está en Postgres.                                                          |
| `Duplicate publish` (relay reintenta)          | `outbox_events` aún `pending` tras éxito | `jobId` determinista + `InMemoryQueue.seen` / BullMQ `jobId` + `processed_jobs` hit → 1 efecto. Ver `outbox.dedupe.test.ts:1`.                                                                                  |

## Observabilidad

- `GET /metrics` → `outbox_lag_seconds`, `outbox_pending`, `dlq_size`, `job_retries_total{queue}`, `job_duration` p95.
- `GET /health/ready` incluye `outbox` check (`health.ts:92`) — si lag >30s, readiness es `degraded` (503) y el orchestrator deja de enviar tráfico hasta recuperarse, pero liveness sigue `ok`.
- Logs worker: `worker_started`, `outbox_relay_error`, `worker_shutdown_started/completed`.

## Estado actual (2026-09-01)

- InMemory: full coverage sin Docker. Persistent: `outbox_events`, `processed_jobs`, `dlq_jobs` con `FORCE RLS`, outbox escrito en `files` e `inventory` transaccionalmente, relay con `SKIP LOCKED`, dedupe con `processed_jobs`, DLQ replay auditado.
- Evidencia: `apps/worker/src/outbox.dedupe.test.ts` 4 tests + `relay/outboxRelay.test.ts` 3 tests, `GET /metrics` y `checkOutbox` en health.
- Pendiente: integración real con `testcontainers` Postgres+Redis (MINIO ya existe) y `k6` para outbox lag bajo carga; dashboard Grafana `worker.json` con `outbox_lag` y `dlq_size`.
