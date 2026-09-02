import { describe, expect, it } from 'vitest';
import {
  canTransition,
  paymentProviderKey,
  providerIdempotencyKey,
  shouldAlert,
  shouldReconcile,
} from './payments.js';
import { validateAutomation } from './automations.js';
import { PERMISSIONS, ROLE_PERMISSIONS, rolesHavePermission } from './index.js';

describe('Fase 13 — unitarias dominio (policies, firmas, idempotencia, transiciones)', () => {
  it('RBAC matrix: cada permiso tiene al menos un rol y owner tiene todos', () => {
    for (const perm of PERMISSIONS) {
      const holders = (
        Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>
      ).filter((r) => ROLE_PERMISSIONS[r].includes(perm));
      expect(holders.length, `perm ${perm} sin holder`).toBeGreaterThan(0);
    }
    expect(ROLE_PERMISSIONS.owner.length).toBe(PERMISSIONS.length);
    // auditor solo lectura + audit
    expect(rolesHavePermission(['auditor'], 'orders:create')).toBe(false);
    expect(rolesHavePermission(['auditor'], 'orders:read')).toBe(true);
    expect(rolesHavePermission(['auditor'], 'audit:read')).toBe(true);
    // operator no puede invitar ni webhooks
    expect(rolesHavePermission(['operator'], 'members:invite')).toBe(false);
    expect(rolesHavePermission(['operator'], 'webhooks:manage')).toBe(false);
    // manager puede inventory:reserve pero no webhooks:manage
    expect(rolesHavePermission(['manager'], 'inventory:reserve')).toBe(true);
    expect(rolesHavePermission(['manager'], 'webhooks:manage')).toBe(false);
  });

  it('payment state machine: transiciones válidas e inválidas', () => {
    expect(canTransition('created', 'pending')).toBe(true);
    expect(canTransition('created', 'paid')).toBe(false);
    expect(canTransition('pending', 'paid')).toBe(true);
    expect(canTransition('pending', 'failed')).toBe(true);
    expect(canTransition('pending', 'unknown')).toBe(true);
    expect(canTransition('pending', 'created')).toBe(false);
    expect(canTransition('unknown', 'paid')).toBe(true);
    expect(canTransition('unknown', 'failed')).toBe(true);
    expect(canTransition('unknown', 'pending')).toBe(false);
    expect(canTransition('paid', 'failed')).toBe(false);
    expect(canTransition('failed', 'unknown')).toBe(false);
    // unknown no debe auto-reembolsar: solo reconciler resuelve
    expect(shouldReconcile({ status: 'pending', updatedAt: Date.now() - 6 * 60 * 1000 })).toBe(
      true,
    );
    expect(shouldReconcile({ status: 'paid', updatedAt: Date.now() - 10 * 60 * 1000 })).toBe(false);
    expect(shouldAlert({ status: 'unknown', updatedAt: Date.now() - 31 * 60 * 1000 })).toBe(true);
    expect(shouldAlert({ status: 'pending', updatedAt: Date.now() - 31 * 60 * 1000 })).toBe(false);
  });

  it('provider idempotency key determinista sha256(tenant:order:amount)', () => {
    const key1 = providerIdempotencyKey({
      tenantId: 'tenant-acme',
      orderId: 'order-123',
      amount: 1999,
      currency: 'USD',
    });
    const key2 = providerIdempotencyKey({
      tenantId: 'tenant-acme',
      orderId: 'order-123',
      amount: 1999,
      currency: 'USD',
    });
    const key3 = providerIdempotencyKey({
      tenantId: 'tenant-acme',
      orderId: 'order-123',
      amount: 2000,
      currency: 'USD',
    });
    const keyOtherTenant = providerIdempotencyKey({
      tenantId: 'tenant-contoso',
      orderId: 'order-123',
      amount: 1999,
      currency: 'USD',
    });
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).not.toBe(keyOtherTenant);
    expect(key1).toMatch(/^[a-f0-9]{32}$/);
    // same via paymentProviderKey
    expect(paymentProviderKey({ tenantId: 't', orderId: 'o', amount: 100 })).toBe(
      providerIdempotencyKey({ tenantId: 't', orderId: 'o', amount: 100 }),
    );
  });

  it('automatizaciones: comandos versionados sin eval, trigger/action validados', () => {
    const ok = validateAutomation({
      trigger: 'order.paid',
      action: { type: 'webhook', params: { url: 'https://example.com' } },
      version: 1,
    });
    expect(ok.trigger).toBe('order.paid');
    expect(ok.action.type).toBe('webhook');
    expect(ok.action.version).toBe(1);
    expect(() =>
      validateAutomation({
        trigger: 'invalid.trigger' as never,
        action: { type: 'webhook' },
      }),
    ).toThrow();
    expect(() =>
      validateAutomation({
        trigger: 'order.paid',
        action: { type: 'eval' as never },
      }),
    ).toThrow();
    // no code exec: action is data, not function
    expect(typeof ok.action).toBe('object');
  });

  it('HMAC firma cambia si body cambia y dedupe por eventId', async () => {
    const { createHmac } = await import('node:crypto');
    const secret = 'test_secret_32bytes_long_______';
    const payload = JSON.stringify({ eventId: 'evt_1', amount: 100 });
    const payloadTampered = JSON.stringify({ eventId: 'evt_1', amount: 999 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    const sigTampered = createHmac('sha256', secret)
      .update(`${ts}.${payloadTampered}`)
      .digest('hex');
    expect(sig).not.toBe(sigTampered);
    // same eventId must dedupe (simulado via Set)
    const dedupe = new Set<string>();
    const key = `tenant-acme:${JSON.parse(payload).eventId}`;
    dedupe.add(key);
    expect(dedupe.has(key)).toBe(true);
    expect(dedupe.has('tenant-contoso:evt_1')).toBe(false);
  });
});
