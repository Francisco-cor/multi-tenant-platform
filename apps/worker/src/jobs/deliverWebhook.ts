import { createHmac } from 'node:crypto';
import { decryptWebhookSecret } from '@platform/config';
import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { metrics } from '@platform/observability';
import { workerGlobalTransaction, workerTenantTransaction } from '../tenant-db.js';
import { fetchWebhook, type WebhookFetch } from '../webhook-egress.js';

export interface DeliverResult {
  status: 'delivered' | 'retrying' | 'failed' | 'dead_letter' | 'disabled';
  attempts: number;
}

function computeSignature(secret: string, timestamp: string, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function backoffMs(attempt: number): number {
  const base = 10000; // 10s base for webhooks
  const max = 10 * 60 * 1000; // 10m cap
  const exp = base * Math.pow(2, attempt);
  const capped = Math.min(exp, max);
  const jitter = capped * 0.2;
  return Math.round(capped + (Math.random() * 2 - 1) * jitter);
}

export interface DeliverWebhookOptions {
  fetchFn?: WebhookFetch | undefined;
  claimToken?: string | undefined;
  leaseDurationMs?: number | undefined;
  leaseRenewalMs?: number | undefined;
}

export const WEBHOOK_LEASE_DURATION_MS = 5 * 60 * 1000;
export const WEBHOOK_LEASE_RENEWAL_MS = 60 * 1000;

function claimGuard(claimToken: string | undefined) {
  return claimToken ? sql`and claim_token=${claimToken}` : sql``;
}

interface LeaseHeartbeat {
  lost: () => boolean;
  loss: Promise<never>;
  stop: () => Promise<void>;
}

function startLeaseHeartbeat(
  db: DatabaseHandle,
  tenantId: string,
  deliveryId: string,
  claimToken: string | undefined,
  options: Pick<DeliverWebhookOptions, 'leaseDurationMs' | 'leaseRenewalMs'>,
  abortController: AbortController,
): LeaseHeartbeat {
  if (!claimToken) {
    return {
      lost: () => false,
      loss: new Promise<never>(() => undefined),
      stop: async () => undefined,
    };
  }

  const durationMs = options.leaseDurationMs ?? WEBHOOK_LEASE_DURATION_MS;
  const renewalMs = options.leaseRenewalMs ?? WEBHOOK_LEASE_RENEWAL_MS;
  let hasLostLease = false;
  let active = true;
  let renewalInFlight = Promise.resolve();
  let rejectLeaseLoss: ((error: Error) => void) | undefined;
  const leaseLost = new Promise<never>((_, reject) => {
    rejectLeaseLoss = reject;
  });

  const renew = async (): Promise<void> => {
    if (!active || hasLostLease) return;
    try {
      const renewed = await workerTenantTransaction(
        db,
        tenantId,
        `webhook-lease:${deliveryId}`,
        (tx) =>
          tx.execute<{ id: string }>(sql`
            update webhook_deliveries
            set claim_until=now() + (${durationMs}::text || ' milliseconds')::interval,
                updated_at=now()
            where id=${deliveryId}::uuid
              and tenant_id=${tenantId}::uuid
              and claim_token=${claimToken}
              and claim_until > now()
            returning id
          `),
      );
      if (renewed.length === 0) throw new Error('webhook_claim_lost');
      metrics.recordWebhookLeaseRenewal();
    } catch (error) {
      hasLostLease = true;
      metrics.recordWebhookLeaseLoss();
      abortController.abort();
      rejectLeaseLoss?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const timer = setInterval(() => {
    if (!active) return;
    renewalInFlight = renewalInFlight.then(renew, renew);
  }, renewalMs);
  timer.unref?.();

  return {
    lost: () => hasLostLease,
    loss: leaseLost,
    stop: async () => {
      active = false;
      clearInterval(timer);
      await renewalInFlight;
    },
  };
}

export async function deliverWebhook(
  db: DatabaseHandle,
  deliveryId: string,
  tenantId: string,
  options: DeliverWebhookOptions = {},
): Promise<DeliverResult> {
  const fetchFn = options.fetchFn ?? fetchWebhook;

  // Load delivery + endpoint with lock
  const ctx = await workerTenantTransaction(db, tenantId, `webhook:${deliveryId}`, async (tx) => {
    const deliveries = await tx.execute<{
      id: string;
      tenant_id: string;
      endpoint_id: string;
      event_id: string;
      event_type: string;
      payload: string;
      status: string;
      attempts: number;
      claim_token: string | null;
      secret_version: number;
    }>(sql`
      select id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload, status, attempts, secret_version
      from webhook_deliveries where id=${deliveryId}::uuid and tenant_id=${tenantId}::uuid for update
    `);
    const del = deliveries[0];
    if (!del) throw new Error('delivery_not_found');
    if (options.claimToken && del.claim_token !== options.claimToken) {
      throw new Error('webhook_claim_lost');
    }
    if (del.status === 'delivered' || del.status === 'dead_letter' || del.status === 'disabled') {
      return { delivery: del, endpoint: null, secret: null };
    }
    const endpoints = await tx.execute<{
      id: string;
      url: string;
      secret_ciphertext: string | null;
      secret_version: number;
      previous_secret_ciphertext: string | null;
      previous_secret_version: number | null;
      previous_secret_expires_at: string | null;
      status: string;
    }>(sql`
      select id, url, secret_ciphertext, secret_version, previous_secret_ciphertext,
             previous_secret_version, previous_secret_expires_at, status
      from webhook_endpoints where id=${del.endpoint_id}::uuid and tenant_id=${tenantId}::uuid limit 1
    `);
    const ep = endpoints[0];
    if (!ep) throw new Error('endpoint_not_found');
    const isCurrent = del.secret_version === ep.secret_version;
    const isPrevious =
      ep.previous_secret_version === del.secret_version &&
      ep.previous_secret_expires_at !== null &&
      new Date(ep.previous_secret_expires_at).getTime() > Date.now();
    const ciphertext = isCurrent
      ? ep.secret_ciphertext
      : isPrevious
        ? ep.previous_secret_ciphertext
        : null;
    if (!ciphertext) throw new Error('webhook_secret_version_unavailable');
    const key = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    if (!key) throw new Error('webhook_secret_encryption_key_required');
    return { delivery: del, endpoint: ep, secret: decryptWebhookSecret(ciphertext, key) };
  });

  if (!ctx.endpoint) {
    return {
      status: ctx.delivery.status as DeliverResult['status'],
      attempts: ctx.delivery.attempts,
    };
  }
  if (ctx.endpoint.status !== 'active') {
    await workerTenantTransaction(db, tenantId, `webhook:${deliveryId}`, async (tx) => {
      const updated = await tx.execute<{ id: string }>(sql`
        update webhook_deliveries set status='disabled', claim_token=null, claim_until=null, updated_at=now() where id=${deliveryId}::uuid ${claimGuard(options.claimToken)}
        returning id
      `);
      if (options.claimToken && updated.length === 0) throw new Error('webhook_claim_lost');
    });
    return { status: 'disabled', attempts: ctx.delivery.attempts };
  }

  const payloadStr = ctx.delivery.payload;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeSignature(ctx.secret, timestamp, payloadStr);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': `v1,${signature}`,
    'x-webhook-event-id': ctx.delivery.event_id,
    'x-webhook-event-type': ctx.delivery.event_type,
  };

  let responseStatus = 0;
  let responseBody = '';
  let error: string | null = null;
  let isTransient = false;
  const abortController = new AbortController();
  const lease = startLeaseHeartbeat(
    db,
    tenantId,
    deliveryId,
    options.claimToken,
    options,
    abortController,
  );

  try {
    const resp = await Promise.race([
      fetchFn(ctx.endpoint.url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: abortController.signal,
      }),
      lease.loss,
    ]);
    responseStatus = resp.status;
    responseBody = await resp.text().catch(() => '');
    if (resp.ok) {
      // 2xx -> delivered
      await workerTenantTransaction(db, tenantId, `webhook:${deliveryId}`, async (tx) => {
        await tx.execute(sql`
          update webhook_deliveries set status='delivered', attempts=attempts+1, delivered_at=now(), last_error=null, claim_token=null, claim_until=null, updated_at=now()
          where id=${deliveryId}::uuid ${claimGuard(options.claimToken)}
        `);
        await tx.execute(sql`
          update webhook_endpoints set failure_count=0, last_delivery_at=now(), updated_at=now()
          where id=${ctx.endpoint!.id}::uuid
        `);
      });
      metrics.recordJobDuration('webhooks', 0);
      return { status: 'delivered', attempts: ctx.delivery.attempts + 1 };
    } else if (responseStatus >= 500 || responseStatus === 429) {
      isTransient = true;
      error = `http_${responseStatus}:${responseBody.slice(0, 200)}`;
    } else {
      // 4xx -> not transient, mark failed (client error) but retry might not help; we treat as failed without retry for 400-404
      // However spec says retry only transient errors, so 4xx (except 429) -> failed without retry
      error = `http_${responseStatus}:${responseBody.slice(0, 200)}`;
      isTransient = false;
    }
  } catch (e) {
    if (lease.lost()) throw new Error('webhook_claim_lost');
    error = e instanceof Error ? e.message : String(e);
    isTransient = true; // network error is transient
  } finally {
    await lease.stop();
  }

  if (lease.lost()) throw new Error('webhook_claim_lost');

  // Handle failure
  const attempts = ctx.delivery.attempts + 1;
  const shouldDeadLetter = attempts >= 8;
  const shouldRetry = isTransient && !shouldDeadLetter;

  await workerTenantTransaction(db, tenantId, `webhook:${deliveryId}`, async (tx) => {
    if (shouldDeadLetter) {
      const updated = await tx.execute<{ id: string }>(sql`
        update webhook_deliveries set status='dead_letter', attempts=${attempts}, last_error=${error}, next_attempt_at=now() + interval '1 hour', claim_token=null, claim_until=null, updated_at=now()
        where id=${deliveryId}::uuid ${claimGuard(options.claimToken)}
        returning id
      `);
      if (options.claimToken && updated.length === 0) throw new Error('webhook_claim_lost');
      await tx.execute(sql`
        update webhook_endpoints set failure_count=failure_count+1, updated_at=now()
        where id=${ctx.endpoint!.id}::uuid
      `);
      // If failure_count >= 5, mark endpoint dead_letter
      const fails = await tx.execute<{ failure_count: number }>(sql`
        select failure_count from webhook_endpoints where id=${ctx.endpoint!.id}::uuid
      `);
      if ((fails[0]?.failure_count ?? 0) >= 5) {
        await tx.execute(
          sql`update webhook_endpoints set status='dead_letter', updated_at=now() where id=${ctx.endpoint!.id}::uuid`,
        );
      }
    } else if (shouldRetry) {
      const delay = backoffMs(attempts);
      const updated = await tx.execute<{ id: string }>(sql`
        update webhook_deliveries set status='retrying', attempts=${attempts}, last_error=${error}, next_attempt_at=now() + (${delay}::text || ' ms')::interval, claim_token=null, claim_until=null, updated_at=now()
        where id=${deliveryId}::uuid ${claimGuard(options.claimToken)}
        returning id
      `);
      if (options.claimToken && updated.length === 0) throw new Error('webhook_claim_lost');
      await tx.execute(
        sql`update webhook_endpoints set failure_count=failure_count+1, updated_at=now() where id=${ctx.endpoint!.id}::uuid`,
      );
    } else {
      // 4xx failed
      const updated = await tx.execute<{ id: string }>(sql`
        update webhook_deliveries set status='failed', attempts=${attempts}, last_error=${error}, claim_token=null, claim_until=null, updated_at=now()
        where id=${deliveryId}::uuid ${claimGuard(options.claimToken)}
        returning id
      `);
      if (options.claimToken && updated.length === 0) throw new Error('webhook_claim_lost');
    }
  });

  if (shouldDeadLetter) return { status: 'dead_letter', attempts };
  if (shouldRetry) return { status: 'retrying', attempts };
  return { status: 'failed', attempts };
}

export async function deliverPendingWebhooks(
  db: DatabaseHandle,
  options: { batchSize?: number; fetchFn?: WebhookFetch } = {},
): Promise<{ processed: number; delivered: number; failed: number }> {
  const batchSize = options.batchSize ?? 10;
  const rows = await workerGlobalTransaction(
    db,
    async (tx): Promise<Array<{ id: string; tenant_id: string; claim_token: string }>> => {
      const candidates = await tx.execute<{ id: string; tenant_id: string }>(sql`
      select id, tenant_id from webhook_deliveries
      where status in ('pending','retrying')
        and next_attempt_at <= now()
        and (claim_until is null or claim_until <= now())
      order by created_at
      limit ${batchSize}
      for update skip locked
    `);
      if (candidates.length === 0) return [];
      const ids = candidates.map((row) => row.id);
      return tx.execute<{ id: string; tenant_id: string; claim_token: string }>(sql`
      update webhook_deliveries
      set status='retrying', claim_token=gen_random_uuid()::text,
          claim_until=now() + interval '5 minutes', updated_at=now()
      where id = any(${ids}::uuid[])
        and status in ('pending','retrying')
        and (claim_until is null or claim_until <= now())
      returning id, tenant_id, claim_token
    `);
    },
  );
  let delivered = 0;
  let failed = 0;
  for (const r of rows) {
    const res = await deliverWebhook(db, r.id, r.tenant_id, {
      fetchFn: options.fetchFn,
      claimToken: r.claim_token,
    });
    if (res.status === 'delivered') delivered++;
    else if (res.status === 'failed' || res.status === 'dead_letter') failed++;
  }
  return { processed: rows.length, delivered, failed };
}
