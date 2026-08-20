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
