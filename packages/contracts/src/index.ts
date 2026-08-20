import { z } from 'zod';
import { ORDER_STATUSES, ORGANIZATION_STATUSES, ROLES } from '@platform/domain';

export const API_VERSION = 'v1' as const;

export const ErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'TENANT_REQUIRED',
  'ORGANIZATION_SELECTION_REQUIRED',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CursorPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const RequestContextSchema = z.object({
  requestId: z.string().min(1),
  traceId: z.string().min(1).optional(),
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  membershipId: z.string().min(1),
  roles: z.array(z.enum(ROLES)).min(1),
});
export type RequestContext = z.infer<typeof RequestContextSchema>;

export const OrganizationSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(120),
  status: z.enum(ORGANIZATION_STATUSES),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const MembershipSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  role: z.enum(ROLES),
  status: z.enum(['invited', 'active', 'suspended', 'removed']),
});
export type Membership = z.infer<typeof MembershipSchema>;

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export const metaResponse = {
  service: 'api',
  status: 'ok',
} as const;
