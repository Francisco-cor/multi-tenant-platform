# Failure scenario — Outbox duplicado (Fase 7)

- **Fecha:** 2026-09-01
- **Fase:** 7 (PLAN_ELEVACION.md:286)
- **Hipótesis:** si el relay publica el mismo `eventId` dos veces (ej. muerte tras `queue.add` antes de `UPDATE outbox SET done`), o si un job se reintenta tras `SIGTERM` mid-handler, el efecto de negocio debe ocurrir **una sola vez** gracias a `jobId` determinista + `processed_jobs` dedupe.

## Preparación

- Tablas: `outbox_events` con `status pending|claimed|done|dead_letter`, `processed_jobs` (`job_id PK = sha256(tenantId:aggregateId:eventType)`), `dlq_jobs`. RLS `FORCE`.
- Outbox write: `apps/api/src/file-store.ts:273` y `inventory-store.ts:445` `writeOutboxEvent(tx, {tenantId, aggregateType, aggregateId, eventType, payload, correlationId})` en misma transacción que el negocio.
- Relay: `apps/worker/src/relay/outboxRelay.ts:24` `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100 WHERE status='pending' AND next_attempt_at <= now()` → `jobId=sha256(tenantId:aggregateId:eventType)` → `queue.add(payload, {jobId})` con `InMemoryQueue` dedupe `seen` + `processed_jobs` check.
- Worker: `processor.ts:1` `processJob` → `withDedup(db, {jobId, tenantId, queue}, handler)` → `isProcessed` hit skip, miss run handler → `markProcessed` `INSERT ... ON CONFLICT DO NOTHING`.
- Queues: `queues.ts:1` `InMemoryQueueFactory` (tests) y `createBullMqFactory` (prod) con `attempts 5`, `backoff 1s→60s jitter 0.2`, `timeout 10s`, `concurrency 10` por cola.

## Inyección

**Unit (sin Docker):**

```bash
pnpm --filter @platform/worker test src/outbox.dedupe.test.ts
pnpm --filter @platform/worker test src/relay/outboxRelay.test.ts
```

- 4 tests dedupe: `deterministicJobId` estable y tenant-scoped, `InMemoryQueue` `same jobId → 1 job`, `processed_jobs` simulado `2 publishes → 1 efecto`, `diferente tenant → diferente jobId`.
- 3 tests relay: routing `file→files`, isolation `files vs inventory` queues, backoff `1000→2000→32000→60000` cap + jitter 20%.

**In-memory API flow:**

```bash
pnpm --filter @platform/api test src/files.test.ts
# files presigned→finalize escribe outbox y se puede verificar que outbox legato en files.test.ts: InMemoryFileStore.outbox length == files created
```

**DB real (integración, requiere Docker):**

```bash
# manual con Postgres + Redis
docker compose up -d postgres redis
pnpm --filter @platform/db migrate
RUN_DB_INTEGRATION=1 pnpm --filter @platform/worker test src/outbox.dedupe.test.ts
# Para outbox real con relay:
# 1. Crear file via API (escribe outbox pending)
# 2. Lanzar relay tick manual: `runOutboxRelayOnce(db, {queueFactory})` → publishes
# 3. Matar worker mid-handler (SIGTERM) y repetir tick → segundo publish deduped
```

## Señal esperada

- **Dedupe:** `deterministicJobId('tenant-a','agg-1','file.created')` == `...` en 2 llamadas; `InMemoryQueue.add` 3× mismo `jobId` → `jobs.length ==1`; `processed` Map `2 publishes → effectCount==1`.
- **Backoff:** `nextAttemptDelayMs(0)=1000`, `1=2000`, `5=32000`, `6=60000` cap; jitter dentro de 20%.
- **Outbox lag:** `/metrics` → `outbox_lag_seconds <30`, `outbox_pending` ==0 tras relay tick; `/health/ready` → `outbox ok` si lag <30, `degraded 503` si lag >30 (`health.ts:92`).
- **DLQ:** tras 5 fallos, `outbox status='dead_letter'` + `dlq_jobs` insert, `dlq_size` gauge sube, `GET /v1/dlq` lista tenant-scoped, `POST /v1/dlq/:id/replay` → `processed_jobs` borrado + nuevo `outbox` pending, replay auditado.

## Recuperación

- **Relay muerte tras publish:** `outbox` quedó `claimed` o `done` ya, `queue.add` con mismo `jobId` deduped, `processed_jobs` evita re-ejecutar handler. Ver `outbox.dedupe.test.ts:44` `publishing same eventId twice yields one effect`.
- **Worker SIGTERM mid-job:** `main.ts:6` `shutdown` espera `relay.stop()` + `queueFactory.closeAll()` 30s, `job` queda `pending` o `attempts++` → `next_attempt_at` con jitter → relay lo re-reclama y `withDedup` lo detecta si ya se insertó `processed_jobs`.
- **Redis caído:** `queue.add` falla → relay marca `pending` con `last_error` + `next_attempt_at = now()+backoff`, no pierde evento (sigue en Postgres). `GET /health/ready` con `redis fail` → `degraded`, y `outbox fail` → `degraded`, pero `liveness` sigue `ok`.
- **Replay DLQ:** `POST /v1/dlq/:id/replay` borra `processed_jobs`, re-inserta `outbox`, handler vuelve a correr idempotentemente (`docs/runbooks/dlq-replay.md`).

## Evidencia 2026-09-01

**Unit (CI sin DB):**

```
✓ outbox dedupe > deterministicJobId is stable and tenant-scoped (2ms)
✓ outbox dedupe > InMemoryQueue dedupes same jobId (1ms)
✓ outbox dedupe > publishing same eventId twice yields one effect (1ms)
✓ outbox dedupe > different tenants same aggregate produce different jobIds (1ms)
✓ outbox relay > routes aggregate_type to correct queue (2ms)
✓ outbox relay > InMemoryQueueFactory isolates by queue name (1ms)
✓ outbox relay > backoff with jitter is bounded (1206ms)
```

`pnpm --filter @platform/worker test` → 2 files, 7 tests passed. `pnpm --filter @platform/api test` → 17 passed con `files` outbox escrito en misma tx.

**Metrics/Health:**

```
curl -s http://localhost:4000/metrics | grep outbox
# outbox_lag_seconds 0
# outbox_pending 0
curl -s http://localhost:4000/health/ready | jq .dependencies
# [{name:"postgres",status:"ok"}, {name:"outbox",status:"ok"}]
```

## Aprendizaje

- `jobId` determinista + `processed_jobs` es la única forma de garantizar `exactly once` effect con `at-least-once` delivery. BullMQ `jobId` solo evita duplicados en la cola, no en el handler si el worker murió tras el efecto pero antes de ack.
- `FOR UPDATE SKIP LOCKED` permite múltiples relays sin lock convoy; el `claimed` transitorio evita que dos relays reclamen mismo batch en la misma transacción.
- Jitter 0.2 evita thundering herd cuando muchos `next_attempt_at` coinciden tras un fallo masivo (ej. S3 caído).
- Métrica `outbox_lag_seconds` es el SLI clave: si p95 >30s, la plataforma está degradada aunque la API siga respondiendo 200.
- Próximo paso: `k6` para outbox lag bajo carga con 100 `files` creados en paralelo + `docker compose --profile observability` para Grafana dashboard `worker.json`.
