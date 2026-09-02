# Runbook — Retención y borrado de datos (Fase 11)

## Objetivo

Definir cuánto se conserva cada dato, cómo se borra/anonymiza y cómo responder a solicitudes de privacidad (`GDPR art. 17`) sin romper `audit_log append-only`.

## 1. Clasificación

| Tabla                                                                                          | Clase         | Tenant               | Sensitive                                   | Retención lógica                                                                                                    | Borrado físico        |
| ---------------------------------------------------------------------------------------------- | ------------- | -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `users`                                                                                        | global        | —                    | PII `email`, `display_name`, `oidc_subject` | activo mientras haya membership activa; tras erase `anonymize`                                                      | `approved`            |
| `organizations`                                                                                | tenant root   | —                    | `name`, `slug`                              | activo; `deleted` indica soft-delete, purge tras 30d                                                                | `cascade`             |
| `memberships`                                                                                  | tenant-scoped | `tenant_id`          | `role`                                      | `active` mientras vigente; `removed` soft                                                                           | —                     |
| `branches`                                                                                     | tenant-scoped | `tenant_id`          | —                                           | activo/archived                                                                                                     | `cascade`             |
| `audit_log`                                                                                    | tenant-scoped | `tenant_id nullable` | `actor_user_id`, `ip`, `trace_id`           | **365 días** lógico, luego archivo S3 `audit-archive/{tenant}/{YYYY}.json.gz` + superuser truncate (bypass trigger) | `superuser only`      |
| `sessions`                                                                                     | tenant?       | `user_id`            | `token_hash`                                | `expires_at` 8h sliding + `purgeSessions` job `FOR UPDATE SKIP LOCKED` borra `< now()`                              | automático            |
| `invitations`                                                                                  | tenant-scoped | `tenant_id`          | `email`, `token_hash`                       | `expires_at` 48h + GC                                                                                               | automático            |
| `products`, `stock_per_branch`, `inventory_reservations`, `inventory_movements`                | tenant-scoped | `tenant_id`          | —                                           | reservas `active` expiran 15m; movements `append-only` 90d luego archivo                                            | —                     |
| `files`                                                                                        | tenant-scoped | `tenant_id`          | `filename` PII potencial                    | `pending` 24h GC `gcFiles`, `ready` huérfano 30d alerta                                                             | S3 delete + `expired` |
| `outbox_events`, `processed_jobs`                                                              | tenant-scoped | `tenant_id`          | —                                           | `pending` P95 <30s; `processed` 30d                                                                                 | —                     |
| `dlq_jobs`                                                                                     | tenant-scoped | `tenant_id`          | `cause` sin PII                             | `pending                                                                                                            | replayed              | discarded` 90d | —   |
| `orders`, `payment_attempts`, `inbound_payment_events`                                         | tenant-scoped | `tenant_id`          | `amount` no PII                             | 7 años fiscal (configurable)                                                                                        | —                     |
| `webhook_endpoints`, `webhook_deliveries`, `inbound_webhook_events`, `api_keys`, `automations` | tenant-scoped | `tenant_id`          | `secret_hash`, `hash`                       | endpoints `deleted` purge 30d; deliveries `dead_letter` 90d; `inbound` 30d                                          | —                     |

## 2. Políticas por recurso

### `audit_log` (365d)

- **Append-only**: `REVOKE UPDATE,DELETE` + trigger `prevent_audit_mutation()` `45000`. `platform_app` solo `SELECT,INSERT`. Truncate requiere `superuser` + `DISABLE TRIGGER`.
- **Retention job** (futuro): `SELECT ... WHERE created_at < now() - interval '365 days'` → `COPY TO 's3://audit-archive/...'` → `DELETE` con superuser en batch 1000 `SKIP LOCKED`.
- **Índices**: `audit_log_tenant_created_idx`, `audit_log_tenant_action_created_idx`, `audit_log_retention_created_idx` (`schema/0011`).
- **Acceso restringido**: `GET /v1/audit?limit=&cursor=&action=` requiere `audit:read` (`owner/admin/manager/auditor`) + RLS `tenant_id = app.tenant_id`; operadores no. Cross-tenant → `404`. Pagination cursor `at|id` base64url, `limit 1-100 default 50`.
- **Campos**: `id, action, actorUserId, tenantId, resourceId, requestId, traceId, ip (anonymized /24 si GDPR strict), result, at, metadata`. `traceId` de `x-trace-id`/`traceparent`, `ip` de `request.ip` (hash si `GDPR strict`).

### `users` / `memberships` (GDPR erasure)

Ver `docs/privacy/gdpr.md` y `runbooks/gdpr-erasure.md`.

### `sessions` (8h)

- Sliding `refreshSession` extiende `expires_at = now()+8h`.
- Job `purgeSessions` (`packages/db/src/jobs/purgeSessions.ts` — si existe) corre cada hora: `DELETE FROM sessions WHERE expires_at < now()` `FOR UPDATE SKIP LOCKED LIMIT 1000`. Métrica `sessions_purged`.

### `invitations` (48h), `files pending` (24h), `inventory reservations` (15m)

- Jobs: `expireReservations` `SKIP LOCKED`, `gcFiles` `pending >24h → expired`, `S3 delete`.
- Métricas `inventory.reserved`, `files.gc`.

## 3. Procedimiento de borrado / erasure

### Tenant completo (churn)

```bash
# 1. Soft-delete organización (owner)
curl -X DELETE http://localhost:4000/v1/organizations/{id} -H 'host: acme.app.localhost' -H "cookie: $COOKIE"
# -> status deleted, RLS sigue bloqueando reads (404), pero datos siguen en DB para retention

# 2. Tras 30d (retención legal), hard-delete con superuser
psql $DATABASE_URL -c "SET ROLE platform_admin; DELETE FROM organizations WHERE id='...' ; -- cascade a branches, memberships, orders, files, etc"
# audit_log NO se borra con cascade si tenant_id nullable? Se conserva global login, pero tenant-scoped audit permanece con tenant_id para 365d archivo.
```

### Usuario (GDPR art. 17) — `job anonymize_user`

```bash
# 1. Solicitud verificada (ver gdpr.md). 2. Crear job
psql -c "INSERT INTO jobs (type,payload) VALUES ('anonymize_user','{\"userId\":\"...\",\"tenantId\":\"...\"}')"

# Worker `anonymizeUser`:
# - UPDATE users SET email='anonymized-{hash}@example.invalid', display_name='Deleted User', oidc_subject='deleted', active=false WHERE id=...
# - UPDATE memberships SET role='auditor', active=false WHERE user_id...
# - UPDATE files SET owner_id=null WHERE owner_id=...   (mantener key pero perder vínculo)
# - audit_log conserva actorUserId pero con metadata.actor_hash=sha256(userId) si retention requiere pseudonymization
# - No DELETE audit_log; retention 365d luego archivo
```

### Archivo huérfano / PII en `metadata`

- Nunca loggear `metadata` con PII sin hash. `audit` `metadata` es `Record<string,string>` con `amountCents` etc, no `email`.
- Si `metadata` contiene PII por bug, worker `redactAudit` job futuro puede `UPDATE audit_log SET metadata = metadata - 'email'`.

## 4. Verificación

```bash
# Retention audit: >365d rows should be archived
psql -c "SELECT count(*) FROM audit_log WHERE created_at < now() - interval '365 days'"

# Simulate erasure (InMemory)
curl -X POST http://localhost:4000/v1/admin/gdpr/erasure -H 'host: acme.app.localhost' -H "cookie: $COOKIE_OWNER" -d '{"userId":"user-42","reason":"gdpr"}' | jq

# Check anonymized
psql -c "SELECT email, display_name, active FROM users WHERE id='user-42'" # -> anonymized-...
```

## 5. Checklist operativo

- [ ] `audit_log` archive job corre diario, S3 `audit-archive` versionado con retención `WORM` 1 año.
- [ ] `purgeSessions` `sessions` y `gcFiles` `files pending` monitoreados `metrics.sessions_purged`, `metrics.files_gc`.
- [ ] `GDPR erasure` runbook `docs/runbooks/gdpr-erasure.md` con SLA 30d y verificación `psql`.
- [ ] `DELETE` físico solo superuser + audit `admin` + 2-man rule; `platform_app` no puede `TRUNCATE`.

## Estado

- InMemory: retención lógica 365d documentada, `listAudit` pagination `cursor|action`, append-only trigger `0003` + `0011` índices.
- Persistent: `schema/0011_audit_hardening.sql` columnas `trace_id,ip,result` + índices retención.
- Pendiente: `anonymize_user` worker job + `audit archive` cron + `DLQ 90d` purge job + `GET /v1/audit/export` presigned S3 para compliance export.
