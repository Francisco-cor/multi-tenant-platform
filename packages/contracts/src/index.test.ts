import { describe, expect, it } from 'vitest';
import { ApiErrorSchema, CursorPageQuerySchema, OrganizationSchema } from './index.js';

describe('HTTP contracts', () => {
  it('applies a safe default and upper bound to cursor pagination', () => {
    expect(CursorPageQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(() => CursorPageQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it('rejects organization slugs that are not safe for subdomains', () => {
    expect(() =>
      OrganizationSchema.parse({ id: '1', slug: 'ACME', name: 'Acme', status: 'active' }),
    ).toThrow();
  });

  it('keeps request IDs in error responses', () => {
    expect(
      ApiErrorSchema.parse({
        error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req-123' },
      }).error.requestId,
    ).toBe('req-123');
  });
});
