# Threat Model — Multi-Tenant Operations Hub (STRIDE)

- Estado: aceptado
- Fecha: 2026-09-01
- Alcance: Fases 0-11 (bootstrap → auditoría/seguridad), `apps/api|worker|web`, `packages/*`, `postgres/redis/s3`, `webhooks`, `auditoría`
- Referencias: `docs/adr/ADR-002 tenant-isolation`, `ADR-010 cache`, `SECURITY.md`, `docs/runbooks/*`

## 1. Arquitectura y trust boundaries

```
Browser (tenant slug *.app.localhost)
  → CDN/Ingress (TLS, HSTS)
  → Next.js web (tenant middleware, no decisiones de permisos)
  → Node.js API (Fastify, auth, RBAC, validation, rate limiting, cache-aside)
     → PostgreSQL (RLS FORCE, trigger append-only, outbox)
     → Redis (rate limit, cache reconstruible, BullMQ)
     → S3/MinIO (presigned, key tenants/{id}/{uuid})
     → Outbox relay → BullMQ/Redis → Worker (retries, DLQ, HMAC webhooks)
  → OIDC Provider (issuer discovery, JWKS)
  → Webhook receptors externos (outbound/inbound HMAC)
  → OTel Collector → Prometheus/Grafana
```

Trust boundaries:

- **TB1** Internet ↔ API (auth, rate limiting, CSRF, SSRF, injection)
- **TB2** API ↔ DB (RLS, pool tenant isolation, SQL param)
- **TB3** API ↔ Redis/S3/OIDC/Webhooks (timeouts, circuit breakers, HMAC, private IP block)
- **TB4** Tenant A ↔ Tenant B (cache key, job payload, S3 key, audit log, RLS)
- **TB5** Worker ↔ DB (FK tenant, dedupe, SKIP LOCKED)

## 2. Actores y privilegios

| Actor         | Rol          | Permisos críticos                                                                              |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| owner         | tenant admin | `members:invite/update/remove`, `webhooks:manage`, `audit:read`, `dlq:replay`                  |
| admin         | tenant admin | similar owner sin `delete org`                                                                 |
| manager       | negocio      | `orders:create/read`, `inventory:reserve`, `webhooks:read`                                     |
| operator      | operativo    | `orders:read`, `inventory:read`, `files:upload/read` (no invite, no webhooks, no audit:export) |
| auditor       | read-only    | `audit:read`, `orders:read`, `inventory:read` (no mutate)                                      |
| M2M (api_key) | scopes       | `webhooks:read`, `orders:read` etc (prefix tenant-scoped)                                      |
| anónimo       | none         | solo `/health/live`, `/v1/auth/login                                                           | callback | dev-login` (rate limited) |
| platform_app  | DB role      | `SELECT/INSERT` audit, `SELECT` sessions, no `UPDATE/DELETE` audit (trigger), no `TRUNCATE`    |

## 3. STRIDE — amenazas por componente

### S — Spoofing

| ID  | Escenario                                                      | Severidad | Mitigación                                                                                                                                                                                                      | Estado                                                          |
| --- | -------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| S1  | Atacante suplanta tenant via `Host` manipulado o `x-tenant-id` | Alta      | `resolveTenantFromHost` + lookup `getOrganizationBySlug` + `getActiveMembership` obligatoria en cada `requireTenantContext`; header `x-tenant-id` solo en webhooks HMAC-verificados, nunca sustituye membresía. | Implementado `app.ts:requireTenantContext` 403 si no membership |
| S2  | Fake OIDC token `kid` no en JWKS                               | Alta      | `validateOidcIdToken` RS256 + `kid/alg` check + `issuer/clientId/nonce` + `oidcBreaker` + JWKS fetch con timeout.                                                                                               | Implementado `packages/auth`                                    |
| S3  | Webhook inbound spoof sin HMAC                                 | Media     | `verifyWebhookSignature` HMAC sha256 `timestamp.rawBody` tolerance 5m, `406` si falla, dedupe `(tenant,event_id)`                                                                                               | `app.ts:webhook-payment`                                        |
| S4  | API key spoof                                                  | Media     | `hash=sha256(raw)`, prefix 8ch, scopes, expiración, rotación sin downtime `POST /:id/rotate`                                                                                                                    | `api-key-store.ts`                                              |

### T — Tampering

| ID  | Escenario                                                       | Mitigación                                                                                                                                                      |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Mass assignment extra fields `tenantId` en body                 | Zod `.strict()` en 17 schemas (Fase 11) → `400 VALIDATION_ERROR` con `path/code`, no `strip` silencioso; DB nunca usa `...body` spread.                         |
| T2  | SQL injection via `slug`, `q`, `cursor`                         | Todas queries usan `sql` tag param `sql\`where id=${id}::uuid\``; `sql.raw`solo`set local role "platform_app"` hard-coded.                                      |
| T3  | Path traversal `filename ../` → S3 key `tenants/acme/../../etc` | Key `tenants/{tenantId}/{uuid}` server-side `randomUUID()`, nunca user input; `file-store.ts` valida `filename !includes / \\ ..` + `encodeURIComponent` split. |
| T4  | Webhook payload tampered                                        | HMAC firma cambia si body cambia; `already_processed` dedupe evita replay de cuerpo distinto con mismo `eventId`.                                               |
| T5  | Audit log editado silencioso                                    | `REVOKE UPDATE,DELETE` + trigger `prevent_audit_mutation()` `45000`; test `audit-append-only` verifica `UPDATE audit_log → 45000`.                              |

### R — Repudiation

| ID  | Escenario                                                     | Mitigación                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Usuario niega acción (order.created, webhook secret rotation) | Audit log `actorUserId, tenantId, resourceId, action, requestId, traceId, ip, result, metadata, at`; `append-only`, `GET /v1/audit?limit&cursor&action` `audit:read` + `x-ratelimit` + pagination; DLQ/webhook/api_key rotates audit `webhook.secret_rotated`, `api_key.rotated` con `auditBase(request)`. |
| R2  | Worker niega ejecución                                        | `outbox_events` + `processed_jobs` `jobId=sha256(tenant:aggregate:event)` + `dlq_jobs` + metrics + `p95`                                                                                                                                                                                                   |

### I — Information Disclosure

| ID  | Escenario                               | Mitigación                                                                                                                                                                                                                        |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | IDOR `GET /v1/files/:id` de otro tenant | `WHERE tenant_id=app.tenant_id` en repo + `FORCE RLS` + cache key `tenant:{id}` + `404` idéntico a no existe; test `files.test.ts` A no lee B.                                                                                    |
| I2  | Error revela existencia cross-tenant    | `RequestProblem 404` genérico, no distingue “exists in other tenant”.                                                                                                                                                             |
| I3  | Secret en logs/UI                       | `secret_hash` sha256 almacenado, `rawSecret` solo al crear `201 {secret}`; logs `pino redact: ['req.headers.cookie','authorization','*.secret']`; `GET /webhooks/endpoints` nunca expone `secret`; `GET /metrics` no incluye PII. |
| I4  | Cache leak tenant                       | Keys `tenant:{id}:v1:{resource}:hash`; `deleteByPrefix` tenant-scoped; test `cache-rate-limit` hit acme ≠ contoso.                                                                                                                |
| I5  | Audit filter leak                       | `WHERE tenant_id = app.tenant_id` en `listAudit`; `tenant_acme` no ve `contoso` `404` (test).                                                                                                                                     |

### D — Denial of Service

| ID  | Escenario                                                | Mitigación                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Hot tenant monopoliza DB pool                            | Rate limiting `ip 100/min`, `tenant 1000/min`, `user 200/min`, `POST /orders 20/min per tenant` fixed-window `rl:{kind}:{id}:{bucket}` Redis fallback InMemory; `GET /v1/inventory` cache HIT <50ms; `HPA` futuro por `tenant` bucket. |
| D2  | Stampede hot key expirado (50 VUs same `GET /inventory`) | `cache.getOrLoad` lock `SET NX PX 5s` + poll 10×50ms + `cache_stampede_fallback_total`; TTL 30s inventario.                                                                                                                            |
| D3  | Large payload 50MB DoS                                   | `bodyLimit 1MB` global + `256KB` en auth/members/invite; `z` limits `filename max255`, `q max100`, `limit max100`; `helmet` + `rateLimit`.                                                                                             |
| D4  | Slow S3/OIDC bloquea event loop                          | `circuitBreaker s3/oidc` `failureThreshold 5`, `timeout 30s`, `requestTimeout 2s`, `withTimeout` → `503 DEPENDENCY_UNAVAILABLE` + métrica `circuit_state 2`.                                                                           |
| D5  | Redis down cascade                                       | Fail-open cache `get → miss` → DB fallback; rate limiter fallback InMemory; `health degraded` pero `liveness ok`.                                                                                                                      |

### E — Elevation of Privilege

| ID  | Escenario                                       | Mitigación                                                                                                                                                             |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Operator intenta `POST /v1/members/invitations` | `requirePermission(context,'members:invite')` + `rolesHavePermission` → `403`; UI `Can` component oculta botón pero API es autoridad; test `app.test.ts` operator 403. |
| E2  | `auditor` escribe `POST /orders`                | `rolesHavePermission` deniega `orders:create` para `auditor`; `403`.                                                                                                   |
| E3  | Cross-tenant admin sin `audit:read`             | `GET /v1/audit`, `GET /v1/dlq`, `POST /dlq/:id/replay` requieren `audit:read` + `owner/admin`; test `dlq.test` 403 para `operator`.                                    |
| E4  | Hard delete audit                               | Trigger + `REVOKE` impide `platform_app` UPDATE/DELETE; superuser requerido para retention truncate (documentado `runbooks/data-retention`).                           |

## 4. Matriz de riesgos (probabilidad × impacto)

| Riesgo                                     | Prob  | Impacto | Nivel | Control actual                                                                                              | Gap residual                                                            |
| ------------------------------------------ | ----- | ------- | ----- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Tenant leak por cache key global           | Baja  | Crítico | Alto  | `tenant:{id}` en key + RLS + tests A/B                                                                      | Revisar nuevos endpoints agreguen tenant                                |
| SSRF `https://169.254.169.254` via webhook | Media | Alto    | Alto  | `validateUrl` bloquea `10/8,172.16/12,192.168/16,127/8,169.254/16,fc00::` + no userinfo + timeout + circuit | Añadir allowlist egress proxy en prod                                   |
| Secret en git                              | Media | Alto    | Alto  | `gitleaks` en CI + `.gitignore .env` + `pino redact` + raw only at create                                   | Falta `detect-secrets` pre-commit hook                                  |
| Mass assignment extra `isAdmin:true`       | Baja  | Alto    | Medio | `.strict()` → `400 VALIDATION_ERROR` + no `...body` spread                                                  | Revisar nuevos schemas agreguen `.strict()`                             |
| Audit tampering                            | Baja  | Alto    | Medio | `REVOKE` + trigger 45000 + `listAudit` tenant-scoped                                                        | Superuser puede `DISABLE TRIGGER` → requiere `pg audit`                 |
| Hot tenant DoS                             | Media | Medio   | Medio | Rate limit per tenant + cache HIT + circuit                                                                 | Sliding window más justo que fixed-window; documentar 3× con 3 réplicas |
| OIDC secret leak                           | Media | Medio   | Medio | `OIDC_CLIENT_SECRET` env, fallback `_OLD` para rotación, `oidcBreaker`                                      | JWKS sin cacheTTL → rotate `kid` puede fallar entre discover/validate   |
| DLQ replay sin permiso                     | Baja  | Medio   | Bajo  | `owner/admin` + `audit:read` + `POST /dlq/:id/replay` audit `dlq.replayed`                                  | `operator` no puede pero `manager` tampoco — intencional                |
| CSRF cookie POST sin Origin                | Baja  | Medio   | Bajo  | `SameSite=Lax` + `CSRF_STRICT=1` check `Origin                                                              | x-requested-with` + CORS allowlist                                      | `CSRF_STRICT=0` por compat tests; habilitar en prod |

## 5. Checklist de salida Fase 11

- [x] `SECURITY.md` actualizado con contacto privado + reporte sin secretos + revisión adicional tenant/webhook
- [x] `CI .github/workflows/ci.yml` jobs `security` con `pnpm audit`, `gitleaks`, `semgrep p/security-audit`, `CodeQL javascript-typescript`, `trivy fs CRITICAL,HIGH` + SARIF upload
- [x] `exceptions` documentadas `docs/security/exceptions.md` (falsos positivos semgrep/trivy)
- [x] Secret rotation `POST /webhooks/endpoints/:id/rotate-secret` + `POST /api-keys/:id/rotate` con audit + zero downtime (old hash invalidated solo tras nuevo 201)
- [x] SSRF block `validateUrl` `private_blocked` test `webhooks.test` 400 private IP

## 6. Próximos pasos

- `oidc` dual secret `OIDC_CLIENT_SECRET_OLD` window 24h + JWKS cache `kid` TTL 5m
- Egress proxy allowlist para webhooks prod + DNS rebinding guard (`fetch redirect:manual` + resolve IP antes de `fetch`)
- `SESSION` purge job ya existe `purgeSessions.ts` + audit retention 365d `audit_log_retention_created_idx`

## 7. Referencias

- `apps/api/src/plugins/security.ts:44` helmet + CORS allowlist `X-Webhook-*`
- `apps/api/src/webhook-store.ts:60` `validateUrl` private_blocked
- `packages/db/migrations/schema/0011_audit_hardening.sql` audit trace/ip/result + retention idx
- `docs/runbooks/data-retention.md` `docs/privacy/gdpr.md`
