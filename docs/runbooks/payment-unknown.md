# Runbook — Pagos inciertos `unknown` y reconciliación (Fase 8)

## Objetivo

Recuperar pagos en estado `pending`/`unknown` sin duplicar cobro, liberar o mantener reserva correctamente y restaurar consistencia `payment_attempt` ↔ `orders`.

## Contratos

- `orders` y `payment_attempts(created)` en misma tx (`payment-store.ts:40` `withTenantTransaction` + `provider_key = sha256(tenant:order:amount:currency)`). `provider_key UNIQUE` evita inserción duplicada aunque reintente el `INSERT`.
- `payment_attempt` estados `created→pending→paid|failed|unknown`, `unknown→paid|failed` solo vía reconciler (`packages/domain/src/payments.ts:10` `canTransition`).
- Worker `processPayment` (`apps/worker/src/jobs/processPayment.ts:30`) cobra con `provider.charge({idempotencyKey: provider_key})` idempotente; segundo intento con misma key no cobra de nuevo (`FakePaymentProvider:40` `store.get(providerKey)` hit).
- Webhook `POST /v1/webhooks/payments` HMAC `sha256(secret, timestamp.rawBody)` tolerance 5m, dedupe `inbound_payment_events(tenant_id,event_id) UNIQUE` + in-memory `__webhookDedupe`.
- Reconciler `reconcilePayments` cada 2m `SELECT ... FOR UPDATE SKIP LOCKED WHERE status IN ('pending','unknown') AND updated_at < now()-5m` → `provider.getStatus(provider_ref)` → `paid/failed/unknown` + `metrics.payment_unknown`.
- Health `GET /health/ready` incluye `payments` check: `unknown` con `oldest >30m` → `degraded 503` (`health.ts:149`).
- `GET /metrics` expone `payment_unknown` gauge y `payment_pending` gauge.

## Verificación rápida

```bash
# 1. Crear orden+payment (pending_payment)
curl -s -X POST http://localhost:4000/v1/orders \
  -H 'host: acme.app.localhost' -H 'cookie: $COOKIE' -H 'content-type: application/json' \
  -d '{"branchId":"branch-acme-main","amountCents":1999}' | jq
# -> {order:{id,status:pending_payment}, paymentAttempt:{id,status:created,providerKey:sha256...}}

# 2. Trigger worker (si DB real): runOutboxRelayOnce + processPayment
# Ver provider charge es idempotente: retry con misma key no incrementa chargeCalls
curl -s http://localhost:4000/metrics | grep payment
# payment_pending 1, payment_unknown 0

# 3. Simular webhook válido
TS=$(date +%s)
BODY='{"eventId":"evt_ps_1","providerRef":"prov_abc","status":"paid","tenantId":"tenant-acme"}'
SIG=$(echo -n "$TS.$BODY" | openssl dgst -sha256 -hmac "test_webhook_secret" | cut -d' ' -f2)
curl -s -X POST http://localhost:4000/v1/webhooks/payments \
  -H "x-webhook-timestamp: $TS" -H "x-webhook-signature: v1,$SIG" -H "x-tenant-id: tenant-acme" \
  -H 'content-type: application/json' -d "$BODY" | jq
# -> {status:processed, eventId:evt_ps_1}
# Reenvío mismo eventId -> already_processed (dedupe)
curl -s -X POST http://localhost:4000/v1/webhooks/payments \
  -H "x-webhook-timestamp: $TS" -H "x-webhook-signature: v1,$SIG" -H "x-tenant-id: tenant-acme" \
  -H 'content-type: application/json' -d "$BODY" | jq
# -> {status:already_processed}

# 4. Forzar reconciler sobre pending>5m (ajustar updated_at a now-6m en DB para test)
psql $DATABASE_URL -c "update payment_attempts set updated_at = now() - interval '6 minutes' where status='pending';"
# worker log: reconciled 1 paid, metrics payment_unknown 0
# Si queda unknown >30m, health degraded:
curl -s http://localhost:4000/health/ready | jq .dependencies
# payments fail: unknown 1 oldest 1800s
```

## Señales y causas

| Señal                                             | Causa                                              | Acción                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_pending` sin decrementar                 | Worker caído o relay lag                           | `docker compose logs worker`, verifica `outbox_pending` y `processPayment` con `FakeProvider chargeCalls`. Retry es idempotente por `provider_key`.                  |
| `payment_unknown 1`                               | Proveedor timeout / `provider_killed_after_charge` | No liberar reserva; reconciler resolverá en <5m vía `getStatus`. Si permanece >30m, `health payments fail` y alerta.                                                 |
| `payment_unknown` con `oldest >30m` health `fail` | PSP caído prolongado                               | Consultar `provider.getStatus` manual, verificar `inbound_payment_events` dedupe, contactar PSP con `providerRef`. Solo `failed` libera reserva; `unknown` conserva. |
| `webhook 401 signature_mismatch`                  | Secret rotado o body tampered                      | Verificar `PAYMENT_WEBHOOK_SECRET`, que `rawBody` sea `JSON.stringify(body)` canónico, y `timestamp` dentro de 5m.                                                   |
| `webhook 401 timestamp_tolerance`                 | Clock skew >5m                                     | Sincronizar NTP, tolerancia fija 5m (`webhook-payment.ts:9`).                                                                                                        |
| Cross-tenant `GET /v1/payments/:id` 404           | Intento de enumerar payment de otro tenant         | IDs no filtrables: RLS + `WHERE tenant_id` garantiza 404 idéntico a no existe. Audit `payment.created` no expone datos sensibles.                                    |

## Recuperación

1. **Muerte post-cobro**: worker murió tras `provider.charge` pero antes de `UPDATE payment_attempt SET paid`. El `provider` ya tiene `providerRef` asociado a `provider_key`. Retry usa misma key → `FakeProvider.getStored(key)` hit → `chargeCalls` no incrementa, segundo `processPayment` ve `pending` y actualiza a `paid` + `orders.status=paid` + `outbox payment.paid` + `order.paid`. Ver `payments.saga.test.ts:18` `kill after charge does not double charge`.
2. **Webhook fuera de orden / duplicado**: `inbound_payment_events` `UNIQUE(tenant_id,event_id)` + `processed` check antes de `UPDATE payment_attempts`. Reenvío 3× mismo `eventId` → 1 efecto. Entrega `pending` antes de `created` → `SELECT pending/created` limit fallback: si solo hay un pending, se aplica al pending actual; si inválida transición, se mantiene estado y reconciler la corregirá.
3. **Reconciler no resuelve**: si `provider.getStatus` sigue `unknown` tras 3 intentos, `payment_attempt` permanece `unknown` y `metrics.payment_unknown` + `health degraded` disparan alerta. Manual: `psql` → `select * from payment_attempts where status='unknown'`, llamar a PSP dashboard con `provider_ref`, luego `update payment_attempts set status='paid'` manualmente dentro de `withTenantTransaction` y `writeOutboxEvent` para liberar inventario. Registrar en `audit_log` con `payment.webhook`.
4. **Rollback**: no hacer `DELETE` de `payment_attempt`; marcar `failed` y crear nueva `payment_attempt` con nuevo `provider_key` si reintento de pago con monto distinto. El `provider_key` incluye `orderId:amount`, por lo que nuevo monto genera nueva key sin colisionar.

## Estado actual (2026-09-01)

- InMemory: cobertura sin Docker ( `payments.test.ts` 3 suites, `payments.saga.test.ts` 4 tests). Persistent: `orders`, `payment_attempts` (`provider_key UNIQUE`), `inbound_payment_events` `FORCE RLS`, outbox `payment.*` y `order.*` en misma tx, `processPayment` con `FOR UPDATE` + `provider deterministic`, webhook HMAC 5m + dedupe, reconciler `SKIP LOCKED`, `metrics payment_unknown` y `health payments`.
- Evidencia: `packages/domain/src/payments.test.ts` transitions + `providerIdempotencyKey` + `shouldReconcile`, `apps/worker/src/payments.saga.test.ts` kill-mid-tx 1 charge, `apps/api/src/payments.test.ts` tenant isolation + HMAC 401 + dedupe.
- Pendiente: testcontainers Postgres real para `reconcilePayments` con `testcontainers` helper y `k6` para pago concurrente.
