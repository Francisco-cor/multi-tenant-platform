# Data ownership — baseline

| Clasificacion      | Ejemplos                                                                      | Regla                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Global             | `users`, proveedores OIDC, feature flags globales                             | No contiene datos operativos de un tenant. El acceso es explicito y restringido.                      |
| Tenant root        | `organizations`                                                               | La organizacion es el tenant: `organizations.id` es el limite y se valida con RLS.                    |
| Tenant-scoped      | `memberships`, `branches`, ordenes, inventario, archivos, webhooks, auditoria | `tenant_id NOT NULL`, FK al tenant, indices/unique compuestos, repository con contexto y RLS.         |
| Cross-tenant admin | soporte y metricas agregadas futuras                                          | Superficie separada, permisos globales, auditoria reforzada y sin reutilizar endpoints tenant-scoped. |

Toda tabla nueva debe declarar su clasificacion en la migracion y en este documento. Los objetos S3 siguen la misma clasificacion aunque no sean filas de PostgreSQL.

La migracion base de Fase 3 implementa `users`, `organizations`, `memberships` y `branches`. Las columnas `created_by` conservan trazabilidad sin convertir al usuario global en un tenant.

Fase 5 añade `products` (tenant-scoped, unique `(tenant_id, sku)`), `stock_per_branch` (`PRIMARY KEY (tenant_id, branch_id, product_id)`, `CHECK available>=0`), `inventory_reservations` (`status active|released|consumed|expired`, `expires_at`, índice parcial `WHERE status='active'`) y `inventory_movements` append-only. Todas `FORCE RLS` con `tenant_id = current_setting('app.tenant_id')`.

Fase 6 añade `files` (tenant-scoped, `key UNIQUE tenants/{tenantId}/{uuid}`, `status pending|ready|expired|deleted`, `size_expected 1..50MiB`, `filename !~ [/\\]`, `expires_at now()+24h`, índices `tenant_id,status` y parcial `WHERE status='pending'`) y objetos S3 con prefijo `tenants/{tenantId}/` (`FORCE RLS`, `GRANT platform_app`). El GC de huérfanos usa `FOR UPDATE SKIP LOCKED`.

Fase 8 añade `orders` y `payment_attempts(provider_key UNIQUE)` + `inbound_payment_events` `FORCE RLS` con reconciler `pending>5m`.

Fase 9 añade `webhook_endpoints`, `webhook_deliveries`, `inbound_webhook_events`, `api_keys`, `automations` `FORCE RLS`.

Fase 14 expand: `branches.description text` nullable con `CHECK char_length 0..500` + `COALESCE` dual-read (`0012_expand_branch_description.sql`), backfill `data/0001_backfill_branch_description.sql` `LIMIT 1000 SKIP LOCKED`, `tenant_feature_flags (tenant_id, flag) PK` `FORCE RLS` para kill switches/canary (`0013_tenant_feature_flags.sql`), `indexes/0005_branch_description_search.sql` `CONCURRENTLY GIN pg_trgm`.
