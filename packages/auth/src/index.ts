import type { Role } from '@platform/domain';

export interface OidcIdentity {
  subject: string;
  email: string;
  displayName?: string;
  issuer: string;
}

export interface AuthorizedMembership {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: readonly Role[];
}

export interface TenantResolution {
  host: string;
  tenantSlug: string;
  tenantId: string;
}

// La validación OIDC y la resolución de membresía se implementarán en la Fase 2.
