# ADR-008: Webhooks — entrega fiable, HMAC y dedupe, automatizaciones versionadas

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: Fase 9 (PLAN_ELEVACION.md:329, IMPLEMENTATION_PLAN.md:378), `packages/db/migrations/schema/0010_webhooks.sql`, `apps/api/src/webhook-store.ts`, `apps/worker/src/jobs/deliverWebhook.ts`, `packages/domain/src/automations.ts`

## Contexto

La plataforma debe integrarse con sistemas externos bajo entrega duplicada, tardía o fuera de orden, sin bloquear la transacción de negocio y sin exponer secretos. Opciones:

1. **Sin firma ni dedupe**: receptor no puede verificar autenticidad; reintentos duplican efectos.
2. **Firma HMAC + dedupe + backoff + DLQ**: cada entrega es verificable, idempotente y observable.
3. **Cola sin estado**: reintentos infinitos sin límite, sin `dead_letter`, sin replay auditado.

Elegir (2). Además, automatizaciones deben ser comandos versionados, no `eval` de código arbitrario.

## Decisión

### Modelo

- `webhook_endpoints` (`id uuid PK`, `tenant_id FK`, `url text https://`, `secret_hash text sha256`, `events jsonb`, `status active|disabled|dead_letter`, `version`, `failure_count`, `created_by`) — `FORCE RLS`, `UNIQUE(tenant_id,url)`, índice `tenant,status` y `GIN(events)`.
- `webhook_deliveries` (`id uuid PK`, `tenant_id FK`, `endpoint_id FK`, `event_id text`, `event_type`, `payload jsonb`, `status pending|retrying|delivered|failed|dead_letter|disabled`, `attempts`, `last_error`, `next_attempt_at`, `delivered_at`) — `FORCE RLS`, `UNIQUE(endpoint_id,event_id)`, índice parcial `WHERE status IN ('pending','retrying')` sobre `(tenant_id,status,next_attempt_at)` para worker.
- `inbound_webhook_events` (`id uuid PK`, `tenant_id FK`, `event_id text`, `source`, `payload jsonb`, `processed_at`) — `FORCE RLS`, `UNIQUE(tenant_id,event_id)` dedupe inbound.
- `api_keys` (`id uuid PK`, `tenant_id FK`, `prefix text UNIQUE 8ch`, `hash sha256`, `scopes jsonb`, `name`, `expires_at`, `revoked_at`) — `FORCE RLS`, M2M tenant-scoped `X-Api-Key: prefix.raw`.
- `automations` (`id uuid PK`, `tenant_id FK`, `trigger` enum `order.created|order.paid|...`, `action jsonb {version,type,params}`, `version`, `enabled`) — `FORCE RLS`, índice `WHERE enabled=true` sobre `(tenant_id,trigger)`. `action` es objeto versionado, nunca código.

### Flujo outbound

1. **Write**: negocio + `outbox_events` en misma tx (p.ej. `order.paid`). Outbox relay ya publica a queue `webhooks`.
2. **Enqueue deliveries**: worker o API al procesar `order.paid` crea `webhook_deliveries` por cada `webhook_endpoints` activo cuyo `events` contiene `order.paid` o `*`. Es tenant-scoped.
3. **Deliver**: `apps/worker/src/jobs/deliverWebhook.ts:30` `deliverWebhook` con `SELECT ... FOR UPDATE` en delivery, `SELECT endpoint`, HMAC `sha256(secret, timestamp.payload)` con `X-Webhook-Timestamp` (segundos) + `X-Webhook-Signature: v1,hmac` + `X-Webhook-Event-Id`. `fetch` POST con timeout. Si `2xx` → `delivered` + `failure_count=0`; si `5xx|429|network` → `retrying` + `attempts++` + `next_attempt_at = now()+backoff(10s→10m jitter 0.2)`; si `4xx` (no 429) → `failed` sin retry; tras 8 intentos `dead_letter`; si endpoint `failure_count>=5` → `endpoint.status=dead_letter`.
4. **Replay**: `POST /v1/webhooks/deliveries/:id/replay` (requiere `webhooks:replay` + `owner/admin`) crea nuevo `delivery` con mismo `event_id` pero nuevo `id` y `pending`, `INSERT` + `writeOutboxEvent(webhook.replayed)` + audit.

### Flujo inbound

1. **Verify**: `POST /v1/webhooks/inbound` y `POST /v1/webhooks/payments` verifican `HMAC` antes del parse lógico y exigen `tenantId` dentro del cuerpo firmado. Hoy el runtime usa `JSON.stringify(body)` canónico; migrar a bytes HTTP exactos es un gate de producción. Secret nunca en logs/UI.
2. **Dedupe**: `INSERT inbound_payment_events(tenant_id,event_id) ON CONFLICT DO NOTHING`; en pagos, el insert y la transición/outbox comparten transacción. El `Set` en memoria solo es una optimización de proceso, no la fuente de verdad persistente.
3. **Effect**: solo si dedupe miss, aplica efecto idempotente (actualiza `payment_attempt` o dispara automation). Reenvío 3× mismo `eventId` → 1 efecto.

### Automatizaciones

- `packages/domain/src/automations.ts:10` `AUTOMATION_TRIGGERS` + `validateAutomation`: solo `type: webhook|log|noop` con `version` y `params` objeto. No `eval`, no `Function`, no `trigger` arbitrario. `version` permite evolución (`expand-contract`).
- Tenant-scoped CRUD `POST /v1/automations` + `GET /v1/automations` requieren `automations:manage/read`. Secret/params no logueados.

### Consecuencias

- **Pros:** firma cambia si cambia body, expiración 5m evita replay, dedupe garantiza `exactly once` effect con `at-least-once` delivery; `SKIP LOCKED` permite múltiples workers; `dead_letter` y `disabled` evitan hot endpoint bloqueando cola; `api_keys` M2M permite integraciones sin OIDC humano.
- **Contras:** más tablas y jobs; el hash no permite recuperar el secreto, por lo que outbound conserva `secret_ciphertext` cifrado con AES-GCM y requiere una futura integración KMS/Vault y rotación versionada/solapada.
- **Alternativa descartada:** sin firma se aceptaba `X-Webhook-Signature` tampered como válido en tests.

## Validación

- `apps/api/src/webhooks.test.ts:1` 4 suites: CRUD tenant 404/409, https allowlist, events allowlist, operator 403; deliveries dedupe `same eventId →1` + replay `pending` + cross-tenant 404; inbound `same eventId 3x → already_processed`, tampered 401, expired 401; api-keys M2M tenant list/revoke; automations versioned `log` ok, invalid trigger 400.
- `apps/worker/src/webhooks.delivery.test.ts:1` 5 tests: HMAC determinista, retry solo 5xx/429, backoff 10s→10m cap, dead_letter tras 8, dedupe 3x.
- `packages/domain/src/automations.test.ts:1` 4 tests: valid trigger/version, reject invalid/unsupported, reject eval, default version.
- `inMemory` sin Docker full coverage; `Persistent` con `FORCE RLS` + `withTenantTransaction` en `webhook-store.ts`.

## Referencias

- `migrations/schema/0010_webhooks.sql:1`,
- `packages/db/src/schema.ts` `webhookEndpoints/webhookDeliveries/inboundWebhookEvents/apiKeys/automations`,
- `apps/api/src/webhook-store.ts:1` `InMemoryWebhookStore`/`PersistentWebhookStore`,
- `apps/api/src/api-key-store.ts:1`,
- `apps/api/src/app.ts` `POST /v1/webhooks/endpoints|deliveries|inbound|api-keys|automations`,
- `apps/worker/src/jobs/deliverWebhook.ts:1` `deliverWebhook` + `deliverPendingWebhooks`,
- `packages/domain/src/automations.ts:1`,
- `docs/api/openapi.yaml` 34 paths 44 schemas `ee30104321ce`.
