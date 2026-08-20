# Runbook — PostgreSQL migrations

## Local

1. Copiar `.env.example` a `.env` y conservar `DATABASE_URL` apuntando al servicio `platform`.
2. Levantar PostgreSQL: `docker compose up -d postgres`.
3. Aplicar migraciones: `pnpm --filter @platform/db migrate`.
4. Ejecutar aislamiento real: `RUN_DB_INTEGRATION=1 pnpm --filter @platform/db test:integration`.

La integracion usa el usuario local `platform` solo para preparar/limpiar datos y hace `SET LOCAL ROLE platform_app` durante la operacion tenant-scoped. La migracion crea `platform_app` como `NOLOGIN` y le concede solo DML sobre las tablas base.

## Produccion

- El proceso de migracion debe usar un lock/advisory lock y una identidad con permisos de DDL.
- La API debe conectarse mediante un login gestionado que pueda asumir `platform_app`, pero no debe ser superusuario ni propietario efectivo de las tablas.
- `DATABASE_ROLE` debe apuntar al rol sin privilegios de bypass RLS.
- El cambio de esquema se registra en `schema_migrations`; no se ejecutan seeds destructivos desde el runner.
- Los cambios incompatibles siguen expand-contract: agregar y backfillear primero, cambiar lectores/escritores despues y eliminar columnas solo cuando ninguna version anterior las use.

## Fallo o pausa

El runner ejecuta cada migracion dentro de una transaccion y libera el advisory lock al cerrar la conexion. Si falla, conservar el error, revisar `schema_migrations` y corregir con una nueva migracion compatible. No editar una migracion ya registrada ni ejecutar `git reset` para intentar reparar el esquema.
