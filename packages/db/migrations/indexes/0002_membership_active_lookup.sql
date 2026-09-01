-- Keep each concurrent index in its own file because the client sends one
-- migration file as a single simple query.

create index concurrently if not exists memberships_tenant_active_idx
  on memberships (tenant_id, active, id);
