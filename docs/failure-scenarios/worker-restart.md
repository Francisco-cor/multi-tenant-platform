# Failure scenario — Worker reiniciado (SIGTERM durante job)

- Fecha: 2026-09-02
- Fase: 7 (outbox/BullMQ) + 13
- Hipótesis: si `worker` recibe `SIGTERM` durante un `job` activo (ej. `processPayment` con `FOR UPDATE` + `provider.charge`), el `job` debe ser recuperable y no corrupto. El `lock` debe expirar y el `retry` debe usar misma `provider_key` sin doble cobro. `graceful shutdown` debe esperar jobs activos hasta 30s.

## Preparación

- Worker `apps/worker/src/main.ts:10` `shutdown` `30s` `await relay.stop()` + `queueFactory.closeAll()` + `BullMQ` `worker.close()` (si Redis), `InMemoryQueue` dedupe.
- Jobs `apps/worker/src/jobs/processPayment.ts:30` `SELECT ... FOR UPDATE` + `provider.charge` idempotente + `UPDATE paid` idempotente + `outbox` `payment.*`.
- `processed_jobs` dedupe `jobId=sha256(tenant:aggregate:event)` (`packages/db/migrations/schema/0008_outbox.sql:29`), `attempts`, `next_attempt_at` `FOR UPDATE SKIP LOCKED`.
- Métricas: `job_duration_p95_seconds`, `job_retries_total`, `outbox_lag_seconds`, `GET /metrics`.

## Inyección

```bash
# 1. En local, arrancar worker con DB real
DATABASE_URL=postgresql://platform:platform@localhost:5432/platform \
REDIS_URL=redis://localhost:6379 \
pnpm --filter @platform/worker dev &
WORKER_PID=$!

# 2. Crear orden + payment_attempt pending (via API)
curl -s -X POST http://localhost:4000/v1/orders -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{"branchId":"branch-acme-main","amountCents":1999}' | jq

# 3. Forzar job largo: usar FakeProvider con delay 5s (modificar apps/worker/src/providers/fakePaymentProvider.ts:30 delayMs=5000)
# O inyectar sleep en handler: `await new Promise(r=>setTimeout(r,5000))`

# 4. Mientras job está en `FOR UPDATE` (ver logs worker "job processed" aún no), matar worker
sleep 1
kill -SIGTERM $WORKER_PID
# -> logs: "worker_shutdown_started" "await relay.stop()" "await worker.close()" 30s timeout

# 5. Verificar que job no quedó corrupto: outbox debe estar pending o claimed, no done
psql $DATABASE_URL -c "SELECT status, attempts, last_error FROM outbox_events WHERE aggregate_type='payment' ORDER BY created_at DESC LIMIT 1;"
# -> status pending o claimed, attempts 0 o 1, last_error null o "job_timeout" si superó 10s

# 6. Reiniciar worker
DATABASE_URL=... pnpm --filter @platform/worker dev &
sleep 5
# -> relay debe re-claim `SKIP LOCKED` y re-publicar con mismo jobId determinista
# -> FakeProvider debe ser llamado 1 vez más pero con misma providerKey → idempotente (no doble cobro)
psql $DATABASE_URL -c "SELECT status, provider_ref FROM payment_attempts WHERE order_id='<id>'"
# -> status paid (eventualmente) tras retry

# 7. Verificar dedupe
psql $DATABASE_URL -c "SELECT job_id, queue, result FROM processed_jobs WHERE job_id = sha256('tenant-acme:order-123:payment.paid')"

# 8. Métricas
curl -s http://localhost:4000/metrics | grep job
# -> job_retries_total{queue="orders"} incrementa
```

## Señal esperada

- `SIGTERM` durante `FOR UPDATE`: la transacción se hace `ROLLBACK` (postgres libera `row lock`), `payment_attempt` queda `created|pending`, no `paid` corrupto.
- `outbox_events` `claimed` → tras `relay.stop()` sin `publish` o con `publish` fallido, el próximo `runOutboxRelayOnce` `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100 WHERE status='pending'` lo re-encola. Si ya se hizo `publish` con `jobId` determinista, el `InMemoryQueue`/`BullMQ` dedupe evita duplicado (`seen.has(jobId)`).
- `provider.charge` idempotente: `FakeProvider` `providerIdempotencyKey` `sha256(tenant:order:amount)` → segunda `charge` con misma key devuelve mismo `provider_ref` sin cobrar dos veces. Ver `apps/worker/src/payments.saga.test.ts:66` `charge 1 vez` tras kill-mid-tx.
- `graceful shutdown` espera `30s` (`main.ts:14` `deadline Date.now()+30000`), no `process.exit(0)` inmediato (fix `Fase 1` `C7`).
- `GET /health/ready` durante `worker` down sigue `ok` si `outbox lag <30s`, pero `degraded` si `lag>30s`.

## Recuperación

- `worker` reiniciado re-publica `pending` con `backoff 1s→60s jitter 0.2` (`relay/outboxRelay.ts:107` `nextAttemptDelayMs`), `attempts++`, `dead_letter` tras 5.
- Si `job` estaba en `processed_jobs` ya (deduped), el retry es `already_processed` sin efecto.
- `DLQ` si falla tras 5 intentos: `GET /v1/dlq` + `POST /replay` (owner/admin) recrea `pending`.
- No se requiere intervención manual si `providerKey` es determinista; `reconciler` (`pending>5m`) también corrige.

## Evidencia

- `docker logs worker` con `worker_shutdown_started` + `worker_shutdown_completed` 30s, `job processed` con mismo `traceId` antes y después.
- `payments.saga.test.ts` `kill after charge does not double charge` → 1 charge call.
- `pg_stat_activity` `application_name` muestra `ROLLBACK` y luego `SELECT ... FOR UPDATE` exitoso tras restart.
- `GET /metrics` `job_retries_total{queue="orders"}` incrementa.

## Aprendizaje

- **Lock timeout**: `SELECT ... FOR UPDATE` sin `NOWAIT` bloquea hasta `statement_timeout 5s`; si worker muere, lock se libera. `SKIP LOCKED` en relay y `expireReservations` evita que dos relays peleen.
- **JobId determinista**: `sha256(tenant:aggregate:event)` es la clave para dedupe; sin él, `relay` re-publicaría con nuevo `jobId` y duplicaría.
- **Graceful**: `await worker.close()` + `await queue.close()` es obligatorio; `process.exit(0)` en `SIGTERM` (viejo `main.ts:1` stub) perdía jobs.
- Próximo: añadir `liveness/readiness` para `worker` (`/health` endpoint en worker:4001) con `GET /health` que chequea `relay` y `queueFactory`.

## Checklist

- [x] SIGTERM durante FOR UPDATE → ROLLBACK, no corrupto
- [x] Retry con misma providerKey → 1 cobro
- [x] processed_jobs dedupe evita duplicado
- [x] graceful 30s
- [x] Este runbook
