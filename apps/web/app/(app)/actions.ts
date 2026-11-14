'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  createBranch,
  createOrder,
  inviteMember,
  removeMember,
  reserveInventory,
} from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { orderIdempotencyKey } from '@/lib/idempotency';
import { hasPermission, type Permission } from '@/lib/permissions';

function fail(path: string, error: unknown): never {
  if (error instanceof ApiError) {
    const status = error.status;
    const code =
      status === 400
        ? 'invalid'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status === 410
                ? 'gone'
                : status === 503
                  ? 'unavailable'
                  : 'failed';
    redirect(`${path}?error=${code}`);
  }
  throw error;
}

function allow(permissions: readonly string[], permission: Permission): boolean {
  return hasPermission({ permissions }, permission);
}

export async function createBranchAction(formData: FormData): Promise<never> {
  const context = await getPageContext();
  if (!allow(context.context.permissions, 'branches:create')) redirect('/branches?error=forbidden');

  const slug = String(formData.get('slug') ?? '')
    .trim()
    .toLowerCase();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || !name) {
    redirect('/branches?error=invalid');
  }

  try {
    await createBranch(context.token, context.host, {
      slug,
      name,
      ...(description ? { description } : {}),
    });
  } catch (error) {
    fail('/branches', error);
  }
  revalidatePath('/branches');
  redirect('/branches?ok=branch_created');
}

export async function createOrderAction(formData: FormData): Promise<never> {
  const context = await getPageContext();
  if (!allow(context.context.permissions, 'orders:create')) redirect('/orders?error=forbidden');

  const branchId = String(formData.get('branchId') ?? '').trim();
  const currency = String(formData.get('currency') ?? 'USD')
    .trim()
    .toUpperCase();
  const amount = Number(formData.get('amount'));
  const amountCents = Math.round(amount * 100);
  const idempotencyNonce = String(formData.get('idempotencyKey') ?? '').trim();

  if (!branchId || !Number.isFinite(amount) || amountCents <= 0 || amountCents > 100_000_000) {
    redirect('/orders?error=invalid_amount');
  }
  if (!/^[A-Z]{3}$/u.test(currency)) redirect('/orders?error=invalid_currency');

  const idempotencyKey = orderIdempotencyKey({
    nonce: idempotencyNonce,
    branchId,
    amountCents,
    currency,
  });
  // A missing nonce means the form was tampered with or rendered before this
  // control existed: never fall back to a per-submit random key.
  if (!idempotencyKey) redirect('/orders?error=invalid_request');

  try {
    await createOrder(context.token, context.host, {
      branchId,
      amountCents,
      currency,
      idempotencyKey,
    });
  } catch (error) {
    fail('/orders', error);
  }
  revalidatePath('/orders');
  redirect('/orders?ok=order_created');
}

export async function reserveInventoryAction(formData: FormData): Promise<never> {
  const context = await getPageContext();
  if (!allow(context.context.permissions, 'inventory:reserve')) {
    redirect('/inventory?error=forbidden');
  }

  const branchId = String(formData.get('branchId') ?? '').trim();
  const productId = String(formData.get('productId') ?? '').trim();
  const quantity = Number(formData.get('quantity'));
  if (!branchId || !productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    redirect(`/inventory?branchId=${encodeURIComponent(branchId)}&error=invalid_quantity`);
  }

  try {
    await reserveInventory(context.token, context.host, { branchId, productId, quantity });
  } catch (error) {
    fail(`/inventory?branchId=${encodeURIComponent(branchId)}`, error);
  }
  revalidatePath('/inventory');
  redirect(`/inventory?branchId=${encodeURIComponent(branchId)}&ok=reserved`);
}

export async function inviteMemberAction(formData: FormData): Promise<never> {
  const context = await getPageContext();
  if (!allow(context.context.permissions, 'members:invite')) redirect('/members?error=forbidden');

  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? 'operator').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) redirect('/members?error=invalid_email');

  try {
    await inviteMember(context.token, context.host, { email, role });
  } catch (error) {
    fail('/members', error);
  }
  revalidatePath('/members');
  redirect('/members?ok=invited');
}

export async function removeMemberAction(formData: FormData): Promise<never> {
  const context = await getPageContext();
  if (!allow(context.context.permissions, 'members:remove')) redirect('/members?error=forbidden');

  const membershipId = String(formData.get('membershipId') ?? '').trim();
  if (!membershipId) redirect('/members?error=invalid');

  try {
    await removeMember(context.token, context.host, membershipId);
  } catch (error) {
    fail('/members', error);
  }
  revalidatePath('/members');
  redirect('/members?ok=removed');
}
