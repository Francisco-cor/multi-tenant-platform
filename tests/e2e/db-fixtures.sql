-- Extra principals for the DB-backed E2E run (PLAYWRIGHT_DB=1).
-- Apply after `pnpm --filter @platform/db migrate && pnpm --filter @platform/db seed`:
--
--   docker exec -i <postgres-container> psql -U platform -d platform \
--     < tests/e2e/db-fixtures.sql
--
-- The in-memory seed uses human-readable ids; this fixture mirrors those users
-- and memberships with UUIDs so the same specs run on Postgres.

insert into users (id, oidc_issuer, oidc_subject, email, display_name, active)
values
  ('00000000-0000-4000-a000-0000000000a1', 'http://localhost:5556/dex', 'e2e-alice', 'alice@e2e.test', 'Alice Owner', true),
  ('00000000-0000-4000-a000-0000000000a2', 'http://localhost:5556/dex', 'e2e-acme-only', 'acme-only@example.test', 'Acme Operator', true),
  ('00000000-0000-4000-a000-0000000000a3', 'http://localhost:5556/dex', 'e2e-contoso-only', 'contoso-only@example.test', 'Contoso Owner', true)
on conflict (id) do update
set email = excluded.email,
    display_name = excluded.display_name,
    active = true;

-- Match the in-memory demo names the specs assert on.
update organizations set name = 'Acme Industries' where slug = 'acme';
update organizations set name = 'Contoso Retail' where slug = 'contoso';

insert into memberships (tenant_id, user_id, role, active)
select o.id, u.id, v.role, true
from (values
  ('acme', '00000000-0000-4000-a000-0000000000a1'::uuid, 'owner'),
  ('contoso', '00000000-0000-4000-a000-0000000000a1'::uuid, 'manager'),
  ('acme', '00000000-0000-4000-a000-0000000000a2'::uuid, 'operator'),
  ('contoso', '00000000-0000-4000-a000-0000000000a3'::uuid, 'owner')
) as v(slug, user_id, role)
join organizations o on o.slug = v.slug
join users u on u.id = v.user_id
on conflict (tenant_id, user_id) do update
set role = excluded.role,
    active = true;

-- Make repeated local runs deterministic.
insert into stock_per_branch (tenant_id, branch_id, product_id, available)
select p.tenant_id, b.id, p.id, 10
from products p
join branches b on b.tenant_id = p.tenant_id
on conflict (tenant_id, branch_id, product_id) do update
set available = 10;
