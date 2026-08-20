import { describe, expect, it, vi } from 'vitest';
import { TenantOrganizationRepository } from './repositories.js';
import {
  assertTenantId,
  assertTenantRepositoryContext,
  type TenantRepositoryContext,
} from './tenant-context.js';

const context: TenantRepositoryContext = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  requestId: 'request-1',
};

describe('tenant database boundary', () => {
  it('requires a UUID tenant and request context', () => {
    expect(() => assertTenantRepositoryContext(context)).not.toThrow();
    expect(() => assertTenantId('tenant-acme')).toThrowError('tenant_id_invalid');
    expect(() =>
      assertTenantRepositoryContext({ tenantId: '', requestId: 'request-1' }),
    ).toThrowError('tenant_id_required');
    expect(() =>
      assertTenantRepositoryContext({ tenantId: context.tenantId, requestId: '' }),
    ).toThrowError('request_id_required');
  });

  it('keeps organization lookup scoped to the supplied tenant', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([{ id: context.tenantId, slug: 'acme', name: 'Acme', status: 'active' }]);
    const repository = new TenantOrganizationRepository({ execute });

    await expect(repository.findById(context, context.tenantId)).resolves.toMatchObject({
      slug: 'acme',
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
