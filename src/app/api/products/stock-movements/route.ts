import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, rowsToCamelCase } from '@/lib/supabase-helpers';
import { verifyAuthUser } from '@/lib/token';
import { cacheGet, cacheSet } from '@/lib/redis-cache';

export async function GET(request: NextRequest) {
  try {
    // ── Auth check ──
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Parse query params ──
    const { searchParams } = new URL(request.url);
    const productId = searchParams.get('productId');
    const type = searchParams.get('type'); // "in" or "out"
    const dateFrom = searchParams.get('dateFrom'); // YYYY-MM-DD
    const dateTo = searchParams.get('dateTo'); // YYYY-MM-DD
    const rawLimit = parseInt(searchParams.get('limit') || '50');
    const rawOffset = parseInt(searchParams.get('offset') || '0');
    const limit = Math.max(1, Math.min(rawLimit || 50, 200));
    const offset = Math.max(0, rawOffset || 0);

    // ── Check cache ──
    const cacheKey = `api:stock-movements:${productId || 'all'}:${type || 'all'}:${dateFrom || ''}:${dateTo || ''}:${limit}:${offset}`;
    try {
      const cached = await cacheGet<any>(cacheKey);
      if (cached) {
        return NextResponse.json(cached);
      }
    } catch { /* cache miss */ }

    // ── Fetch stock movements via db.from() (Prisma/MariaDB) ──
    const result = await fetchMovements(productId, type, dateFrom, dateTo, limit, offset);

    // Cache for 30 seconds (realtime sync handles instant invalidation)
    try {
      await cacheSet(cacheKey, { ...result, limit, offset }, { ttlMs: 30_000 });
    } catch { /* non-fatal */ }

    return NextResponse.json({ ...result, limit, offset });
  } catch (error) {
    console.error('Get stock movements error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}

/** Fetch stock movements via db.from() (Prisma/MariaDB) */
async function fetchMovements(
  productId: string | null,
  type: string | null,
  dateFrom: string | null,
  dateTo: string | null,
  limit: number,
  offset: number
): Promise<{ movements: any[]; total: number }> {
  let query = db
    .from('logs')
    .select('*', { count: 'exact' })
    .like('action', 'stock_updated%')
    .eq('entity', 'product')
    .order('created_at', { ascending: false });

  if (productId) query = query.eq('entityId', productId);
  if (type === 'in' || type === 'out') query = query.ilike('payload', `%"type":"${type}"%`);
  if (dateFrom) query = query.gte('created_at', `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lte('created_at', `${dateTo}T23:59:59.999Z`);

  const { data: logs, count, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error('Gagal mengambil data pergerakan stok');

  if (!logs || logs.length === 0) return { movements: [], total: count || 0 };

  const productIds = [...new Set(logs.map((l: any) => l.entity_id).filter(Boolean))];
  const userIds = [...new Set(logs.map((l: any) => l.user_id).filter(Boolean))];

  const unitIds: string[] = [];
  for (const log of logs) {
    try {
      const payload = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
      if (payload?.unitId) unitIds.push(payload.unitId);
    } catch { /* skip */ }
  }
  const uniqueUnitIds = [...new Set(unitIds.filter(Boolean))];

  const [productsResult, usersResult, unitsResult] = await Promise.all([
    productIds.length > 0
      ? db.from('products').select('id, name, sku, unit, subUnit, conversionRate').in('id', productIds)
      : Promise.resolve({ data: [] }),
    userIds.length > 0
      ? db.from('users').select('id, name').in('id', userIds)
      : Promise.resolve({ data: [] }),
    uniqueUnitIds.length > 0
      ? db.from('units').select('id, name').in('id', uniqueUnitIds)
      : Promise.resolve({ data: [] }),
  ]);

  const productMap = new Map<string, any>(
    (productsResult.data || []).map((p: any) => [p.id, toCamelCase(p)])
  );
  const userMap = new Map<string, string>(
    (usersResult.data || []).map((u: any) => [u.id, u.name])
  );
  const unitMap = new Map<string, string>(
    (unitsResult.data || []).map((u: any) => [u.id, u.name])
  );

  const movements = logs.map((log: any) => {
    let payload: Record<string, any> = {};
    try {
      payload = typeof log.payload === 'string' ? JSON.parse(log.payload) : (log.payload || {});
    } catch { payload = {}; }

    const product: any = productMap.get(log.entity_id) || {};
    const userName = userMap.get(log.user_id as string) || 'Unknown';

    let unitLabel: string | null = null;
    if (payload.stockType === 'per_unit' && payload.unitId) {
      unitLabel = unitMap.get(payload.unitId as string) || null;
    }

    return {
      id: log.id,
      productId: log.entity_id,
      productName: product.name || 'Unknown',
      productSku: product.sku || null,
      type: payload.type || null,
      stockType: payload.stockType || null,
      quantity: payload.quantity ?? null,
      quantityInSubUnits: payload.quantityInSubUnits ?? null,
      stockUnitType: payload.stockUnitType || null,
      unitName: product.unit || null,
      subUnit: product.subUnit || null,
      conversionRate: product.conversionRate ?? null,
      newStock: payload.newStock ?? null,
      unitLabel,
      userName,
      createdAt: log.created_at,
    };
  });

  return { movements, total: count || 0 };
}
