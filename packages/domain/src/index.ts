export const ROLES = ['owner', 'admin', 'manager', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

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

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((permission) => permission !== 'billing:manage'),
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

export * from './payments.js';
export * from './automations.js';
