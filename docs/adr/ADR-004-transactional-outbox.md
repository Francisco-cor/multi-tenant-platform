# ADR-004: Transactional outbox frente a dual writes

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: Fase 7 (PLAN_ELEVACION.md:286, IMPLEMENTATION_PLAN.md:317), `packages/db/migrations/schema/0008_outbox.sql`, `packages/db/src/outbox.ts`, `apps/worker/src/relay/outboxRelay.ts`

## Contexto

Las escrituras de negocio (crear archivo, reservar inventario, crear orden) deben generar eventos asíncronos sin perder el evento si el proceso muere antes de publicar, y sin duplicar efectos si el publish se reintenta. Opciones:

1. **Dual write** (escribir en DB y luego `await publish` a Redis/BullMQ en la misma request). Si la API muere entre commit y publish, el evento se pierde. Si publica y luego el worker lo procesa dos veces, se duplica.
2. **Transactional outbox** (escribir `outbox_events` en la misma transacción que el negocio, y un relay publica a posteriori con `FOR UPDATE SKIP LOCKED`). Sobrevive a muerte del proceso y permite dedupe + replay.
3. **Polling de tabla de negocio** (triggers que descubren cambios). Acopla el relay al esquema de negocio y rompe expand-contract.

## Decisión

Elegir **(2) transactional outbox** con:

### Modelo

- `outbox_events` (`id uuid PK`, `tenant_id FK organizations`, `aggregate_type file|inventory|order|generic`, `aggregate_id uuid`, `event_type text`, `payload jsonb`, `payload_version`, `status pending|claimed|done|failed|dead_letter`, `attempts`, `next_attempt_at`, `correlation_id`, `created_at`, `published_at`, `last_error`) — `FORCE RLS` tenant-scoped, índice parcial `WHERE status='pending'` sobre `(tenant_id, status, next_attempt_at)` para relay.
- `processed_jobs` (`job_id text PK` determinista `sha256(tenantId:aggregateId:eventType)`, `tenant_id`, `queue`, `result jsonb`, `processed_at`) — `FORCE RLS`, índice `(tenant_id,queue)`. Dedupe en consumidor.
- `dlq_jobs` (`id uuid PK`, `job_id`, `tenant_id`, `queue`, `payload jsonb`, `cause`, `attempts`, `status pending|replayed|discarded`) — `FORCE RLS`, índice `(tenant_id,queue,status)`.
- Triggers `platform_touch_updated_at` para `outbox` y `dlq`.

### Flujo

1. **Write**: negocio + `INSERT outbox_events` en `withTenantTransaction` (`file-store.ts:273` `writeOutboxEvent(tx, {tenantId, aggregateType:'file', aggregateId:id, eventType:'file.created'})`, `inventory-store.ts:445` `inventory.reserved`). Sin `await publish` en la tx. El `correlation_id = request.id` viaja en payload.
2. **Relay**: `apps/worker/src/relay/outboxRelay.ts:24` `runOutboxRelayOnce` con `SELECT ... FOR UPDATE SKIP LOCKED WHERE status='pending' AND next_attempt_at <= now() LIMIT 100` → `UPDATE status='claimed'` → por cada fila `queue.add(payload, {jobId=sha256(tenantId:aggregateId:eventType)})` → en éxito `status='done'`, en fallo `attempts++` + `nextAttemptAt = now() + backoff(attempts)` (exp 1s→60s jitter 0.2 via `nextAttemptDelayMs`), tras 5 intentos `status='dead_letter'` + `INSERT dlq_jobs`.
3. **Queues**: `apps/worker/src/queues.ts:32` `deterministicJobId` + `InMemoryQueue` (test) / `createBullMqFactory` (prod) con `QUEUES = files,inventory,orders,webhooks,emails,generic`, `getQueueForAggregate` mapea `file→files`, `order→orders`. BullMQ con `attempts 5`, `backoff exponential 1s`, `removeOnComplete 1h`.
4. **WorkerProcessor**: `apps/worker/src/processor.ts:1` `processJob` con `withDedup` (`dedup.ts:1` check `processed_jobs` → hit → skip effect, miss → run handler → `markProcessed`) + `timeout 10s` + `metrics.recordJobDuration`. `QUEUE_CONFIG` con `concurrency 10` por cola.
5. **Graceful shutdown**: `apps/worker/src/main.ts:10` `shutdown` con `await relay.stop()` + `await queueFactory.closeAll()` + `SIGTERM 30s deadline`, `relay.stop` espera `running` flag con 5s grace.
6. **Métricas/Health**: `packages/observability/src/metrics.ts:1` `outbox_lag_seconds`, `outbox_pending`, `job_duration p95`, `dlq_size`, `job_retries` → `GET /metrics` (`app.ts:420`); `apps/api/src/health.ts:92` `checkOutbox` calcula `lag = now()-min(created_at) WHERE status='pending'`, degraded si `lag>30s`.

### Consecuencias

- **Pros:** `business + outbox` atómicos sobreviven a `kill -9` entre commit y publish; relay idempotente + `jobId` determinista evitan duplicar efectos; `processed_jobs` garantiza entrega _al menos una vez_ sin duplicar negocio; `SKIP LOCKED` permite múltiples relays/ workers sin pelear por mismas filas; DLQ con replay auditado (`POST /v1/admin/dlq/:id/replay` `audit:read` + `owner/admin`) permite corrección sin perder trazabilidad.
- **Contras:** más tablas + relay + jitter; `outbox_events` retiene `payload` hasta `done` (requiere retención/vacuum); el relay añade ~2s de lag p95 objetivo <30s.
- **Alternativas descartadas:** dual write se demostró perdiendo eventos en tests de muerte; polling de negocio se descartó por acoplamiento.

## Validación

- `apps/worker/src/outbox.dedupe.test.ts:1` `deterministicJobId` estable y tenant-scoped, `InMemoryQueue` dedupe `same jobId → 1 job`, `processed_jobs` simulado `1 efecto` con 2 publishes.
- `apps/worker/src/relay/outboxRelay.test.ts:1` routing `file→files` y backoff `1000→2000→32000→60000` cap.
- `apps/api/src/file-store.ts:273` y `inventory-store.ts:445` pruebas que `outbox` se escribe en misma tx (fila visible solo tras commit, una fila por negocio).
- `docs/failure-scenarios/outbox-dedupe.md` con muerte del worker entre `publish` y `processed_jobs` → retry sin duplicar.

## Referencias

- `packages/db/migrations/schema/0008_outbox.sql:1`,
- `packages/db/src/outbox.ts:1` (`deterministicJobId`, `writeOutboxEvent`, `nextAttemptDelayMs`),
- `apps/worker/src/relay/outboxRelay.ts:1`,
- `apps/worker/src/queues.ts:1` (`InMemoryQueueFactory`, `createBullMqFactory`),
- `apps/worker/src/processor.ts:1` (`QUEUE_CONFIG`, `processJob`),
- `apps/api/src/health.ts:92` (`checkOutbox`),
- `packages/observability/src/metrics.ts:1`.
