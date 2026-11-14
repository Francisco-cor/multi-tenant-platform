import { describe, expect, it } from 'vitest';
import {
  ROLES,
  ROLE_RANK,
  canAssignRole,
  requiresOwnerApproval,
  roleHasPermission,
  type Role,
} from './index.js';

const expected: Record<Role, readonly Role[]> = {
  owner: ['owner', 'admin', 'manager', 'operator', 'auditor'],
  admin: ['manager', 'operator', 'auditor'],
  manager: [],
  operator: [],
  auditor: [],
};

describe('role assignment policy', () => {
  for (const actor of ROLES) {
    for (const target of ROLES) {
      it(`${actor} assigning ${target} is ${expected[actor].includes(target) ? 'allowed' : 'denied'}`, () => {
        expect(canAssignRole(actor, target)).toBe(expected[actor].includes(target));
      });
    }
  }

  it('orders roles by privilege', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.manager);
    expect(ROLE_RANK.manager).toBeGreaterThan(ROLE_RANK.operator);
    expect(ROLE_RANK.operator).toBeGreaterThan(ROLE_RANK.auditor);
  });

  it('grants owner assignment only to owners', () => {
    expect(roleHasPermission('owner', 'members:assign_owner')).toBe(true);
    expect(roleHasPermission('admin', 'members:assign_owner')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
  });

  it('requires owner approval whenever an owner is involved', () => {
    expect(requiresOwnerApproval('owner', 'admin')).toBe(true);
    expect(requiresOwnerApproval('admin', 'owner')).toBe(true);
    expect(requiresOwnerApproval('admin', 'manager')).toBe(false);
  });
});
