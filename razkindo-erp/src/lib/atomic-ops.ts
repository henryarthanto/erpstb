// =====================================================================
// ATOMIC OPS — Server-side helpers for atomic financial operations.
// Each function wraps a PostgreSQL RPC that runs inside a single
// statement, preventing race conditions on concurrent requests.
// =====================================================================

import { db } from '@/lib/supabase';

/**
 * Atomically update a cash box or bank account balance.
 * Throws if balance would go below minBalance (default 0).
 * Returns the new balance.
 */
export async function atomicUpdateBalance(
  table: 'cash_boxes' | 'bank_accounts',
  id: string,
  delta: number,
  minBalance = 0,
): Promise<number> {
  const { data, error } = await db.rpc('atomic_update_balance', {
    p_table: table,
    p_id: id,
    p_delta: delta,
    p_min: minBalance,
  });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
}

/**
 * Atomically update a pool balance setting.
 * Settings are stored as JSON stringified numbers.
 * Throws if balance would go below minBalance (default 0).
 * Returns the new balance.
 */
export async function atomicUpdatePoolBalance(
  key: string,
  delta: number,
  minBalance = 0,
): Promise<number> {
  const { data, error } = await db.rpc('atomic_update_setting_balance', {
    p_key: key,
    p_delta: delta,
    p_min: minBalance,
  });
  if (error) throw new Error(error.message);
  const result = Number(data) || 0;

  // WARNING: Log if balance goes negative unexpectedly (should only happen during rollback)
  if (result < 0 && minBalance >= 0) {
    console.error(`[POOL] WARNING: Balance negatif terdeteksi: key=${key}, balance=${result}, delta=${delta}, minBalance=${minBalance}`);
  }

  return result;
}

/**
 * Get a pool balance from settings table.
 * Settings can be stored as plain text numbers or JSON stringified numbers.
 * Auto-creates the setting if it doesn't exist.
 */
export async function getPoolBalance(key: string): Promise<number> {
  const { data } = await db
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (!data) {
    // Auto-create pool setting with 0 balance
    const { generateId } = await import('@/lib/supabase-helpers');
    const now = new Date().toISOString();
    try { await db.from('settings').insert({
      id: generateId(),
      key,
      value: '0',
      created_at: now,
      updated_at: now,
    }); } catch { /* best effort */ }
    return 0;
  }
  try {
    // Try JSON.parse first (for JSON stringified values like "1724500")
    const parsed = JSON.parse(data.value);
    return parseFloat(parsed) || 0;
  } catch {
    // Fallback: parse as plain number string (for values like "1724500")
    return parseFloat(data.value) || 0;
  }
}

/**
 * Atomically deduct global stock (wraps the decrement_stock RPC).
 * Note: decrement_stock returns void — this wrapper fetches the new stock
 * after decrement for the caller.
 */
export async function atomicDecrementStock(
  productId: string,
  qty: number,
): Promise<{ newStock: number }> {
  const { error } = await db.rpc('decrement_stock', {
    p_product_id: productId,
    p_qty: qty,
  });
  if (error) throw new Error(error.message);

  // Fetch updated stock after decrement
  const { data: product } = await db
    .from('products')
    .select('global_stock')
    .eq('id', productId)
    .single();

  return { newStock: Number(product?.global_stock) || 0 };
}
