# Runbook — Webhooks y automatizaciones (Fase 9)

## Objetivo

Operar endpoints, entregas, inbound dedupe y automatizaciones sin exponer secretos ni filtrar datos entre tenants.

## Contratos

- **Endpoints outbound**: `POST /v1/webhooks/endpoints` `{url:https://, events:[order.paid,...], secret?}` → `{endpoint, secret}` (secret solo al crear). `GET /v1/webhooks/endpoints` lista tenant-scoped. `PATCH /v1/webhooks/endpoints/:id` `{url,events,status}` versionado. `DELETE` → `status deleted`. Requiere `webhooks:manage` (owner/admin/manager no, operator no). `url` must https, `events` subset de `order.created|order.paid|payment.paid|file.ready|inventory.reserved|generic`.
- **Entregas**: `GET /v1/webhooks/deliveries?endpointId=&limit=` tenant-scoped (`webhooks:read`). `GET /v1/webhooks/deliveries/:id` → `{id,endpointId,eventId,eventType,status,attempts}` sin secret. `POST /v1/webhooks/deliveries/:id/replay` → nuevo `pending` con mismo `eventId`, requiere `webhooks:replay` + `owner/admin` + audit `webhookReplay`. Estados: `pending|retrying|delivered|failed|dead_letter|disabled`.
- **Inbound**: `POST /v1/webhooks/inbound` headers `X-Webhook-Timestamp` (sec) + `X-Webhook-Signature: v1,hmac` + `X-Tenant-Id`, body `{eventId, source?, payload}`. Verificación `HMAC sha256(secret, timestamp.rawBody)` antes de parse, tolerance 5m. Dedupe `inbound_webhook_events(tenant_id,event_id) UNIQUE` → `already_processed`. Secret nunca en logs/UI.
- **Api keys M2M**: `POST /v1/api-keys` `{name, scopes:[webhooks:read], expiresInMs?}` → `{apiKey:{id,prefix,name,scopes}, raw:pk_...}`. `GET /v1/api-keys` lista, `DELETE /v1/api-keys/:id` revoke. Requiere `webhooks:manage` + `owner/admin`. Scopes subset de `webhooks:read|orders:read|...`.
- **Automatizaciones**: `POST /v1/automations` `{trigger:order.paid, action:{type:log|webhook|noop, params:{}}, version:1}` validado `validateAutomation`, `GET /v1/automations` tenant-scoped. No `eval`, solo objetos versionados. Requiere `automations:manage/read`.

## Verificación rápida

```bash
# 1. Crear endpoint (acme)
COOKIE=$(curl -s -c - http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-alice"}' | grep platform_session | awk '{print $7}')
# Si alice tiene 2 tenants, seleccionar acme
curl -s -X POST http://localhost:4000/v1/auth/switch-organization -b "platform_session=$COOKIE" -H 'content-type: application/json' -d '{"slug":"acme"}'
curl -s -X POST http://localhost:4000/v1/webhooks/endpoints \
  -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hook","events":["order.paid"]}' | jq
# -> {endpoint:{id,url,events}, secret:"..."}  (guardar secret)

# 2. Listar (contoso no ve acme)
curl -s http://localhost:4000/v1/webhooks/endpoints -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq .data[0].id
curl -s http://localhost:4000/v1/webhooks/endpoints -H 'host: contoso.app.localhost' -H "cookie: $COOKIE" | jq # 404 tenant

# 3. Simular delivery (via helper o worker): si order.paid, worker crea delivery pending
curl -s http://localhost:4000/v1/webhooks/deliveries -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq

# 4. Replay (owner)
DELIVERY_ID=$(curl -s http://localhost:4000/v1/webhooks/deliveries -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq -r .data[0].id)
curl -s -X POST http://localhost:4000/v1/webhooks/deliveries/$DELIVERY_ID/replay -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq

# 5. Inbound dedupe
TS=$(date +%s)
BODY='{"eventId":"in_1","source":"external","payload":{"foo":"bar"},"tenantId":"tenant-acme"}'
SIG=$(echo -n "$TS.$BODY" | openssl dgst -sha256 -hmac "test_webhook_secret" | cut -d' ' -f2)
curl -s -X POST http://localhost:4000/v1/webhooks/inbound \
  -H "x-webhook-timestamp: $TS" -H "x-webhook-signature: v1,$SIG" -H "x-tenant-id: tenant-acme" -H 'content-type: application/json' -d "$BODY" | jq
# 2nd time same eventId -> already_processed
curl -s -X POST http://localhost:4000/v1/webhooks/inbound \
  -H "x-webhook-timestamp: $TS" -H "x-webhook-signature: v1,$SIG" -H "x-tenant-id: tenant-acme" -H 'content-type: application/json' -d "$BODY" | jq

# 6. Api keys
curl -s -X POST http://localhost:4000/v1/api-keys -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"name":"ci","scopes":["webhooks:read"]}' | jq
curl -s http://localhost:4000/v1/api-keys -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq
```

## Flujo outbox → webhook

1. Negocio escribe `outbox_events` (p.ej. `order.paid`) en misma tx que `orders`.
2. Relay publica a queue `webhooks` con `jobId` determinista.
3. Worker handler crea `webhook_deliveries` por cada endpoint suscrito (tenant-scoped) con `pending`.
4. `deliverWebhook` firma y POST, maneja `2xx` vs `5xx|429` vs `4xx`, backoff 10s→10m jitter, tras 8 intentos `dead_letter`, endpoint `failure_count>=5` → `dead_letter`.

## Fallos y recuperación

| Señal | Causa | Recuperación |
|---|---|---|
| `webhook_deliveries retrying` | Receptor 5xx/timeout | Worker reintenta con backoff exponencial, no bloquea tx. Ver `deliverWebhook.ts:80` logs. |
| `dead_letter` | 8 fallos consecutivos | Inspeccionar `last_error`, corregir URL/secret, `POST /v1/webhooks/deliveries/:id/replay` auditado. |
| `endpoint dead_letter` | 5 deliveries `failure_count` | `PATCH /v1/webhooks/endpoints/:id {status:active}` tras arreglar receptor. |
| `401 signature_mismatch` inbound | Secret rotado o body tampered | Verificar `WEBHOOK_INBOUND_SECRET` y que `rawBody` sea bytes exactos antes de parse (en demo `JSON.stringify`). |
| `401 timestamp_tolerance` | Clock skew >5m | Sincronizar NTP. |
| `403 Forbidden` en `/v1/webhooks/endpoints` | Operator sin `webhooks:manage` | Asignar `manager`/`admin` vía `PATCH /v1/members/:id`. |
| `Cross-tenant 404` | Intento de leer delivery de otro tenant | RLS + `WHERE tenant_id` → 404 idéntico a no existe, no filtra existencia. |

## Observabilidad

- `GET /metrics` → `dlq_size`, `job_retries_total{queue="webhooks"}` (si se usa DLQ para webhooks), `webhook` logs con `endpointId` hash.
- `GET /health/ready` no incluye webhooks por ahora, pero `webhook_deliveries` `dead_letter` visible en `GET /v1/webhooks/deliveries?status=dead_letter` (filtro futuro).
- Audit: `webhookCreated`, `webhookReplay`, `apiKeyCreated` via `membership.role_changed` con `resourceId` (mejora futura: acción específica).

## Estado actual (2026-09-01)

- InMemory: full coverage sin Docker. Persistent: `webhook_endpoints`+`webhook_deliveries`+`inbound_webhook_events`+`api_keys`+`automations` `FORCE RLS`, `webhook-store.ts` `InMemory`/`Persistent` con `FOR UPDATE SKIP LOCKED`, `deliverWebhook.ts` HMAC + backoff + dead_letter, `automations` versioned, `webhooks.test.ts` 4 suites.
- Evidencia: `webhooks.test.ts` CRUD 403/404/409, events allowlist, deliveries replay cross-tenant 404, inbound 3x dedupe + tampered 401 + expired 401, api-keys tenant isolation + revoke, automations versioned.
- Pendiente: integración real con `testcontainers` Postgres + `fetch` mock para `deliverWebhook` con receptor efímero (http server), y `k6` para webhook hot-tenant.
