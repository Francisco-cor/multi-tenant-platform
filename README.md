# Multi-Tenant SaaS Platform

Operations Hub B2B para organizaciones con múltiples sucursales. El proyecto prioriza aislamiento tenant real, consistencia bajo reintentos y evidencia operativa sobre la cantidad de pantallas.

## Estado por fase

Estado verificado el **2026-11-13** sobre `main` fusionado. Una fase solo se marca **Completa** si el código existe, sus pruebas pasan en CI y la documentación operativa está enlazada. Las fases con implementación real pero evidencia incompleta se marcan **Parcial**; no se presentan como cerradas.

| Fase                               | Código   | Pruebas  | Docs     | Evidencia                                                                                           | Gaps conocidos                                                                                                                   |
| ---------------------------------- | -------- | -------- | -------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0 Bootstrap                        | Completa | Completa | Completa | `pnpm install`, `pnpm build`, Compose de infraestructura                                            | Nada bloqueante para local                                                                                                       |
| 1 Contratos y dominio              | Completa | Parcial  | Completa | `pnpm openapi:check`; esquemas Zod y dominio                                                        | El contrato OpenAPI tiene rutas no implementadas y `sku` vs `productId`; lo corrige el pase posterior de OpenAPI                 |
| 2 Identidad, tenants y RBAC        | Completa | Parcial  | Completa | API + BFF web, sesiones y RBAC; tests unitarios                                                     | E2E de navegador es opt-in (`ENABLE_E2E=true`), no gate por defecto                                                              |
| 3 PostgreSQL, migraciones y RLS    | Completa | Completa | Completa | Migraciones 0001–0028, roles `platform_app`/`platform_auth`, RLS `FORCE`; integración en CI         | RLS depende de un login gestionado que asuma el rol sin `BYPASSRLS`                                                              |
| 4 Órdenes                          | Parcial  | Parcial  | Parcial  | `orders`, creación/listado/consulta y saga de pago                                                  | Sin líneas de orden, precios capturados, export ni idempotencia HTTP cableada; `order_idempotency` existe pero la ruta no la usa |
| 5 Inventario concurrente           | Completa | Completa | Completa | Reserva 15 min, `UPDATE ... WHERE available >= qty`, expiración `SKIP LOCKED`, test stock 1         | Los escenarios `k6` no se ejecutan en CI                                                                                         |
| 6 Archivos S3                      | Completa | Completa | Completa | Presign → finalize → download, RLS, GC; integración MinIO en CI                                     | La ruta real es `POST /v1/files/presign`; OpenAPI aún publica `presigned-upload`                                                 |
| 7 Outbox, BullMQ y workers         | Completa | Completa | Completa | Outbox transaccional, relay `SKIP LOCKED`, dedupe, leases, DLQ, readiness de worker                 | Retención existe como helper de DB; no hay scheduler de retención cableado                                                       |
| 8 Pagos                            | Parcial  | Parcial  | Completa | `FakePaymentProvider`, saga, webhook HMAC y reconciler; `StripePaymentProvider` con tests unitarios | Stripe no está probado contra la API real ni en sandbox; no hay reembolsos                                                       |
| 9 Webhooks y automatizaciones      | Completa | Parcial  | Completa | Endpoints, deliveries, replay, inbound dedupe, automatizaciones versionadas, egress con DNS pinning | Sin receptor real en CI ni prueba de entrega contra internet                                                                     |
| 10 Cache, rate limit y resiliencia | Completa | Parcial  | Completa | Cache tenant-scoped, rate limit por IP/tenant/usuario/endpoint, breakers                            | Pruebas usan Redis/InMemory simulados; no hay Redis real en CI para cache                                                        |
| 11 Auditoría y seguridad           | Parcial  | Completa | Completa | `audit_log` + `platform_audit_log`, roles separados, headers, SSRF, CI de seguridad                 | KMS/Vault pendiente; egress proxy pendiente; API `/metrics` sin token                                                            |
| 12 Observabilidad                  | Completa | Completa | Completa | Trazas, logs redactados, RED metrics, alertas y dashboards                                          | Métricas del API deben restringirse por red; no hay autenticación en `/metrics`                                                  |
| 13 Testing y fallos                | Parcial  | Parcial  | Completa | Vitest, integración CI, escenarios documentados                                                     | E2E opt-in, `k6` fuera de CI y varios escenarios son procedimientos, no evidencia reciente                                       |
| 14 Migraciones y despliegues       | Parcial  | Parcial  | Completa | Expand-contract, migraciones por clase, runbook de rollback                                         | Sin rollout real de dos versiones ni clúster; contract diferido                                                                  |
| 15 Docker, K8s y Terraform         | Parcial  | Parcial  | Parcial  | Imágenes no-root de API/web/worker y Compose; matriz Docker en CI                                   | No hay manifests Kubernetes ni Terraform en el árbol                                                                             |
| 16 CI/CD y release                 | Parcial  | Completa | Parcial  | CI con calidad, unit, integración y seguridad                                                       | No hay pipeline de staging/producción, canary, ni release inmutable                                                              |

Evidencia local reproducible:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm openapi:check
pnpm migrate:check
```

La integración real de PostgreSQL/Redis/MinIO vive en `.github/workflows/ci.yml` (`integration`) y requiere servicios. No se debe afirmar que E2E o Fase 13 están cerrados: el job `e2e` solo corre con `vars.ENABLE_E2E=true`.

## Requisitos locales

- Node.js `24.x`
- pnpm `11.x`
- Docker Desktop con Compose

## Quickstart

```bash
pnpm install --ignore-scripts
cp .env.example .env
docker compose up -d
pnpm dev
```

En PowerShell, usa `Copy-Item .env.example .env`. Las dependencias locales quedan disponibles en:

- Web: <http://localhost:3000> (tenant de ejemplo: `acme.app.localhost:3000`)
- API: <http://localhost:4000>
- API liveness: <http://localhost:4000/health/live>
- Worker health: <http://localhost:4010/health/ready>
- MinIO console: <http://localhost:9001>
- Grafana: <http://localhost:3001>
- Prometheus: <http://localhost:9090>

`pnpm dev` en la raíz ejecuta `scripts/dev.mjs`, que carga `.env` (o `.env.example` como fallback) antes de lanzar Turbo. Los scripts de cada app (`pnpm --filter @platform/api dev`) **no** cargan `.env` por sí mismos: exporta las variables o usa `node --env-file=.env` al ejecutarlos directamente.

Compose levanta solo infraestructura y exporters; las apps se ejecutan desde el workspace para acelerar el ciclo local. No hay servicios de API/web/worker en `docker-compose.yml`.

## Comandos

```bash
pnpm dev                 # web, API y worker (tsx watch); carga .env desde la raíz
pnpm build               # emite dist/ (api/worker) y .next/ (web)
pnpm typecheck           # TypeScript en todos los paquetes
pnpm lint                # ESLint + import/no-cycle + boundaries
pnpm test:unit           # Vitest unitario; falla si no se ejecuta ningún test
pnpm test:integration    # integración por workspace (requiere servicios)
pnpm test:e2e            # Playwright (opt-in; instala navegador)
pnpm format:check        # formato reproducible
pnpm openapi:check       # valida docs/api/openapi.yaml y hash drift (.openapi.hash)
node scripts/check-docs-links.mjs  # enlaces y rutas citadas en la documentación
```

### Docker (builds reproducibles)

```bash
docker build -f apps/api/Dockerfile -t platform-api:local .
docker build -f apps/web/Dockerfile -t platform-web:local .
docker build -f apps/worker/Dockerfile -t platform-worker:local .
# web standalone requiere STANDALONE=1 (ya seteado en Dockerfile)
```

### PostgreSQL y aislamiento

```bash
pnpm --filter @platform/db migrate
RUN_DB_INTEGRATION=1 pnpm --filter @platform/db test:integration
pnpm --filter @platform/db backup --output .artifacts/db/platform-manual.dump
pnpm --filter @platform/db restore:drill
# Integración con containers efímeros (requiere Docker)
pnpm --filter @platform/testing exec vitest --run  # usa withPostgres() si TESTCONTAINERS_DISABLED!=1
```

El runner toma `DATABASE_URL`, usa un advisory lock y registra cada archivo en `schema_migrations`. Las migraciones se separan en `schema/`, `data/` e `indexes/`; las de índices grandes se ejecutan fuera de transacción. El restore drill crea una base temporal, verifica filas, historial y RLS y la elimina al terminar.

La aplicación usa `DATABASE_ROLE=platform_app`; autenticación/credenciales usan `platform_auth`; el worker usa `platform_worker` para el relay global. Los tres son roles `NOLOGIN` sin `SUPERUSER` ni `BYPASSRLS` (el worker usa `BYPASSRLS` solo para el relay y no sirve requests tenant). En producción el login debe poder asumir el rol correspondiente sin ser superusuario ni propietario de las tablas.

### Contrato OpenAPI

`pnpm openapi:check` valida sintaxis, rutas mínimas y hash. No demuestra que cada ruta del YAML exista en el runtime. Diferencias conocidas al 2026-11-13:

- `POST /v1/inventory/reserve` usa `productId` en la API; OpenAPI documenta `sku`.
- OpenAPI publica `POST /v1/files/presigned-upload`, `GET/POST /v1/organizations/{id}/members`, `POST /v1/inventory/reservations`, `/v1/me` y `/v1/webhooks/{id}/replay`; el runtime usa otras rutas o métodos.
- El pase posterior de OpenAPI debe reconciliar el contrato; este documento no lo modifica.

## Estructura

```text
apps/web       Next.js UI, middleware de tenant y BFF (proxy server-side)
apps/api       API HTTP versionada
apps/worker    Procesos BullMQ, relay outbox y reconciliadores
packages/auth  Contratos de identidad/autorización
packages/config Configuración validada
packages/contracts Esquemas HTTP y errores
packages/db    Frontera de acceso a datos tenant-scoped y migraciones
packages/domain Reglas de dominio, roles y estados
packages/observability Correlation IDs y primitives de telemetría
packages/testing Utilidades compartidas para tests
docs/          Arquitectura, ADRs, contratos y runbooks
infra/         Configuración local de observabilidad (K8s/Terraform pendientes)
```

## Principios de desarrollo

1. El contexto autenticado es la única fuente válida de `tenant_id`.
2. Los repositories tenant-scoped reciben contexto explícito; no hay búsquedas globales por ID.
3. PostgreSQL aplica una segunda barrera mediante RLS dentro de transacciones con `app.tenant_id`; la sesión se vincula con `app.user_id`.
4. Toda operación con efectos repetibles debe definir idempotencia antes de entrar a producción.
5. Un cambio que no tiene prueba de fallo, observabilidad y documentación no está terminado.

## Documentación

- Índice: [`docs/README.md`](docs/README.md)
- Demo para entrevista: [`docs/demo.md`](docs/demo.md)
- Estado y evidencia: [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
- Seguridad: [`SECURITY.md`](SECURITY.md) y [`docs/threat-model.md`](docs/threat-model.md)
- Runbooks: [`docs/runbooks/`](docs/runbooks/)

## Seguridad

No pongas credenciales reales en `.env.example`, commits, logs o archivos de Compose. Para reportar una vulnerabilidad usa el canal privado definido en [`SECURITY.md`](SECURITY.md) antes de abrir un issue público.
