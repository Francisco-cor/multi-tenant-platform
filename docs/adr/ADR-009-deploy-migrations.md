# ADR-009: Migraciones expand-contract, separación por clases y RLS como última barrera

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: ADR-002 (tenant isolation), ADR-003 (Drizzle + migraciones), Fase 3
- Última verificación: 2026-11-13

## Contexto

Las tablas tenant-scoped (`organizations`, `memberships`, `branches`, `invitations`, `audit_log`, `sessions`) ya tienen RLS `FORCE` y filtros explícitos en `TenantRepository` (`packages/db/src/tenant-repository.ts`, `packages/db/src/repositories.ts`). Sin disciplina de deploy, un cambio de esquema puede romper pods viejos, dejar una migración a medias sin runbook, o permitir que un `SELECT` sin `app.tenant_id` vea datos cross-tenant.

Se necesita una política que garantice:

1. Ningún deploy exponga datos por falta de `tenant_id`.
2. Ninguna migración sea destructiva en la misma release que introduce la columna/tabla.
3. Los índices grandes no bloqueen escrituras en producción.
4. Cada migración sea trazable (quién, cuándo, cuánto tardó, checksum).

## Decisión

### 1. Separación por clases

- `migrations/schema/`: DDL, RLS, funciones, constraints — transaccionales (cada archivo en `BEGIN/COMMIT`), se aplican con advisory lock `pg_try_advisory_lock` con timeout (`packages/db/src/migrate.ts`).
- `migrations/data/`: backfills y transformaciones reanudables, con `LIMIT`/`SKIP LOCKED`, no mezclados con DDL.
- `migrations/indexes/`: `CREATE INDEX CONCURRENTLY` — **no transaccionales** (`packages/db/src/migrate.ts`, `transactional: kind !== 'indexes'`).

Orden de aplicación: `schema` → `data` → `indexes`, y dentro de cada clase por `id` lexicográfico (`packages/db/src/migrate.ts`).

### 2. Schema_migrations duro

Tabla `schema_migrations` (`packages/db/src/migrate.ts`) con:

- `id text PK` (e.g. `schema/0005_db_hardening.sql` y legacy `0001_identity_and_rls.sql`),
- `applied_at timestamptz`,
- `kind text` (`schema|data|indexes`),
- `checksum text` (sha256 del archivo, `packages/db/src/migrate.ts`),
- `duration_ms integer` (medido `Date.now()` alrededor del `unsafe`, `packages/db/src/migrate.ts`),
- `applied_by text default current_user`.

Si una migración ya aplicada cambia de checksum, el runner falla `migration_checksum_mismatch` y no avanza (`packages/db/src/migrate.ts`). No se edita una migración aplicada; se crea una nueva.

### 3. Expand-contract

1. **Expand:** añadir columnas/tablas/índices `NULL`/`DEFAULT` o constraints no validantes; no eliminar ni renombrar.
2. Desplegar API que entiende viejo y nuevo esquema.
3. Backfill en batches pequeños reanudables (`data/`).
4. Cambiar lectores/escritores a nuevo camino con feature flag por tenant si aplica.
5. **Contract:** eliminar camino viejo en otra release, cuando ningún pod viejo quede en tráfico.

Ejemplo Fase 2.7: `organizations.deleted → archived` y `memberships member/viewer → operator` se migró con `UPDATE` antes de `ADD CONSTRAINT` (`schema/0004_align_domain_enums.sql:8`), default `role` pasó a `operator` (`schema.ts:42`) y `invitations` se alineó.

### 4. RLS como última barrera, no la primera

- Repositories exigen `TenantRepositoryContext` (`tenant-context.ts:13`) y filtran `WHERE tenant_id = $1` aun cuando el caller conozca el ID (`repositories.ts:25`).
- `withTenantTransaction` (`packages/db/src/database.ts`) abre transacción, hace `SET LOCAL role "platform_app"` y `SELECT set_config('app.tenant_id', $1, true)` — el `SET LOCAL` garantiza que el valor no se pegue a la conexión del pool (`packages/db/src/isolation.concurrent.test.ts` con pool concurrente).
- RLS `FORCE` en `organizations`, `memberships`, `branches`, `invitations`, `audit_log` (`packages/db/migrations/schema/0001_identity_and_rls.sql`, `0002_persistent_identity.sql`) replica el filtro: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`. Sin `app.tenant_id`, `SELECT` devuelve 0 filas incluso para `platform_app` (comprobado `packages/db/src/isolation.rls.test.ts`).

Si un futuro feature olvida el filtro, RLS aún oculta el otro tenant; los tests fallan por RLS antes que en staging.

### 5. Observabilidad de DB

- `pg_stat_statements` habilitado y `pg_read_all_stats` concedido a `platform_app` (`packages/db/migrations/schema/0005_db_hardening.sql`).
- Role defaults: `statement_timeout 5s`, `idle_in_transaction 30s`, `lock_timeout 3s`, `idle_session 5min` (`packages/db/migrations/schema/0005_db_hardening.sql`) para evitar pods colgados.
- Métricas esperadas: `outbox_lag`, `job_duration`, `audit_log` insert rate, `pg_stat_statements` p95.

### 6. CI

El job `integration` de `.github/workflows/ci.yml` levanta PostgreSQL/Redis/MinIO con imágenes pinneadas, ejecuta `pnpm --filter @platform/db migrate` dos veces (la segunda debe ser no-op por checksum) y corre las suites de DB con `RUN_DB_INTEGRATION=1`. El job `quality` ejecuta además `pnpm migrate:check` (análisis estático de migraciones). No hay un job separado llamado `migrate-check`.

## Consecuencias

- **Pros:** deploys rolling sin downtime, migraciones reproducibles, RLS auditable, pool sin fuga de contexto, observabilidad temprana.
- **Contras:** más migraciones (expand+contract en dos releases), backfills requieren monitoreo, `CREATE INDEX CONCURRENTLY` no puede estar en transacción (el runner lo respeta).
- **Riesgos mitigados:** `dual write` perdido (outbox transaccional implementado para archivos, inventario, órdenes y pagos), `sticky connection` (validado con 50 concurrent), `migration_checksum_mismatch` (detecta edición ilícita).

## Alternativas consideradas

- **Alembic/Liquibase gestionado:** ocultaba RLS/locks; se descartó por falta de control sobre `CONCURRENTLY` y `SET LOCAL`.
- **RLS sin filtros en repo:** se descartó — RLS es última barrera, no sustituye `WHERE tenant_id`.

## Referencias

- `docs/runbooks/postgres-migrations.md` (clases de migración),
- `docs/runbooks/database-restore.md` (drill con RLS vérificado),
- `docs/architecture/tenant-isolation.md` (3 capas),
- `packages/db/src/migrate.ts` (runner),
- `packages/db/src/database.ts` (withTenantTransaction).
