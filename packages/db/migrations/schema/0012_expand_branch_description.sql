-- Phase 14 expand: branches.description nullable (expand-contract)
-- Expand step: add nullable column, no NOT NULL, no DEFAULT with rewrite, no index blocking.
-- Old code (vN) SELECT id, slug, name FROM branches still works (ignores new column).
-- New code (vN+1) SELECT id, slug, name, COALESCE(description,'') as description handles both.
-- Backfill is in data/0001_backfill_branch_description.sql (batched, resumable).
-- Contract (set NOT NULL or DROP if needed) is deferred 1 release — see docs/runbooks/rollback.md and ADR-009.

alter table branches add column if not exists description text;

-- Optional check: description length 0..500 if present
alter table branches drop constraint if exists branches_description_length;
alter table branches add constraint branches_description_length check (description is null or char_length(description) between 0 and 500);

comment on column branches.description is 'expand-contract: added nullable in 0012, backfilled in data/0001, contract deferred';
