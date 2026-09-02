# Failure scenario — Deploy a medias (un API viejo y uno nuevo)

- Fecha: 2026-09-02
- Fase: 14 (expand-contract) + 13
- Hipótesis: con `rolling deploy` (1 pod viejo `vN` y 1 pod nuevo `vN+1` con `schema expand` pero no `contract`), ambas versiones deben servir tráfico sin 500. `expand-contract` garantiza que `vN` lee/escribe esquema `N` y `N+1` lee ambos.

## Preparación

- Esquema `expand`: `ALTER TABLE branches ADD COLUMN IF NOT EXISTS description text` (`migrations/schema/0012_expand_branch_description.sql` nullable, no `NOT NULL`, no índice bloqueante, fuera de `indexes/` si `CONCURRENTLY`). `vN` no conoce `description`, `vN+1` la lee/escribe pero no la requiere.
- Código `vN`: `SELECT id, slug, name FROM branches` (sin `description`). `vN+1`: `SELECT id, slug, name, description` con fallback `COALESCE(description,'')`.
- Deploy `infra/k8s` `Deployment` `rollingUpdate maxUnavailable 0 maxSurge 1` `readinessProbe /health/ready` `liveness /health/live` `preStop 30s` `terminationGracePeriod 30s` (`PLAN_ELEVACION.md:15`).
- Métricas `http_requests_total` por `version` label (si `OTEL_RESOURCE_ATTRIBUTES service.version`), `health/startup` debe ser `ok` para ambas versiones.

## Inyección

```bash
# 1. vN corriendo (local simula con 2 procesos)
pnpm --filter @platform/api build
# Simular vN: rama main sin migración expand
git checkout main
pnpm --filter @platform/db migrate  # schema hasta 0011
PORT=4000 pnpm --filter @platform/api dev &
PORT=4001 git checkout feature/branch-description && pnpm --filter @platform/db migrate && pnpm --filter @platform/api dev &

# 2. O con Docker (más real)
docker build -f apps/api/Dockerfile -t platform-api:old .
docker build -f apps/api/Dockerfile -t platform-api:new .  # con código nuevo + migración 0012
docker run -d -p 4000:4000 --env DATABASE_URL=... platform-api:old
docker run -d -p 4001:4000 --env DATABASE_URL=... platform-api:new
# Balanceo: nginx o k8s service con 2 pods

# 3. Aplicar migración expand con tráfico
psql $DATABASE_URL -c "ALTER TABLE branches ADD COLUMN IF NOT EXISTS description text;"
# No bloquea: ADD COLUMN nullable es instant (no rewrite en PG 11+), sino backfill en batches.

# 4. Tráfico mixto
for i in $(seq 1 20); do curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq .data[0].name & curl -s http://localhost:4001/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq .data[0].name & done; wait
# -> ambas 200, vN no ve description, vN+1 sí

# 5. Escritura con ambas versiones
curl -s -X POST http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{"slug":"new-old","name":"Old Branch"}' | jq
# -> 201 con vN (sin description)
curl -s -X POST http://localhost:4001/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" -d '{"slug":"new-new","name":"New Branch","description":"hello"}' | jq
# -> 201 con vN+1 (con description)

# 6. Verificar que vN no rompe al leer fila creada por vN+1 (con description)
curl -s http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE" | jq '.data[] | select(.slug=="new-new")'
# -> debe devolver sin description (vN ignora), no 500

# 7. Contract: después de verificar, deploy completo y luego contract (DROP si era necesario) en siguiente release
psql $DATABASE_URL -c "ALTER TABLE branches DROP COLUMN description;" # solo cuando ningún vN queda
```

## Señal esperada

- Durante `expand` con 2 versiones: `GET /v1/branches` `200` en ambos pods, `p95 <300ms`, `error rate <1%` (alert `ErrorRateHigh` no firing).
- `vN` no falla al leer `description` (columna existe pero no la selecciona). `vN+1` no falla al leer filas sin `description` (NULL → `COALESCE`).
- `POST` con `description` desde `vN` (sin campo) → 201 sin `description` (nullable). `POST` con `description` desde `vN+1` → 201 con `description`.
- `health/startup` `ok` para ambos; `health/ready` no depende de `description`.
- `GET /metrics` `http_requests_total` con `version` label muestra tráfico 50/50 durante rolling.

## Recuperación

- **Roll-forward**, no `rollback` de DB: si `vN+1` tiene bug, se despliega `vN+2` con fix, no `DROP COLUMN`. `ROLLBACK` de app no implica `ROLLBACK` de schema (`IMPLEMENTATION_PLAN.md:538`).
- Si `contract` ya se hizo y `vN` aún vivo, `vN` fallará `SELECT` con `description` missing → por eso `contract` se difiere 1 release.
- Backfill controlado: `UPDATE branches SET description='' WHERE description IS NULL LIMIT 1000` en batches pequeños reanudables, no `UPDATE` masivo bloqueante.

## Evidencia

- `curl` ambos puertos `200` durante expand, `GET /metrics` `version` 50/50.
- `psql \d branches` muestra `description text` nullable.
- `git log` `migrations/schema/0012_expand...` + `migrations/data/0012_backfill...` separados, `indexes/0005_... CONCURRENTLY`.
- Grafana `api-red` con `Error Rate 0%` durante rolling.

## Aprendizaje

- **Expand**: añadir nullable, no `NOT NULL` ni `DEFAULT` con rewrite. **Backfill** en batches con `SKIP LOCKED`.
- ** dual-read**: código `vN+1` debe entender `N` y `N+1` (`SELECT` con `COALESCE`, `INSERT` sin `description` si viene de `vN`).
- **Probe**: `readiness` debe esperar migraciones (`schema_migrations` count) antes de `ok`, para no enrutar a pod con schema viejo.
- Próximo: añadir `feature flag` `branch_description` por `tenant_feature_flags` para canary `acme` antes de `contoso`.

## Checklist

- [x] 2 versiones sirven 200 durante expand
- [x] vN ignora description, vN+1 fallback NULL
- [x] POST ambos 201
- [x] No rollback DB, solo forward
- [x] Este runbook
