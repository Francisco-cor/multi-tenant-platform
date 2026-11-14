# Threat model — Multi-Tenant Operations Hub (STRIDE)

- Estado: aceptado; revisado el 2026-11-13
- Alcance: `apps/api`, `apps/web`, `apps/worker`, `packages/*`, PostgreSQL/Redis/S3, webhooks, auditoría y pagos
- Fuera de alcance: KMS/Vault (gap), egress proxy (gap), Kubernetes/Terraform (no implementados), Stripe live (no probado)
- Referencias: `docs/adr/ADR-002-tenant-isolation.md`, `docs/adr/ADR-008-webhooks.md`, `docs/adr/ADR-010-cache-rate-limit.md`, `SECURITY.md`, `docs/runbooks/`

## 1. Arquitectura y trust boundaries

```text
Browser (tenant slug *.app.localhost)
  → Next.js web (middleware de host + BFF; no decide permisos)
  → Node.js API (Fastify, sesión, RBAC, validación, rate limit, cache)
     → PostgreSQL (RLS FORCE, roles separados, trigger append-only, outbox)
     → Redis (rate limit, cache reconstruible, BullMQ)
     → S3/MinIO (presigned, key tenants/{id}/{uuid})
     → Outbox relay → BullMQ → Worker (retries, leases, DLQ, HMAC webhooks)
  → OIDC Provider (issuer discovery, JWKS)
  → Webhook receptors externos (outbound/inbound HMAC)
  → OTel Collector → Prometheus/Grafana
```

Trust boundaries:

- **TB1** Internet ↔ API: auth, CSRF, rate limit, SSRF, validación estricta, body limit.
- **TB2** API ↔ DB: roles `platform_app`/`platform_auth`, `SET LOCAL ROLE`, RLS, FK tenant.
- **TB3** API/worker ↔ Redis/S3/OIDC/webhooks: timeouts, circuit breakers, HMAC, DNS pinning.
- **TB4** Tenant A ↔ Tenant B: RLS, repository filters, cache keys, job payloads, S3 keys, auditoría.
- **TB5** Worker ↔ DB: rol `platform_worker` para el relay global, handlers tenant con `platform_app`, leases y dedupe.
- **TB6** Navegador ↔ BFF: cookie HttpOnly, SameSite=Lax, host-only; el token no llega a JS.

## 2. Actores y privilegios

| Actor              | Rol             | Permisos críticos                                                                                       |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------- |
| owner              | tenant admin    | Todos, incluido `billing:manage`                                                                        |
| admin              | tenant admin    | Todos salvo `billing:manage`                                                                            |
| manager            | negocio         | Órdenes, inventario, archivos, lectura de auditoría/webhooks; sin invitar                               |
| operator           | operativo       | Órdenes e inventario limitados; sin auditoría ni webhooks                                               |
| auditor            | read-only       | Lectura de organización, miembros, órdenes, inventario, archivos y auditoría                            |
| M2M (`x-api-key`)  | scopes          | `webhooks:read`, `orders:read`, etc.; tenant-scoped por host                                            |
| anónimo            | ninguno         | `/health/live`, `/health/ready`, `/v1/auth/login`, `/v1/auth/callback`, `/v1/auth/dev-login` (solo dev) |
| `platform_app`     | DB tenant       | DML de negocio bajo RLS; no borra organizaciones/membresías                                             |
| `platform_auth`    | DB credenciales | `users`, `sessions`, `invitations`, credenciales; no negocio                                            |
| `platform_worker`  | DB relay        | `BYPASSRLS` solo para el dispatcher global; no sirve requests                                           |
| `platform_auditor` | DB auditoría    | Lectura de `platform_audit_log`; no sirve requests                                                      |

La matriz completa está en `docs/permissions-matrix.md` y su fuente es `ROLE_PERMISSIONS`.

## 3. STRIDE — amenazas y controles

### S — Spoofing

| ID  | Escenario                                   | Severidad | Mitigación                                                                                                                                                     | Estado       |
| --- | ------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| S1  | Suplantar tenant con `Host` o `x-tenant-id` | Alta      | `resolveTenantFromHost` + organización activa + membresía activa; `x-tenant-id` no sustituye membresía; el BFF ignora `x-forwarded-host` salvo `TRUST_PROXY=1` | Implementado |
| S2  | Token OIDC falso o `kid` desconocido        | Alta      | RS256, `kid`/`alg`, issuer/audience/nonce, JWKS con timeout y `oidcBreaker`                                                                                    | Implementado |
| S3  | Webhook inbound sin HMAC                    | Media     | HMAC sobre bytes crudos, tolerancia 5 min, dedupe por `(tenant,event_id)`; Stripe usa `Stripe-Signature`                                                       | Implementado |
| S4  | API key robada o reutilizada                | Media     | `sha256(raw)`, prefix de 8 caracteres, scopes, expiración y revocación; rotación revoca la anterior                                                            | Implementado |
| S5  | Sesión de otro usuario                      | Alta      | Sesión user-bound (`app.user_id`), cookie HttpOnly host-only, expiración deslizante + absoluta                                                                 | Implementado |

### T — Tampering

| ID  | Escenario                               | Mitigación                                                                                                                     |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| T1  | Mass assignment (`tenantId`, `isAdmin`) | Zod `.strict()` en schemas de entrada; la DB nunca usa spread del body                                                         |
| T2  | SQL injection en slug/q/cursor          | Queries parametrizadas; `sql.raw` solo para roles y nombres de tabla controlados                                               |
| T3  | Path traversal en `filename`            | Key server-side `tenants/{tenantId}/{uuid}`; filename sin `/`, `\` ni `..`; validación Zod + `CHECK`                           |
| T4  | Webhook tampering                       | Firma sobre bytes exactos; cambio de body invalida la firma; dedupe de `eventId`                                               |
| T5  | Editar auditoría                        | `REVOKE UPDATE,DELETE` + triggers `audit_log_no_update`/`audit_log_no_delete` con error `45000`; `platform_audit_log` separado |

### R — Repudiation

| ID  | Escenario                       | Mitigación                                                                                                                |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1  | Usuario niega una acción        | `audit_log` con actor, tenant, acción, recurso, request/trace, IP, resultado y metadata; `GET /v1/audit` con `audit:read` |
| R2  | Worker niega ejecución          | Outbox, `processed_jobs`, leases, DLQ y métricas con `jobId` determinista                                                 |
| R3  | Rotación de secreto no trazable | Acciones `webhook.secret_rotated` y `api_key.rotated` auditadas; la versión anterior de webhook dura 24 h                 |

### I — Information Disclosure

| ID  | Escenario                             | Mitigación                                                                                                                                                         |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | IDOR en archivos/órdenes/pagos        | Filtro tenant + RLS `FORCE`; `404` idéntico a no existe                                                                                                            |
| I2  | Error revela existencia cross-tenant  | `RequestProblem` genérico; no se distingue “existe en otro tenant”                                                                                                 |
| I3  | Secreto en logs/UI                    | `secret_hash`/`secret_ciphertext`; `rawSecret` solo al crear; logger redacta cookie, authorization y secretos; `GET /metrics` del API no debe exponerse a Internet |
| I4  | Cache leak entre tenants              | Keys `tenant:{id}:v1:{resource}:hash16`; invalidación por prefijo tenant; TTL corto                                                                                |
| I5  | Auditoría global filtrada a un tenant | `platform_audit_log` separado; `audit_log` exige `tenant_id NOT NULL`                                                                                              |
| I6  | Token en el navegador                 | BFF guarda el token en cookie HttpOnly; el cliente no lo lee; CSP y `no-store` en HTML tenant                                                                      |

### D — Denial of Service

| ID  | Escenario                     | Mitigación                                                                           |
| --- | ----------------------------- | ------------------------------------------------------------------------------------ |
| D1  | Hot tenant monopoliza pool    | Rate limit IP/tenant/usuario y endpoints sensibles; cache; breakers                  |
| D2  | Stampede de cache             | `getOrLoad` con lock `SET NX PX 5s` y fallback acotado                               |
| D3  | Payload gigante               | `bodyLimit 1 MB` global y `256 KB` en auth/members; límites Zod de tamaño/cantidad   |
| D4  | S3/OIDC lento bloquea workers | Circuit breakers, timeouts de 2 s y `503 DEPENDENCY_UNAVAILABLE`                     |
| D5  | Redis caído                   | Cache fail-open a DB, rate limiter InMemory, readiness `degraded` pero liveness `ok` |
| D6  | Worker atascado retiene jobs  | Leases con heartbeat, timeout de handler, DLQ y replay auditado                      |

### E — Elevation of Privilege

| ID  | Escenario                              | Mitigación                                                                                  |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| E1  | Operator intenta invitar               | `members:invite` denegado en API; UI no es autoridad                                        |
| E2  | Auditor intenta escribir               | `orders:create`/`inventory:reserve` denegados                                               |
| E3  | Tenant intenta operación de plataforma | Borrado de organización/membresía revocado de `platform_app`; solo `platform_auth`/operador |
| E4  | Borrado de auditoría                   | Trigger + `REVOKE`; retención física requiere superusuario y procedimiento 2-man            |
| E5  | API key escala a owner                 | Los scopes M2M se validan; la identidad M2M no hereda rol humano                            |

## 4. Matriz de riesgos residuales

| Riesgo                                  | Prob. | Impacto | Control actual                                                                                                  | Gap residual                                                                         |
| --------------------------------------- | ----- | ------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| SSRF a metadata/red privada vía webhook | Media | Alto    | `validateUrl` al crear + DNS pinning en worker, bloqueo de rangos privados/link-local, HTTPS:443, sin redirects | Falta egress proxy con allowlist y defensa de red en producción                      |
| Secreto de webhook en entorno           | Media | Alto    | AES-GCM, `WEBHOOK_SECRET_ENCRYPTION_KEY`, rotación con ventana 24 h                                             | Sin KMS/Vault; rotación de la clave maestra es manual                                |
| Métricas del API expuestas              | Media | Medio   | `/metrics` solo debe publicarse en red privada                                                                  | No hay token de autenticación en el API; el worker sí soporta `WORKER_METRICS_TOKEN` |
| Stripe no probado en vivo               | Media | Alto    | Adapter con tests unitarios y timeout                                                                           | Sin sandbox/live; no hay reembolsos                                                  |
| Audit tampering por superusuario        | Baja  | Alto    | Trigger + `REVOKE`; `platform_auditor` separado                                                                 | Un superusuario puede `DISABLE TRIGGER`; requiere control de acceso a DB             |
| Hot tenant                              | Media | Medio   | Rate limits + cache + breakers                                                                                  | Fixed window; no hay aislamiento de pool por tenant                                  |
| Contrato OpenAPI drift                  | Alta  | Medio   | `openapi:check` valida sintaxis/hash                                                                            | No valida rutas runtime; lo corrige el pase de OpenAPI                               |

## 5. Checklist de controles verificables

- [x] Aislamiento tenant con RLS `FORCE`, roles separados, `app.tenant_id` y `app.user_id`.
- [x] Sesiones user-bound y cookie HttpOnly; BFF sin exponer el token.
- [x] Auditoría append-only y separación `audit_log`/`platform_audit_log`.
- [x] HMAC de webhooks con dedupe y ventana de timestamp.
- [x] SSRF de creación + DNS pinning de salida; bloqueo de rangos privados.
- [x] Rate limits y circuit breakers.
- [x] CI de seguridad: `pnpm audit`, gitleaks, Semgrep, CodeQL (condicional) y Trivy.
- [ ] KMS/Vault para cifrado de secretos.
- [ ] Egress proxy con allowlist.
- [ ] Autenticación de `/metrics` en el API o proxy con allowlist.

## 6. Próximos pasos

1. Integrar KMS/Vault y rotar `WEBHOOK_SECRET_ENCRYPTION_KEY` con procedimiento probado.
2. Añadir egress proxy/allowlist y prueba de DNS rebinding.
3. Proteger `/metrics` del API con token o red privada y alerta `MetricsScrapeDenied`.
4. Probar Stripe en sandbox y documentar reembolsos/chargebacks.
5. Reconciliar OpenAPI y añadir contract tests que ejecuten las rutas reales.

## 7. Referencias

- `apps/api/src/plugins/security.ts` — helmet, CORS, body limit, CSRF.
- `apps/api/src/webhook-store.ts` — `validateUrl` y cifrado de secretos.
- `apps/worker/src/webhook-egress.ts` — DNS pinning y rangos bloqueados.
- `packages/db/migrations/schema/0024_identity_privilege_hardening.sql` — roles, sesiones, auditoría.
- `packages/db/migrations/schema/0011_audit_hardening.sql` — append-only y campos de auditoría.
- `docs/runbooks/security.md`, `docs/runbooks/egress-ssrf.md`, `docs/runbooks/key-rotation.md`.
