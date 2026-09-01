# Runbook — PostgreSQL migrations

## Local

1. Copiar `.env.example` a `.env` y conservar `DATABASE_URL` apuntando al servicio `platform`.
2. Levantar PostgreSQL: `docker compose up -d postgres`.
3. Aplicar migraciones: `pnpm --filter @platform/db migrate`.
4. Ejecutar aislamiento real: `RUN_DB_INTEGRATION=1 pnpm --filter @platform/db test:integration`
5. Ejecutar el corte API/RLS: `RUN_DB_INTEGRATION=1 pnpm --filter @platform/api test:integration`.

La integracion usa el usuario local `platform` solo para preparar/limpiar datos y hace `SET LOCAL ROLE platform_app` durante la operacion tenant-scoped. La migracion crea `platform_app` como `NOLOGIN` y le concede solo DML sobre las tablas base.

## Produccion

- El proceso de migracion debe usar un lock/advisory lock y una identidad con permisos de DDL.
- La API debe conectarse mediante un login gestionado que pueda asumir `platform_app`, pero no debe ser superusuario ni propietario efectivo de las tablas.
- `DATABASE_ROLE` debe apuntar al rol sin privilegios de bypass RLS.
- El cambio de esquema se registra en `schema_migrations`; no se ejecutan seeds destructivos desde el runner.
- Los cambios incompatibles siguen expand-contract: agregar y backfillear primero, cambiar lectores/escritores despues y eliminar columnas solo cuando ninguna version anterior las use.

## Fallo o pausa

El runner ejecuta cada migracion dentro de una transaccion y libera el advisory lock al cerrar la conexion. Si falla, conservar el error, revisar `schema_migrations` y corregir con una nueva migracion compatible. No editar una migracion ya registrada ni ejecutar `git reset` para intentar reparar el esquema.

El runner y los tests eliminan el query parameter `schema` si aparece en DATABASE_URL, porque `postgres` lo interpreta como GUC; el esquema activo es `public` por defecto.

## Clases de migracion

- `schema/` contiene cambios de esquema, RLS y funciones; cada archivo es transaccional.
- `data/` contiene backfills o transformaciones de datos reanudables; no se mezclan con DDL de la aplicacion.
- `indexes/` contiene indices grandes o sensibles a locks; se ejecutan fuera de transaccion y usan `CREATE INDEX CONCURRENTLY`.

Los archivos que ya existian como `0001_identity_and_rls.sql` y
`0002_persistent_identity.sql` se reconocen como aliases historicos despues
de moverse a `migrations/schema/`. No se editan una vez aplicados.

## Backups y restore

El procedimiento completo esta en `docs/runbooks/database-restore.md`. El
comando reproducible es:

    pnpm --filter @platform/db restore:drill

El drill restaura en una base temporal, compara filas e historial, comprueba
RLS forzado y reejecuta el runner. La evidencia queda en `.artifacts/db/` y
la base temporal se elimina al terminar, salvo `--keep-target`.
