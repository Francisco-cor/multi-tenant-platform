# Política de seguridad

No reportes vulnerabilidades mediante issues públicos ni incluyas secretos, tokens o datos reales en reportes.

Cuando el repositorio esté publicado, usa **GitHub Security Advisories** o el canal privado configurado para mantenedores. En desarrollo local, documenta únicamente un caso reproducible y datos sintéticos.

Los cambios de autorización, tenant isolation, storage, webhooks y secretos requieren revisión adicional y pruebas negativas antes de merge.

## Reporte privado

- Si el repo está en `github.com/Francisco-cor/multi-tenant-platform`, abre `Security → Report a vulnerability` (Advisory) o escribe a `security@platform.example` (placeholder — configurar GPG).
- Incluye: `commit`, `endpoint`, `reproducción sintética`, `impacto` y `mitigación sugerida`. No adjuntes `DATABASE_URL`, `REDIS_URL`, `S3_SECRET`, `OIDC_CLIENT_SECRET` reales; usa `***`.
- SLA: acuse 2 días laborables, evaluación 7 días, parche crítico 30 días. Si no hay respuesta, escalar a `CODEOWNERS` (`@platform-architecture`).

## Alcance

- En scope: `apps/api` (`/v1/*` tenant-scoped `FORCE RLS`), `apps/worker` (BullMQ, HMAC, retries), `packages/auth` (OIDC state/nonce), `packages/db` (RLS, outbox, audit append-only), `infra` (K8s, Terraform futuro), `webhooks` (HMAC, SSRF block), `audit_log`, `files` S3 presigned, `rate limiting`, `circuit breakers`.
- Out of scope inicial: facturación SaaS completa, app móvil, BI, edición colaborativa (ver `IMPLEMENTATION_PLAN.md:29`).

## Headers y endurecimiento (Fase 11)

- `helmet`: `CSP default-src 'self' object-src 'none' frame-ancestors 'none'`, `COEP same-origin`, `CORP same-origin`, `Referrer-Policy no-referrer`, `X-Content-Type-Options nosniff`, `X-XSS-Protection`, `HSTS maxAge 31_536_000 includeSubDomains preload` (solo `NODE_ENV=production`).
- `cors` tenant-aware `origin: *.${TENANT_BASE_DOMAIN}` + `localhost` dev + `WEB_PUBLIC_URL`, `allowedHeaders` incluye `X-Webhook-*`, `X-Trace-Id`, `Traceparent`, `exposedHeaders` incluye `X-RateLimit-*`, `Retry-After`, `X-Cache`.
- `bodyLimit 1MB` global + `256KB` en `auth/members/invite`; `zod .strict()` en 17 schemas → `400 VALIDATION_ERROR` si extra keys; `CSRF_STRICT=1` requiere `Origin` o `X-Requested-With` para mutaciones con cookie.
- `rateLimit` per IP 100/min, per tenant 1000/min, endpoints sensibles `POST /orders 20/min`, `S3` circuit breaker `503`.

## Protección de datos

- **Tenant isolation**: RLS `FORCE` + `app.tenant_id` + cache keys `tenant:{id}` + S3 `tenants/{id}/` + job payloads tenant-scoped. Tests `isolation.*` A no lee B.
- **Audit log**: `packages/db/migrations/schema/0003_audit_append_only.sql` `REVOKE UPDATE,DELETE` + trigger `prevent_audit_mutation() 45000` + `0011_audit_hardening.sql` `trace_id, ip, result` + `GET /v1/audit?limit&cursor&action` `audit:read` (`owner/admin/manager/auditor`). Retention 365d `docs/runbooks/data-retention.md`.
- **Secret redaction**: `pino redact: ['req.headers.cookie','req.headers.authorization','*.secret']`, `secret_hash` sha256, `rawSecret` solo al crear `201` nunca en lista/get.

## Validación CI reproducible

Ver `.github/workflows/ci.yml` jobs:

- `quality`: `format:check`, `lint`, `typecheck`, `test`, `openapi:check` (`b5422461d0b7`)
- `migrate-check`: `pg 16` ephemeral + `RLS + pool 50` integration
- `security` (Fase 11): `pnpm audit --prod --audit-level=high`, `gitleaks`, `semgrep p/security-audit`, `CodeQL javascript-typescript`, `trivy fs CRITICAL,HIGH` SARIF → `docs/security/exceptions.md` lista falsos positivos y `med` tolerados.

Si CI falla un check, ver `docs/security/exceptions.md` antes de añadir excepción. Todo cambio `tenant/auth/storage/webhook` requiere test negativo `403/404` + `audit` entry.

## Rotación de secretos sin downtime

- **Webhooks**: `POST /v1/webhooks/endpoints/:id/rotate-secret` genera nuevo `rawSecret` base64url 32B, `sha256` hash y `secret_ciphertext` AES-GCM, incrementa `version`, invalida cache y audita `webhook.secret_rotated`. La ventana dual de versiones/KMS sigue pendiente.
- **API keys**: `POST /v1/api-keys/:id/rotate` revoca old (`revokedAt=now()`) y crea nuevo `prefix/hash` mismo `name/scopes` + audit `api_key.rotated`. M2M clientes usan `X-Api-Key: prefix.raw` nuevo sin downtime.
- **S3**: `S3_ACCESS_KEY` + `S3_SECRET_KEY` rotación via env `S3_ACCESS_KEY_OLD/NEW` o IAM STS `AssumeRole`; `FakeS3Service` demo con `ensureBucket`.
- **OIDC**: `OIDC_CLIENT_SECRET` + `OIDC_CLIENT_SECRET_OLD` (24h window), JWKS `kid` rotación con cache `jwk` TTL 5m en `validateOidcIdToken`; `oidcBreaker` 3 fails 60s.
- **Payment webhooks**: `PAYMENT_WEBHOOK_SECRET` global, requerido en producción, con `tenantId` dentro del cuerpo firmado. La rotación dual `*_OLD` y el raw-body exacto siguen pendientes.

## Auditoría y retención

- `audit_log` campos `actor, tenant, action, resource, request_id, trace_id, ip, result, at, metadata`. Ver `docs/threat-model.md` + `docs/runbooks/data-retention.md` (365d audit, 8h sessions, 48h invites, 24h pending files, 30d endpoints).
- GDPR erasure: `docs/privacy/gdpr.md` + `docs/runbooks/gdpr-erasure.md` (anonymize `users.email='anonymized-...@example.invalid'`).
- Superuser delete requiere `DISABLE TRIGGER` + `2-man` + archivo S3 `WORM`; `platform_app` no puede.

## Excepciones conocidas

Ver `docs/security/exceptions.md`.

## Contacto / DPO

- `security@platform.example` (placeholder), `dpo@platform.example` futuro. No usar issues públicos.
