export interface TenantRepositoryContext {
  tenantId: string;
  requestId: string;
  userId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertTenantId(tenantId: string): void {
  if (!UUID_PATTERN.test(tenantId)) throw new Error('tenant_id_invalid');
}

export function assertTenantRepositoryContext(context: TenantRepositoryContext): void {
  if (!context.tenantId.trim()) throw new Error('tenant_id_required');
  if (!context.requestId.trim()) throw new Error('request_id_required');
  assertTenantId(context.tenantId);
}
