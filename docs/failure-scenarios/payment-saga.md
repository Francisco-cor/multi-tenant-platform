# Failure scenario — Pago con muerte post-cobro (Fase 8)

- **Fecha:** 2026-09-01
- **Fase:** 8 (PLAN_ELEVACION.md:308, IMPLEMENTATION_PLAN.md:342)
- **Hipótesis:** si el worker muere inmediatamente después de `provider.charge()` y antes de `UPDATE payment_attempts SET status='paid'` + `UPDATE orders SET status='paid'`, el retry **no debe** cobrar de nuevo y el sistema debe cerrar eventualmente a `paid` vía retry con misma `provider_idempotency_key` o vía reconciler/webhook.

## Preparación

- **Dominio:** `packages/domain/src/payments.ts:10` máquina `created→pending→paid|failed|unknown`, `providerIdempotencyKey = sha256(tenantId:orderId:amount:currency).slice(0,32)` determinista, `shouldReconcile >5m`.
- **DB:** `migrations/schema/0009_payments.sql:1` `orders(pending_payment)`, `payment_attempts(provider_key UNIQUE, status, provider_ref)`, `inbound_payment_events(tenant_id,event_id UNIQUE)` `FORCE RLS`, outbox `payment` aggregate agregado a `outbox_aggregate_check`.
- **API:** `apps/api/src/payment-store.ts:40` `createOrderWithPayment` en `withTenantTransaction`: `INSERT orders` + `INSERT payment_attempts(created)` + `writeOutboxEvent(order.created)` + `writeOutboxEvent(payment.created)` atómicos, sin dual write.
- **Provider:** `apps/worker/src/providers/fakePaymentProvider.ts:30` `FakePaymentProvider` con `Map providerKey→ChargeResult`, `chargeCalls` contador, `failNextChargeAfterProvider` flag para simular `kill` tras side-effect.
- **Worker:** `apps/worker/src/jobs/processPayment.ts:30` `processPayment` con `SELECT ... FOR UPDATE` → `pending`, `provider.charge` fuera de tx con misma key, `SELECT ... FOR UPDATE` → `paid/failed/unknown` + `UPDATE orders` + `writeOutboxEvent`.
- **Webhook:** `apps/api/src/webhook-payment.ts:1` HMAC `sha256(secret, timestamp.rawBody)` tolerance 5m, `apps/api/src/app.ts:940` `POST /v1/webhooks/payments` dedupe `inbound_payment_events` `ON CONFLICT DO NOTHING` + global `__webhookDedupe`.
- **Reconciler:** `apps/worker/src/jobs/reconcilePayments.ts:10` `SELECT ... FOR UPDATE SKIP LOCKED WHERE status IN (pending,unknown) AND updated_at < now()-5m` → `provider.getStatus` → `paid/failed`.
- **Métricas/Health:** `packages/observability/src/metrics.ts:35` `payment_unknown` gauge, `apps/api/src/health.ts:90` `checkPayments` `unknown >30m` → `degraded 503`.
- **Tests:** `packages/domain/src/payments.test.ts` 4 tests, `apps/worker/src/payments.saga.test.ts` 4 tests, `apps/api/src/payments.test.ts` 3 suites.

## Inyección

### Unit sin Docker (CI)

```bash
# Dominio: state machine + key determinista
pnpm --filter @platform/domain test src/payments.test.ts
# Worker saga: FakeProvider idempotencia y kill-mid-tx
pnpm --filter @platform/worker test src/payments.saga.test.ts
# API isolation + webhook HMAC + dedupe
pnpm --filter @platform/api test src/payments.test.ts
```

### Kill mid-tx simulado (app/worker)

```js
// payments.saga.test.ts:18
const fake = new FakePaymentProvider({mode:'always_paid'});
fake.failNextChargeAfterProvider = true;
await fake.charge({idempotencyKey:key,...}); // throws provider_killed_after_charge, but store already has prov ref
// chargeCalls ==1
const retry = await fake.charge({idempotencyKey:key,...}); // idempotent hit
expect(fake.chargeCalls).toBe(1); // no double charge
```

En `processPayment` real, el primer intento hace `provider.charge` → store side-effect → throw → persiste `unknown` con `last_error`. El retry siguiente ve `pending/unknown` + misma `provider_key` → `FakeProvider` retorna `already stored` sin incrementar `chargeCalls` → segunda tx actualiza a `paid`.

### Concurrencia tenant-isolada

```bash
# 50 VUs no aplica aquí (es para inventory), pero para pagos:
# - Tenant A crea order 1999, tenant B crea order 1999 con mismos amount → providerKey distinto (tenant prefix)
# Ver payments.test.ts: acme order invisible para contoso (404)
```

### Webhook

```bash
# 1. Crear payload y firma
TS=$(date +%s)
BODY='{"eventId":"evt_1","providerRef":"prov_abc","status":"paid","tenantId":"tenant-acme"}'
SIG=$(echo -n "$TS.$BODY" | openssl dgst -sha256 -hmac "test_webhook_secret" | cut -d' ' -f2)
curl -X POST http://localhost:4000/v1/webhooks/payments -H "x-webhook-timestamp:$TS" -H "x-webhook-signature:v1,$SIG" -d "$BODY"
# 2. Reenviar mismo eventId 3x -> 1 efecto
# 3. Firma tampered -> 401 signature_mismatch
# 4. Timestamp >5m -> 401 timestamp_tolerance
```

### Reconciler

```bash
# En DB real (testcontainers):
psql -c "update payment_attempts set updated_at = now() - interval '6 minutes', status='pending' where id='$ID';"
# esperar tick 2m o llamar reconcilePayments(db, fake)
# fake.getStatus retorna paid -> payment_attempt pasa a paid, order a paid, outbox payment.reconciled_paid
```

## Señal esperada

- **Anti-doble-cobro:** `FakePaymentProvider.chargeCalls ==1` tras `kill` + retry. `providerRef` estable. `payment_attempt.provider_ref` único.
- **Estado final:** tras retry o webhook o reconciler, `payment_attempt.status == 'paid'` y `orders.status == 'paid'` (no `pending_payment`). `failed` deja `orders.status='failed'` y permite liberar `inventory_reservations`.
- **Unknown conservado:** si `provider.charge` timeout → `payment_attempt.status='unknown'`, `orders` permanece `pending_payment`, **no** se consume reserva, `metrics.payment_unknown ==1`.
- **Dedupe webhook:** `POST /v1/webhooks/payments` 1º `200 {status:processed}`, 2º mismo `eventId` → `200 {status:already_processed}`, `inbound_payment_events` 1 fila, `payment_attempt` actualizado 1 vez.
- **HMAC:** tampered body o secret erróneo → `401 Unauthorized signature_mismatch`; timestamp >5m → `401 timestamp_tolerance`.
- **Tenant isolation:** `GET /v1/payments/:id` de otro tenant → `404` (no `403` para no filtrar existencia), `POST /v1/orders` de acme no visible en `GET /v1/orders` de contoso.
- **Health:** `GET /health/ready` → `payments:ok` si no hay `unknown` viejo; si `unknown` >30m → `payments:fail unknown 1 oldest 1805s` y readiness `degraded`.
- **Métricas:** `curl /metrics | grep payment` → `payment_pending`, `payment_unknown`.
- **Outbox:** `payment.created`, `payment.paid`, `order.paid` etc. en `outbox_events` con `tenant_id` correcto; `inbound_payment_events` con `tenant_id,event_id` único.

## Recuperación

- **Retry automático:** `processPayment` segunda tx usa `SELECT ... FOR UPDATE` y `canTransition`; si `curStatus` ya es `paid`, retorna `deduped:true` sin llamar provider. `withDedup` (`processed_jobs`) también evita re-ejecutar handler si `jobId=sha256(tenant:attemptId:payment.charge)` ya procesado.
- **Webhook replays:** reenviar mismo webhook con mismo `eventId` es `already_processed` sin efecto adicional. Cambiar `eventId` pero mismo `providerRef` → `UPDATE payment_attempt` idempotente (segunda actualización con mismo `target` es no-op).
- **Reconciler:** `pending >5m` consulta `provider.getStatus(providerRef)`. Si PSP dice `paid`, `UPDATE payment_attempts SET paid` + `UPDATE orders SET paid`. Si dice `failed`, libera reserva. Si sigue `unknown` >30m, alerta y runbook `payment-unknown.md` describe consulta manual a PSP dashboard con `provider_ref`.
- **Compensación manual:** nunca `DELETE` payment_attempt; si cobro fue erróneo y `paid` definitivo pero orden debe cancelarse, crear reembolso (`billing:manage` futuro) y `UPDATE orders SET cancelled` sin tocar `payment_attempt` (audit). Si `unknown` y PSP no responde en horas, decidir `failed` manual y `released` reserva.

## Evidencia 2026-09-01

**Unit (CI sin DB):**

```
✓ payments state machine > defines 5 statuses (3ms)
✓ payments state machine > allows valid transitions and blocks invalid (1ms)
✓ payments state machine > providerIdempotencyKey deterministic (1ms)
✓ payments state machine > shouldReconcile >5m (1ms)
✓ payments saga anti-double-charge > FakeProvider is idempotent via providerKey (2ms)
✓ payments saga anti-double-charge > kill after charge does not double charge (1ms)
✓ payments saga anti-double-charge > different tenants produce different providerRefs (1ms)
✓ payments saga anti-double-charge > unknown -> reconciler resolve (1ms)
✓ payments saga — tenant isolation + webhook > POST /v1/orders creates order+payment same tx (40ms)
✓ payments saga — tenant isolation + webhook > webhook HMAC invalid ->401, tolerance, dedupe (30ms)
✓ payments saga — tenant isolation + webhook > GET /v1/payments/:id tenant-isolated (10ms)
```

`pnpm --filter @platform/domain test src/payments.test.ts` → 4 passed
`pnpm --filter @platform/worker test src/payments.saga.test.ts` → 4 passed
`pnpm --filter @platform/api test src/payments.test.ts` → 3 passed
`pnpm lint/typecheck/build` verde, `pnpm openapi:check` 25 paths/28 schemas hash `fd0fe0b9ed98`.

**Métricas/Health (local sin DB real):**

```
curl -s http://localhost:4000/metrics | grep payment
# payment_unknown 0
# payment_pending 0
curl -s http://localhost:4000/health/ready | jq .dependencies
# payments skip (sin DATABASE_URL) -> readiness ok
# Con DATABASE_URL y unknown >30m -> payments fail oldest 1800s -> degraded
```

**DB real pendiente:**

- `testcontainers` Postgres 16 para `processPayment` + `reconcilePayments` con `FOR UPDATE SKIP LOCKED` concurrente y RLS `FORCE`.
- `k6` pago concurrente 20 VUs misma orden no debe duplicar charge (usar `Idempotency-Key` header futuro).

## Aprendizaje

- `provider_key` debe incluir `tenantId:orderId:amount:currency` para que diferentes montos no colisionen y el retry no reuse key de monto distinto (evita `amount` tampering).
- `unknown` explícito es load-bearing: sin él, un timeout se marcaría `failed` y liberaría reserva prematuramente, o `paid` y completaría orden sin confirmación. La saga mantiene `unknown` y conserva reserva hasta evidencia.
- HMAC debe verificarse **antes** de `JSON.parse` (usar `rawBody`); en Fastify se requiere `fastify-raw-body` o capturar `request.rawBody` en `onRequest`. Nuestra demo usa `JSON.stringify(body)` canónico por simplicidad, pero prod debe usar bytes exactos.
- `inbound_payment_events` dedupe por `(tenant_id,event_id)` evita doble efecto incluso si PSP reenvía webhook tras `200`.
- `SKIP LOCKED` en reconciler permite múltiples workers sin pelear por mismas filas `pending` stale.
- Próximo paso: exponer `Idempotency-Key` header en `POST /v1/orders` para que cliente externo también tenga idempotencia local además de `provider_key` del proveedor.
