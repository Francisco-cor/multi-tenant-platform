# ADR-009: Migraciones expand-contract, separación por clases y RLS como última barrera

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: ADR-002 (tenant isolation), ADR-003 (Drizzle + migraciones), Fase 3 (IMPLEMENTATION_PLAN.md:214-250)

## Contexto

Las tablas tenant-scoped (`organizations`, `memberships`, `branches`, `invitations`, `audit_log`, `sessions`) ya tienen RLS `FORCE` y filtros explícitos en `TenantRepository` (`packages/db/src/tenant-repository.ts:1`, `repositories.ts:1`). Sin disciplina de deploy, un cambio de esquema puede romper pods viejos, dejar una migración a medias sin runbook, o permitir que un `SELECT` sin `app.tenant_id` vea datos cross-tenant.

Se necesita una política que garantice:
1. Ningún deploy exponga datos por falta de `tenant_id`.
2. Ninguna migración sea destructiva en la misma release que introduce la columna/tabla.
3. Los índices grandes no bloqueen escrituras en producción.
4. Cada migración sea trazable (quién, cuándo, cuánto tardó, checksum).

## Decisión

### 1. Separación por clases

- `migrations/schema/`: DDL, RLS, funciones, constraints — transaccionales (cada archivo en `BEGIN/COMMIT`), se aplican con advisory lock `pg_advisory_lock('platform:schema-migrations')` (`migrate.ts:110`).
- `migrations/data/`: backfills y transformaciones reanudables, con `LIMIT`/`SKIP LOCKED`, no mezclados con DDL.
- `migrations/indexes/`: `CREATE INDEX CONCURRENTLY` — **no transaccionales** (`migrate.ts:80` `transactional: kind !== 'indexes'`).

Orden de aplicación: `schema` → `data` → `indexes`, y dentro de cada clase por `id` lexicográfico (`migrate.ts:61`).

### 2. Schema_migrations duro

Tabla `schema_migrations` (`migrate.ts:117`) con:

- `id text PK` (e.g. `schema/0005_db_hardening.sql` y legacy `0001_identity_and_rls.sql`),
- `applied_at timestamptz`,
- `kind text` (`schema|data|indexes`),
- `checksum text` (sha256 del archivo, `migrate.ts:75`),
- `duration_ms integer` (medido `Date.now()` alrededor del `unsafe`, `migrate.ts:148`),
- `applied_by text default current_user`.

Si una migración ya aplicada cambia de checksum, el runner falla `migration_checksum_mismatch` y no avanza (`migrate.ts:136`). No se edita una migración aplicada; se crea una nueva.

### 3. Expand-contract

1. **Expand:** añadir columnas/tablas/índices `NULL`/`DEFAULT` o constraints no validantes; no eliminar ni renombrar.
2. Desplegar API que entiende viejo y nuevo esquema.
3. Backfill en batches pequeños reanudables (`data/`).
4. Cambiar lectores/escritores a nuevo camino con feature flag por tenant si aplica.
5. **Contract:** eliminar camino viejo en otra release, cuando ningún pod viejo quede en tráfico.

Ejemplo Fase 2.7: `organizations.deleted → archived` y `memberships member/viewer → operator` se migró con `UPDATE` antes de `ADD CONSTRAINT` (`schema/0004_align_domain_enums.sql:8`), default `role` pasó a `operator` (`schema.ts:42`) y `invitations` se alineó.

### 4. RLS como última barrera, no la primera

- Repositories exigen `TenantRepositoryContext` (`tenant-context.ts:13`) y filtran `WHERE tenant_id = $1` aun cuando el caller conozca el ID (`repositories.ts:25`).
- `withTenantTransaction` (`database.ts:53`) abre transacción, hace `SET LOCAL role "platform_app"` y `SELECT set_config('app.tenant_id', $1, true)` — el `SET LOCAL` garantiza que el valor no se pegue a la conexión del pool (`isolation.concurrent.test.ts:50` con `maxConnections:5`).
- RLS `FORCE` en `organizations`, `memberships`, `branches`, `invitations`, `audit_log` (`schema/0001:56`, `schema/0002:50`) replica el filtro: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`. Sin `app.tenant_id`, `SELECT` devuelve 0 filas incluso para `platform_app` (comprobado `isolation.rls.test.ts:1`).

Si un futuro feature olvida el filtro, RLS aún oculta el otro tenant; los tests fallan por RLS antes que en staging.

### 5. Observabilidad de DB

- `pg_stat_statements` habilitado y `pg_read_all_stats` concedido a `platform_app` (`schema/0005_db_hardening.sql:6`).
- Role defaults: `statement_timeout 5s`, `idle_in_transaction 30s`, `lock_timeout 3s`, `idle_session 5min` (`schema/0005:9`) para evitar pods colgados.
- Métricas esperadas: `outbox_lag`, `job_duration`, `audit_log` insert rate, `pg_stat_statements` p95.

### 6. CI

`migrate-check` job (`.github/workflows/ci.yml:60`) levanta `postgres:16-alpine` efímero, ejecuta `migrate` dos veces (segunda debe ser no-op por checksum) y `RUN_DB_INTEGRATION=1` con `isolation.integration|concurrent|rls` — falla si RLS no es `FORCE` o si una query directa cross-tenant ve 1 fila.

## Consecuencias

- **Pros:** deploys rolling sin downtime, migraciones reproducibles, RLS auditable, pool sin fuga de contexto, observabilidad temprana.
- **Contras:** más migraciones (expand+contract en dos releases), backfills requieren monitoreo, `CREATE INDEX CONCURRENTLY` no puede estar en transacción (el runner lo respeta).
- **Riesgos mitigados:** `dual write` perdido (outbox en Fase 4 aún pendiente), `sticky connection` (validado con 50 concurrent), `migration_checksum_mismatch` (detecta edición ilícita).

## Alternativas consideradas

- **Alembic/Liquibase gestionado:** ocultaba RLS/locks; se descartó por falta de control sobre `CONCURRENTLY` y `SET LOCAL`.
- **RLS sin filtros en repo:** se descartó — RLS es última barrera, no sustituye `WHERE tenant_id`.

## Referencias

- `docs/runbooks/postgres-migrations.md:28` (clases de migración),
- `docs/runbooks/database-restore.md` (drill con RLS vérificado),
- `docs/architecture/tenant-isolation.md:17` (3 capas),
- `packages/db/src/migrate.ts:104` (runner),
- `packages/db/src/database.ts:53` (withTenantTransaction).
