-- Phase 14 data: backfill branches.description in small batches, resumable, observable
-- Pattern: UPDATE ... WHERE description IS NULL LIMIT 1000 with SKIP LOCKED style via id ordering
-- This file is transactional but contains batched updates with small LIMIT to avoid long locks.
-- It can be re-run safely (idempotent): only touches rows where description IS NULL.
-- For large tables (10k+ rows), run in loop externally: `while pnpm migrate` or dedicated job.

-- Backfill null descriptions to empty string for older rows (optional, keeps COALESCE fallback simple)
-- Use batches of 1000 to avoid blocking writes. See docs/runbooks/postgres-migrations.md#backfill

do $$
declare
  batch int := 1000;
  affected int;
begin
  loop
    update branches
    set description = ''
    where id in (
      select id from branches where description is null order by id asc limit batch for update skip locked
    );
    get diagnostics affected = row_count;
    exit when affected = 0;
    -- Small pause to reduce load (10ms) — only if many batches
    perform pg_sleep(0.01);
  end loop;
end $$;

-- Note: contract phase (ALTER TABLE ALTER COLUMN SET NOT NULL / DROP) is deferred to next release
-- after verifying no vN pods remain. See docs/runbooks/rollback.md and deploy-half.md
