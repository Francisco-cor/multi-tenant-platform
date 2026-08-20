import { describe, expect, it } from 'vitest';
import { roleHasPermission } from './index.js';

describe('RBAC baseline', () => {
  it('owner can manage billing', () => {
    expect(roleHasPermission('owner', 'billing:manage')).toBe(true);
  });

  it('operator cannot change membership roles', () => {
    expect(roleHasPermission('operator', 'members:update_role')).toBe(false);
  });

  it('auditor is read-only for the initial contract', () => {
    expect(roleHasPermission('auditor', 'orders:read')).toBe(true);
    expect(roleHasPermission('auditor', 'orders:update')).toBe(false);
  });
});
