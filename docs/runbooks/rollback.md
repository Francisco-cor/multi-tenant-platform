# Runbook — Rollback, roll-forward y criterios de abort (Fase 14)

> Fase 14 expand-contract — regla crítica: **rollback de app no implica rollback de DB**. Si el esquema ya se expandió, la app anterior debe seguir compatible; si no lo es, se hace **roll-forward** con corrección compatible. Cambios destructivos se difieren hasta contract.

## 1. Principios

- **Expand** añade columnas/tablas/índices nullable o compatibles (ej `branches.description text null` `0012_expand_branch_description.sql`). No `NOT NULL`, no `DEFAULT` con rewrite, no `DROP`.
- **Contract** elimina camino viejo en otra release, cuando ningún pod `vN` queda en tráfico.
- **Backfill** en batches pequeños reanudables (`data/0001_backfill_branch_description.sql` `LIMIT 1000 SKIP LOCKED`, `pg_sleep 10ms`).
- **Índices grandes** siempre `CREATE INDEX CONCURRENTLY` fuera de transacción (`indexes/0005_branch_description_search.sql`, `migrate.ts transactional:false`).
- Cada migración registra `schema_migrations(kind, checksum, duration_ms, applied_by)` con advisory lock `pg_try_advisory_lock` + `lock_timeout 10s` + `statement_timeout 30s` y logs JSON (`migrate.ts`).

## 2. Pipeline de migración (qué ejecuta y cuándo)

```
CI: pnpm --filter @platform/db analyze:migrations   # verifica CONCURRENTLY, no NOT NULL sin default, no DROP sin contract
    pnpm --filter @platform/db migrate:dry-run      # lista pending sin aplicar (JSON log)
    pnpm --filter @platform/db migrate              # aplica schema -> data -> indexes con lock
CD: helm upgrade --set image.tag=$COMMIT_SHA  (rollingUpdate maxUnavailable 0 maxSurge 1, readiness /health/ready)
    kubectl rollout status deployment/api
    node scripts/smoke.mjs --api https://staging.api
    node scripts/rolling-deploy-check.mjs --api https://staging.api
```

- `MIGRATION_LOCK_TIMEOUT_MS=10000` y `MIGRATION_STATEMENT_TIMEOUT_MS=30000` pueden sobreescribirse vía env.
- Si el runner muere a mitad (`kill -9`), `schema_migrations` no tiene row para esa migración, índice `CONCURRENTLY` puede quedar `INVALID` — ver §5.

## 3. Deploy rolling con 2 versiones (vN y vN+1)

- `Deployment` `rollingUpdate maxUnavailable 0 maxSurge 1`, `readinessProbe /health/ready`, `liveness /health/live`, `preStop 30s` `terminationGracePeriod 30s`.
- Durante expand, ambos pods sirven `200`:
  - `vN` hace `SELECT id, slug, name FROM branches` (sin `description`) — columna existe pero no seleccionada, no falla.
  - `vN+1` hace `SELECT id, slug, name, COALESCE(description,'')` — filas viejas con `NULL` → `''`.
  - Escritura: `vN` inserta sin `description` (nullable), `vN+1` inserta con `description`. Ver `persistent-identity-store.ts createBranch` fallback si columna no existe.
- Métricas: `http_requests_total` con `version` label (si `OTEL_RESOURCE_ATTRIBUTES service.version` presente), Grafana `api-red` con error rate.

Ver `docs/failure-scenarios/deploy-half.md` para inyección completa y `apps/api/src/rolling-deploy.test.ts` para test automatizado + `scripts/rolling-deploy-check.mjs` para verificación post-deploy.

## 4. Feature flags y kill switches por tenant

Tabla `tenant_feature_flags (tenant_id, flag) PK` (`0013_tenant_feature_flags.sql`) `FORCE RLS`.

- Flags: `branch_description`, `orders_create`, `inventory_reserve`, `webhook_delivery`, `hot_tenant_rate_limit`, `kill_orders_write`, `kill_webhooks`.
- API: `GET /v1/flags` (list), `GET /v1/flags/:flag`, `PUT /v1/flags/:flag {enabled,payload}` (requiere `audit:read` + `owner|admin`, audit `flag.updated`).
- Kill switch: `PUT /v1/flags/kill_orders_write {enabled:true}` tenant-scoped. `POST /v1/orders` verifica `featureFlagStore.isEnabled(tenant, 'kill_orders_write')` y si true retorna `503 KILL_SWITCH` sin tocar DB (fail-closed para abuso, fail-open para flag store error). Ver `apps/api/src/rolling-deploy.test.ts` canary `acme` kill no afecta `contoso`.

Canary por tenant: habilitar `branch_description` solo en `acme` (`payload:{percentage:10}`) antes de rollout global.

## 5. Rollback de aplicación vs roll-forward de esquema

| Situación                                                                      | Acción                                                                                                                                                      | Por qué                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Bug en app `vN+1` pero esquema expand ya aplicado                              | **Rollback de app** a `vN` (`kubectl rollout undo` o `helm rollback`) — **no** `DROP COLUMN`                                                                | `vN` es compatible con esquema `N+1` (nullable). DB permanece en `N+1`. |
| Migración expand falla a mitad                                                 | No deja `schema_migrations` row; si índice `INVALID`, `DROP INDEX CONCURRENTLY IF EXISTS` + rerun `pnpm migrate` (idempotente)                              | `CONCURRENTLY` fuera de tx puede dejar `indisvalid=true`                |
| Necesidad de deshacer cambio destructivo                                       | **Roll-forward** con nueva migración compatible que revierte el efecto (ej `ALTER TABLE ADD COLUMN` de vuelta) — nunca `git reset` sobre migración aplicada | `migration_checksum_mismatch` bloquea edición ilícita                   |
| Contract ya aplicado y `vN` aún en tráfico (error 500 `column does not exist`) | Roll-forward inmediato: redeploy `vN+1` fix o restaurar columna via `ADD COLUMN IF NOT EXISTS`                                                              | Contract se difiere 1 release por eso                                   |

Checklist rollback:

- [ ] `kubectl get pods` — ¿quedan pods `vN`? Si sí, contract **no** aplicado.
- [ ] `select * from schema_migrations order by applied_at` — confirmar qué expand está aplicado.
- [ ] `select indexname, indisvalid from pg_index where indisvalid=false` — si false, `DROP CONCURRENTLY` y rerun.
- [ ] `node scripts/smoke.mjs` — liveness/readiness/metrics/openapi.
- [ ] `node scripts/rolling-deploy-check.mjs` — ambos pods 200.

## 6. Criterio de abortar / pausar / continuar

**Abortar deploy** (no promover canary):

- `http_req_failed > 0.01` (k6 `http_req_failed<0.01`) o `5xx / requests > 1%` (alert `ErrorRateHigh` firing) — ver `infra/prometheus/alerts.yml`.
- `p95 > 300ms` en lecturas o `>500ms` en escrituras.
- `outbox_lag_seconds > 30` (health `outbox` fail).
- `payment_unknown` `oldest_age > 30m` o `dlq_size > 0` nuevo.
- Cualquier `schema_migrations` con `migration_checksum_mismatch`.

**Pausar** (mantener canary 10%):

- Latencia subida pero sin 500 (p95 300-500ms).
- Un tenant hot (`rate_limit_hits` para `acme` alto pero `contoso` ok) — usar kill switch antes de pausar global.
- `redis-down` o `db-slow` con circuit `OPEN` pero degradado controlado.

**Continuar/promover** (100%):

- Smoke 8 checks pasan (`scripts/smoke.mjs`).
- Rolling check pasa (`rolling-deploy-check.mjs`).
- `migrate:dry-run` pending 0 y `analyze:migrations` sin errores.
- `GET /metrics` sin `kill_switch` activo salvo intencional.

## 7. Seeds y entornos

- **Nunca** `pnpm --filter @platform/db seed` en `NODE_ENV=production` sin `ALLOW_SEED=1`. El seed usa `INSERT ... ON CONFLICT DO NOTHING` y nunca `DELETE/TRUNCATE`.
- Local/CI: `pnpm --filter @platform/db seed` crea `acme/contoso` + `branch-acme-main` etc para `tests/e2e/isolation.spec.ts` y `k6`.
- Staging/prod: datos via migraciones + API (`POST /v1/organizations`) — no seed destructivo. `seed --check` verifica existencia sin escribir.

## 8. Versionado de imágenes y artefactos

- `docker build -f apps/api/Dockerfile --build-arg COMMIT_SHA=$(git rev-parse HEAD) --build-arg BUILD_DATE=$(date +%Y%m%d) -t platform-api:$(git rev-parse --short HEAD) .` (`scripts/docker-tag.mjs`).
- Label OCI: `org.opencontainers.image.revision`, `created`, `version` visibles en `docker inspect`.
- CI publica `platform-api:${commitSHA}` y `platform-api:latest` inmutables; deploy referencia `image.tag = commitSHA` (trazable a `git log`).
- Matriz compatibilidad: `docs/api/.openapi.hash` + `schema_migrations` checksum + `image tag` — ver `docs/runbooks/postgres-migrations.md`.

## 9. Evidencia esperada tras Fase 14

- `pnpm --filter @platform/db migrate:dry-run` `JSON {pending:["schema/0012...","schema/0013...","data/0001...","indexes/0005..."]}` antes de apply, `0 pending` después.
- `node scripts/analyze-migrations.mjs` `OK analysis passed`.
- `pnpm test` `rolling-deploy.test.ts` 3 passed (branch dual-read, flag isolation kill switch, RBAC).
- `node scripts/rolling-deploy-check.mjs` `PASS` (HTTP o in-memory).
- Grafana sin `ErrorRateHigh` durante rolling, `GET /metrics` con `http_requests_total`.
