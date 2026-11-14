import { decryptWebhookSecret, encryptWebhookSecret } from '@platform/config';
import { sql } from '@platform/db';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from '@platform/db';
import type { StoreTenantContext } from './identity-store.js';

export type InboundProvider = 'stripe' | 'generic' | 'inbound';

export interface ResolvedInboundSecret {
  version: number;
  secret: string;
}

export const PROVIDER_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Versioned per-tenant inbound webhook secrets.
 *
 * The tenant selector is untrusted: it decides which key ring to try, never
 * which tenant the event belongs to. The signed body must name the same
 * tenant afterwards.
 */
export class ProviderSecretStore {
  constructor(
    private readonly db: DatabaseHandle | null,
    private readonly encryptionKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY,
  ) {}

  static fromConnectionString(
    connectionString: string,
    role = 'platform_app',
    encryptionKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY,
  ): ProviderSecretStore {
    return new ProviderSecretStore(createDatabase(connectionString, { role }), encryptionKey);
  }

  get enabled(): boolean {
    return this.db !== null && Boolean(this.encryptionKey);
  }

  /** Active version plus non-expired retired versions, newest first. */
  async verificationSecrets(
    context: StoreTenantContext,
    provider: InboundProvider,
  ): Promise<ResolvedInboundSecret[]> {
    if (!this.db) return [];
    if (!this.encryptionKey) throw new Error('webhook_secret_encryption_key_required');
    const key = this.encryptionKey;
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{ version: number; secret_ciphertext: string }>(sql`
        select version, secret_ciphertext
        from provider_inbound_secrets
        where tenant_id = ${context.tenantId}::uuid
          and provider = ${provider}
          and (status = 'active' or (status = 'retired' and expires_at > now()))
        order by version desc
      `);
      return rows.map((row) => ({
        version: row.version,
        secret: decryptWebhookSecret(row.secret_ciphertext, key),
      }));
    });
  }

  /**
   * Rotate to a new secret. The previous active version stays verifiable for
   * the overlap window so in-flight provider retries do not fail.
   */
  async rotate(
    context: StoreTenantContext,
    provider: InboundProvider,
    secret: string,
    options: { createdBy?: string | undefined; overlapMs?: number | undefined } = {},
  ): Promise<{ version: number }> {
    if (!this.db) throw new Error('provider_secret_store_unavailable');
    if (!this.encryptionKey) throw new Error('webhook_secret_encryption_key_required');
    if (secret.length < 8 || secret.length > 512) throw new Error('provider_secret_invalid');
    const ciphertext = encryptWebhookSecret(secret, this.encryptionKey);
    const overlap = Math.max(options.overlapMs ?? PROVIDER_SECRET_OVERLAP_MS, 0);
    return withTenantTransaction(this.db, context, async (tx) => {
      // Serialize rotations for this tenant+provider so two admins cannot
      // allocate the same version.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${context.tenantId}:${provider}`}))`,
      );
      const latest = await tx.execute<{ version: number }>(sql`
        select coalesce(max(version), 0) as version
        from provider_inbound_secrets
        where tenant_id = ${context.tenantId}::uuid and provider = ${provider}
      `);
      const version = (latest[0]?.version ?? 0) + 1;
      await tx.execute(sql`
        update provider_inbound_secrets
        set status = 'retired',
            expires_at = now() + (${overlap}::int * interval '1 millisecond'),
            updated_at = now()
        where tenant_id = ${context.tenantId}::uuid
          and provider = ${provider}
          and status = 'active'
      `);
      await tx.execute(sql`
        insert into provider_inbound_secrets
          (tenant_id, provider, version, secret_ciphertext, status, created_by)
        values (
          ${context.tenantId}::uuid, ${provider}, ${version},
          ${ciphertext}, 'active', ${options.createdBy ?? null}::uuid
        )
      `);
      return { version };
    });
  }

  async close(): Promise<void> {
    await this.db?.close();
  }
}
