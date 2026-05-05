import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';
import { cacheGet, cacheSet } from '@/lib/redis-cache';

// =====================================================================
// PWA Products - Public (no auth required)
// GET /api/pwa/[code]/products — Returns active products for the customer
// Products the customer frequently purchases are shown first with badges
// =====================================================================

interface ProductInfo {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  subUnit: string | null;
  conversionRate: number | null;
  price: number;
  stock: number;
  imageUrl: string | null;
  purchaseCount: number;
  lastPurchased: string | null;
  dealPrice: number | null;
  dealSubUnitPrice: number | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;

    if (!code || code.trim().length === 0) {
      return NextResponse.json(
        { error: 'Kode pelanggan diperlukan' },
        { status: 400 }
      );
    }

    // ── Check cache first (PWA products = expensive queries) ──
    const cacheKey = `api:pwa:products:${code.trim().toUpperCase()}`;
    try {
      const cached = await cacheGet<{ products: ProductInfo[] }>(cacheKey);
      if (cached) {
        return NextResponse.json(cached);
      }
    } catch { /* cache miss */ }

    // Look up customer to get unit_id
    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id, unit_id')
      .eq('code', code.trim().toUpperCase())
      .eq('status', 'active')
      .single();

    if (customerError || !customer) {
      return NextResponse.json(
        { error: 'Kode pelanggan tidak ditemukan' },
        { status: 404 }
      );
    }

    // ── Fetch PWA products via db.from() (Supabase/PostgreSQL) ──
    let productList = await fetchPwaProducts(customer.id, customer.unit_id);

    // ── Sort: deal price products first, then frequently purchased, then by name ──
    productList.sort((a, b) => {
      const aHasDeal = (a.dealPrice && a.dealPrice > 0) ? 1 : 0;
      const bHasDeal = (b.dealPrice && b.dealPrice > 0) ? 1 : 0;
      if (aHasDeal !== bHasDeal) return bHasDeal - aHasDeal;

      if (aHasDeal && bHasDeal) {
        if (a.purchaseCount !== b.purchaseCount) return b.purchaseCount - a.purchaseCount;
      }

      if (a.purchaseCount > 0 && b.purchaseCount === 0) return -1;
      if (a.purchaseCount === 0 && b.purchaseCount > 0) return 1;
      if (a.purchaseCount > 0 && b.purchaseCount > 0) {
        if (a.purchaseCount !== b.purchaseCount) return b.purchaseCount - a.purchaseCount;
        const aLast = a.lastPurchased || '';
        const bLast = b.lastPurchased || '';
        if (aLast > bLast) return -1;
        if (aLast < bLast) return 1;
      }
      return a.name.localeCompare(b.name);
    });

    const result = { products: productList };

    // Cache for 2 minutes (realtime sync handles instant invalidation)
    try {
      await cacheSet(cacheKey, result, { ttlMs: 120_000 });
    } catch { /* non-fatal */ }

    return NextResponse.json(result);
  } catch (error) {
    console.error('PWA products error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}

/** Fetch PWA products via db.from() (Supabase/PostgreSQL) — 4 parallel queries */
async function fetchPwaProducts(customerId: string, unitId: string): Promise<ProductInfo[]> {
  const [
    purchaseHistoryResult,
    unitProductsResult,
    productsResult,
    dealPricesResult,
  ] = await Promise.all([
    db
      .from('transactions')
      .select('items:transaction_items(*)')
      .eq('customer_id', customerId)
      .eq('type', 'sale')
      .neq('status', 'cancelled'),

    db
      .from('unit_products')
      .select('product_id, stock')
      .eq('unit_id', unitId),

    db
      .from('products')
      .select('id, name, sku, unit, subUnit, conversionRate, selling_price, global_stock, min_stock, is_active, stock_type, image_url')
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(500),

    db
      .from('customer_prices')
      .select('product_id, deal_price, sub_unit_price, updated_at')
      .eq('customer_id', customerId)
      .eq('is_active', true),
  ]);

  // Build purchase history map from transactions
  const purchaseMap = new Map<string, { count: number; totalQty: number; lastDate: string }>();
  const transactions = purchaseHistoryResult.data;
  if (Array.isArray(transactions)) {
    for (const tx of transactions) {
      const items = (tx as any).items || (tx as any).transaction_items;
      if (!Array.isArray(items)) continue;
      for (const wrapper of items) {
        const item = wrapper || wrapper?.transactionItem;
        if (!item) continue;
        const pid = item.productId || item.product_id;
        if (!pid) continue;
        const existing = purchaseMap.get(pid);
        const itemDate = item.createdAt || item.created_at || '';
        if (existing) {
          existing.count += 1;
          existing.totalQty += item.qty || 0;
          if (itemDate > existing.lastDate) existing.lastDate = itemDate;
        } else {
          purchaseMap.set(pid, { count: 1, totalQty: item.qty || 0, lastDate: itemDate });
        }
      }
    }
  }

  const unitProductMap = new Map<string, { stock: number }>();
  const unitProducts = unitProductsResult.data;
  if (Array.isArray(unitProducts)) {
    for (const up of unitProducts) {
      unitProductMap.set(up.product_id, { stock: up.stock });
    }
  }

  const dealPriceMap = new Map<string, { dealPrice: number; subUnitPrice: number; updatedAt: string }>();
  const dealPrices = dealPricesResult.data;
  if (Array.isArray(dealPrices)) {
    for (const dp of dealPrices) {
      dealPriceMap.set(dp.product_id, {
        dealPrice: dp.deal_price || 0,
        subUnitPrice: dp.sub_unit_price || 0,
        updatedAt: dp.updated_at || '',
      });
    }
  }

  const products = productsResult.data;
  if (productsResult.error) throw new Error('Gagal memuat produk');

  const productList: ProductInfo[] = [];

  for (const p of (products || [])) {
    const camel = toCamelCase(p);
    const productId = camel.id;

    let effectiveStock: number;
    if (camel.stockType === 'per_unit') {
      const up = unitProductMap.get(productId);
      if (!up) continue;
      effectiveStock = up.stock;
    } else {
      effectiveStock = camel.globalStock || 0;
    }

    const purchaseInfo = purchaseMap.get(productId);
    const dealInfo = dealPriceMap.get(productId);

    productList.push({
      id: productId,
      name: camel.name,
      sku: camel.sku,
      unit: camel.unit,
      subUnit: camel.subUnit,
      conversionRate: camel.conversionRate,
      price: 0,
      stock: effectiveStock,
      imageUrl: camel.imageUrl,
      purchaseCount: purchaseInfo?.count || 0,
      lastPurchased: purchaseInfo?.lastDate || null,
      dealPrice: dealInfo?.dealPrice && dealInfo.dealPrice > 0 ? dealInfo.dealPrice : null,
      dealSubUnitPrice: dealInfo?.subUnitPrice && dealInfo.subUnitPrice > 0 ? dealInfo.subUnitPrice : null,
    });
  }

  return productList;
}
