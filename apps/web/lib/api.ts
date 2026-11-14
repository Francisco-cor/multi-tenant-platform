import { apiBaseUrl } from './config';
import { apiTransport } from './api-transport';
import type {
  AuthMe,
  Branch,
  FileRecord,
  InventoryItem,
  InventoryReservation,
  Member,
  Order,
  PresignedUpload,
  TenantContext,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  token?: string;
  tenantHost?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface ApiEnvelope {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  };
}

export async function apiRequest<T>(path: string, options: ApiRequest = {}): Promise<T> {
  const url = new URL(`${apiBaseUrl}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers = new Headers({ accept: 'application/json' });
  if (options.tenantHost) headers.set('host', options.tenantHost);
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);

  let response: Response;
  try {
    response = await apiTransport(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'No se pudo contactar con la API.');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ApiEnvelope;
    throw new ApiError(
      response.status,
      envelope.error?.code ?? 'HTTP_ERROR',
      envelope.error?.message ?? `API respondió ${response.status}`,
      envelope.error?.requestId,
      envelope.error?.details,
    );
  }

  return payload as T;
}

/** Absolute URL used by server actions to reach the API on the tenant's behalf. */
export async function getAuthMe(token: string): Promise<AuthMe> {
  return apiRequest<AuthMe>('/v1/auth/me', { token });
}

export async function selectTenant(token: string, slug: string, tenantHost: string): Promise<void> {
  await apiRequest('/v1/auth/switch-organization', {
    method: 'POST',
    token,
    tenantHost,
    body: { slug },
  });
}

export async function getContext(token: string, tenantHost: string): Promise<TenantContext> {
  return apiRequest<TenantContext>('/v1/context', { token, tenantHost });
}

export async function listBranches(token: string, tenantHost: string): Promise<Branch[]> {
  const body = await apiRequest<{ data: Branch[] }>('/v1/branches', { token, tenantHost });
  return body.data;
}

export async function createBranch(
  token: string,
  tenantHost: string,
  input: { slug: string; name: string; description?: string },
): Promise<Branch> {
  const body = await apiRequest<{ branch: Branch }>('/v1/branches', {
    method: 'POST',
    token,
    tenantHost,
    body: input,
  });
  return body.branch;
}

export async function listOrders(token: string, tenantHost: string): Promise<Order[]> {
  const body = await apiRequest<{ data: Order[] }>('/v1/orders', { token, tenantHost });
  return body.data;
}

export async function createOrder(
  token: string,
  tenantHost: string,
  input: {
    branchId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  },
): Promise<Order> {
  const body = await apiRequest<{ order: Order }>('/v1/orders', {
    method: 'POST',
    token,
    tenantHost,
    headers: { 'idempotency-key': input.idempotencyKey },
    body: {
      branchId: input.branchId,
      amountCents: input.amountCents,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
    },
  });
  return body.order;
}

export async function listInventory(
  token: string,
  tenantHost: string,
  branchId: string,
): Promise<InventoryItem[]> {
  const body = await apiRequest<{ items: InventoryItem[] }>('/v1/inventory', {
    token,
    tenantHost,
    query: { branchId },
  });
  return body.items;
}

export async function reserveInventory(
  token: string,
  tenantHost: string,
  input: { branchId: string; productId: string; quantity: number },
): Promise<InventoryReservation> {
  const body = await apiRequest<{ reservation: InventoryReservation }>('/v1/inventory/reserve', {
    method: 'POST',
    token,
    tenantHost,
    body: input,
  });
  return body.reservation;
}

export async function listFiles(token: string, tenantHost: string): Promise<FileRecord[]> {
  const body = await apiRequest<{ data: FileRecord[] }>('/v1/files', { token, tenantHost });
  return body.data;
}

export async function presignUpload(
  token: string,
  tenantHost: string,
  input: { filename: string; contentType: string; size: number },
): Promise<PresignedUpload> {
  return apiRequest<PresignedUpload>('/v1/files/presigned-upload', {
    method: 'POST',
    token,
    tenantHost,
    body: input,
  });
}

export async function finalizeUpload(
  token: string,
  tenantHost: string,
  fileId: string,
  sizeActual: number,
): Promise<FileRecord> {
  const body = await apiRequest<{ file: FileRecord }>(`/v1/files/${fileId}/finalize`, {
    method: 'POST',
    token,
    tenantHost,
    body: { sizeActual },
  });
  return body.file;
}

export async function listMembers(token: string, tenantHost: string): Promise<Member[]> {
  const body = await apiRequest<{ data: Member[] }>('/v1/members', { token, tenantHost });
  return body.data;
}

export async function inviteMember(
  token: string,
  tenantHost: string,
  input: { email: string; role: string },
): Promise<{ id: string; email: string; role: string; expiresAt: number }> {
  const body = await apiRequest<{
    invitation: { id: string; email: string; role: string; expiresAt: number };
  }>('/v1/members/invitations', { method: 'POST', token, tenantHost, body: input });
  return body.invitation;
}

export async function removeMember(
  token: string,
  tenantHost: string,
  membershipId: string,
): Promise<void> {
  await apiRequest(`/v1/members/${encodeURIComponent(membershipId)}`, {
    method: 'DELETE',
    token,
    tenantHost,
  });
}

export async function logoutSession(token: string, tenantHost: string): Promise<void> {
  await apiRequest('/v1/auth/logout', { method: 'POST', token, tenantHost, body: {} });
}

export async function loginWithDevUser(
  userId: string,
  tenantHost: string,
): Promise<{ token: string; displayName: string }> {
  const headers = new Headers({
    host: tenantHost,
    'content-type': 'application/json',
    accept: 'application/json',
  });
  const response = await apiTransport(`${apiBaseUrl}/v1/auth/dev-login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userId }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const envelope = (payload ?? {}) as ApiEnvelope;
    throw new ApiError(
      response.status,
      envelope.error?.code ?? 'LOGIN_FAILED',
      envelope.error?.message ?? 'No se pudo iniciar sesión.',
      envelope.error?.requestId,
    );
  }
  const token = extractSessionToken(response);
  if (!token) throw new ApiError(502, 'SESSION_MISSING', 'La API no devolvió una sesión.');
  const body = payload as { user?: { displayName?: string } } | null;
  return { token, displayName: body?.user?.displayName ?? userId };
}

/** Reads platform_session from a Set-Cookie header (Node fetch exposes it via getSetCookie). */
export function extractSessionToken(response: Response): string | null {
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  for (const cookie of setCookies) {
    const match = /(?:^|;\s*)platform_session=([^;]+)/u.exec(cookie ?? '');
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

export function extractCookie(response: Response, name: string): string | null {
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  for (const cookie of setCookies) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, 'u').exec(cookie ?? '');
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}
