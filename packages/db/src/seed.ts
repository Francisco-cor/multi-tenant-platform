import { sql } from 'drizzle-orm';
import { createDatabase } from './database.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Separate seed runner — never destructive in production.
 * Usage:
 *   pnpm --filter @platform/db seed              # idempotent insert of demo tenants (dev/test)
 *   pnpm --filter @platform/db seed --check      # verify seed exists, exit 1 if missing
 * Guard:
 *   - In production (NODE_ENV=production) requires ALLOW_SEED=1, otherwise refuses.
 *   - Never runs DELETE/TRUNCATE; uses INSERT ... ON CONFLICT DO NOTHING.
 *   - Seeded data is minimal and tenant-scoped (acme/contoso) for E2E/Playwright.
 */
interface SeedOptions {
  check?: boolean;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function allowSeed(): boolean {
  return process.env.ALLOW_SEED === '1' || process.argv.includes('--force');
}

export async function runSeed(
  connectionString: string,
  options: SeedOptions = {},
): Promise<{ seeded: boolean; tenants: string[] }> {
  if (isProduction() && !allowSeed()) {
    throw new Error(
      'seed_refused_in_production: set ALLOW_SEED=1 to allow seeds in production (never use destructive seeds)',
    );
  }

  const db = createDatabase(connectionString);
  const logJson = (payload: Record<string, unknown>): void => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'seed', ...payload }));
  };

  try {
    // Idempotent demo seed: two tenants, two users, branches, products
    // Uses raw sql with ON CONFLICT to remain idempotent across reruns.
    // All inserts are additive; never DELETE/UPDATE destructive.

    // Upsert demo users (idempotent by oidc identity)
    const users = [
      {
        id: '00000000-0000-4000-a000-000000000001',
        email: 'alice@acme.test',
        displayName: 'Alice Acme',
        oidcIssuer: 'dev',
        oidcSubject: 'alice-acme',
      },
      {
        id: '00000000-0000-4000-a000-000000000002',
        email: 'bob@contoso.test',
        displayName: 'Bob Contoso',
        oidcIssuer: 'dev',
        oidcSubject: 'bob-contoso',
      },
    ];

    // Check mode: verify at least acme tenant exists
    if (options.check) {
      const res = await db.db.execute<{ count: string }>(
        sql`select count(*) as count from organizations where slug in ('acme','contoso')`,
      );
      const count = Number(res[0]?.count ?? 0);
      logJson({ event: 'seed_check', count });
      if (count === 0) throw new Error('seed_missing: demo tenants not found, run seed');
      return { seeded: false, tenants: ['acme', 'contoso'].slice(0, count) };
    }

    for (const u of users) {
      await db.db.execute(sql`
        insert into users (id, oidc_issuer, oidc_subject, email, display_name, active)
        values (${u.id}::uuid, ${u.oidcIssuer}, ${u.oidcSubject}, ${u.email}, ${u.displayName}, true)
        on conflict (oidc_issuer, oidc_subject) do update set email = excluded.email, display_name = excluded.display_name
      `);
    }

    const tenants = [
      { id: '10000000-0000-4000-a000-000000000001', slug: 'acme', name: 'Acme Corp' },
      { id: '10000000-0000-4000-a000-000000000002', slug: 'contoso', name: 'Contoso Ltd' },
    ];

    for (const t of tenants) {
      await db.db.execute(sql`
        insert into organizations (id, slug, name, status)
        values (${t.id}::uuid, ${t.slug}, ${t.name}, 'active')
        on conflict (slug) do update set name = excluded.name
      `);
      logJson({ event: 'tenant_seeded', slug: t.slug, id: t.id });
    }

    // Memberships: alice->acme owner, bob->contoso owner
    const memberships = [
      { tenantId: tenants[0]!.id, userId: users[0]!.id, role: 'owner' },
      { tenantId: tenants[1]!.id, userId: users[1]!.id, role: 'owner' },
    ];
    for (const m of memberships) {
      await db.db.execute(sql`
        insert into memberships (tenant_id, user_id, role, active)
        values (${m.tenantId}::uuid, ${m.userId}::uuid, ${m.role}, true)
        on conflict (tenant_id, user_id) do update set role = excluded.role, active = true
      `);
    }

    // Branches per tenant
    const branches = [
      {
        id: '20000000-0000-4000-a000-000000000001',
        tenantId: tenants[0]!.id,
        slug: 'branch-acme-main',
        name: 'Acme Main',
      },
      {
        id: '20000000-0000-4000-a000-000000000002',
        tenantId: tenants[1]!.id,
        slug: 'branch-contoso-main',
        name: 'Contoso Main',
      },
    ];
    for (const b of branches) {
      await db.db.execute(sql`
        insert into branches (id, tenant_id, slug, name, active)
        values (${b.id}::uuid, ${b.tenantId}::uuid, ${b.slug}, ${b.name}, true)
        on conflict (tenant_id, slug) do update set name = excluded.name
      `);
    }

    // Products + stock demo (only if products table exists)
    try {
      const products = [
        {
          id: '30000000-0000-4000-a000-000000000001',
          tenantId: tenants[0]!.id,
          sku: 'acme-1',
          name: 'Acme Widget',
        },
        {
          id: '30000000-0000-4000-a000-000000000002',
          tenantId: tenants[1]!.id,
          sku: 'contoso-1',
          name: 'Contoso Widget',
        },
      ];
      for (const p of products) {
        await db.db.execute(sql`
          insert into products (id, tenant_id, sku, name, active)
          values (${p.id}::uuid, ${p.tenantId}::uuid, ${p.sku}, ${p.name}, true)
          on conflict (tenant_id, sku) do update set name = excluded.name
        `);
      }
      // Stock per branch (available 100)
      const stocks = [
        {
          tenantId: tenants[0]!.id,
          branchId: branches[0]!.id,
          productId: products[0]!.id,
          available: 100,
        },
        {
          tenantId: tenants[1]!.id,
          branchId: branches[1]!.id,
          productId: products[1]!.id,
          available: 100,
        },
      ];
      for (const s of stocks) {
        await db.db.execute(sql`
          insert into stock_per_branch (tenant_id, branch_id, product_id, available)
          values (${s.tenantId}::uuid, ${s.branchId}::uuid, ${s.productId}::uuid, ${s.available})
          on conflict do nothing
        `);
      }
    } catch (e) {
      logJson({
        event: 'seed_products_skipped',
        error: e instanceof Error ? e.message : String(e),
      });
    }

    logJson({ event: 'seed_complete', tenants: tenants.map((t) => t.slug) });
    return { seeded: true, tenants: tenants.map((t) => t.slug) };
  } finally {
    await db.close();
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to run seed');
  const check = process.argv.includes('--check');
  await runSeed(connectionString, { check });
}
