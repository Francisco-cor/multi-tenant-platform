export interface TenantRepositoryContext {
  tenantId: string;
  requestId: string;
  userId?: string;
}

export function assertTenantRepositoryContext(context: TenantRepositoryContext): void {
  if (!context.tenantId) throw new Error('tenant_id_required');
  if (!context.requestId) throw new Error('request_id_required');
}

// La conexión Drizzle, RLS y las migraciones se incorporarán en la Fase 3.
