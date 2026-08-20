# Multi-Tenant SaaS Platform

Operations Hub B2B para organizaciones con múltiples sucursales. El proyecto prioriza aislamiento tenant real, consistencia bajo reintentos y evidencia operativa sobre la cantidad de pantallas.

## Estado

Fase 0 y 1 estan cerradas. La Fase 2 tiene implementado el vertical slice de identidad, organizaciones, subdominios, RBAC y auditoria. La Fase 3 ya incluye la migracion base PostgreSQL, RLS y el limite transaccional de tenant; el corte completo de la API a repositories persistentes sigue en la siguiente iteracion. El roadmap completo esta en [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

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
pnpm dev                 # web, API y worker
pnpm typecheck           # TypeScript en todos los paquetes
pnpm lint                # checks de ESLint
pnpm test                # suite disponible por workspace
pnpm format:check        # formato reproducible
```

### PostgreSQL y aislamiento

```bash
pnpm --filter @platform/db migrate
RUN_DB_INTEGRATION=1 pnpm --filter @platform/db test:integration
```

El runner toma `DATABASE_URL`, usa un advisory lock y registra cada archivo en `schema_migrations`. En local `DATABASE_ROLE=platform_app` hace que la aplicacion use el rol NOLOGIN creado por la migracion; en produccion debe enlazarse a un login gestionado sin privilegios de superusuario.

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
