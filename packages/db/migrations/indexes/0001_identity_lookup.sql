-- Large or lock-sensitive indexes run outside the migration transaction.
-- Keep this file idempotent so a failed concurrent build can be retried safely.

create index concurrently if not exists invitations_tenant_pending_expiry_idx
  on invitations (tenant_id, expires_at)
  where accepted_at is null;
