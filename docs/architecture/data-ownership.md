# Data ownership — baseline

| Clasificacion      | Ejemplos                                                                      | Regla                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Global             | `users`, proveedores OIDC, feature flags globales                             | No contiene datos operativos de un tenant. El acceso es explicito y restringido.                      |
| Tenant root        | `organizations`                                                               | La organizacion es el tenant: `organizations.id` es el limite y se valida con RLS.                    |
| Tenant-scoped      | `memberships`, `branches`, ordenes, inventario, archivos, webhooks, auditoria | `tenant_id NOT NULL`, FK al tenant, indices/unique compuestos, repository con contexto y RLS.         |
| Cross-tenant admin | soporte y metricas agregadas futuras                                          | Superficie separada, permisos globales, auditoria reforzada y sin reutilizar endpoints tenant-scoped. |

Toda tabla nueva debe declarar su clasificacion en la migracion y en este documento. Los objetos S3 siguen la misma clasificacion aunque no sean filas de PostgreSQL.

La migracion base de Fase 3 implementa `users`, `organizations`, `memberships` y `branches`. Las columnas `created_by` conservan trazabilidad sin convertir al usuario global en un tenant.
