-- Phase 14 indexes: GIN index for branches.description full-text (optional) + tenant lookup
-- Must be CONCURRENTLY and outside transaction (runner treats indexes/* as non-transactional)
-- This index is expand-only, not required by vN, used by vN+1 for search. Old code does not break if missing.

create extension if not exists pg_trgm;

create index concurrently if not exists branches_tenant_description_idx
  on branches using gin (tenant_id, to_tsvector('simple', coalesce(description, '')));

-- Also add tenant+slug trgm index if not exists (idempotent) — requires pg_trgm
create index concurrently if not exists branches_tenant_slug_trgm_idx
  on branches using gin (slug gin_trgm_ops);

comment on index branches_tenant_description_idx is 'Phase 14: tenant-scoped description search, CONCURRENTLY (non-blocking)';
