# Multi-Tenant SaaS Platform

Operations Hub B2B para organizaciones con múltiples sucursales. El proyecto prioriza aislamiento tenant real, consistencia bajo reintentos y evidencia operativa sobre la cantidad de pantallas.

## Estado

Fase 0 y 1 estan cerradas (bootstrap + contratos). La **Fase 1 de elevación** también cerrada: `apps/api`/`worker` emiten `dist/`, `apps/web` soporta `standalone` (STANDALONE=1), Dockerfiles multi-stage con base `node:24-alpine` pinnada, `.dockerignore`, validación estricta `TENANT_BASE_DOMAIN`, lint `import/no-cycle` + boundaries y helpers `testcontainers` para integración. La Fase 2 mantiene el vertical slice de identidad y RBAC con store en memoria para tests unitarios. La Fase 3 ya incluye migraciones PostgreSQL, RLS real, contexto transaccional y API conectada al adaptador persistente tenant-scoped. **Fase 5 (inventario concurrente)** cerrada: reserva temporal 15m + `UPDATE WHERE available>=qty` atómico, `expireReservations` con `SKIP LOCKED`, tests 50 concurrent stock 1 + k6. **Fase 6 (archivos S3)** cerrada: `files` tenant-scoped + RLS, keys `tenants/{tenantId}/{uuid}` TTL 300s/60s, flujo presigned → finalize → download, GC huérfanos 24h, tests cross-tenant 404/409/410. **Fase 7 (outbox/BullMQ)** cerrada: `outbox_events` + `processed_jobs` + `dlq_jobs` `FORCE RLS`, `files` e `inventory` escriben outbox transaccional, relay `SKIP LOCKED` + `jobId` sha256 + backoff jitter, queues `InMemory`/`BullMQ` concurrency 10 timeout 10s, dedupe `processed_jobs`, `GET /metrics` + `health outbox lag`, DLQ `GET /v1/dlq` + `POST /replay` `owner/admin` + audit, `ADR-004`.

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

- Web: <http://localhost:3000>
- API: <http://localhost:4000>
- API liveness: <http://localhost:4000/health/live>
- MinIO console: <http://localhost:9001>
- Grafana: <http://localhost:3001>
- Prometheus: <http://localhost:9090>

La primera versión de Compose levanta infraestructura de desarrollo; los servicios de aplicación se ejecutan desde el workspace para acelerar el ciclo local.

## Comandos

```bash
pnpm dev                 # web, API y worker (tsx watch)
pnpm build               # emite dist/ (api/worker) y .next/ (web)
pnpm typecheck           # TypeScript en todos los paquetes
pnpm lint                # ESLint + import/no-cycle + boundaries
pnpm test                # suite disponible por workspace
pnpm format:check        # formato reproducible
pnpm openapi:check       # valida docs/api/openapi.yaml y hash drift (.openapi.hash)
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
pnpm --filter @platform/testing exec vitest --run  # usa withPostgres() helper si TESTCONTAINERS_DISABLED!=1
```

El runner toma `DATABASE_URL`, usa un advisory lock y registra cada archivo en `schema_migrations`. Las migraciones se separan en `schema/`, `data/` e `indexes/`; las de indices grandes se ejecutan fuera de transaccion. El restore drill crea una base temporal, verifica filas, historial y RLS y la elimina al terminar. En local `DATABASE_ROLE=platform_app` hace que la aplicacion use el rol NOLOGIN creado por la migracion; en produccion debe enlazarse a un login gestionado sin privilegios de superusuario.

## Estructura

```text
apps/web       Next.js UI y resolución de tenant por host
apps/api       API HTTP versionada
apps/worker    Proceso de trabajos asíncronos
packages/auth  Contratos de identidad/autorización
packages/config Configuración validada
packages/contracts Esquemas HTTP y errores
packages/db    Frontera de acceso a datos tenant-scoped
packages/domain Reglas de dominio, roles y estados
packages/observability Correlation IDs y primitives de telemetría
packages/testing Utilidades compartidas para tests
docs/          Arquitectura, ADRs, contratos y runbooks
infra/         Configuración local y futura infraestructura declarativa
```

## Principios de desarrollo

1. El contexto autenticado es la única fuente válida de `tenant_id`.
2. Los repositories tenant-scoped reciben contexto explícito; no hay búsquedas globales por ID.
3. PostgreSQL aplica una segunda barrera mediante RLS dentro de transacciones con `app.tenant_id`.
4. Toda operación con efectos repetibles debe definir idempotencia antes de entrar a producción.
5. Un cambio que no tiene prueba de fallo, observabilidad y documentación no está terminado.

## Seguridad

No pongas credenciales reales en `.env.example`, commits, logs o archivos de Compose. Para reportar una vulnerabilidad usa el canal privado definido por el equipo antes de abrir un issue público.
