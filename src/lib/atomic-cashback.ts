// =====================================================================
// ATOMIC CASHBACK — Prisma Transaction-based Cashback Operation
//
// Atomically adds cashback to a customer's balance using Prisma
// interactive transaction. Replaces the PostgreSQL RPC function
// 'atomic_add_cashback' from the Supabase migration.
// =====================================================================

import { prisma } from './supabase';

/**
 * Atomically add cashback to a customer's balance.
 * Uses Prisma interactive transaction for true atomicity.
 */
export async function atomicAddCashback(
  customerId: string,
  amount: number,
): Promise<{ newBalance: number }> {
  return await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { cashbackBalance: true },
    });

    if (!customer) {
      throw new Error(`Customer not found: ${customerId}`);
    }

    const currentBalance = Number(customer.cashbackBalance) || 0;
    const newBalance = currentBalance + amount;

    await tx.customer.update({
      where: { id: customerId },
      data: { cashbackBalance: newBalance },
    });

    return { newBalance };
  });
}
