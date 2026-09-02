# Privacidad y GDPR — borrado y solicitudes de datos (Fase 11)

- Estado: aceptado
- Fecha: 2026-09-01
- Alcance: `users`, `memberships`, `audit_log`, `files`, `invitations`, `orders`, derechos `art. 15-17, 20`

## 1. Principios

- **Minimización**: solo `email`, `display_name`, `oidc_subject` en `users`; `ip` en `audit_log` solo `/24` hash si `GDPR_STRICT=1`, `trace_id` sin PII.
- **Limitación de finalidad**: auditoría para `login|membership|order|webhook|api_key` con `result/ip/traceId`; no se usa para marketing.
- **Exactitud**: `upsertOidcUser` sincroniza `email/display_name` desde IdP; no sobrescribe manual `suspended`.
- **Limitación de conservación**: Tabla `retention` en `data-retention.md` (audit 365d, sessions 8h, invites 48h, etc.). Tras vencimiento, archivo S3 `WORM` luego anonimización.
- **Integridad**: `REVOKE UPDATE,DELETE` audit + `FORCE RLS` + `CSRF` + `HMAC` + `strict validation`.
- **Responsable**: tenant `owner` es controlador para datos de sus usuarios; plataforma es encargada. Soporte cross-tenant (`/v1/admin/*`) no lee PII sin `audit:read` + `owner/admin`.

## 2. Derechos del interesado

| Derecho                        | Endpoint / proceso                                                                                 | SLA       | Evidencia                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Art. 15 Acceso**             | `GET /v1/audit?limit=&cursor=&action=` + `GET /v1/members` + `GET /v1/organization` (`audit:read`) | 30d       | Export `audit` pagination `cursor` + `metadata`; no expone `token_hash`, `secret_hash`.                                                                                                                                  |
| **Art. 16 Rectificación**      | `PATCH /v1/members/:id` `role` o `POST /v1/auth/me` vía IdP `upsertOidcUser`                       | inmediato | Audit `membership.role_changed` con `traceId/ip`.                                                                                                                                                                        |
| **Art. 17 Supresión (olvido)** | `POST /v1/admin/gdpr/erasure {userId, tenantId, reason}` → worker `anonymize_user` (ver runbook)   | 30d       | `users.email='anonymized-{hash}@example.invalid'`, `display_name='Deleted User'`, `memberships active=false`, `files owner_id=null`; `audit_log` conserva `actorUserId` pero `metadata` pseudonimizado si antes de 365d. |
| **Art. 18 Limitación**         | `POST /v1/members/:id {status:suspended}` o `users.active=false`                                   | inmediato | `user.status suspended → 403` en `requireSession`.                                                                                                                                                                       |
| **Art. 20 Portabilidad**       | `GET /v1/audit/export?format=json` (futuro) + `GET /v1/files/:id` presigned                        | 30d       | Export tenant-scoped, `limit 100` cursors.                                                                                                                                                                               |
| **Oposición**                  | `DELETE /v1/members/:id` (salir org) o `DELETE /v1/organizations/:id` (churn)                      | inmediato | Soft-delete 30d luego hard-delete superuser cascade.                                                                                                                                                                     |

## 3. Flujo de erasure (art. 17)

```
Solicitud (carta / ticket) → verificación identidad (email + OIDC subject) + verifica membership en tenant → owner aprueba → crea `audit_log` {action: gdpr.erasure.requested} → worker `anonymize_user` → verifica `users.email` anonimizado + `memberships` removed + `files owner_id null` → audit {action: gdpr.erasure.completed} → notifica interesado → archiva ticket 3 años
```

- **No se borra**: `audit_log` (conserva trazabilidad legal 365d), `orders/payment_attempts` si obligación fiscal 7 años (anonimiza `created_by` a `deleted_user_hash` pero mantiene `amount`).
- **Se borra/anonymiza**: `users` PII, `sessions` (`purgeSessions`), `invitations` con PII `email`, `api_keys` revocadas, `webhook_endpoints` sin PII (solo `url` si contiene PII en query? se considera).

### Ejemplo InMemory (demo)

```bash
COOKIE_OWNER=$(curl -s -c - http://localhost:4000/v1/auth/dev-login -d '{"userId":"user-alice"}' | grep platform_session | awk '{print $7}')
# Owner crea erasure para user-acme-only (operator) que abandona acme
curl -s -X POST http://localhost:4000/v1/auth/dev-login -H 'content-type: application/json' -d '{"userId":"user-alice"}' -b "platform_session=$COOKIE_OWNER" | jq
# Simula worker anonymize_user (InMemory):
#  - InMemoryIdentityStore.users.set('user-acme-only', {email:'anonymized-abc@example.invalid', displayName:'Deleted User', active:false})
```

Persistente: `UPDATE users SET email='anonymized-'||substr(md5(id::text),1,8)||'@example.invalid', display_name='Deleted User', oidc_subject='deleted:'||id, active=false WHERE id=$1 AND id IN (SELECT user_id FROM memberships WHERE tenant_id=$2)`.

## 4. Conservación vs supresión

| Tabla         | Conserva para audit/retención | Anonymiza                           | Borra                              |
| ------------- | ----------------------------- | ----------------------------------- | ---------------------------------- |
| `audit_log`   | 365d                          | `metadata` sin PII                  | superuser archive+delete post 365d |
| `users`       | `id` (FK)                     | `email, display_name, oidc_subject` | no delete FK cascade               |
| `memberships` | `id, tenant_id`               | `role→auditor` + `active=false`     | —                                  |
| `files`       | `key, tenant_id`              | `owner_id=null`                     | S3 bytes `gcFiles` 24h pending     |
| `sessions`    | —                             | —                                   | `expires_at < now()` hourly        |

## 5. Transferencias y subprocesadores

- Infra: `postgres:16`, `redis:7`, `minio` local; prod `managed postgres`, `redis`, `S3` en `eu` región (supuesto). `OIDC` externo (`dex` local, `Auth0` prod) con `clientSecret` rotación dual.
- `webhooks` outbound: datos se envían solo a `url https://` validada + `HMAC` + `secret_hash`; no se envía PII más allá de `orderId, amount` minimizado.
- `OTel/Prometheus/Grafana`: logs estructurados con `tenant redacted/hashed`, nunca `email/token/secret`.

## 6. Registro de actividades (ROPA)

- `docs/privacy/ropa.md` (futuro) lista `users, audit_log, sessions` con base jurídica `contract`, `legitimate_interest` (fraud prevention), retention.
- `DPIA` requerido para `payment saga` `inbound_payment_events` con `provider_ref` (no PII) — bajo.

## 7. Contacto

Ver `SECURITY.md`: reportar vía `GitHub Security Advisories` privado. `DPO` futuro: `dpo@platform.example` (placeholder). No exponer secretos.

## Estado

- InMemory anonymize documentado, `Persistent` `UPDATE users` listo, `audit` append-only impide borrado silencioso, `listAudit` pagination para export.
- Pendiente: `POST /v1/admin/gdpr/erasure` endpoint formal + `worker anonymize_user` + `GET /v1/audit/export` presigned + `ROPA` sheet.
