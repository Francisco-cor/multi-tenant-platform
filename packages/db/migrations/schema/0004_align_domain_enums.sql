-- Phase 2.7: align DB enums with domain (packages/domain/src/index.ts)
-- Organizations: active, suspended, archived (deleted -> archived)
-- Memberships: owner, admin, manager, operator, auditor (member/viewer -> operator)

-- Backfill legacy statuses before tightening constraint
update organizations set status = 'archived' where status = 'deleted';
update organizations set updated_at = now() where status = 'archived' and updated_at is null;

-- Backfill legacy roles before tightening constraint
update memberships set role = 'operator' where role in ('member', 'viewer');
-- Ensure active flag consistency: if role was member/viewer and still active, keep active

-- Drop old constraints if exist, recreate tightened
alter table organizations drop constraint if exists organizations_status_check;
alter table organizations add constraint organizations_status_check
  check (status in ('active', 'suspended', 'archived'));

alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'manager', 'operator', 'auditor'));

-- Align defaults: memberships role default should be explicit; change from 'member' to 'operator'
alter table memberships alter column role set default 'operator';
-- organizations default already 'active' matches domain, ensure
alter table organizations alter column status set default 'active';

-- Also fix invitations role check (created in 0002) to match same set without viewer/member
alter table invitations drop constraint if exists invitations_role_check;
alter table invitations add constraint invitations_role_check
  check (role in ('owner', 'admin', 'manager', 'operator', 'auditor'));
