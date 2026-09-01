-- Phase 5.6: enable FTS/trgm for inventory search tenant-scoped.
create extension if not exists pg_trgm;
create extension if not exists btree_gin;

-- GIN for fast search on sku/name per tenant. Uses trgm for ILIKE %q% and FTS via to_tsvector.
create index concurrently if not exists products_tenant_sku_trgm_idx
  on products using gin (tenant_id, sku gin_trgm_ops, name gin_trgm_ops);

create index concurrently if not exists products_tsvector_idx
  on products using gin (to_tsvector('simple', coalesce(sku,'') || ' ' || coalesce(name,'')));

-- For stock listing by branch/product tenant-scoped
create index concurrently if not exists stock_per_branch_branch_product_idx
  on stock_per_branch (tenant_id, branch_id, product_id);
