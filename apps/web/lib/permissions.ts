/**
 * Capability gating used by the UI. The API remains the enforcement point:
 * every helper here only decides what to render.
 */

export const PERMISSIONS = [
  'organization:read',
  'organization:update',
  'members:read',
  'members:invite',
  'members:update_role',
  'members:remove',
  'branches:read',
  'branches:create',
  'branches:update',
  'branches:archive',
  'orders:read',
  'orders:create',
  'orders:approve',
  'orders:update',
  'orders:cancel',
  'inventory:read',
  'inventory:adjust',
  'inventory:reserve',
  'files:read',
  'files:upload',
  'files:delete',
  'automations:read',
  'automations:manage',
  'webhooks:read',
  'webhooks:manage',
  'webhooks:replay',
  'audit:read',
  'billing:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'admin', 'manager', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  permissions: readonly string[];
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

export function hasAnyPermission(
  principal: Principal,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => hasPermission(principal, permission));
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
