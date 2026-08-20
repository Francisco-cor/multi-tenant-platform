# Data ownership — baseline

| Clasificación      | Ejemplos                                                                                   | Regla                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Global             | `users`, proveedores OIDC, catálogo de feature flags global                                | No contiene datos operativos de un tenant. Acceso explícito y restringido.                            |
| Tenant-scoped      | organizaciones, membresías, sucursales, órdenes, inventario, archivos, webhooks, auditoría | `tenant_id NOT NULL`, repository con contexto y RLS.                                                  |
| Cross-tenant admin | soporte y métricas agregadas futuras                                                       | Superficie separada, permisos globales, auditoría reforzada y sin reutilizar endpoints tenant-scoped. |

Toda tabla nueva debe declarar su clasificación en la migración y en este documento. Los objetos S3 siguen la misma clasificación aunque no sean filas de PostgreSQL.
