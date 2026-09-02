import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, writeOutboxEvent } from '@platform/db';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from '@platform/db';
import type { StoreTenantContext } from './identity-store.js';

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secretHash: string;
  events: string[];
  status: 'active' | 'disabled' | 'dead_letter';
  version: number;
  failureCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastDeliveryAt: number | null;
}

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: 'pending' | 'retrying' | 'delivered' | 'failed' | 'dead_letter' | 'disabled';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt?: number | undefined;
}

export interface CreateEndpointInput {
  url: string;
  secret?: string | undefined;
  events: string[];
  createdBy: string;
}

const ALLOWED_EVENTS = new Set([
  'order.created',
  'order.paid',
  'order.failed',
  'payment.paid',
  'payment.failed',
  'payment.created',
  'file.ready',
  'inventory.reserved',
  'generic',
]);

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function validateUrl(url: string): void {
  if (!url.startsWith('https://')) throw new Error('webhook_url_must_be_https');
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('webhook_url_must_be_https');
  } catch {
    throw new Error('webhook_url_invalid');
  }
  if (url.length > 2048) throw new Error('webhook_url_too_long');
}

export function validateEvents(events: string[]): void {
  if (!Array.isArray(events) || events.length === 0) throw new Error('webhook_events_required');
  for (const e of events) {
    if (!ALLOWED_EVENTS.has(e) && e !== '*') throw new Error(`webhook_event_invalid:${e}`);
  }
}

export interface WebhookStore {
  createEndpoint(context: StoreTenantContext, input: CreateEndpointInput): Promise<{ endpoint: WebhookEndpoint; rawSecret: string }>;
  listEndpoints(context: StoreTenantContext): Promise<WebhookEndpoint[]>;
  getEndpoint(context: StoreTenantContext, id: string): Promise<WebhookEndpoint | null>;
  updateEndpoint(context: StoreTenantContext, id: string, patch: { url?: string | undefined; events?: string[] | undefined; status?: string | undefined }): Promise<WebhookEndpoint>;
  deleteEndpoint(context: StoreTenantContext, id: string): Promise<void>;
  listDeliveries(context: StoreTenantContext, opts?: { endpointId?: string | undefined; limit?: number | undefined }): Promise<WebhookDelivery[]>;
  getDelivery(context: StoreTenantContext, deliveryId: string): Promise<WebhookDelivery | null>;
  replayDelivery(context: StoreTenantContext, deliveryId: string): Promise<WebhookDelivery>;
}

export class InMemoryWebhookStore implements WebhookStore {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly deliveries = new Map<string, WebhookDelivery>();
  // Store raw secrets only for test retrieval (not in prod)
  private readonly rawSecrets = new Map<string, string>();

  async createEndpoint(context: StoreTenantContext, input: CreateEndpointInput): Promise<{ endpoint: WebhookEndpoint; rawSecret: string }> {
    validateUrl(input.url);
    validateEvents(input.events);
    // Unique per tenant+url
    for (const ep of this.endpoints.values()) {
      if (ep.tenantId === context.tenantId && ep.url === input.url) throw new Error('webhook_url_taken');
    }
    const rawSecret = input.secret ?? randomBytes(32).toString('base64url');
    const secretHash = hashSecret(rawSecret);
    const now = Date.now();
    const endpoint: WebhookEndpoint = {
      id: randomUUID(),
      tenantId: context.tenantId,
      url: input.url,
      secretHash,
      events: [...input.events],
      status: 'active',
      version: 1,
      failureCount: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      lastDeliveryAt: null,
    };
    this.endpoints.set(endpoint.id, endpoint);
    this.rawSecrets.set(endpoint.id, rawSecret);
    return { endpoint, rawSecret };
  }

  async listEndpoints(context: StoreTenantContext): Promise<WebhookEndpoint[]> {
    return [...this.endpoints.values()].filter((e) => e.tenantId === context.tenantId);
  }

  async getEndpoint(context: StoreTenantContext, id: string): Promise<WebhookEndpoint | null> {
    const ep = this.endpoints.get(id);
    if (!ep || ep.tenantId !== context.tenantId) return null;
    return ep;
  }

  async updateEndpoint(context: StoreTenantContext, id: string, patch: { url?: string; events?: string[]; status?: string }): Promise<WebhookEndpoint> {
    const ep = this.endpoints.get(id);
    if (!ep || ep.tenantId !== context.tenantId) throw new Error('webhook_not_found');
    if (patch.url !== undefined) {
      validateUrl(patch.url);
      // check uniqueness
      for (const other of this.endpoints.values()) {
        if (other.id !== id && other.tenantId === context.tenantId && other.url === patch.url) throw new Error('webhook_url_taken');
      }
      ep.url = patch.url;
    }
    if (patch.events !== undefined) {
      validateEvents(patch.events);
      ep.events = [...patch.events];
    }
    if (patch.status !== undefined) {
      if (!['active', 'disabled', 'dead_letter'].includes(patch.status)) throw new Error('webhook_status_invalid');
      ep.status = patch.status as WebhookEndpoint['status'];
    }
    ep.version += 1;
    ep.updatedAt = Date.now();
    this.endpoints.set(id, ep);
    return ep;
  }

  async deleteEndpoint(context: StoreTenantContext, id: string): Promise<void> {
    const ep = this.endpoints.get(id);
    if (!ep || ep.tenantId !== context.tenantId) throw new Error('webhook_not_found');
    this.endpoints.delete(id);
    this.rawSecrets.delete(id);
    // also delete deliveries for endpoint
    for (const [did, d] of this.deliveries) {
      if (d.endpointId === id && d.tenantId === context.tenantId) this.deliveries.delete(did);
    }
  }

  async listDeliveries(context: StoreTenantContext, opts: { endpointId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    let list = [...this.deliveries.values()].filter((d) => d.tenantId === context.tenantId);
    if (opts.endpointId) list = list.filter((d) => d.endpointId === opts.endpointId);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list.slice(0, limit);
  }

  async getDelivery(context: StoreTenantContext, deliveryId: string): Promise<WebhookDelivery | null> {
    const d = this.deliveries.get(deliveryId);
    if (!d || d.tenantId !== context.tenantId) return null;
    return d;
  }

  async replayDelivery(context: StoreTenantContext, deliveryId: string): Promise<WebhookDelivery> {
    const d = this.deliveries.get(deliveryId);
    if (!d || d.tenantId !== context.tenantId) throw new Error('delivery_not_found');
    // Create new delivery with same eventId but new id, reset attempts
    const now = Date.now();
    const replay: WebhookDelivery = {
      ...d,
      id: randomUUID(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveries.set(replay.id, replay);
    return replay;
  }

  // Helper to simulate delivery creation on business event
  async createDeliveryForEvent(context: StoreTenantContext, event: { eventId: string; eventType: string; payload: unknown }): Promise<WebhookDelivery[]> {
    const eps = await this.listEndpoints(context);
    const now = Date.now();
    const created: WebhookDelivery[] = [];
    for (const ep of eps) {
      if (ep.status !== 'active') continue;
      if (!ep.events.includes(event.eventType) && !ep.events.includes('*') && !ep.events.includes('generic')) continue;
      // Enforce unique endpoint+event (like DB constraint)
      const exists = [...this.deliveries.values()].some((d) => d.endpointId === ep.id && d.eventId === event.eventId);
      if (exists) continue;
      const delivery: WebhookDelivery = {
        id: randomUUID(),
        tenantId: context.tenantId,
        endpointId: ep.id,
        eventId: event.eventId,
        eventType: event.eventType,
        payload: event.payload,
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextAttemptAt: now,
        deliveredAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.deliveries.set(delivery.id, delivery);
      created.push(delivery);
    }
    return created;
  }

  getRawSecret(endpointId: string): string | undefined {
    return this.rawSecrets.get(endpointId);
  }
}

export class PersistentWebhookStore implements WebhookStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }

  static fromConnectionString(connectionString: string, role = 'platform_app'): PersistentWebhookStore {
    return new PersistentWebhookStore(createDatabase(connectionString, { role }));
  }

  async createEndpoint(context: StoreTenantContext, input: CreateEndpointInput): Promise<{ endpoint: WebhookEndpoint; rawSecret: string }> {
    validateUrl(input.url);
    validateEvents(input.events);
    const rawSecret = input.secret ?? randomBytes(32).toString('base64url');
    const secretHash = hashSecret(rawSecret);
    const eventsJson = JSON.stringify(input.events);
    return withTenantTransaction(this.db, context, async (tx) => {
      try {
        const rows = await tx.execute<{
          id: string;
          tenant_id: string;
          url: string;
          secret_hash: string;
          events: string;
          status: string;
          version: number;
          failure_count: number;
          created_by: string;
          created_at: string;
          updated_at: string;
          last_delivery_at: string | null;
        }>(sql`
          insert into webhook_endpoints (tenant_id, url, secret_hash, events, status, created_by)
          values (${context.tenantId}::uuid, ${input.url}, ${secretHash}, ${eventsJson}::jsonb, 'active', ${input.createdBy}::uuid)
          returning id, tenant_id, url, secret_hash, events::text as events, status, version, failure_count, created_by, created_at, updated_at, last_delivery_at
        `);
        const r = rows[0];
        if (!r) throw new Error('webhook_create_failed');
        const endpoint: WebhookEndpoint = {
          id: r.id,
          tenantId: r.tenant_id,
          url: r.url,
          secretHash: r.secret_hash,
          events: JSON.parse(r.events),
          status: r.status as WebhookEndpoint['status'],
          version: r.version,
          failureCount: r.failure_count,
          createdBy: r.created_by,
          createdAt: new Date(r.created_at).getTime(),
          updatedAt: new Date(r.updated_at).getTime(),
          lastDeliveryAt: r.last_delivery_at ? new Date(r.last_delivery_at).getTime() : null,
        };
        // Also write outbox for webhook.created
        await writeOutboxEvent(tx, {
          tenantId: context.tenantId,
          aggregateType: 'webhook',
          aggregateId: endpoint.id,
          eventType: 'webhook.created',
          payload: { endpointId: endpoint.id, url: endpoint.url, events: endpoint.events },
          correlationId: context.requestId,
        });
        return { endpoint, rawSecret };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('webhook_url_tenant_unique') || msg.includes('duplicate key')) throw new Error('webhook_url_taken');
        throw e;
      }
    });
  }

  async listEndpoints(context: StoreTenantContext): Promise<WebhookEndpoint[]> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string; tenant_id: string; url: string; secret_hash: string; events: string; status: string; version: number; failure_count: number; created_by: string; created_at: string; updated_at: string; last_delivery_at: string | null;
      }>(sql`
        select id, tenant_id, url, secret_hash, events::text as events, status, version, failure_count, created_by, created_at, updated_at, last_delivery_at
        from webhook_endpoints where tenant_id=${context.tenantId}::uuid order by created_at desc
      `);
      return rows.map((r) => ({
        id: r.id, tenantId: r.tenant_id, url: r.url, secretHash: r.secret_hash,
        events: JSON.parse(r.events), status: r.status as WebhookEndpoint['status'],
        version: r.version, failureCount: r.failure_count, createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(), updatedAt: new Date(r.updated_at).getTime(),
        lastDeliveryAt: r.last_delivery_at ? new Date(r.last_delivery_at).getTime() : null,
      }));
    });
  }

  async getEndpoint(context: StoreTenantContext, id: string): Promise<WebhookEndpoint | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string; tenant_id: string; url: string; secret_hash: string; events: string; status: string; version: number; failure_count: number; created_by: string; created_at: string; updated_at: string; last_delivery_at: string | null;
      }>(sql`
        select id, tenant_id, url, secret_hash, events::text as events, status, version, failure_count, created_by, created_at, updated_at, last_delivery_at
        from webhook_endpoints where id=${id}::uuid and tenant_id=${context.tenantId}::uuid limit 1
      `);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, tenantId: r.tenant_id, url: r.url, secretHash: r.secret_hash,
        events: JSON.parse(r.events), status: r.status as WebhookEndpoint['status'],
        version: r.version, failureCount: r.failure_count, createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(), updatedAt: new Date(r.updated_at).getTime(),
        lastDeliveryAt: r.last_delivery_at ? new Date(r.last_delivery_at).getTime() : null,
      };
    });
  }

  async updateEndpoint(context: StoreTenantContext, id: string, patch: { url?: string; events?: string[]; status?: string }): Promise<WebhookEndpoint> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const existing = await tx.execute<{ id: string }>(sql`select id from webhook_endpoints where id=${id}::uuid and tenant_id=${context.tenantId}::uuid for update`);
      if (existing.length === 0) throw new Error('webhook_not_found');
      if (patch.url !== undefined) validateUrl(patch.url);
      if (patch.events !== undefined) validateEvents(patch.events);
      if (patch.status !== undefined && !['active', 'disabled', 'dead_letter'].includes(patch.status)) throw new Error('webhook_status_invalid');
      const eventsJson = patch.events ? JSON.stringify(patch.events) : null;
      const rows = await tx.execute<{
        id: string; tenant_id: string; url: string; secret_hash: string; events: string; status: string; version: number; failure_count: number; created_by: string; created_at: string; updated_at: string; last_delivery_at: string | null;
      }>(sql`
        update webhook_endpoints set
          url = coalesce(${patch.url ?? null}, url),
          events = coalesce(${eventsJson}::jsonb, events),
          status = coalesce(${patch.status ?? null}, status),
          version = version + 1,
          updated_at = now()
        where id=${id}::uuid and tenant_id=${context.tenantId}::uuid
        returning id, tenant_id, url, secret_hash, events::text as events, status, version, failure_count, created_by, created_at, updated_at, last_delivery_at
      `);
      const r = rows[0];
      if (!r) throw new Error('webhook_not_found');
      return {
        id: r.id, tenantId: r.tenant_id, url: r.url, secretHash: r.secret_hash,
        events: JSON.parse(r.events), status: r.status as WebhookEndpoint['status'],
        version: r.version, failureCount: r.failure_count, createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(), updatedAt: new Date(r.updated_at).getTime(),
        lastDeliveryAt: r.last_delivery_at ? new Date(r.last_delivery_at).getTime() : null,
      };
    });
  }

  async deleteEndpoint(context: StoreTenantContext, id: string): Promise<void> {
    await withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`delete from webhook_endpoints where id=${id}::uuid and tenant_id=${context.tenantId}::uuid returning id`);
      if (rows.length === 0) throw new Error('webhook_not_found');
    });
  }

  async listDeliveries(context: StoreTenantContext, opts: { endpointId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = opts.endpointId
        ? await tx.execute<{
          id: string; tenant_id: string; endpoint_id: string; event_id: string; event_type: string; payload: string; status: string; attempts: number; last_error: string | null; next_attempt_at: string; delivered_at: string | null; created_at: string;
        }>(sql`
          select id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
          from webhook_deliveries where tenant_id=${context.tenantId}::uuid and endpoint_id=${opts.endpointId}::uuid order by created_at desc limit ${limit}
        `)
        : await tx.execute<{
          id: string; tenant_id: string; endpoint_id: string; event_id: string; event_type: string; payload: string; status: string; attempts: number; last_error: string | null; next_attempt_at: string; delivered_at: string | null; created_at: string;
        }>(sql`
          select id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
          from webhook_deliveries where tenant_id=${context.tenantId}::uuid order by created_at desc limit ${limit}
        `);
      return rows.map((r) => ({
        id: r.id, tenantId: r.tenant_id, endpointId: r.endpoint_id, eventId: r.event_id, eventType: r.event_type,
        payload: JSON.parse(r.payload), status: r.status as WebhookDelivery['status'],
        attempts: r.attempts, lastError: r.last_error, nextAttemptAt: new Date(r.next_attempt_at).getTime(),
        deliveredAt: r.delivered_at ? new Date(r.delivered_at).getTime() : null, createdAt: new Date(r.created_at).getTime(),
      }));
    });
  }

  async getDelivery(context: StoreTenantContext, deliveryId: string): Promise<WebhookDelivery | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string; tenant_id: string; endpoint_id: string; event_id: string; event_type: string; payload: string; status: string; attempts: number; last_error: string | null; next_attempt_at: string; delivered_at: string | null; created_at: string;
      }>(sql`
        select id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
        from webhook_deliveries where id=${deliveryId}::uuid and tenant_id=${context.tenantId}::uuid limit 1
      `);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, tenantId: r.tenant_id, endpointId: r.endpoint_id, eventId: r.event_id, eventType: r.event_type,
        payload: JSON.parse(r.payload), status: r.status as WebhookDelivery['status'],
        attempts: r.attempts, lastError: r.last_error, nextAttemptAt: new Date(r.next_attempt_at).getTime(),
        deliveredAt: r.delivered_at ? new Date(r.delivered_at).getTime() : null, createdAt: new Date(r.created_at).getTime(),
      };
    });
  }

  async replayDelivery(context: StoreTenantContext, deliveryId: string): Promise<WebhookDelivery> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string; tenant_id: string; endpoint_id: string; event_id: string; event_type: string; payload: string;
      }>(sql`
        select id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload from webhook_deliveries
        where id=${deliveryId}::uuid and tenant_id=${context.tenantId}::uuid for update
      `);
      const r = rows[0];
      if (!r) throw new Error('delivery_not_found');
      // Check permission: only active endpoints can be replayed, but we allow replay even if endpoint disabled (creates new pending)
      const newId = randomUUID();
      const newRows = await tx.execute<{
        id: string; tenant_id: string; endpoint_id: string; event_id: string; event_type: string; payload: string; status: string; attempts: number; next_attempt_at: string; delivered_at: string | null; created_at: string; last_error: string | null;
      }>(sql`
        insert into webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, payload, status, attempts, next_attempt_at)
        values (${newId}::uuid, ${r.tenant_id}::uuid, ${r.endpoint_id}::uuid, ${r.event_id}, ${r.event_type}, ${r.payload}::jsonb, 'pending', 0, now())
        returning id, tenant_id, endpoint_id, event_id, event_type, payload::text as payload, status, attempts, next_attempt_at, delivered_at, created_at, last_error
      `);
      const nr = newRows[0];
      if (!nr) throw new Error('replay_failed');
      await writeOutboxEvent(tx, {
        tenantId: context.tenantId,
        aggregateType: 'webhook',
        aggregateId: nr.id,
        eventType: 'webhook.replayed',
        payload: { deliveryId: nr.id, endpointId: nr.endpoint_id, eventId: nr.event_id },
        correlationId: context.requestId,
      });
      return {
        id: nr.id, tenantId: nr.tenant_id, endpointId: nr.endpoint_id, eventId: nr.event_id, eventType: nr.event_type,
        payload: JSON.parse(nr.payload), status: nr.status as WebhookDelivery['status'],
        attempts: nr.attempts, lastError: nr.last_error, nextAttemptAt: new Date(nr.next_attempt_at).getTime(),
        deliveredAt: nr.delivered_at ? new Date(nr.delivered_at).getTime() : null, createdAt: new Date(nr.created_at).getTime(),
      };
    });
  }
}
