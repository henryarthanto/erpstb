// =====================================================================
// ATOMIC OPS — Prisma Transaction-based Atomic Operations
//
// These operations use Prisma $transaction to ensure atomicity
// for balance updates, stock deductions, and pool operations.
//
// Replaces the previous PostgreSQL RPC functions (atomic_update_balance,
// atomic_update_setting_balance, atomic_decrement_stock) that were
// removed during the PostgreSQL migration.
// =====================================================================

import { prisma } from './supabase';

/**
 * Atomically update a cash box or bank account balance.
 * Uses Prisma $transaction for true atomicity.
 */
export async function atomicUpdateBalance(
  table: 'cashBox' | 'bankAccount',
  id: string,
  delta: number,
  minBalance = 0,
): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const record = await (tx as any)[table].findUnique({
      where: { id },
      select: { balance: true, version: true },
    });

    if (!record) {
      throw new Error(`${table} record not found: ${id}`);
    }

    const currentBalance = Number(record.balance) || 0;
    const newBalance = currentBalance + delta;

    if (newBalance < minBalance) {
      throw new Error(
        `Insufficient balance. Current: ${currentBalance}, Attempted: ${delta}, Min: ${minBalance}`
      );
    }

    await (tx as any)[table].update({
      where: { id },
      data: {
        balance: newBalance,
        version: (record.version || 0) + 1,
      },
    });

    return newBalance;
  });
}

/**
 * Atomically update a pool balance setting.
 * Uses Prisma $transaction for true atomicity.
 */
export async function atomicUpdatePoolBalance(
  key: string,
  delta: number,
  minBalance = 0,
): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const record = await (tx as any).setting.findUnique({
      where: { key },
    });

    let currentBalance = 0;
    if (record?.value) {
      try {
        currentBalance = parseFloat(JSON.parse(record.value)) || 0;
      } catch {
        currentBalance = parseFloat(record.value) || 0;
      }
    }

    const newBalance = currentBalance + delta;
    if (newBalance < minBalance) {
      throw new Error(
        `Insufficient pool balance. Key: ${key}, Current: ${currentBalance}, Attempted: ${delta}`
      );
    }

    if (record) {
      await (tx as any).setting.update({
        where: { key },
        data: { value: JSON.stringify(newBalance) },
      });
    } else {
      await (tx as any).setting.create({
        data: {
          key,
          value: JSON.stringify(newBalance),
        },
      });
    }

    return newBalance;
  });
}

/**
 * Get a pool balance from settings table.
 */
export async function getPoolBalance(key: string): Promise<number> {
  const record = await (prisma as any).setting.findUnique({
    where: { key },
    select: { value: true },
  });

  if (!record) return 0;
  try {
    return parseFloat(JSON.parse(record.value)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Atomically deduct global stock.
 * Uses Prisma $transaction for true atomicity.
 */
export async function atomicDecrementStock(
  productId: string,
  qty: number,
): Promise<{ newStock: number }> {
  return await prisma.$transaction(async (tx) => {
    const product = await (tx as any).product.findUnique({
      where: { id: productId },
      select: { globalStock: true },
    });

    if (!product) {
      throw new Error(`Product not found: ${productId}`);
    }

    const currentStock = Number(product.globalStock) || 0;
    if (currentStock < qty) {
      throw new Error(
        `Insufficient stock for product ${productId}. Available: ${currentStock}, Required: ${qty}`
      );
    }

    const newStock = currentStock - qty;
    await (tx as any).product.update({
      where: { id: productId },
      data: { globalStock: newStock },
    });

    return { newStock };
  });
}
