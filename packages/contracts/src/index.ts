import { z } from 'zod';
import {
  MEMBERSHIP_STATUSES,
  ORDER_STATUSES,
  ORGANIZATION_STATUSES,
  ROLES,
} from '@platform/domain';

export const API_VERSION = 'v1' as const;

export const ErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'GONE',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'DEPENDENCY_UNAVAILABLE',
  'TENANT_REQUIRED',
  'ORGANIZATION_SELECTION_REQUIRED',
  'CSRF_REQUIRED',
  'CSRF_ORIGIN_DENIED',
  'CSRF_TOKEN_INVALID',
  'KILL_SWITCH',
  'WEBHOOK_NOT_CONFIGURED',
  'METRICS_NOT_CONFIGURED',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Acknowledgement body for `POST /v1/webhooks/payments`.
 *
 * `unresolved` is a retryable 202: the event was stored but the current local
 * state machine cannot apply it (for example a `paid` after `refunded`). The
 * provider must retry; the row stays unprocessed so a later retry re-evaluates
 * it instead of being deduplicated as a no-op.
 */
export const PaymentWebhookResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('processed'), eventId: z.string().min(1) }),
  z.object({ status: z.literal('already_processed'), eventId: z.string().min(1) }),
  z.object({ status: z.literal('ignored'), eventId: z.string().min(1) }),
  z.object({
    status: z.literal('unresolved'),
    eventId: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type PaymentWebhookResponse = z.infer<typeof PaymentWebhookResponseSchema>;

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
  status: z.enum(MEMBERSHIP_STATUSES),
});
export type Membership = z.infer<typeof MembershipSchema>;

export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * Wire representation of an order. Units are explicit (`amountCents`) and
 * statuses are the same closed set used by the domain state machine.
 */
export const OrderSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  status: OrderStatusSchema,
  amountCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  createdAt: z.number().int().nonnegative(),
});
export type Order = z.infer<typeof OrderSchema>;

export const metaResponse = {
  service: 'api',
  status: 'ok',
} as const;

export * from './events.js';
export * from './webhook-url.js';
