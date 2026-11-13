import { describe, expect, it } from 'vitest';
import { ROLES, hasAnyPermission, hasPermission, isRole } from './permissions';

const owner = {
  permissions: [
    'organization:read',
    'members:invite',
    'members:remove',
    'branches:create',
    'orders:create',
    'inventory:reserve',
    'files:upload',
  ],
};

const auditor = {
  permissions: ['organization:read', 'members:read', 'orders:read', 'files:read'],
};

describe('capability gating', () => {
  it('grants a capability the principal has', () => {
    expect(hasPermission(owner, 'members:invite')).toBe(true);
    expect(hasPermission(owner, 'billing:manage')).toBe(false);
  });

  it('hides actions for read-only roles', () => {
    expect(hasPermission(auditor, 'members:invite')).toBe(false);
    expect(hasPermission(auditor, 'orders:create')).toBe(false);
    expect(hasPermission(auditor, 'inventory:reserve')).toBe(false);
    expect(hasPermission(auditor, 'files:upload')).toBe(false);
  });

  it('treats unknown permissions as denied', () => {
    expect(hasPermission(owner, 'unknown:action' as never)).toBe(false);
  });

  it('supports any-of checks', () => {
    expect(hasAnyPermission(auditor, ['members:invite', 'members:read'])).toBe(true);
    expect(hasAnyPermission(auditor, ['members:invite', 'members:remove'])).toBe(false);
  });

  it('recognizes every documented role', () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    expect(isRole('superadmin')).toBe(false);
  });
});
