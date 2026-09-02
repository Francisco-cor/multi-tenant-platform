# Failure scenario — Webhooks y automatizaciones (Fase 9)

- **Fecha:** 2026-09-01
- **Fase:** 9 (PLAN_ELEVACION.md:329, IMPLEMENTATION_PLAN.md:378)
- **Hipótesis:** reenviar el mismo `eventId` 3 veces, entrega con firma tampered, o caída del receptor no debe duplicar efectos, filtrar datos entre tenants, ni bloquear transacción de negocio. `retry` solo para errores transitorios, `dead_letter` tras 8, `replay` auditado restaura `pending` sin perder trazabilidad. Automatizaciones solo comandos versionados.

## Preparación

- **Modelo:** `migrations/schema/0010_webhooks.sql:1` `webhook_endpoints(tenant_id,url unique, secret_hash, events, status)` + `webhook_deliveries(endpoint_id,event_id unique, status, attempts, next_attempt_at)` + `inbound_webhook_events(tenant_id,event_id unique)` + `api_keys(prefix unique, hash, scopes)` + `automations(trigger, action versioned)` `FORCE RLS`.
- **Dominio:** `packages/domain/src/automations.ts:10` `validateAutomation` rechaza `invalid.trigger` y `eval`.
- **API:** `apps/api/src/webhook-store.ts:1` `InMemoryWebhookStore`/`PersistentWebhookStore` con `FOR UPDATE SKIP LOCKED`, `apps/api/src/api-key-store.ts:1` `InMemoryApiKeyStore`, `apps/api/src/app.ts` `POST /v1/webhooks/endpoints` (https allowlist, events allowlist, 409 duplicate), `GET /v1/webhooks/endpoints|deliveries` tenant-scoped 404, `POST /v1/webhooks/deliveries/:id/replay` (`webhooks:replay`), `POST /v1/webhooks/inbound` HMAC 5m dedupe, `POST /v1/api-keys`, `POST /v1/automations` versioned.
- **Worker:** `apps/worker/src/jobs/deliverWebhook.ts:1` `computeSignature(secret,timestamp,payload)` `HMAC sha256`, `backoff 10s→10m jitter 0.2`, `isTransient` solo `5xx|429|network`, `dead_letter` tras 8, `endpoint failure_count>=5 → dead_letter`.
- **Métricas:** no se loguea `secret` ni `raw` payload completo; `GET /metrics` expone `job_retries_total{queue="webhooks"}` si se integra con DLQ.
- **Tests:** `apps/api/src/webhooks.test.ts:1` 4 suites, `apps/worker/src/webhooks.delivery.test.ts:1` 5 tests, `packages/domain/src/automations.test.ts:1` 4 tests.

## Inyección

### Unit sin Docker

```bash
pnpm --filter @platform/api test src/webhooks.test.ts
# - CRUD https/event allowlist, 409 duplicate, operator 403, cross-tenant 404
# - Deliveries: create 1, duplicate eventId no new, replay ->2, cross-tenant 0/404
# - Inbound: same eventId 3x ->1 processed +2 already_processed, tampered 401, expired 401
# - Api-keys: operator 403, owner create 201, list tenant-scoped, revoke
# - Automations: valid log 201, invalid trigger 400, list tenant-scoped

pnpm --filter @platform/worker test src/webhooks.delivery.test.ts
# HMAC determinista, retry solo 5xx/429, backoff cap, dead_letter after 8, dedupe 3x

pnpm --filter @platform/domain test src/automations.test.ts
# trigger/version, reject eval
```

### Receptor caído (outbound)

```js
// Mock fetch that returns 500 twice then 200
let calls=0;
const fakeFetch = async () => {
  calls++;
  if (calls<3) return { ok:false, status:500, text: async()=>'error' } as Response;
  return { ok:true, status:200, text: async()=>'ok' } as Response;
};
await deliverWebhook(db, deliveryId, tenantId, {fetchFn: fakeFetch});
// attempts: 1-> retrying, 2-> retrying, 3-> delivered, failure_count reset
```

En `Persistent` real: `deliverPendingWebhooks` cada 10s reclama `pending|retrying` con `SKIP LOCKED`, `update status='retrying'` antes de fetch para evitar double process.

### Firma tampered / expirada (inbound)

```bash
TS=$(date +%s)
BODY='{"eventId":"in_1","payload":{"foo":"bar"}}'
SIG=$(echo -n "$TS.$BODY" | openssl dgst -sha256 -hmac "test_webhook_secret" | cut -d' ' -f2)
curl -X POST http://localhost:4000/v1/webhooks/inbound -H "x-webhook-timestamp:$TS" -H "x-webhook-signature:v1,$SIG" -d "$BODY" # 200
# Tamper: change foo->tampered but keep old SIG ->401
# Expired: TS=$(($(date +%s)-600)) ->401 timestamp_tolerance
```

### Duplicado / fuera de orden

```bash
# Reenviar mismo eventId 3x
for i in 1 2 3; do curl -X POST /v1/webhooks/inbound -H "x-webhook-timestamp:$TS" -H "x-webhook-signature:v1,$SIG" -d "$BODY"; done
# -> 1x processed, 2x already_processed, effectCount=1
# Fuera de orden: entrega update antes de create -> deliveries tabla permite cualquier order, pero consumer valida version/sequence si tiene timestamp
```

## Señal esperada

- **Outbound dedupe:** `endpointId`+`eventId` único: `createDeliveryForEvent` 2× mismo `eventId` → `created.length 0` segunda vez. `delivery.status` `delivered` después de `2xx`; `retrying` tras `5xx` con `next_attempt_at` futuro; `dead_letter` tras 8.
- **HMAC:** `computeSignature(secret,ts,body1) != computeSignature(secret,ts,body2)`; `same body -> same sig`; tampered `rawBody` con mismo header `signature` → `401 signature_mismatch`.
- **Inbound dedupe:** `POST /v1/webhooks/inbound` 1º `200 processed`, 2º `200 already_processed` (misma `eventId`+`tenant`), 3º `already_processed`; `inbound_webhook_events` 1 fila por `tenant,eventId`; cross-tenant `tenant-b` mismo `eventId` crea fila separada.
- **Tenant isolation:** `GET /v1/webhooks/endpoints` acme `1` vs contoso `1` distintos; `GET /v1/webhooks/endpoints/:id` cross-tenant `404`; `GET /v1/webhooks/deliveries` cross-tenant `0`; `replay` cross-tenant `404`; `api-keys` list tenant-scoped.
- **No bloqueo tx:** `webhook_deliveries` se crea **después** de `outbox` commit (vía relay), por lo que caída del receptor (`fetch` 500) no revierte `order.paid`. `orders` sigue `paid` aunque `delivery` esté `retrying`.
- **Automatizaciones:** `POST /v1/automations` con `{trigger:'order.paid', action:{type:'log'}}` → `201`; `trigger:'invalid'` → `400 automation_trigger_invalid`; `action:{type:'eval'}` → `400 automation_action_type_invalid`; `GET /v1/automations` tenant-scoped.
- **Secret redaction:** `GET /v1/webhooks/endpoints` nunca devuelve `secret` ni `secret_hash`; solo al `POST` inicial. Logs no contienen `secret` ni `raw` payload completo.

## Recuperación

- **Retry automático:** `deliverWebhook` backoff 10s→10m jitter, `retrying` con `next_attempt_at`. `deliverPendingWebhooks` con `SKIP LOCKED` permite múltiples workers sin pelear.
- **Dead letter:** tras 8 intentos `delivery.status=dead_letter`, `endpoint.failure_count++`. Si `failure_count>=5`, `endpoint.status=dead_letter` (desactivado). Corregir URL/secret, luego `POST /v1/webhooks/deliveries/:id/replay` (audit) crea nuevo `pending` con mismo `eventId` pero nuevo `id`; no borra histórico `dead_letter` para trazabilidad.
- **Inbound replay:** reenviar webhook con mismo `eventId` es `already_processed` sin efecto; para reprocesar con `eventId` nuevo, cambiar `eventId` y re-firmar. No hay `replay` para inbound (solo outbound), pero se puede `DELETE` dedupe manualmente en DB con `DELETE FROM inbound_webhook_events WHERE tenant_id=X AND event_id=Y` (requiere superuser, auditado).
- **Automatizaciones:** si `action` es obsoleta (`version` antigua), crear nueva automation `version:2` y desactivar vieja (`enabled:false`) — no hay migración destructiva.

## Evidencia 2026-09-01

```
✓ webhooks — tenant isolation, HMAC, dedupe, replay > CRUD webhook endpoints tenant-scoped + URL https + events allowlist 386ms
✓ webhooks — tenant isolation, HMAC, dedupe, replay > webhook deliveries: eventId uniqueness + replay tenant-scoped 120ms
✓ webhooks — tenant isolation, HMAC, dedupe, replay > inbound webhook HMAC dedupe: same eventId 3x ->1 effect, tampered ->401 80ms
✓ webhooks — tenant isolation, HMAC, dedupe, replay > api-keys M2M tenant-scoped + automations versioned 150ms
✓ webhooks delivery HMAC and retry > signature changes if body changes 5ms
✓ webhooks delivery HMAC and retry > retry only on transient errors 2ms
✓ webhooks delivery HMAC and retry > backoff grows exponentially 1ms
✓ webhooks delivery HMAC and retry > dead_letter after 8 attempts 1ms
✓ webhooks delivery HMAC and retry > inbound dedupe: same eventId 3x ->1 effect 1ms
✓ automations versioned commands > validates trigger and version 2ms
✓ automations versioned commands > rejects invalid trigger or unsupported version 1ms
✓ automations versioned commands > rejects arbitrary code — only versioned types allowed 1ms
✓ automations versioned commands > defaults to version 1 when not provided 1ms
```

`pnpm --filter @platform/api test src/webhooks.test.ts` → 4 passed, `pnpm --filter @platform/worker test src/webhooks.delivery.test.ts` →5 passed, `pnpm --filter @platform/domain test src/automations.test.ts` →4 passed. `pnpm lint/typecheck/build` verde, `pnpm openapi:check` 34 paths 44 schemas `ee30104321ce`.

## Aprendizaje

- `endpointId+eventId` único + `tenant_id` en índice evita hot spot global y permite `SELECT ... FOR UPDATE SKIP LOCKED` por tenant sin lock convoy.
- HMAC debe incluir `timestamp.payload` (no solo payload) para evitar replay infinito; `tolerance 5m` balancea clock skew y ventana de replay.
- `4xx` no reintentable evita bucle infinito cuando `url` mal configurada (ej. `403` por auth); solo `5xx|429|network` reintenta.
- Secret nunca en `GET`; rotación requiere `PATCH /v1/webhooks/endpoints/:id` con nuevo `secret` (hash) e incrementar `version`.
- Automatizaciones como objetos versionados evitan RCE; `type: webhook` es el único que sale de la plataforma, con `url` validada https.
- Próximo paso: `api_keys` auth middleware `X-Api-Key: prefix.raw` para M2M, y exponer `GET /v1/webhooks/deliveries?status=dead_letter` para dashboard.
