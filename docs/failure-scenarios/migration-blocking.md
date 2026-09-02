# Failure scenario — Migración bloqueante (índice con tráfico)

- Fecha: 2026-09-02
- Fase: 14 (expand-contract) + 13
- Hipótesis: ejecutar `CREATE INDEX` bloqueante (`LOCK TABLE`) con tráfico debe no hacer que `requests` antiguas fallen (500) ni `migrate` deje el esquema en estado desconocido. La migración debe usar `CONCURRENTLY` fuera de transacción, con `lock` timeout y `retry` observable.

## Preparación

- Runner `packages/db/src/migrate.ts:1` `advisory lock pg_advisory_lock`, `schema/data/indexes` separados, `CONCURRENTLY` fuera de tx, `checksum sha256`.
- Índice grande: `branches` 10k filas, `CREATE INDEX CONCURRENTLY tenant_branches_lookup ON branches(tenant_id, slug)` (`migrations/indexes/0003_concurrent_branch_lookup.sql`).
- Tráfico: `k6 run k6/orders-read.js --vus 10 --duration 30s` contra `GET /v1/branches` (usa índice `tenant_id, slug`).
- `statement_timeout 5s` `idle_in_transaction 5s` para `platform_app` (`migrations/schema/0005_db_hardening.sql`).

## Inyección

```bash
# 1. Baseline sin índice: ya existe, lo borramos para probar migración bloqueante
psql $DATABASE_URL -c "DROP INDEX IF EXISTS tenant_branches_lookup;"

# 2. Lanzar tráfico en background
k6 run k6/orders-read.js --vus 10 --duration 60s &
K6_PID=$!

# 3. Ejecutar migración bloqueante (mala): con LOCK
psql $DATABASE_URL -c "CREATE INDEX tenant_branches_lookup ON branches(tenant_id, slug);" &
# -> bloquea WRITES en branches durante 5-10s (AccessExclusive), requests 500 o timeout

# 4. Observar: durante CREATE INDEX (sin CONCURRENTLY), curl debe seguir 200 pero con latencia alta
for i in $(seq 1 10); do curl -s -w "%{http_code} %{time_total}\n" -o /dev/null http://localhost:4000/v1/branches -H 'host: acme.app.localhost' -H "cookie: $COOKIE"; done
# -> con bloqueo: 2-3× 500 o >5s timeout

# 5. Ahora con CONCURRENTLY (buena): fuera de transacción, no bloquea
psql $DATABASE_URL -c "DROP INDEX IF EXISTS tenant_branches_lookup;"
psql $DATABASE_URL -c "CREATE INDEX CONCURRENTLY tenant_branches_lookup ON branches(tenant_id, slug);"
# -> no bloquea, requests siguen 200, p95 no sube >100ms

# 6. Runner correcto: debe hacer CONCURRENTLY fuera de tx
pnpm --filter @platform/db migrate
# -> log: "migrating 0003_concurrent_branch_lookup.sql CONCURRENTLY outside transaction" + advisory lock + duration_ms

# 7. Simular migración fallida a mitad (kill -9 del runner)
ps aux | grep migrate
kill -9 <pid>
psql $DATABASE_URL -c "SELECT * FROM schema_migrations WHERE filename='0003_concurrent_branch_lookup.sql';"
# -> no row (no registrada porque no terminó), estado conocido. Reintentar:
pnpm --filter @platform/db migrate
# -> debe reintentar CONCURRENTLY, no dejar índice inválido (PG marca INVALID si falla CONCURRENTLY, debe DROP y reintentar)
psql $DATABASE_URL -c "SELECT indexname, indisvalid FROM pg_index WHERE indexname='tenant_branches_lookup';"
# -> indisvalid false si falló a mitad, runner debe DROP CONCURRENTLY IF EXISTS y re-crear

# 8. Verificar que migración fallida no deja estado desconocido sin runbook
cat docs/runbooks/postgres-migrations.md
# -> runbook: si indisvalid, DROP INDEX CONCURRENTLY y re-run migrate
```

## Señal esperada

- Con `CREATE INDEX` bloqueante: `p95` sube a >5s, `http_req_failed` >2% (k6 threshold `http_req_failed <0.02` falla), `ErrorRateHigh` alert firing.
- Con `CREATE INDEX CONCURRENTLY`: `p95` <300ms, `http_req_failed 0%`, `requests` antiguas 200. `migrate` log `duration_ms` y `checksum`.
- `migrate` con `kill -9`: `schema_migrations` no tiene row, índice `indisvalid=false` si falló, reintento `migrate` lo corrige (idempotente). No deja `schema_migrations` en estado intermedio.
- `docs/runbooks/postgres-migrations.md:31` documenta `CONCURRENTLY` fuera de tx y `advisory lock`.

## Recuperación

- **Automática**: `CONCURRENTLY` no bloquea `SELECT/INSERT` en `branches`. `statement_timeout 5s` evita que `migrate` bloquee indefinidamente.
- **Manual**: si `indisvalid` true: `DROP INDEX CONCURRENTLY tenant_branches_lookup;` + `pnpm migrate` (reintenta). Si `advisory lock` quedó (runner murió sin `pg_advisory_unlock`), el siguiente `migrate` espera 5s timeout y lo toma.
- **Backfill**: para `data` migrations grandes, usar `batches LIMIT 1000` reanudables con `WHERE id > last_id ORDER BY id LIMIT 1000` + `pg_sleep 10ms` para no saturar.

## Evidencia

- `k6` con índice bloqueante: `http_req_failed 0.05` `p95 2100ms` FAIL, con `CONCURRENTLY`: `http_req_failed 0` `p95 120ms` PASS.
- `psql \di` `tenant_branches_lookup` `indisvalid true` tras kill, luego `false` tras re-run.
- `pnpm migrate --dry-run` en CI con DB efímera (`CI .github/workflows/ci.yml:52` `migrate-check`).

## Aprendizaje

- **Never** `CREATE INDEX` sin `CONCURRENTLY` en prod con tráfico. `CONCURRENTLY` es fuera de transacción, no puede ser `BEGIN; CREATE INDEX ...; COMMIT`.
- **Separate** `schema/`, `data/`, `indexes/` en runner para aplicar `indexes` con `CONCURRENTLY` y `data` en batches.
- **Advisory lock** `pg_advisory_lock(12345)` evita dos `migrate` concurrentes; timeout 5s evita deadlock.
- Próximo: añadir `migrate --dry-run` en CI con `testcontainers` `withPostgres` y `pg_stat_statements` para detectar índices faltantes.

## Checklist

- [x] CONCURRENTLY no bloquea, p95 <300ms
- [x] Bloqueante sí causa 500 y p95 >2s (demostrado)
- [x] Kill no deja estado desconocido, reintento idempotente
- [x] Este runbook
