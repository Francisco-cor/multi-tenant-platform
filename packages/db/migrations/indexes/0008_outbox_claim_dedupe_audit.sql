-- D-10/D-18/D-31/D-34/D-20: outbox claim + dedupe indexes, audit actor lookup,
-- ledger idempotency and redundant index cleanup.

-- Relay claim: serves both the pending branch and the stale-claim recovery
-- branch in one index (the old partial index only covered status = 'pending',
-- forcing a scan of the whole outbox for recovery).
create index concurrently if not exists outbox_claim_idx
  on outbox_events (status, next_attempt_at)
  where status in ('pending', 'claimed');

-- Producer idempotency: a retried API request cannot create two events.
create unique index concurrently if not exists outbox_dedupe_uidx
  on outbox_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

-- Auditor query: "what did user X do".
create index concurrently if not exists audit_log_actor_created_idx
  on audit_log (actor_user_id, created_at desc, id);

-- A retried reserve/consume with the same correlation id must not double-write
-- the ledger. If a legacy database already contains duplicates this index
-- build fails with a duplicate-key error (visible, repair required); the
-- append-only ledger is never rewritten automatically.
create unique index concurrently if not exists inventory_movements_correlation_uidx
  on inventory_movements (tenant_id, correlation_id, reason);

-- D-20: write amplification / unused indexes.
-- stock_per_branch_branch_product_idx is an exact duplicate of the primary key.
drop index concurrently if exists stock_per_branch_branch_product_idx;
-- tenant_feature_flags_tenant_idx is a prefix of the (tenant_id, flag) PK.
drop index concurrently if exists tenant_feature_flags_tenant_idx;
-- Global FTS index cannot serve a tenant-scoped search and is a full copy of
-- the catalog; products_tenant_sku_trgm_idx covers the search path.
drop index concurrently if exists products_tsvector_idx;
-- branches_tenant_slug_trgm_idx cannot serve equality; (tenant_id, slug) can.
drop index concurrently if exists branches_tenant_slug_trgm_idx;

-- Delivery listing for retention uses (tenant_id, status, created_at); the
-- existing webhook_deliveries_created_idx covers the global sweep.
