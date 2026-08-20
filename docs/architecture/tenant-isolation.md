# Tenant isolation — invariantes

## Invariantes

1. `tenant_id` proviene del contexto autenticado y nunca del body como fuente de autorización.
2. Todo repository tenant-scoped recibe un `TenantRepositoryContext` explícito.
3. Toda relación entre entidades tenant-scoped verifica el mismo tenant.
4. Cache keys y job payloads incluyen tenant cuando contienen datos tenant-scoped.
5. Object keys de S3 comienzan con `tenants/{tenantId}/` y se emiten solo después de autorizar metadata.
6. PostgreSQL RLS es una barrera adicional; no reemplaza los filtros explícitos del repository.
7. Los errores no revelan si un ID existe en otro tenant.

## Prueba mínima de seguridad

Crear datos homónimos en `tenant-acme` y `tenant-contoso`; ejecutar la misma lectura, modificación, descarga y replay con cada contexto. La suite debe demostrar que A no observa el resultado de B, incluso si conoce IDs, slugs internos o claves de eventos.

## Implementacion PostgreSQL de Fase 3

`packages/db` aplica tres capas que deben permanecer juntas:

1. `TenantOrganizationRepository` recibe un `TenantRepositoryContext` explicito y repite el filtro de tenant aunque el caller conozca un ID.
2. `withTenantTransaction` abre una transaccion, configura `set_config('app.tenant_id', ..., true)` y nunca deja el valor pegado a la conexion del pool.
3. RLS en `organizations`, `memberships` y `branches` fuerza el mismo tenant para lecturas y escrituras. El rol de aplicacion no debe ser superusuario.

La prueba `src/isolation.integration.test.ts` consulta datos espejo de A y B, comprueba el filtro del repository y ejecuta una query directa sin filtro bajo el rol `platform_app`; B debe resultar invisible.
