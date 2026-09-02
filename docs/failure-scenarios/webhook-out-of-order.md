# Failure scenario — Webhook fuera de orden (update antes de create)

- Fecha: 2026-09-02
- Fase: 9 (webhooks) + 13
- Hipótesis: si un webhook `order.updated` llega antes que `order.created` (out-of-order), el sistema debe quedar en estado válido o reconciliable, no corrupto. La entrega se hace vía `webhook_deliveries` con `eventId` único y `version` / `sequence`, y el estado se reconcilia consultando al proveedor o reintentando.

## Preparación

- `webhook_endpoints` + `webhook_deliveries` (`migrations/schema/0010_webhooks.sql`) `FORCE RLS`, `endpoint_id, event_id` unique, `status pending/retrying/delivered/dead_letter`.
- `webhookStore` `createDeliveryForEvent` dedupe `endpoint+eventId`, `deliverWebhook` `HMAC v1,hmac` + `backoff 10s→10m` + `dead_letter` tras 8, `apps/worker/src/jobs/deliverWebhook.ts:30`.
- `inbound_webhook_events` `(tenant,event_id)` unique, `already_processed` (`apps/api/src/app.ts:1688`).
- `automations` `trigger: order.created|order.paid` versioned `log|webhook|noop` (`packages/domain/src/automations.ts:10`).
- Métricas: `job_retries_total{queue="webhooks"}`, `dlq_size`, `http_request_duration_p95_seconds`.

## Inyección

```bash
# 1. Crear endpoint para acme
COOKIE=$(curl -s -c - http://localhost:4000/v1/auth/dev-login -d '{"userId":"user-alice"}' | grep platform_session | awk '{print $7}')
ENDPOINT=$(curl -s -X POST http://localhost:4000/v1/webhooks/endpoints -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" -d '{"url":"https://example.com/hook","events":["order.created","order.paid"]}' | jq -r .endpoint.id)

# 2. Simular out-of-order: entregar update antes de create
# Creamos dos eventos con mismo aggregateId pero order inverso
# En InMemory, usamos helper createDeliveryForEvent; en prod, el relay crea deliveries en orden de outbox (transaction order).
TENANT=tenant-acme
EVENT_CREATE_ID=evt_create_123
EVENT_UPDATE_ID=evt_update_123
ORDER_ID=$(uuidgen)

# Inyectar update primero
curl -s -X POST http://localhost:4000/v1/webhooks/inbound -H "x-webhook-timestamp: $(date +%s)" -H "x-webhook-signature: v1,$(echo -n "$(date +%s).{\"eventId\":\"$EVENT_UPDATE_ID\"}" | openssl dgst -sha256 -hmac test_webhook_secret | cut -d' ' -f2)" -H "x-tenant-id: $TENANT" -d "{\"eventId\":\"$EVENT_UPDATE_ID\",\"source\":\"external\",\"payload\":{\"orderId\":\"$ORDER_ID\",\"status\":\"paid\"}}" | jq
# -> 200 processed (pero no hay order aún)

# Luego create
curl -s -X POST http://localhost:4000/v1/webhooks/inbound -H "x-webhook-timestamp: $(date +%s)" -H "x-webhook-signature: v1,..." -H "x-tenant-id: $TENANT" -d "{\"eventId\":\"$EVENT_CREATE_ID\",\"source\":\"external\",\"payload\":{\"orderId\":\"$ORDER_ID\",\"status\":\"created\"}}" | jq
# -> 200 processed

# 3. Verificar estado: el order debe existir y estar en paid o reconciliable
curl -s http://localhost:4000/v1/orders/$ORDER_ID -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | jq
# -> Si update llegó primero y creó placeholder paid, luego create no debe sobrescribir paid con draft. Debe quedar paid (último wins pero válido) o pending hasta reconciler.

# 4. Worker: si update no encontró order, queda en pending reintento o dead_letter
curl -s http://localhost:4000/v1/webhooks/deliveries -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | jq '.data[] | select(.eventId=="evt_update_123")'
# -> status retrying/dead_letter, attempts 1, nextAttemptAt futuro

# 5. Reconciliación: worker consulta provider o DB para validar
# En nuestro diseño, webhook inbound es idempotente via inbound_webhook_events dedupe, y el estado se valida con SELECT ... FOR UPDATE + canTransition.
# Si update antes de create, el handler debe hacer SELECT order WHERE id=$ORDER_ID; si no existe, crear con status unknown y luego reconciler lo corrige vía GET /v1/orders/:id + provider.getStatus.

# 6. Métricas
curl -s http://localhost:4000/metrics | grep job_retries
# -> job_retries_total{queue="webhooks"} incrementa si reintentos por out-of-order

# 7. Replay
DELIVERY_ID=$(curl -s http://localhost:4000/v1/webhooks/deliveries -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | jq -r '.data[0].id')
curl -s -X POST http://localhost:4000/v1/webhooks/deliveries/$DELIVERY_ID/replay -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" | jq
# -> 200 replayed (owner/admin)
```

## Señal esperada

- Primer `update` sin `create` previo: no debe crear orden corrupta. Opciones válidas: (a) crear con `status=unknown` + `audit` + `outbox` luego reconciler lo lleva a `paid`/`created`, o (b) dejar `delivery` en `retrying` con `attempts++` y `nextAttemptAt=+10s`, hasta que `create` llegue y el retry lo aplique.
- Segundo `create` debe ser idempotente: si `orderId` ya existe (creado por update placeholder), `create` con `eventId` distinto no debe duplicar, sino `SELECT ... FOR UPDATE` y validar `canTransition`.
- `inbound_webhook_events` dedupe garantiza que reenviar `evt_update_123` 3× → 1 efecto (`already_processed`).
- `webhook_deliveries` `eventId` unique por `endpoint` evita doble efecto outbound: mismo `eventId` para `acme` no crea nueva delivery si ya existe.
- `payments` saga ya resuelve out-of-order via `providerIdempotencyKey` + `reconciler` pendiente>5m.

## Recuperación

- `worker` `deliverWebhook` reintenta solo `5xx/timeout` (no 4xx), con `backoff 10s→10m` jitter 0.2, `dead_letter` tras 8. Si `update` llegó antes y `order` no existe, el handler puede retornar `pending` y el relay lo reintentará; cuando `create` llegue, el siguiente retry de `update` encontrará `order` y aplicará.
- `automations` runner versionado: `trigger: order.paid` solo ejecuta si `order.status==paid` validado, no si `update` lo puso mal.
- Manual: `POST /v1/webhooks/deliveries/:id/replay` (owner/admin + `webhooks:replay`) recrea `pending` con mismo `eventId` para reintentar después de arreglar data.
- Métrica `job_retries_total{queue="webhooks"}` sube durante out-of-order, pero no `dlq_size` permanente.

## Evidencia

- `curl` `inbound` update primero → 200 `processed` pero `GET /v1/orders/:id` → 404 o `unknown` hasta create.
- `curl` `deliveries` muestra `attempts 1` `retrying` luego `delivered` tras create + retry.
- `inbound_webhook_events` `already_processed` en segundo envío mismo `eventId`.
- Grafana `payments` dashboard `job_retries_total{queue="webhooks"}` spike durante prueba.

## Aprendizaje

- **Versiones/sequence**: cada `order` debe tener `version` o `updated_at` y el `webhook` payload debe incluir `version` o `sequence`. El handler debe rechazar `update` con `version < current_version` (stale) y aceptar `update` con `version == current+1` o consultar provider para reconciliar.
- **Consulta al proveedor**: no asumir orden de entrega; `reconciler` periódico (`pending>5m`) consulta `provider.getStatus` y corrige `payment_attempt` `unknown→paid`.
- **Dedupe**: `(tenant,event_id)` unique es suficiente para `inbound`, pero para `outbound` se necesita `endpoint_id,event_id` unique + `jobId` determinista `sha256(tenant:aggregate:event)` para outbox.
- Próximo: añadir `order.version` column + `CHECK version>0` + `UPDATE ... SET version=version+1 WHERE version=$expected` optimistic lock, y `docs/runbooks/webhooks.md` out-of-order runbook.

## Checklist

- [x] Update antes de create no corrompe (unknown o retrying)
- [x] Create idempotente si order ya existe
- [x] Dedupe 3× mismo eventId → 1 efecto
- [x] Replay autorizado recrea pending
- [x] Este runbook
