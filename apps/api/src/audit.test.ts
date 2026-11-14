import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryIdentityStore, type AuditRecord } from './identity-store.js';
import { InMemoryInventoryStore } from './inventory-store.js';
import { InMemoryApiKeyStore } from './api-key-store.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  return cookieValue.split(';', 1)[0] ?? '';
}

async function loginAs(app: ReturnType<typeof buildApp>, userId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    payload: { userId },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

function actions(rows: AuditRecord[]): string[] {
  return rows.map((row) => `${row.action}:${row.result ?? 'success'}`);
}

describe('audit coverage and failure rows', () => {
  it('records inventory reserve success and failure rows scoped to the tenant', async () => {
    const store = new InMemoryIdentityStore(true);
    const inventoryStore = new InMemoryInventoryStore(true);
    const app = buildApp({ allowDevLogin: true, store, inventoryStore });
    const cookie = await loginAs(app, 'user-acme-only');

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/inventory/reserve',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { branchId: 'branch-acme-main', productId: 'product-acme-1', quantity: 2 },
    });
    expect(ok.statusCode).toBe(201);
    const reservationId = ok.json().reservation.id as string;

    const soldOut = await app.inject({
      method: 'POST',
      url: '/v1/inventory/reserve',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { branchId: 'branch-acme-main', productId: 'product-acme-1', quantity: 999 },
    });
    expect(soldOut.statusCode).toBe(409);

    const rows = store.auditLog.filter((row) => row.action === 'inventory.reserved');
    expect(actions(rows)).toEqual(['inventory.reserved:success', 'inventory.reserved:failure']);
    expect(rows[0]?.tenantId).toBe('tenant-acme');
    // In-memory reservation ids are not UUIDs: they are kept as a reference
    // instead of being written to the uuid column.
    expect(rows[0]?.resourceId).toBeUndefined();
    expect(rows[0]?.metadata?.resourceRef).toBe(reservationId);
    expect(rows[1]?.metadata?.reason).toBe('out_of_stock');
    expect(rows[1]?.actorUserId).toBe('user-acme-only');

    // The failure row must not be visible from another tenant.
    const audit = await store.listAudit('tenant-contoso');
    expect(audit.some((row) => row.action === 'inventory.reserved')).toBe(false);
    await app.close();
  });

  it('audits branch create/update successes and failed updates', async () => {
    const store = new InMemoryIdentityStore(true);
    const app = buildApp({ allowDevLogin: true, store });
    const cookie = await loginAs(app, 'user-alice');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { slug: 'north', name: 'North' },
    });
    expect(created.statusCode).toBe(201);
    const branchId = created.json().branch.id as string;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/branches/${branchId}`,
      headers: { host: 'acme.app.localhost', cookie },
      payload: { name: 'North Renamed' },
    });
    expect(updated.statusCode).toBe(200);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/v1/branches/does-not-exist',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { name: 'Nope' },
    });
    expect(missing.statusCode).toBe(404);

    const branchRows = store.auditLog.filter((row) => row.action.startsWith('branch.'));
    expect(actions(branchRows)).toEqual([
      'branch.created:success',
      'branch.updated:success',
      'branch.updated:failure',
    ]);
    expect(branchRows[0]?.resourceId).toBeUndefined();
    expect(branchRows[0]?.metadata?.resourceRef).toBe(branchId);
    expect(branchRows[2]?.resourceId).toBeUndefined();
    expect(branchRows[2]?.metadata?.resourceRef).toBe('does-not-exist');
    expect(branchRows[2]?.metadata?.reason).toBe('not_found');
    await app.close();
  });

  it('audits API key create/revoke and failed revocations', async () => {
    const store = new InMemoryIdentityStore(true);
    const apiKeyStore = new InMemoryApiKeyStore();
    const app = buildApp({ allowDevLogin: true, store, apiKeyStore });
    const cookie = await loginAs(app, 'user-alice');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { name: 'ci', scopes: ['orders:read'] },
    });
    expect(created.statusCode).toBe(201);
    const keyId = created.json().apiKey.id as string;

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${keyId}`,
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(revoked.statusCode).toBe(200);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${crypto.randomUUID()}`,
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(missing.statusCode).toBe(404);

    const rows = store.auditLog.filter((row) => row.action.startsWith('api_key.'));
    expect(actions(rows)).toEqual([
      'api_key.created:success',
      'api_key.revoked:success',
      'api_key.revoked:failure',
    ]);
    expect(rows[2]?.metadata?.reason).toBe('api_key_not_found');
    await app.close();
  });

  it('does not fail a committed operation when the audit insert fails', async () => {
    const store = new InMemoryIdentityStore(true);
    const originalAddAudit = store.addAudit.bind(store);
    const inventoryStore = new InMemoryInventoryStore(true);
    const app = buildApp({ allowDevLogin: true, store, inventoryStore });
    const cookie = await loginAs(app, 'user-acme-only');
    store.addAudit = () => {
      throw new Error('audit backend down');
    };

    const reserve = await app.inject({
      method: 'POST',
      url: '/v1/inventory/reserve',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { branchId: 'branch-acme-main', productId: 'product-acme-1', quantity: 1 },
    });

    expect(reserve.statusCode).toBe(201);
    // Restore for the injected login request's own audit writes.
    store.addAudit = originalAddAudit;
    await app.close();
  });
});
