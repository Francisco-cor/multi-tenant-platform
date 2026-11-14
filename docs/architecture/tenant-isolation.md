# Tenant isolation — invariantes y evidencia

- Estado: implementado y endurecido; última revisión 2026-11-13
- Alcance: API, worker, DB, cache, object storage y auditoría

## 1. Invariantes

1. `tenant_id` proviene del contexto autenticado (host + sesión/membresía) y nunca del body como fuente de autorización.
2. Todo repository tenant-scoped recibe un contexto explícito con `tenantId` y, cuando aplica, `userId`.
3. Toda relación entre entidades tenant-scoped verifica el mismo tenant; las FK compuestas y constraints lo refuerzan.
4. Cache keys y job payloads incluyen tenant cuando contienen datos tenant-scoped.
5. Object keys de S3 comienzan con `tenants/{tenantId}/` y se emiten solo después de autorizar metadata.
6. PostgreSQL RLS es una barrera adicional; no reemplaza los filtros explícitos del repository.
7. Los errores no revelan si un ID existe en otro tenant: `404` es idéntico a “no existe”.
8. La sesión se vincula al usuario (`app.user_id`); el rol tenant no puede leer sesiones ajenas.

## 2. Roles de base de datos

| Rol                | Uso                                                   | Aislamiento                                                                         |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `platform_app`     | Requests tenant-scoped y stores de negocio            | RLS `FORCE`; `app.tenant_id`; sesiones user-bound                                   |
| `platform_auth`    | Login, sesiones, usuarios, invitaciones, credenciales | Camino estrecho; no sirve negocio tenant                                            |
| `platform_worker`  | Relay global de outbox y jobs cross-tenant            | `BYPASSRLS` deliberado solo para el dispatcher; handlers tenant usan `platform_app` |
| `platform_auditor` | Lectura de auditoría cross-tenant                     | Solo `platform_audit_log`; no sirve requests                                        |

`createDatabase` exige `role` salvo `allowUnscoped` explícito y verifica que el rol exista y no tenga `SUPERUSER`/`BYPASSRLS`. `withTenantTransaction` hace `SET LOCAL ROLE` y fija `app.tenant_id`/`app.user_id` dentro de la transacción, por lo que el contexto no queda pegado a una conexión del pool.

## 3. Implementación PostgreSQL

`packages/db` aplica tres capas que deben permanecer juntas:

1. El repository recibe `TenantRepositoryContext` y repite el filtro de tenant aunque el caller conozca un ID.
2. `withTenantTransaction` abre una transacción, configura `set_config('app.tenant_id', ..., true)` y `set_config('app.user_id', ..., true)` y nunca deja el valor pegado a la conexión.
3. RLS `FORCE` en las tablas tenant-scoped aplica el mismo tenant para lecturas y escrituras. Las policies usan `app_tenant_id()`/`app_user_id()`, que devuelven `NULL` ante un GUC malformado en vez de lanzar `22P02`.

Endurecimientos relevantes:

- `0024_identity_privilege_hardening.sql`: roles `platform_auth`/`platform_auditor`, sesiones user-bound, `tenant_users` como proyección, `platform_audit_log` para eventos globales, borrado de organización restringido a `platform_auth`.
- `0025_tenant_integrity_runtime.sql`: tablas runtime e integridad tenant.
- `0026_safe_tenant_policies.sql`: policies seguras ante GUC inválido.
- `0027_least_privilege_cleanup.sql`: limpieza de privilegios.
- `0028_restore_platform_audit_policies.sql`: restaura las policies de auditoría global tras la limpieza.

## 4. Prueba mínima de seguridad

Crear datos homónimos en dos tenants y ejecutar la misma lectura, modificación, descarga y replay con cada contexto. La suite debe demostrar que A no observa el resultado de B, incluso si conoce IDs, slugs internos o claves de eventos.

Evidencia:

- `packages/db/src/isolation.integration.test.ts`: datos espejo A/B, filtro de repository y query directa bajo `platform_app`.
- `packages/db/src/isolation.rls.test.ts`: RLS sin `app.tenant_id` devuelve cero filas.
- `packages/db/src/isolation.concurrent.test.ts`: pool concurrente sin contexto pegado.
- `packages/db/src/fase13.migration.test.ts`: migraciones idempotentes y RLS `FORCE`.
- `apps/api/src/fase13.isolation.test.ts`: aislamiento API A/B.
- CI `integration` ejecuta DB, worker y API contra PostgreSQL/Redis/MinIO reales.

No se debe citar `InMemoryIdentityStore` como evidencia de aislamiento de producción. Es un adaptador de tests unitarios.
