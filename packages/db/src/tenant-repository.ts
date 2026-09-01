import { assertTenantRepositoryContext, type TenantRepositoryContext } from './tenant-context.js';
import type { DatabaseExecutor } from './database.js';

/**
 * Base for tenant-scoped repositories.
 * - Every public method must receive TenantRepositoryContext explicitly.
 * - No method may query tenant-scoped tables without tenant_id filter.
 * - RLS is the second barrier, not the first.
 */
export abstract class TenantRepository {
  protected constructor(protected readonly db: DatabaseExecutor) {}

  protected assertContext(context: TenantRepositoryContext): void {
    assertTenantRepositoryContext(context);
  }

  protected bindTenant<T extends TenantRepositoryContext>(context: T): T {
    this.assertContext(context);
    return context;
  }
}

export type { TenantRepositoryContext };
