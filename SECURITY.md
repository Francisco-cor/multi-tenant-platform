# Política de seguridad

- Última revisión: 2026-11-13
- Owner: `platform-security`
- Contacto: GitHub Security Advisories o `security@platform.example` (placeholder; configurar GPG antes de publicar)

No reportes vulnerabilidades mediante issues públicos ni incluyas secretos, tokens o datos reales en reportes.

## Reporte privado

- Si el repo está en `github.com/Francisco-cor/multi-tenant-platform`, abre `Security → Report a vulnerability` (Advisory) o escribe a `security@platform.example`.
- Incluye: `commit`, `endpoint`, reproducción sintética, impacto y mitigación sugerida. No adjuntes `DATABASE_URL`, `REDIS_URL`, `S3_SECRET` ni `OIDC_CLIENT_SECRET` reales; usa `***`.
- SLA: acuse en 2 días laborables, evaluación en 7 días, parche crítico en 30 días. Si no hay respuesta, escala a `@platform-security` o `@platform-architecture` (`CODEOWNERS`).

## Alcance

- En scope: `apps/api` (`/v1/*` tenant-scoped con RLS `FORCE`), `apps/web` (middleware y BFF), `apps/worker` (BullMQ, HMAC, retries), `packages/auth` (OIDC state/nonce), `packages/db` (RLS, outbox, auditoría append-only), `webhooks` (HMAC, SSRF), `audit_log`, `files` S3 presigned, rate limiting y circuit breakers.
- Fuera del primer release: facturación SaaS completa, app móvil, BI y edición colaborativa. Ver `IMPLEMENTATION_PLAN.md`.
- Pendiente de producción: KMS/Vault, egress proxy con allowlist, autenticación del `/metrics` del API, Stripe live y manifests K8s/Terraform.

## Aislamiento y roles

- **Tenant isolation:** RLS `FORCE` + `app.tenant_id` + filtros de repository + cache keys `tenant:{id}` + S3 `tenants/{id}/` + jobs tenant-scoped. Evidencia en `docs/architecture/tenant-isolation.md`.
- **Roles DB:** `platform_app` (negocio tenant), `platform_auth` (credenciales), `platform_worker` (relay global) y `platform_auditor` (auditoría global). `platform_app` no puede borrar organizaciones ni membresías.
- **Sesiones:** user-bound con `app.user_id`; cookie `platform_session` HttpOnly, SameSite=Lax, host-only por defecto, 8 h, `Secure` en producción. El BFF web no expone el token a JavaScript.
- **Auditoría:** `audit_log` tenant-scoped con `tenant_id NOT NULL`, `REVOKE UPDATE,DELETE` y triggers `audit_log_no_update`/`audit_log_no_delete` (error `45000`). Los eventos globales van a `platform_audit_log` y se leen con `platform_auditor`. Retención 365 días.
- **Secret redaction:** logger JSON con `tenantHash` y redacción de `cookie`, `authorization` y `*.secret`; `secret_hash`/`secret_ciphertext`; `rawSecret` solo en la respuesta `201` de creación.

## Headers y endurecimiento

- `helmet`: CSP `default-src 'self' object-src 'none' frame-ancestors 'none'`, COOP `same-origin`, CORP `same-origin`, `Referrer-Policy no-referrer`, `X-Content-Type-Options nosniff`, HSTS 1 año `includeSubDomains preload` solo en producción.
- `cors` tenant-aware para `*.${TENANT_BASE_DOMAIN}`, `localhost` en dev y `WEB_PUBLIC_URL`; allowlist de headers `X-Webhook-*`, `X-Trace-Id`, `Traceparent`; expone `X-RateLimit-*`, `Retry-After`, `X-Cache`.
- `bodyLimit` 1 MB global + 256 KB en auth/members; Zod `.strict()` en las entradas → `400 VALIDATION_ERROR` si hay claves extra.
- `CSRF_STRICT=1` (o `NODE_ENV=production`) exige `Origin` o `X-Requested-With` para mutaciones con cookie. En local el default es `0` para tests.
- Rate limit por IP 100/min, tenant 1000/min, usuario 200/min y límites por endpoint; breakers S3/OIDC/pagos.

## Validación CI

`.github/workflows/ci.yml`:

- `quality`: `format:check`, `lint`, `typecheck`, `build`, `test:scripts`, `openapi:check`, `migrate:check`, `docker compose config`.
- `unit`: `pnpm test:coverage`; falla si no se ejecuta ningún test.
- `integration`: PostgreSQL, Redis y MinIO con imágenes pinneadas; migraciones, RLS y suites de API/worker.
- `security`: `pnpm audit --prod --audit-level=high`, gitleaks, Semgrep (`p/security-audit`, `p/secrets`, `p/owasp-top-ten`) y Trivy `CRITICAL,HIGH`.
- `codeql`: condicional a repo público o `vars.ENABLE_CODEQL=true`.
- `e2e`: opt-in con `vars.ENABLE_E2E=true`; no es gate por defecto.

Si CI falla, revisa `docs/security/exceptions.md` antes de añadir una excepción. Todo cambio de tenant/auth/storage/webhook requiere prueba negativa `403/404` y entrada de auditoría.

## Rotación de secretos

La rotación de la clave maestra de cifrado y los secretos de proveedor es manual; ver `docs/runbooks/key-rotation.md`.

- **Webhooks:** `POST /v1/webhooks/endpoints/:id/rotate-secret` genera un secreto nuevo, guarda `secret_ciphertext` AES-GCM, incrementa `secret_version`, conserva la versión anterior 24 h (`previous_secret_ciphertext`) y audita `webhook.secret_rotated`. KMS/Vault sigue pendiente.
- **API keys:** `POST /v1/api-keys/:id/rotate` revoca la clave anterior (`revokedAt`) y crea una nueva con el mismo nombre/scopes. El cliente debe cambiar al valor nuevo de inmediato; no hay ventana dual.
- **S3:** rotación por IAM/entorno; no hay automatización en el repo.
- **OIDC:** `OIDC_CLIENT_SECRET` + JWKS con cache TTL; la ventana dual `_OLD` no está implementada en el código actual.
- **Pagos:** `PAYMENT_PROVIDER_API_KEY` y `PAYMENT_PROVIDER_WEBHOOK_SECRET` por entorno; el modo Stripe valida `Stripe-Signature`. No hay rotación dual automática.

## Métricas y observabilidad

- El `/metrics` del API **no** tiene autenticación en el código. Debe exponerse solo en red privada o detrás de un proxy con allowlist; no se debe publicar en Internet.
- El worker soporta `WORKER_METRICS_TOKEN`; si `NODE_ENV=production` y falta, emite un warning y el operador debe mantener el puerto privado.
- `GET /metrics` no debe contener PII ni secretos; los logs usan `tenantHash`, no `tenantId` crudo en labels.

## Excepciones conocidas

Ver `docs/security/exceptions.md`. No hay excepciones `CRITICAL` o `HIGH` aceptadas para aislamiento, auditoría, webhooks o pagos.

## Contacto / DPO

- `security@platform.example` (placeholder), `dpo@platform.example` (futuro). No usar issues públicos.
