export const ROLES = ['owner', 'admin', 'manager', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'organization:read',
  'organization:update',
  'members:read',
  'members:invite',
  'members:update_role',
  'members:assign_owner',
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

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter(
    (permission) => permission !== 'billing:manage' && permission !== 'members:assign_owner',
  ),
  manager: [
    'organization:read',
    'members:read',
    'branches:read',
    'branches:update',
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
    'automations:read',
    'webhooks:read',
    'audit:read',
  ],
  operator: [
    'organization:read',
    'branches:read',
    'orders:read',
    'orders:create',
    'orders:update',
    'inventory:read',
    'inventory:reserve',
    'files:read',
    'files:upload',
  ],
  auditor: [
    'organization:read',
    'members:read',
    'branches:read',
    'orders:read',
    'inventory:read',
    'files:read',
    'audit:read',
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ORGANIZATION_STATUSES = ['active', 'suspended', 'archived'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const ORDER_STATUSES = [
  'draft',
  'pending_payment',
  'paid',
  'processing',
  'completed',
  'cancelled',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const INVENTORY_RESERVATION_STATUSES = [
  'active',
  'released',
  'consumed',
  'expired',
] as const;
export type InventoryReservationStatus = (typeof INVENTORY_RESERVATION_STATUSES)[number];

export const RESOURCES = [
  'organization',
  'members',
  'branches',
  'orders',
  'inventory',
  'files',
  'automations',
  'webhooks',
  'audit',
  'billing',
] as const;
export type Resource = (typeof RESOURCES)[number];

export function rolesHavePermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}

/**
 * Privilege ceiling per role. A role may only grant roles strictly below its
 * own rank. Owners are the sole exception: they may grant `owner` so a tenant
 * can recover from losing its only owner, but self-promotion is still rejected
 * at the route layer (see F-01).
 */
export const ROLE_RANK: Record<Role, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  operator: 2,
  auditor: 1,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'owner' && targetRole !== 'admin';
  return false;
}

/** Only an owner may touch (grant, demote or remove) an owner membership. */
export function requiresOwnerApproval(currentRole: Role, nextRole: Role): boolean {
  return currentRole === 'owner' || nextRole === 'owner';
}

export * from './payments.js';
export * from './automations.js';
export * from './feature-flags.js';
