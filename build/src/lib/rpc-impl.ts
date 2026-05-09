// =====================================================================
// RPC IMPLEMENTATION — All 19 database RPC functions using Prisma transactions
//
// Replaces PostgreSQL RPC functions that were removed during migration.
// Each function is atomic, uses prisma.$transaction(), and returns
// { data, error } format compatible with PostgrestResult.
//
// Exported individually and as a single `rpcHandlers` dispatch map.
// =====================================================================

import { prisma } from './supabase';
import { atomicUpdatePoolBalance } from './atomic-ops';

// ─────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────

type RpcResult = {
  data: any;
  error: { message: string; code?: string } | null;
};

type RpcHandler = (params: Record<string, any>) => Promise<RpcResult>;

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

/** Ensure Decimal-like values are converted to plain numbers */
function N(val: any): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  if (typeof val.toJSON === 'function') {
    const r = val.toJSON();
    return typeof r === 'number' ? r : parseFloat(String(r)) || 0;
  }
  return parseFloat(String(val)) || 0;
}

/** Wrap an async function in try/catch, returning { data, error } */
function wrap(fn: () => Promise<any>): Promise<RpcResult> {
  return fn().then(data => ({ data, error: null })).catch(err => ({
    data: null,
    error: {
      message: err instanceof Error ? err.message : String(err),
      code: (err as any).code || 'RPC_ERROR',
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────
// 1. decrement_stock
// Atomic: read current global_stock, validate qty <= stock, update.
// ─────────────────────────────────────────────────────────────────────

export async function decrement_stock(p_product_id: string, p_qty: number): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const newStock = await prisma.$transaction(async (tx) => {
      const product = await (tx as any).product.findUnique({
        where: { id: p_product_id },
        select: { globalStock: true, trackStock: true },
      });
      if (!product) throw new Error(`Product not found: ${p_product_id}`);

      const currentStock = N(product.globalStock);
      if (currentStock < qty) {
        throw new Error(
          `Insufficient stock for product ${p_product_id}. Available: ${currentStock}, Required: ${qty}`
        );
      }

      const updated = await (tx as any).product.update({
        where: { id: p_product_id },
        data: { globalStock: currentStock - qty },
        select: { globalStock: true },
      });

      return N(updated.globalStock);
    });

    return { new_stock: newStock };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 2. increment_stock
// Atomic: read current global_stock, add qty, update.
// ─────────────────────────────────────────────────────────────────────

export async function increment_stock(p_product_id: string, p_qty: number): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const newStock = await prisma.$transaction(async (tx) => {
      const product = await (tx as any).product.findUnique({
        where: { id: p_product_id },
        select: { globalStock: true },
      });
      if (!product) throw new Error(`Product not found: ${p_product_id}`);

      const currentStock = N(product.globalStock);

      const updated = await (tx as any).product.update({
        where: { id: p_product_id },
        data: { globalStock: currentStock + qty },
        select: { globalStock: true },
      });

      return N(updated.globalStock);
    });

    return { new_stock: newStock };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 3. decrement_unit_stock
// Atomic: read current unit_products.stock, validate, update.
// ─────────────────────────────────────────────────────────────────────

export async function decrement_unit_stock(p_unit_product_id: string, p_qty: number): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const newStock = await prisma.$transaction(async (tx) => {
      const unitProduct = await (tx as any).unitProduct.findUnique({
        where: { id: p_unit_product_id },
        select: { stock: true, productId: true },
      });
      if (!unitProduct) throw new Error(`UnitProduct not found: ${p_unit_product_id}`);

      const currentStock = N(unitProduct.stock);
      if (currentStock < qty) {
        throw new Error(
          `Insufficient unit stock for ${p_unit_product_id}. Available: ${currentStock}, Required: ${qty}`
        );
      }

      const updated = await (tx as any).unitProduct.update({
        where: { id: p_unit_product_id },
        data: { stock: currentStock - qty },
        select: { stock: true },
      });

      return N(updated.stock);
    });

    return { new_stock: newStock };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 4. increment_unit_stock
// Atomic: read current unit_products.stock, add, update.
// ─────────────────────────────────────────────────────────────────────

export async function increment_unit_stock(p_unit_product_id: string, p_qty: number): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const newStock = await prisma.$transaction(async (tx) => {
      const unitProduct = await (tx as any).unitProduct.findUnique({
        where: { id: p_unit_product_id },
        select: { stock: true },
      });
      if (!unitProduct) throw new Error(`UnitProduct not found: ${p_unit_product_id}`);

      const currentStock = N(unitProduct.stock);

      const updated = await (tx as any).unitProduct.update({
        where: { id: p_unit_product_id },
        data: { stock: currentStock + qty },
        select: { stock: true },
      });

      return N(updated.stock);
    });

    return { new_stock: newStock };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 5. decrement_unit_stock_recalc
// Atomic: decrement unit stock + recalculate global stock from sum of
// all unit_products for the same product.
// ─────────────────────────────────────────────────────────────────────

export async function decrement_unit_stock_recalc(
  p_unit_product_id: string,
  p_qty: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const result = await prisma.$transaction(async (tx) => {
      // 1. Read and validate unit stock
      const unitProduct = await (tx as any).unitProduct.findUnique({
        where: { id: p_unit_product_id },
        select: { stock: true, productId: true },
      });
      if (!unitProduct) throw new Error(`UnitProduct not found: ${p_unit_product_id}`);

      const currentUnitStock = N(unitProduct.stock);
      if (currentUnitStock < qty) {
        throw new Error(
          `Insufficient unit stock for ${p_unit_product_id}. Available: ${currentUnitStock}, Required: ${qty}`
        );
      }

      // 2. Decrement unit stock
      const updatedUnit = await (tx as any).unitProduct.update({
        where: { id: p_unit_product_id },
        data: { stock: currentUnitStock - qty },
        select: { stock: true },
      });

      // 3. Recalculate global stock from sum of all unit_products for the same product
      const allUnits = await (tx as any).unitProduct.findMany({
        where: { productId: unitProduct.productId },
        select: { stock: true },
      });

      const newGlobalStock = allUnits.reduce((sum: number, u: any) => sum + N(u.stock), 0);

      await (tx as any).product.update({
        where: { id: unitProduct.productId },
        data: { globalStock: newGlobalStock },
      });

      return {
        new_unit_stock: N(updatedUnit.stock),
        new_global_stock: newGlobalStock,
      };
    });

    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────
// 6. recalc_global_stock
// Calculate sum of all unit_products.stock where product_id matches,
// update products.global_stock.
// ─────────────────────────────────────────────────────────────────────

export async function recalc_global_stock(p_product_id: string): Promise<RpcResult> {
  return wrap(async () => {
    const newGlobalStock = await prisma.$transaction(async (tx) => {
      // Verify product exists
      const product = await (tx as any).product.findUnique({
        where: { id: p_product_id },
        select: { id: true },
      });
      if (!product) throw new Error(`Product not found: ${p_product_id}`);

      // Sum all unit products
      const allUnits = await (tx as any).unitProduct.findMany({
        where: { productId: p_product_id },
        select: { stock: true },
      });

      const totalStock = allUnits.reduce((sum: number, u: any) => sum + N(u.stock), 0);

      await (tx as any).product.update({
        where: { id: p_product_id },
        data: { globalStock: totalStock },
      });

      return totalStock;
    });

    return { new_global_stock: newGlobalStock };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 7. batch_decrement_centralized_stock
// Params are JSON strings. Parse them, then atomic batch: validate
// all stocks, decrement all.
// ─────────────────────────────────────────────────────────────────────

export async function batch_decrement_centralized_stock(
  p_product_ids: string,
  p_quantities: string,
): Promise<RpcResult> {
  return wrap(async () => {
    const productIds: string[] = JSON.parse(p_product_ids);
    const quantities: number[] = JSON.parse(p_quantities);

    if (productIds.length !== quantities.length) {
      throw new Error('product_ids and quantities arrays must have the same length');
    }

    const results = await prisma.$transaction(async (tx) => {
      // Phase 1: Validate all stocks first (all-or-nothing)
      const validationResults = await Promise.all(
        productIds.map((pid, i) =>
          (tx as any).product.findUnique({
            where: { id: pid },
            select: { globalStock: true, trackStock: true, id: true },
          })
        )
      );

      for (let i = 0; i < validationResults.length; i++) {
        const product = validationResults[i];
        if (!product) throw new Error(`Product not found: ${productIds[i]}`);
        const currentStock = N(product.globalStock);
        if (currentStock < N(quantities[i])) {
          throw new Error(
            `Insufficient stock for product ${productIds[i]}. Available: ${currentStock}, Required: ${N(quantities[i])}`
          );
        }
      }

      // Phase 2: Decrement all stocks
      const updateResults = await Promise.all(
        productIds.map((pid, i) =>
          (tx as any).product.update({
            where: { id: pid },
            data: { globalStock: { decrement: N(quantities[i]) } },
            select: { id: true, globalStock: true },
          })
        )
      );

      return updateResults.map((r: any) => ({
        product_id: r.id,
        new_stock: N(r.globalStock),
      }));
    });

    return { results };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 8. increment_stock_with_hpp
// Atomic: Read product, add qty to stock, recalculate avg_hpp.
// ─────────────────────────────────────────────────────────────────────

export async function increment_stock_with_hpp(
  p_product_id: string,
  p_qty: number,
  p_new_hpp: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    const newHpp = N(p_new_hpp);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const result = await prisma.$transaction(async (tx) => {
      const product = await (tx as any).product.findUnique({
        where: { id: p_product_id },
        select: { globalStock: true, avgHpp: true },
      });
      if (!product) throw new Error(`Product not found: ${p_product_id}`);

      const oldStock = N(product.globalStock);
      const oldHpp = N(product.avgHpp);
      const newStock = oldStock + qty;

      // Weighted average HPP: (old_stock * old_hpp + qty * new_hpp) / (old_stock + qty)
      const newAvgHpp = newStock > 0
        ? (oldStock * oldHpp + qty * newHpp) / newStock
        : newHpp;

      const updated = await (tx as any).product.update({
        where: { id: p_product_id },
        data: {
          globalStock: newStock,
          avgHpp: Math.round(newAvgHpp * 100) / 100, // Round to 2 decimal places
        },
        select: { globalStock: true, avgHpp: true },
      });

      return {
        new_stock: N(updated.globalStock),
        new_avg_hpp: N(updated.avgHpp),
      };
    });

    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────
// 9. reverse_purchase_stock_with_hpp
// Reverse a purchase: deduct stock and reverse HPP calculation.
// ─────────────────────────────────────────────────────────────────────

export async function reverse_purchase_stock_with_hpp(
  p_product_id: string,
  p_qty: number,
  p_original_hpp: number,
  p_unit_product_id: string | null,
): Promise<RpcResult> {
  return wrap(async () => {
    const qty = N(p_qty);
    const originalHpp = N(p_original_hpp);
    if (qty <= 0) throw new Error('Quantity must be positive');

    const result = await prisma.$transaction(async (tx) => {
      const product = await (tx as any).product.findUnique({
        where: { id: p_product_id },
        select: { globalStock: true, avgHpp: true },
      });
      if (!product) throw new Error(`Product not found: ${p_product_id}`);

      const oldStock = N(product.globalStock);
      const oldHpp = N(product.avgHpp);

      if (oldStock < qty) {
        throw new Error(
          `Insufficient stock to reverse. Current: ${oldStock}, Trying to reverse: ${qty}`
        );
      }

      const newStock = oldStock - qty;

      // Reverse HPP: (old_stock * old_hpp - qty * original_hpp) / (old_stock - qty)
      let newAvgHpp = 0;
      if (newStock > 0) {
        newAvgHpp = (oldStock * oldHpp - qty * originalHpp) / newStock;
        // Clamp to non-negative
        newAvgHpp = Math.max(0, newAvgHpp);
      }

      // Decrement unit stock if unit_product_id provided
      if (p_unit_product_id) {
        const unitProduct = await (tx as any).unitProduct.findUnique({
          where: { id: p_unit_product_id },
          select: { stock: true },
        });
        if (unitProduct) {
          const currentUnitStock = N(unitProduct.stock);
          if (currentUnitStock < qty) {
            throw new Error(
              `Insufficient unit stock to reverse. Current: ${currentUnitStock}, Trying to reverse: ${qty}`
            );
          }
          await (tx as any).unitProduct.update({
            where: { id: p_unit_product_id },
            data: { stock: currentUnitStock - qty },
          });
        }
      }

      const updated = await (tx as any).product.update({
        where: { id: p_product_id },
        data: {
          globalStock: newStock,
          avgHpp: Math.round(newAvgHpp * 100) / 100,
        },
        select: { globalStock: true, avgHpp: true },
      });

      return {
        new_stock: N(updated.globalStock),
        new_avg_hpp: N(updated.avgHpp),
      };
    });

    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────
// 10. atomic_increment_customer_stats
// Atomic: read customer, add delta to total_orders/total_spent,
// update last_transaction_date.
// ─────────────────────────────────────────────────────────────────────

export async function atomic_increment_customer_stats(
  p_customer_id: string,
  p_order_delta: number,
  p_spent_delta: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const orderDelta = N(p_order_delta);
    const spentDelta = N(p_spent_delta);

    const result = await prisma.$transaction(async (tx) => {
      const customer = await (tx as any).customer.findUnique({
        where: { id: p_customer_id },
        select: { totalOrders: true, totalSpent: true },
      });
      if (!customer) throw new Error(`Customer not found: ${p_customer_id}`);

      const newTotalOrders = N(customer.totalOrders) + orderDelta;
      const newTotalSpent = N(customer.totalSpent) + spentDelta;

      await (tx as any).customer.update({
        where: { id: p_customer_id },
        data: {
          totalOrders: Math.max(0, newTotalOrders),
          totalSpent: Math.max(0, newTotalSpent),
          lastTransactionDate: new Date(),
        },
      });

      return {
        total_orders: Math.max(0, newTotalOrders),
        total_spent: Math.max(0, newTotalSpent),
      };
    });

    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────
// 11. atomic_update_setting_balance
// Atomic: read setting value (parse JSON), add delta, update.
// Delegates to atomicUpdatePoolBalance from atomic-ops.ts.
// ─────────────────────────────────────────────────────────────────────

export async function atomic_update_setting_balance(
  p_key: string,
  p_delta: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const delta = N(p_delta);
    const newBalance = await atomicUpdatePoolBalance(p_key, delta);
    return { new_balance: newBalance };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 12. atomic_deduct_cashback
// Atomic: read customer.cashbackBalance, validate >= amount, deduct.
// ─────────────────────────────────────────────────────────────────────

export async function atomic_deduct_cashback(
  p_customer_id: string,
  p_amount: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const amount = N(p_amount);
    if (amount <= 0) throw new Error('Amount must be positive');

    const newBalance = await prisma.$transaction(async (tx) => {
      const customer = await (tx as any).customer.findUnique({
        where: { id: p_customer_id },
        select: { cashbackBalance: true },
      });
      if (!customer) throw new Error(`Customer not found: ${p_customer_id}`);

      const currentBalance = N(customer.cashbackBalance);
      if (currentBalance < amount) {
        throw new Error(
          `Insufficient cashback balance. Current: ${currentBalance}, Required: ${amount}`
        );
      }

      const updated = await (tx as any).customer.update({
        where: { id: p_customer_id },
        data: { cashbackBalance: currentBalance - amount },
        select: { cashbackBalance: true },
      });

      return N(updated.cashbackBalance);
    });

    return { new_balance: newBalance };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 13. atomic_add_cashback
// Atomic: read customer.cashbackBalance, add delta, update.
// ─────────────────────────────────────────────────────────────────────

export async function atomic_add_cashback(
  p_customer_id: string,
  p_delta: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const delta = N(p_delta);

    const newBalance = await prisma.$transaction(async (tx) => {
      const customer = await (tx as any).customer.findUnique({
        where: { id: p_customer_id },
        select: { cashbackBalance: true },
      });
      if (!customer) throw new Error(`Customer not found: ${p_customer_id}`);

      const currentBalance = N(customer.cashbackBalance);
      const updated = await (tx as any).customer.update({
        where: { id: p_customer_id },
        data: { cashbackBalance: currentBalance + delta },
        select: { cashbackBalance: true },
      });

      return N(updated.cashbackBalance);
    });

    return { new_balance: newBalance };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 14. atomic_add_courier_cash
// Atomic: Find or create CourierCash record for courier+unit, add
// delta to balance and totalCollected.
// ─────────────────────────────────────────────────────────────────────

export async function atomic_add_courier_cash(
  p_courier_id: string,
  p_unit_id: string,
  p_delta: number,
): Promise<RpcResult> {
  return wrap(async () => {
    const delta = N(p_delta);

    const newBalance = await prisma.$transaction(async (tx) => {
      // Find or create CourierCash record
      let courierCash = await (tx as any).courierCash.findUnique({
        where: { courierId_unitId: { courierId: p_courier_id, unitId: p_unit_id } },
      });

      if (!courierCash) {
        courierCash = await (tx as any).courierCash.create({
          data: {
            courierId: p_courier_id,
            unitId: p_unit_id,
            balance: delta,
            totalCollected: Math.max(0, delta),
            totalHandover: 0,
          },
        });
        return N(courierCash.balance);
      }

      const currentBalance = N(courierCash.balance);
      const updated = await (tx as any).courierCash.update({
        where: { id: courierCash.id },
        data: {
          balance: currentBalance + delta,
          totalCollected: N(courierCash.totalCollected) + Math.max(0, delta),
        },
        select: { balance: true },
      });

      return N(updated.balance);
    });

    return { new_balance: newBalance };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 15. process_courier_handover
// Complex atomic operation: deduct from courier cash, credit brankas,
// create handover + finance request records.
// ─────────────────────────────────────────────────────────────────────

export async function process_courier_handover(
  p_courier_id: string,
  p_unit_id: string,
  p_amount: number,
  p_processed_by_id: string,
  p_notes: string | null,
): Promise<RpcResult> {
  return wrap(async () => {
    const amount = N(p_amount);
    if (amount <= 0) throw new Error('Amount must be positive');

    const result = await prisma.$transaction(async (tx) => {
      // 1. Get or create CourierCash for courier+unit
      let courierCash = await (tx as any).courierCash.findUnique({
        where: { courierId_unitId: { courierId: p_courier_id, unitId: p_unit_id } },
      });

      if (!courierCash) {
        courierCash = await (tx as any).courierCash.create({
          data: {
            courierId: p_courier_id,
            unitId: p_unit_id,
            balance: 0,
            totalCollected: 0,
            totalHandover: 0,
          },
        });
      }

      // 2. Validate sufficient balance
      const currentBalance = N(courierCash.balance);
      if (currentBalance < amount) {
        throw new Error(
          `Saldo kurir tidak cukup untuk melakukan handover. Tersedia: ${currentBalance}, Diminta: ${amount}`
        );
      }

      // 3. Deduct from CourierCash
      const updatedCash = await (tx as any).courierCash.update({
        where: { id: courierCash.id },
        data: {
          balance: currentBalance - amount,
          totalHandover: N(courierCash.totalHandover) + amount,
        },
      });

      // 4. Find or create CashBox (brankas) for unit
      let cashBox = await (tx as any).cashBox.findFirst({
        where: {
          unitId: p_unit_id,
          isActive: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!cashBox) {
        // Get unit name for the cashbox
        const unit = await (tx as any).unit.findUnique({
          where: { id: p_unit_id },
          select: { name: true },
        });
        const unitName = unit?.name || 'Unknown';

        cashBox = await (tx as any).cashBox.create({
          data: {
            name: `Brankas ${unitName}`,
            unitId: p_unit_id,
            balance: amount,
            isActive: true,
            version: 1,
          },
        });
      } else {
        // 5. Credit CashBox balance
        cashBox = await (tx as any).cashBox.update({
          where: { id: cashBox.id },
          data: {
            balance: { increment: amount },
            version: { increment: 1 },
          },
        });
      }

      // 6. Create CourierHandover record
      const handoverId = crypto.randomUUID();
      const handover = await (tx as any).courierHandover.create({
        data: {
          id: handoverId,
          courierCashId: courierCash.id,
          amount,
          notes: p_notes || null,
          status: 'processed',
          processedById: p_processed_by_id,
          processedAt: new Date(),
        },
      });

      // 7. Create FinanceRequest record (type: courier_deposit)
      const financeRequestId = crypto.randomUUID();
      const financeRequest = await (tx as any).financeRequest.create({
        data: {
          id: financeRequestId,
          type: 'courier_deposit',
          requestById: p_processed_by_id,
          unitId: p_unit_id,
          courierId: p_courier_id,
          amount,
          description: `Setoran kas kurir - ${p_notes || 'Handover brankas'}`,
          status: 'processed',
          processedById: p_processed_by_id,
          processedAt: new Date(),
          cashBoxId: cashBox.id,
        },
      });

      // Link finance request to handover
      await (tx as any).courierHandover.update({
        where: { id: handoverId },
        data: { financeRequestId },
      });

      return {
        handover_id: handoverId,
        finance_request_id: financeRequestId,
        cash_box_id: cashBox.id,
        new_balance: N(updatedCash.balance),
        cash_box_balance: N(cashBox.balance),
      };
    });

    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────
// 16. get_courier_cash_totals
// Aggregate: sum of all CourierCash.balance, total_collected,
// total_handover.
// ─────────────────────────────────────────────────────────────────────

export async function get_courier_cash_totals(): Promise<RpcResult> {
  return wrap(async () => {
    const totals = await (prisma as any).courierCash.aggregate({
      _sum: {
        balance: true,
        totalCollected: true,
        totalHandover: true,
      },
    });

    return {
      total_balance: N(totals._sum?.balance),
      total_collected: N(totals._sum?.totalCollected),
      total_handover: N(totals._sum?.totalHandover),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 17. get_sale_totals_aggregate
// Aggregate: sum of hpp_paid and profit_paid from all transactions
// where type='sale'.
// ─────────────────────────────────────────────────────────────────────

export async function get_sale_totals_aggregate(): Promise<RpcResult> {
  return wrap(async () => {
    const totals = await (prisma as any).transaction.aggregate({
      where: { type: 'sale' },
      _sum: {
        hppPaid: true,
        profitPaid: true,
      },
    });

    return {
      hpp_paid: N(totals._sum?.hppPaid),
      profit_paid: N(totals._sum?.profitPaid),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 18. get_physical_balance_totals
// Aggregate: sum of active CashBox.balance as total_brankas, sum of
// active BankAccount.balance as total_rekening.
// ─────────────────────────────────────────────────────────────────────

export async function get_physical_balance_totals(): Promise<RpcResult> {
  return wrap(async () => {
    const [cashBoxTotals, bankAccountTotals] = await Promise.all([
      (prisma as any).cashBox.aggregate({
        where: { isActive: true },
        _sum: { balance: true },
      }),
      (prisma as any).bankAccount.aggregate({
        where: { isActive: true },
        _sum: { balance: true },
      }),
    ]);

    const totalBrankas = N(cashBoxTotals._sum?.balance);
    const totalRekening = N(bankAccountTotals._sum?.balance);

    return {
      total_brankas: totalBrankas,
      total_rekening: totalRekening,
      total_physical: totalBrankas + totalRekening,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 19. finance_reconcile
// Compare stored pool balances vs derived values.
// If autoFix, update stored to match derived.
// ─────────────────────────────────────────────────────────────────────

export async function finance_reconcile(p_auto_fix: boolean): Promise<RpcResult> {
  return wrap(async () => {
    const autoFix = p_auto_fix === true;

    // Get derived values from aggregates
    const [saleAgg, physAgg] = await Promise.all([
      (prisma as any).transaction.aggregate({
        where: { type: 'sale' },
        _sum: { hppPaid: true, profitPaid: true },
      }),
      (prisma as any).cashBox.aggregate({
        where: { isActive: true },
        _sum: { balance: true },
      }),
    ]);

    const bankAgg = await (prisma as any).bankAccount.aggregate({
      where: { isActive: true },
      _sum: { balance: true },
    });

    const derivedHpp = Math.round(N(saleAgg._sum?.hppPaid));
    const derivedProfit = Math.round(N(saleAgg._sum?.profitPaid));
    const totalBrankas = Math.round(N(physAgg._sum?.balance));
    const totalRekening = Math.round(N(bankAgg._sum?.balance));
    const totalPhysical = totalBrankas + totalRekening;

    // Get stored pool balances
    const getSettingBalance = async (key: string): Promise<number> => {
      const record = await (prisma as any).setting.findUnique({
        where: { key },
        select: { value: true },
      });
      if (!record?.value) return 0;
      try {
        return parseFloat(JSON.parse(record.value)) || 0;
      } catch {
        return parseFloat(record.value) || 0;
      }
    };

    const storedHpp = await getSettingBalance('pool_hpp_paid_balance');
    const storedProfit = await getSettingBalance('pool_profit_paid_balance');
    const storedInvestor = await getSettingBalance('pool_investor_fund');
    const totalPool = storedHpp + storedProfit + storedInvestor;

    // Check discrepancies
    const discrepancies: Array<{
      pool: string;
      stored: number;
      derived: number;
      diff: number;
    }> = [];
    const fixesApplied: Array<{ pool: string; old: number; new: number }> = [];

    // HPP pool vs derived HPP
    const hppDiff = storedHpp - derivedHpp;
    if (Math.abs(hppDiff) > 0.01) {
      discrepancies.push({
        pool: 'pool_hpp_paid_balance',
        stored: storedHpp,
        derived: derivedHpp,
        diff: hppDiff,
      });
    }

    // Profit pool vs derived profit
    const profitDiff = storedProfit - derivedProfit;
    if (Math.abs(profitDiff) > 0.01) {
      discrepancies.push({
        pool: 'pool_profit_paid_balance',
        stored: storedProfit,
        derived: derivedProfit,
        diff: profitDiff,
      });
    }

    // Total pool vs total physical (investor fund check)
    const investorFundDerived = Math.max(0, totalPhysical - derivedHpp - derivedProfit);
    const investorDiff = storedInvestor - investorFundDerived;
    if (Math.abs(investorDiff) > 0.01) {
      discrepancies.push({
        pool: 'pool_investor_fund',
        stored: storedInvestor,
        derived: investorFundDerived,
        diff: investorDiff,
      });
    }

    // Pool total vs physical total
    const poolPhysDiff = totalPool - totalPhysical;
    if (Math.abs(poolPhysDiff) > 0.01) {
      discrepancies.push({
        pool: 'total_pool_vs_physical',
        stored: totalPool,
        derived: totalPhysical,
        diff: poolPhysDiff,
      });
    }

    // Auto-fix if requested
    if (autoFix && discrepancies.length > 0) {
      await prisma.$transaction(async (tx) => {
        const upsertSetting = async (key: string, value: number) => {
          const existing = await (tx as any).setting.findUnique({
            where: { key },
            select: { id: true },
          });
          if (existing) {
            await (tx as any).setting.update({
              where: { key },
              data: { value: JSON.stringify(value) },
            });
          } else {
            await (tx as any).setting.create({
              data: { key, value: JSON.stringify(value) },
            });
          }
        };

        // Fix HPP pool
        if (Math.abs(storedHpp - derivedHpp) > 0.01) {
          const oldVal = storedHpp;
          await upsertSetting('pool_hpp_paid_balance', derivedHpp);
          fixesApplied.push({ pool: 'pool_hpp_paid_balance', old: oldVal, new: derivedHpp });
        }

        // Fix profit pool
        if (Math.abs(storedProfit - derivedProfit) > 0.01) {
          const oldVal = storedProfit;
          await upsertSetting('pool_profit_paid_balance', derivedProfit);
          fixesApplied.push({ pool: 'pool_profit_paid_balance', old: oldVal, new: derivedProfit });
        }

        // Fix investor fund
        const newInvestorFund = Math.max(0, totalPhysical - derivedHpp - derivedProfit);
        if (Math.abs(storedInvestor - newInvestorFund) > 0.01) {
          const oldVal = storedInvestor;
          await upsertSetting('pool_investor_fund', newInvestorFund);
          fixesApplied.push({ pool: 'pool_investor_fund', old: oldVal, new: newInvestorFund });
        }
      });
    }

    const isHealthy = discrepancies.length === 0;

    return {
      is_healthy: isHealthy,
      issues_count: discrepancies.length,
      discrepancies,
      fixes_applied: fixesApplied,
      derived: {
        hpp_paid: derivedHpp,
        profit_paid: derivedProfit,
        total_physical: totalPhysical,
        total_brankas: totalBrankas,
        total_rekening: totalRekening,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// RPC HANDLERS DISPATCH MAP
// Maps RPC function names (as called via db.rpc('name', {...params}))
// to their implementation functions. Each handler receives a flat
// params object and returns { data, error }.
// ─────────────────────────────────────────────────────────────────────

export const rpcHandlers: Record<string, RpcHandler> = {
  decrement_stock: (params) =>
    decrement_stock(params.p_product_id, params.p_qty),

  increment_stock: (params) =>
    increment_stock(params.p_product_id, params.p_qty),

  decrement_unit_stock: (params) =>
    decrement_unit_stock(params.p_unit_product_id, params.p_qty),

  increment_unit_stock: (params) =>
    increment_unit_stock(params.p_unit_product_id, params.p_qty),

  decrement_unit_stock_recalc: (params) =>
    decrement_unit_stock_recalc(params.p_unit_product_id, params.p_qty),

  recalc_global_stock: (params) =>
    recalc_global_stock(params.p_product_id),

  batch_decrement_centralized_stock: (params) =>
    batch_decrement_centralized_stock(params.p_product_ids, params.p_quantities),

  increment_stock_with_hpp: (params) =>
    increment_stock_with_hpp(params.p_product_id, params.p_qty, params.p_new_hpp),

  reverse_purchase_stock_with_hpp: (params) =>
    reverse_purchase_stock_with_hpp(
      params.p_product_id,
      params.p_qty,
      params.p_original_hpp,
      params.p_unit_product_id ?? null,
    ),

  atomic_increment_customer_stats: (params) =>
    atomic_increment_customer_stats(
      params.p_customer_id,
      params.p_order_delta,
      params.p_spent_delta,
    ),

  atomic_update_setting_balance: (params) =>
    atomic_update_setting_balance(params.p_key, params.p_delta),

  atomic_deduct_cashback: (params) =>
    atomic_deduct_cashback(params.p_customer_id, params.p_amount),

  atomic_add_cashback: (params) =>
    atomic_add_cashback(params.p_customer_id, params.p_delta),

  atomic_add_courier_cash: (params) =>
    atomic_add_courier_cash(params.p_courier_id, params.p_unit_id, params.p_delta),

  process_courier_handover: (params) =>
    process_courier_handover(
      params.p_courier_id,
      params.p_unit_id,
      params.p_amount,
      params.p_processed_by_id,
      params.p_notes ?? null,
    ),

  get_courier_cash_totals: () =>
    get_courier_cash_totals(),

  get_sale_totals_aggregate: () =>
    get_sale_totals_aggregate(),

  get_physical_balance_totals: () =>
    get_physical_balance_totals(),

  finance_reconcile: (params) =>
    finance_reconcile(params.p_auto_fix ?? false),
};
