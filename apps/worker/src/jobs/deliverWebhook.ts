import { createHmac } from 'node:crypto';
import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { metrics } from '@platform/observability';

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
  fetchFn?: typeof fetch | undefined;
}

export async function deliverWebhook(
  db: DatabaseHandle,
  deliveryId: string,
  tenantId: string,
  options: DeliverWebhookOptions = {},
): Promise<DeliverResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  // Load delivery + endpoint with lock
  const ctx = await db.db.transaction(async (tx) => {
    const deliveries = await tx.execute<{
      id: string;
      tenant_id: string;
      endpoint_id: string;
      event_id: string;
      event_type: string;
      payload: string;
      status: string;
      attempts: number;
    }>(sql`
      select id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload, status, attempts
      from webhook_deliveries where id=${deliveryId}::uuid and tenant_id=${tenantId}::uuid for update
    `);
    const del = deliveries[0];
    if (!del) throw new Error('delivery_not_found');
    if (del.status === 'delivered' || del.status === 'dead_letter' || del.status === 'disabled') {
      return { delivery: del, endpoint: null, secret: null };
    }
    const endpoints = await tx.execute<{
      id: string;
      url: string;
      secret_hash: string;
      status: string;
    }>(sql`
      select id, url, secret_hash, status from webhook_endpoints where id=${del.endpoint_id}::uuid and tenant_id=${tenantId}::uuid limit 1
    `);
    const ep = endpoints[0];
    if (!ep) throw new Error('endpoint_not_found');
    // Use secret_hash as secret for HMAC (demo); prod should use vault
    return { delivery: del, endpoint: ep, secret: ep.secret_hash };
  });

  if (!ctx.endpoint) {
    return {
      status: ctx.delivery.status as DeliverResult['status'],
      attempts: ctx.delivery.attempts,
    };
  }
  if (ctx.endpoint.status !== 'active') {
    await db.db.execute(sql`
      update webhook_deliveries set status='disabled', updated_at=now() where id=${deliveryId}::uuid
    `);
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

  try {
    const resp = await fetchFn(ctx.endpoint.url, {
      method: 'POST',
      headers,
      body: payloadStr,
    });
    responseStatus = resp.status;
    responseBody = await resp.text().catch(() => '');
    if (resp.ok) {
      // 2xx -> delivered
      await db.db.transaction(async (tx) => {
        await tx.execute(sql`
          update webhook_deliveries set status='delivered', attempts=attempts+1, delivered_at=now(), last_error=null, updated_at=now()
          where id=${deliveryId}::uuid
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
    error = e instanceof Error ? e.message : String(e);
    isTransient = true; // network error is transient
  }

  // Handle failure
  const attempts = ctx.delivery.attempts + 1;
  const shouldDeadLetter = attempts >= 8;
  const shouldRetry = isTransient && !shouldDeadLetter;

  await db.db.transaction(async (tx) => {
    if (shouldDeadLetter) {
      await tx.execute(sql`
        update webhook_deliveries set status='dead_letter', attempts=${attempts}, last_error=${error}, next_attempt_at=now() + interval '1 hour', updated_at=now()
        where id=${deliveryId}::uuid
      `);
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
      await tx.execute(sql`
        update webhook_deliveries set status='retrying', attempts=${attempts}, last_error=${error}, next_attempt_at=now() + (${delay}::text || ' ms')::interval, updated_at=now()
        where id=${deliveryId}::uuid
      `);
      await tx.execute(
        sql`update webhook_endpoints set failure_count=failure_count+1, updated_at=now() where id=${ctx.endpoint!.id}::uuid`,
      );
    } else {
      // 4xx failed
      await tx.execute(sql`
        update webhook_deliveries set status='failed', attempts=${attempts}, last_error=${error}, updated_at=now()
        where id=${deliveryId}::uuid
      `);
    }
  });

  if (shouldDeadLetter) return { status: 'dead_letter', attempts };
  if (shouldRetry) return { status: 'retrying', attempts };
  return { status: 'failed', attempts };
}

export async function deliverPendingWebhooks(
  db: DatabaseHandle,
  options: { batchSize?: number; fetchFn?: typeof fetch } = {},
): Promise<{ processed: number; delivered: number; failed: number }> {
  const batchSize = options.batchSize ?? 10;
  const rows = await db.db.execute<{ id: string; tenant_id: string }>(sql`
    select id, tenant_id from webhook_deliveries
    where status in ('pending','retrying') and next_attempt_at <= now()
    order by created_at limit ${batchSize} for update skip locked
  `);
  let delivered = 0;
  let failed = 0;
  for (const r of rows) {
    // Mark claimed to avoid double process
    await db.db.execute(
      sql`update webhook_deliveries set status='retrying', updated_at=now() where id=${r.id}::uuid and status in ('pending','retrying')`,
    );
    const res = await deliverWebhook(db, r.id, r.tenant_id, { fetchFn: options.fetchFn });
    if (res.status === 'delivered') delivered++;
    else if (res.status === 'failed' || res.status === 'dead_letter') failed++;
  }
  return { processed: rows.length, delivered, failed };
}
