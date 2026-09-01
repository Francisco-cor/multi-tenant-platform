import { randomUUID } from 'node:crypto';
import { sql } from '@platform/db';
import {
  createDatabase,
  withTenantTransaction,
  type DatabaseHandle,
} from '@platform/db';
import type { StoreTenantContext } from './identity-store.js';

export interface ProductRecord {
  [key: string]: unknown;
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  active: boolean;
}

export interface StockRecord {
  [key: string]: unknown;
  tenantId: string;
  branchId: string;
  productId: string;
  available: number;
}

export interface ReservationRecord {
  [key: string]: unknown;
  id: string;
  tenantId: string;
  branchId: string;
  productId: string;
  quantity: number;
  status: 'active' | 'released' | 'consumed' | 'expired';
  expiresAt: number;
  createdBy: string;
  correlationId: string;
}

export interface ReserveInput {
  branchId: string;
  productId: string;
  quantity: number;
  correlationId: string;
  createdBy: string;
  expiresInMs?: number;
}

export interface InventoryStore {
  reserve(context: StoreTenantContext, input: ReserveInput): Promise<ReservationRecord>;
  getStock(context: StoreTenantContext, branchId: string, productId: string): Promise<StockRecord | null>;
  listReservations(context: StoreTenantContext): Promise<ReservationRecord[]>;
  // helpers for tests/seed
  upsertProduct(product: ProductRecord): Promise<void> | void;
  setStock(record: StockRecord): Promise<void> | void;
}

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

export class InMemoryInventoryStore implements InventoryStore {
  private readonly products = new Map<string, ProductRecord>();
  private readonly stock = new Map<string, StockRecord>();
  private readonly reservations = new Map<string, ReservationRecord>();

  constructor(seed = true) {
    if (seed) this.seedDemo();
  }

  private key(tenantId: string, branchId: string, productId: string) {
    return `${tenantId}:${branchId}:${productId}`;
  }

  private seedDemo() {
    const acmeTenant = 'tenant-acme';
    const contosoTenant = 'tenant-contoso';
    const acmeBranch = 'branch-acme-main';
    const contosoBranch = 'branch-contoso-main';

    const prodAcme: ProductRecord = {
      id: 'product-acme-1',
      tenantId: acmeTenant,
      sku: 'SKU-ACME-1',
      name: 'Acme Widget',
      active: true,
    };
    const prodContoso: ProductRecord = {
      id: 'product-contoso-1',
      tenantId: contosoTenant,
      sku: 'SKU-CONTOSO-1',
      name: 'Contoso Gadget',
      active: true,
    };
    this.products.set(prodAcme.id, prodAcme);
    this.products.set(prodContoso.id, prodContoso);
    this.stock.set(this.key(acmeTenant, acmeBranch, prodAcme.id), {
      tenantId: acmeTenant,
      branchId: acmeBranch,
      productId: prodAcme.id,
      available: 10,
    });
    this.stock.set(this.key(contosoTenant, contosoBranch, prodContoso.id), {
      tenantId: contosoTenant,
      branchId: contosoBranch,
      productId: prodContoso.id,
      available: 10,
    });
  }

  async upsertProduct(product: ProductRecord): Promise<void> {
    this.products.set(product.id, product);
  }

  async setStock(record: StockRecord): Promise<void> {
    this.stock.set(this.key(record.tenantId, record.branchId, record.productId), record);
  }

  async getStock(context: StoreTenantContext, branchId: string, productId: string): Promise<StockRecord | null> {
    if (context.tenantId.includes('-') === false) {
      // simple check, but we allow
    }
    return this.stock.get(this.key(context.tenantId, branchId, productId)) ?? null;
  }

  async listReservations(context: StoreTenantContext): Promise<ReservationRecord[]> {
    return [...this.reservations.values()].filter((r) => r.tenantId === context.tenantId);
  }

  async reserve(context: StoreTenantContext, input: ReserveInput): Promise<ReservationRecord> {
    if (input.quantity <= 0) throw new Error('quantity_invalid');
    // Validate product belongs to tenant
    const product = this.products.get(input.productId);
    if (!product || product.tenantId !== context.tenantId) {
      throw new Error('product_not_found');
    }
    // Validate branch: we rely on identity store branches; but for in-memory we accept any branchId that exists in that tenant's stock keys
    const stockKey = this.key(context.tenantId, input.branchId, input.productId);
    const stock = this.stock.get(stockKey);
    if (!stock) throw new Error('stock_not_found');
    // Atomic check: available >= qty
    if (stock.available < input.quantity) throw new Error('out_of_stock');
    stock.available -= input.quantity;
    this.stock.set(stockKey, stock);

    const reservation: ReservationRecord = {
      id: `res_${randomUUID()}`,
      tenantId: context.tenantId,
      branchId: input.branchId,
      productId: input.productId,
      quantity: input.quantity,
      status: 'active',
      expiresAt: Date.now() + (input.expiresInMs ?? DEFAULT_RESERVATION_TTL_MS),
      createdBy: input.createdBy,
      correlationId: input.correlationId,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  // For expiry job in-memory
  async expireReservations(now = Date.now()): Promise<number> {
    let count = 0;
    for (const [id, r] of this.reservations) {
      if (r.status === 'active' && r.expiresAt <= now) {
        r.status = 'expired';
        const stockKey = this.key(r.tenantId, r.branchId, r.productId);
        const stock = this.stock.get(stockKey);
        if (stock) {
          stock.available += r.quantity;
          this.stock.set(stockKey, stock);
        }
        count++;
        this.reservations.set(id, r);
      }
    }
    return count;
  }
}

export class PersistentInventoryStore implements InventoryStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }

  static fromConnectionString(connectionString: string, role = 'platform_app'): PersistentInventoryStore {
    return new PersistentInventoryStore(createDatabase(connectionString, { role }));
  }

  async upsertProduct(product: ProductRecord): Promise<void> {
    await withTenantTransaction(
      this.db,
      { tenantId: product.tenantId, requestId: `product.upsert:${product.id}` },
      async (tx) => {
        await tx.execute(sql`
          insert into products (id, tenant_id, sku, name, active)
          values (${product.id}::uuid, ${product.tenantId}::uuid, ${product.sku}, ${product.name}, ${product.active})
          on conflict (tenant_id, sku) do update set name = excluded.name, active = excluded.active, updated_at = now()
        `);
      },
    );
  }

  async setStock(record: StockRecord): Promise<void> {
    await withTenantTransaction(
      this.db,
      { tenantId: record.tenantId, requestId: `stock.set:${record.branchId}:${record.productId}` },
      async (tx) => {
        await tx.execute(sql`
          insert into stock_per_branch (tenant_id, branch_id, product_id, available)
          values (${record.tenantId}::uuid, ${record.branchId}::uuid, ${record.productId}::uuid, ${record.available})
          on conflict (tenant_id, branch_id, product_id)
          do update set available = excluded.available, updated_at = now()
        `);
      },
    );
  }

  async getStock(context: StoreTenantContext, branchId: string, productId: string): Promise<StockRecord | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<StockRecord>(sql`
        select tenant_id as "tenantId", branch_id as "branchId", product_id as "productId", available
        from stock_per_branch
        where tenant_id = ${context.tenantId}::uuid
          and branch_id = ${branchId}::uuid
          and product_id = ${productId}::uuid
        limit 1
      `);
      return (rows[0] as StockRecord) ?? null;
    });
  }

  async listReservations(context: StoreTenantContext): Promise<ReservationRecord[]> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<ReservationRecord>(sql`
        select id, tenant_id as "tenantId", branch_id as "branchId", product_id as "productId", quantity, status, extract(epoch from expires_at)*1000 as "expiresAt", created_by as "createdBy", order_id as "orderId"
        from inventory_reservations
        where tenant_id = ${context.tenantId}::uuid
        order by created_at desc limit 100
      `);
      return rows as unknown as ReservationRecord[];
    });
  }

  async reserve(context: StoreTenantContext, input: ReserveInput): Promise<ReservationRecord> {
    const expiresAt = new Date(Date.now() + (input.expiresInMs ?? DEFAULT_RESERVATION_TTL_MS));
    const correlationId = input.correlationId;
    return withTenantTransaction(this.db, context, async (tx) => {
      // Atomic decrement with guard
      const updated = await tx.execute<{ available: number }>(sql`
        update stock_per_branch
        set available = available - ${input.quantity}, updated_at = now()
        where tenant_id = ${context.tenantId}::uuid
          and branch_id = ${input.branchId}::uuid
          and product_id = ${input.productId}::uuid
          and available >= ${input.quantity}
        returning available
      `);
      if (updated.length === 0) {
        // Determine if product/stock missing vs out of stock
        const stockRows = await tx.execute<{ available: number }>(sql`
          select available from stock_per_branch
          where tenant_id = ${context.tenantId}::uuid
            and branch_id = ${input.branchId}::uuid
            and product_id = ${input.productId}::uuid
        `);
        if (stockRows.length === 0) throw new Error('stock_not_found');
        throw new Error('out_of_stock');
      }

      const reservationId = randomUUID();
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        branch_id: string;
        product_id: string;
        quantity: number;
        status: string;
        expires_at: string;
        created_by: string;
      }>(sql`
        insert into inventory_reservations (id, tenant_id, branch_id, product_id, quantity, status, expires_at, created_by)
        values (${reservationId}::uuid, ${context.tenantId}::uuid, ${input.branchId}::uuid, ${input.productId}::uuid, ${input.quantity}, 'active', ${expiresAt.toISOString()}::timestamptz, ${input.createdBy}::uuid)
        returning id, tenant_id, branch_id, product_id, quantity, status, expires_at, created_by
      `);
      const row = rows[0];
      if (!row) throw new Error('reservation_create_failed');

      await tx.execute(sql`
        insert into inventory_movements (tenant_id, branch_id, product_id, delta, reason, correlation_id, created_by)
        values (${context.tenantId}::uuid, ${input.branchId}::uuid, ${input.productId}::uuid, ${-input.quantity}, 'reserve', ${correlationId}, ${input.createdBy}::uuid)
      `);

      return {
        id: row.id,
        tenantId: row.tenant_id,
        branchId: row.branch_id,
        productId: row.product_id,
        quantity: row.quantity,
        status: row.status as ReservationRecord['status'],
        expiresAt: new Date(row.expires_at).getTime(),
        createdBy: row.created_by,
        correlationId,
      };
    });
  }
}
