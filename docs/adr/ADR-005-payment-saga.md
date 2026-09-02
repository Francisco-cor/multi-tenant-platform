# ADR-005: Pagos — saga durable con incertidumbre explícita y anti-doble-cobro

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: Fase 8 (PLAN_ELEVACION.md:308, IMPLEMENTATION_PLAN.md:342), `packages/domain/src/payments.ts`, `packages/db/migrations/schema/0009_payments.sql`, `apps/worker/src/jobs/processPayment.ts`, `apps/api/src/payment-store.ts`

## Contexto

No existe transacción ACID entre PostgreSQL y proveedor de pagos externo. Opciones:

1. **Dual write frágil** (`INSERT order` + `await provider.charge()` en misma request). Si el worker muere después de cobrar y antes de `UPDATE orders SET status='paid'`, el cobro existe pero la orden queda `pending` → riesgo de doble cobro en retry.
2. **Saga durable con idempotencia determinista** + **webhook firmado** + **reconciler**. Cobra con `provider_idempotency_key` estable y permite reanudar sin duplicar.
3. **Transacción distribuida 2PC/XA** sobre proveedor: no disponible para PSPs reales.

Elegir (2). Pagos debe distinguir `failed` (definitivo → liberar reserva), `paid` (confirmado → consumir reserva), `unknown` (incierto → conservar, alertar, reintentar consulta) — no asumir orden del webhook.

## Decisión

### Modelo

- `orders` (`id uuid PK`, `tenant_id FK organizations`, `branch_id FK branches`, `status draft|pending_payment|paid|processing|completed|cancelled|failed`, `amount_cents integer CHECK >0`, `currency text default 'USD'`, `created_by FK users`, `created_at`, `updated_at`) — `FORCE RLS`, índice `tenant_id,status`.
- `payment_attempts` (`id uuid PK`, `tenant_id FK`, `order_id FK orders CASCADE`, `provider_key text UNIQUE` — `sha256(tenantId:orderId:amount:currency)`, `status created|pending|paid|failed|unknown`, `provider_ref text`, `amount_cents integer`, `currency text`, `attempts integer default 0`, `last_error text`, `created_at`, `updated_at`) — `FORCE RLS`, índice parcial `WHERE status IN ('pending','unknown')` sobre `(tenant_id, updated_at)` para reconciler, índice `(tenant_id, order_id)`.
- `inbound_payment_events` (`id uuid PK`, `tenant_id FK`, `event_id text`, `provider_ref text`, `status text`, `payload jsonb`, `processed_at`, `created_at`, `UNIQUE(tenant_id, event_id)`) — `FORCE RLS`, dedupe webhook por `event_id` tenant-scoped.

### Estados y transiciones (`packages/domain/src/payments.ts:6`)

- `created → pending → paid|failed|unknown`
- `unknown → paid|failed` (vía reconciler)
- `created → failed` (validación inmediata)
- Helpers: `canTransition(from,to)`, `assertTransition`, `isTerminal`, `shouldReconcile` (>5m), `shouldAlert` (>30m unknown).

`provider_key = sha256(tenantId:orderId:amount:currency).slice(0,32)` — determinista, evita doble cobro incluso con kill entre `provider.charge` y commit local. Retry usa **misma key**; provider devuelve `already_charged` con mismo `provider_ref`.

### Flujo

1. **Create**: `apps/api/src/payment-store.ts:40` `createOrderWithPayment` en `withTenantTransaction`: `INSERT orders (pending_payment)` + `INSERT payment_attempts (created, provider_key)` + `INSERT outbox_events (payment.created, aggregate_type='order')` atómica. Sin dual write.
2. **Charge**: `apps/worker/src/jobs/processPayment.ts:30` `processPayment` con `SELECT ... FOR UPDATE` en `payment_attempts`, `assertTransition(created→pending)`, `UPDATE status='pending'`, luego `provider.charge(amount, {idempotencyKey: provider_key})` **fuera** de lock de orden pero con `jobId` determinista `sha256(tenant:attemptId:payment.charge)` + `withDedup` (`processed_jobs`) para no duplicar efecto en retry. Si provider responde `paid` → `UPDATE payment_attempts SET status='paid', provider_ref` + `UPDATE orders SET status='paid'` idempotente; si `failed` → `failed`; si timeout/error → `unknown`.
3. **Webhook**: `apps/api/src/routes/webhooks.ts` inbound `POST /v1/webhooks/payments` con `rawBody` antes de `JSON.parse`, verifica `HMAC sha256(secret, timestamp.body)`, tolerance 5m, `event_id` dedupe en `inbound_payment_events` (`UNIQUE tenant,event_id`), luego `SELECT FOR UPDATE` en `payment_attempt` y aplica transición `pending/unknown → paid/failed` idempotente. Responde `200 already_processed` si dedupe hit.
4. **Reconciler**: `apps/worker/src/jobs/reconcilePayments.ts:10` cron 2m `SELECT ... FOR UPDATE SKIP LOCKED WHERE status IN ('pending','unknown') AND updated_at < now()-5m LIMIT 100`, por cada fila `provider.getStatus(provider_ref||provider_key)` → mapea a `paid/failed/unknown` + `UPDATE` + `metrics.payment_unknown`. `unknown >30m` → `metrics` + alerta (log + `dlq` si excede). Nunca re-intenta `charge` sin misma key.
5. **Compensación**: solo `failed` libera `inventory_reservations` (`released`); `unknown` conserva reserva hasta `paid/failed` definitivo — nunca se cobra de nuevo.

### Consecuencias

- **Pros:** muerte post-cobro no duplica: retry con misma key → provider retorna `provider_ref` existente; webhook fuera de orden/deduped no corrompe; reconciler cierra `pending` huérfano; `paid` es única señal para liberar inventario/completar orden; audit log + `processed_jobs` trazables.
- **Contras:** más estados/tablas y job reconciliador; requiere provider `getStatus` y webhook idempotente; `unknown` puede quedar horas si PSP caído (mitigado con alerta 30m).
- **Alternativa descartada:** dual write se demostró perdiendo estado en `docs/failure-scenarios/payment-saga.md`.

## Validación

- `packages/domain/src/payments.test.ts:1` state machine 6 transiciones + `providerIdempotencyKey` determinista + `shouldReconcile` 5m / `shouldAlert` 30m.
- `apps/worker/src/payments.saga.test.ts:1` kill mid-tx: `FakeProvider` cuenta `chargeCalls`, `processPayment` 1º falla antes de commit → 2º retry misma key → `chargeCalls==1`, `payment_attempt` final `paid`.
- `apps/api/src/payments.webhook.test.ts:1` HMAC tampered → 401, tolerance 5m, dedupe 2× mismo `event_id` → 1 efecto.
- `apps/worker/src/reconcilePayments.test.ts:1` pending>5m consulta fake `getStatus` → paid/failed.

## Referencias

- `packages/domain/src/payments.ts:1`,
- `migrations/schema/0009_payments.sql:1`,
- `packages/db/src/schema.ts` `orders`+`paymentAttempts`+`inboundPaymentEvents`,
- `apps/api/src/payment-store.ts:1` (`persistentPaymentStore`),
- `apps/api/src/routes/payments.ts`, `apps/api/src/routes/webhooks.ts`,
- `apps/worker/src/jobs/processPayment.ts:1`, `reconcilePayments.ts:1`,
- `packages/observability/src/metrics.ts` `payment_unknown`,
- `docs/runbooks/payment-unknown.md`, `docs/failure-scenarios/payment-saga.md`.
