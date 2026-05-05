import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, rowsToCamelCase } from '@/lib/supabase-helpers';
import { enforceFinanceRole } from '@/lib/require-auth';
import { cacheGet, cacheSet } from '@/lib/redis-cache';

export async function GET(request: NextRequest) {
  try {
    const auth = await enforceFinanceRole(request);
    if (!auth.success) return auth.response;

    try {
      const cached = await cacheGet<any>('api:asset-value:summary');
      if (cached) return NextResponse.json(cached);
    } catch { /* cache miss */ }

    // ── Fetch products via db.from() (Supabase/PostgreSQL) ──
    const productList = await fetchAssetProducts();

    let totalAssetValue = 0;
    let totalSellingValue = 0;
    let productCount = productList.length;
    let lowStockCount = 0;

    const categoryMap = new Map<string, { assetValue: number; productCount: number }>();
    const productValues: Array<{ id: string; name: string; assetValue: number; stock: number; hpp: number }> = [];

    for (const p of productList) {
      const stock = parseFloat(p.globalStock) || 0;
      const hpp = parseFloat(p.avgHpp) || 0;
      const conversionRate = parseFloat(p.conversionRate) || 1;
      const assetValue = stock * hpp;
      totalAssetValue += assetValue;

      let sellingValue = 0;
      const sellPricePerSub = parseFloat(p.sellPricePerSubUnit) || 0;
      const sellPrice = parseFloat(p.sellingPrice) || 0;
      if (sellPricePerSub > 0) { sellingValue = stock * sellPricePerSub; }
      else if (sellPrice > 0) { sellingValue = (stock / conversionRate) * sellPrice; }
      totalSellingValue += sellingValue;

      const minStock = parseFloat(p.minStock) || 0;
      if (stock <= minStock) lowStockCount++;

      const category = p.category || 'Uncategorized';
      const catEntry = categoryMap.get(category) || { assetValue: 0, productCount: 0 };
      catEntry.assetValue += assetValue;
      catEntry.productCount += 1;
      categoryMap.set(category, catEntry);
      productValues.push({ id: p.id, name: p.name, assetValue, stock, hpp });
    }

    const categories = Array.from(categoryMap.entries())
      .map(([name, data]) => ({ name, assetValue: data.assetValue, productCount: data.productCount }))
      .sort((a, b) => b.assetValue - a.assetValue);
    const topProducts = productValues.sort((a, b) => b.assetValue - a.assetValue).slice(0, 5);

    const result = { totalAssetValue, totalSellingValue, productCount, lowStockCount, categories, topProducts };

    try { await cacheSet('api:asset-value:summary', result, { ttlMs: 120_000 }); } catch {}
    return NextResponse.json(result);
  } catch (error) {
    console.error('Get asset value error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

/** Fetch products for asset value calculation via db.from() (Supabase/PostgreSQL) */
async function fetchAssetProducts(): Promise<any[]> {
  const { data: products, error } = await db
    .from('products')
    .select('id, name, category, global_stock, avg_hpp, selling_price, sell_price_per_sub_unit, conversionRate, min_stock, is_active')
    .eq('is_active', true);
  if (error) throw new Error('Gagal mengambil data nilai aset');
  return rowsToCamelCase(products || []);
}
