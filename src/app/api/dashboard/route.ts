import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/supabase';
import { Prisma } from '@prisma/client';
import { rowsToCamelCase } from '@/lib/supabase-helpers';
import { verifyAndGetAuthUser } from '@/lib/token';

/** Wrap a promise with a timeout (ms). Returns fallback on timeout or error. */
function withTimeout<T>(promise: PromiseLike<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout] as [Promise<T>, Promise<never>])
    .finally(() => clearTimeout(timer))
    .catch((err) => {
      console.error(`[Dashboard] ${label} failed:`, err?.message || err);
      return fallback;
    });
}

/** Wrap a query promise with try/catch, returning fallback on any error. */
function safeQuery(promise: PromiseLike<any>, fallback: any, label: string): Promise<any> {
  return Promise.resolve(promise).catch((err) => {
    console.error(`[Dashboard] ${label} failed:`, err?.message || err);
    return fallback;
  });
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userRole = authResult.user.role;

    const { searchParams } = new URL(request.url);
    const unitId = searchParams.get('unitId');
    const startDateParam = searchParams.get('startDate');
    const endDateParam = searchParams.get('endDate');

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Date range from filter params
    const filterStart = startDateParam
      ? new Date(new Date(startDateParam).setHours(0, 0, 0, 0))
      : monthStart;
    const filterEnd = endDateParam
      ? new Date(new Date(endDateParam).setHours(23, 59, 59, 999))
      : monthEnd;

    const thirtySecondsAgo = new Date(now.getTime() - 30000);
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // ========== RAW PRISMA QUERIES: Dashboard summary ==========
    // Replaces the PostgreSQL RPC (get_dashboard_summary) with direct Prisma queries.
    // Three queries run in parallel for optimal performance:
    //   1. Period summary  — totalSales, totalProfit, HPP, receivables, counts
    //   2. Today + Month    — todaySales, todayProfit, monthlySales, monthlyProfit
    //   3. Chart data       — daily sales/profit grouped by DATE
    const QUERY_TIMEOUT = 8000; // 8 seconds per query

    // End-of-day boundary for today
    const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    // Broadened range covering both today and the current month
    const todayMonthStart = new Date(Math.min(today.getTime(), monthStart.getTime()));
    const todayMonthEnd = new Date(Math.max(todayEnd.getTime(), monthEnd.getTime()));

    // Dynamic unit filter (parameterized via Prisma — no SQL injection risk)
    const unitFilter = unitId ? Prisma.sql`AND unit_id = ${unitId}` : Prisma.empty;

    const [periodRows, todayMonthRows, chartRows] = await Promise.all([
      // ── Query 1: Period summary ────────────────────────────────
      // All metrics scoped to the user-selected date range (filterStart → filterEnd)
      // NOTE: ::numeric cast + double-quoted aliases prevent Prisma Decimal objects
      // and ensure correct camelCase column names in result rows.
      withTimeout(safeQuery(
        prisma.$queryRaw`
          SELECT
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN total ELSE 0 END), 0)::numeric AS "totalSales",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN total_profit ELSE 0 END), 0)::numeric AS "totalProfit",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN paid_amount ELSE 0 END), 0)::numeric AS "totalPaid",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 AND payment_status != 'paid' THEN remaining_amount ELSE 0 END), 0)::numeric AS "totalReceivables",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN total_hpp ELSE 0 END), 0)::numeric AS "totalHpp",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN hpp_paid ELSE 0 END), 0)::numeric AS "hppInHand",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN hpp_unpaid ELSE 0 END), 0)::numeric AS "hppUnpaid",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN profit_paid ELSE 0 END), 0)::numeric AS "profitInHand",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN profit_unpaid ELSE 0 END), 0)::numeric AS "profitUnpaid",
            COUNT(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN 1 END)::int AS "periodTxCount"
          FROM transactions
          WHERE transaction_date >= ${filterStart} AND transaction_date <= ${filterEnd}
            ${unitFilter}
        `,
        [],
        'periodSummary'
      ), QUERY_TIMEOUT, [], 'periodSummary'),

      // ── Query 2: Today + Monthly summary ───────────────────────
      // Scans the broadened range (today ∪ current month) so both
      // today and month metrics are accurate regardless of filter period.
      withTimeout(safeQuery(
        prisma.$queryRaw`
          SELECT
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 AND transaction_date >= ${today} AND transaction_date <= ${todayEnd}
                 THEN total ELSE 0 END), 0)::numeric AS "todaySales",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 AND transaction_date >= ${today} AND transaction_date <= ${todayEnd}
                 THEN total_profit ELSE 0 END), 0)::numeric AS "todayProfit",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 AND transaction_date >= ${monthStart} AND transaction_date <= ${monthEnd}
                 THEN total ELSE 0 END), 0)::numeric AS "monthlySales",
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 AND transaction_date >= ${monthStart} AND transaction_date <= ${monthEnd}
                 THEN total_profit ELSE 0 END), 0)::numeric AS "monthlyProfit"
          FROM transactions
          WHERE transaction_date >= ${todayMonthStart} AND transaction_date <= ${todayMonthEnd}
            ${unitFilter}
        `,
        [],
        'todayMonthSummary'
      ), QUERY_TIMEOUT, [], 'todayMonthSummary'),

      // ── Query 3: Chart data ────────────────────────────────────
      // Daily sales & profit for the selected period, used by the area chart.
      withTimeout(safeQuery(
        prisma.$queryRaw`
          SELECT transaction_date::date AS date,
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN total ELSE 0 END), 0)::numeric AS sales,
            COALESCE(SUM(CASE WHEN type = 'sale' AND status IN ('approved', 'paid')
                 THEN total_profit ELSE 0 END), 0)::numeric AS profit
          FROM transactions
          WHERE transaction_date >= ${filterStart} AND transaction_date <= ${filterEnd}
            ${unitFilter}
          GROUP BY transaction_date::date
          ORDER BY 1
        `,
        [],
        'chartData'
      ), QUERY_TIMEOUT, [], 'chartData'),
    ]);

    // Merge query results into the summaryData object (same shape as the old RPC)
    const periodRow: any = Array.isArray(periodRows) ? periodRows[0] : {};
    const todayMonthRow: any = Array.isArray(todayMonthRows) ? todayMonthRows[0] : {};

    const summaryData: Record<string, any> = {
      totalSales: Number(periodRow?.totalSales) || 0,
      totalProfit: Number(periodRow?.totalProfit) || 0,
      totalPaid: Number(periodRow?.totalPaid) || 0,
      totalHpp: Number(periodRow?.totalHpp) || 0,
      totalReceivables: Number(periodRow?.totalReceivables) || 0,
      hppInHand: Number(periodRow?.hppInHand) || 0,
      hppUnpaid: Number(periodRow?.hppUnpaid) || 0,
      profitInHand: Number(periodRow?.profitInHand) || 0,
      profitUnpaid: Number(periodRow?.profitUnpaid) || 0,
      periodTxCount: Number(periodRow?.periodTxCount) || 0,
      todaySales: Number(todayMonthRow?.todaySales) || 0,
      todayProfit: Number(todayMonthRow?.todayProfit) || 0,
      monthlySales: Number(todayMonthRow?.monthlySales) || 0,
      monthlyProfit: Number(todayMonthRow?.monthlyProfit) || 0,
      chartData: Array.isArray(chartRows) ? chartRows : [],
    };

    // ========== BATCH 1: Remaining independent queries (8 parallel) ==========
    // Each query is wrapped with safeQuery (try/catch) + withTimeout (8s deadline)
    // so one failing/slow query doesn't crash the entire dashboard.
    const [
      pendingApprovalsCount,
      lowStockRows,
      onlineUsersCount,
      receivablesData,
      topProductsRaw,
      topSalesRaw,
      salesTargetsData,
      superAdminUsersData,
    ] = await Promise.all([
      // Pending approvals
      withTimeout(safeQuery(
        (() => {
          let q = db.from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending');
          if (unitId) q = q.eq('unit_id', unitId);
          return q;
        })(),
        { count: 0 },
        'pendingApprovals'
      ), QUERY_TIMEOUT, { count: 0 }, 'pendingApprovals'),

      // Low stock products (count products where globalStock <= minStock)
      withTimeout(safeQuery(
        (() => {
          let q = db.from('products')
            .select('id, global_stock, min_stock, is_active, track_stock')
            .eq('is_active', true)
            .eq('track_stock', true);
          if (unitId) {
            // For unit-specific filter, use unit_products stock
            return db.from('unit_products')
              .select('product_id, stock')
              .eq('unit_id', unitId)
              .then(({ data: unitProducts }) => {
                if (!unitProducts || unitProducts.length === 0) return [];
                const productIds = unitProducts.map(up => up.product_id);
                return db.from('products')
                  .select('id, name, global_stock, min_stock, is_active, track_stock, stock_type')
                  .in('id', productIds)
                  .eq('is_active', true)
                  .then(({ data: products }) => {
                    if (!products) return [];
                    const unitStockMap = new Map(unitProducts.map(up => [up.product_id, up.stock]));
                    return (products as any[]).filter(p => {
                      if (p.stock_type === 'per_unit') {
                        const unitStock = unitStockMap.get(p.id);
                        return unitStock !== undefined && unitStock <= (p.min_stock || 0);
                      }
                      return p.global_stock <= (p.min_stock || 0);
                    });
                  });
              });
          }
          return q.then(({ data }) => {
            if (!data) return [];
            return (data as any[]).filter((p: any) => p.global_stock <= (p.min_stock || 0));
          });
        })(),
        [],
        'lowStock'
      ), QUERY_TIMEOUT, [], 'lowStock'),

      // Online users (last 30 seconds)
      withTimeout(safeQuery(
        db.from('users')
          .select('id', { count: 'exact', head: true })
          .gte('last_seen_at', thirtySecondsAgo.toISOString())
          .eq('is_active', true)
          .eq('status', 'approved'),
        { count: 0 },
        'onlineUsers'
      ), QUERY_TIMEOUT, { count: 0 }, 'onlineUsers'),

      // Receivables
      withTimeout(safeQuery(
        db.from('receivables')
          .select('remaining_amount')
          .eq('status', 'active')
          .then(({ data }) => (data || []).reduce((sum: number, r: any) => sum + (r.remaining_amount || 0), 0)),
        0,
        'receivables'
      ), QUERY_TIMEOUT, 0, 'receivables'),

      // Top products — OPTIMIZED: first get matching transaction IDs, then fetch only their items
      // This avoids fetching 5000 items and filtering in JS
      withTimeout(safeQuery(
        (() => {
          let txQuery = db.from('transactions')
            .select('id')
            .eq('type', 'sale')
            .in('status', ['approved', 'paid'])
            .gte('transaction_date', filterStart.toISOString())
            .lte('transaction_date', filterEnd.toISOString());
          if (unitId) txQuery = txQuery.eq('unit_id', unitId);

          return txQuery.then(async ({ data: txRows }) => {
            const txIds = (txRows || []).map((r: any) => r.id);
            if (txIds.length === 0) return { data: [] as any[] };

            // Fetch items only for these transactions, limit to last 500 for safety
            // NOTE: transaction_items has no created_at column — sort client-side
            let itemQuery = db.from('transaction_items')
              .select('product_id, product_name, qty, subtotal')
              .in('transaction_id', txIds)
              .limit(500);
            return itemQuery;
          });
        })(),
        { data: [] },
        'topProducts'
      ), QUERY_TIMEOUT, { data: [] }, 'topProducts'),

      // Top sales people
      withTimeout(safeQuery(
        (() => {
          let q = db.from('transactions')
            .select('created_by_id, total')
            .eq('type', 'sale')
            .in('status', ['approved', 'paid'])
            .gte('transaction_date', filterStart.toISOString())
            .lte('transaction_date', filterEnd.toISOString());
          if (unitId) q = q.eq('unit_id', unitId);
          return q;
        })(),
        { data: [] },
        'topSales'
      ), QUERY_TIMEOUT, { data: [] }, 'topSales'),

      // Sales targets
      withTimeout(safeQuery(
        db.from('sales_targets')
          .select('*, user:users!user_id(id, name, role, email)')
          .eq('period', 'monthly')
          .eq('year', currentYear)
          .eq('month', currentMonth)
          .eq('status', 'active'),
        { data: [] },
        'salesTargets'
      ), QUERY_TIMEOUT, { data: [] }, 'salesTargets'),

      // Super admin users
      withTimeout(safeQuery(
        db.from('users')
          .select('id, name')
          .eq('role', 'super_admin')
          .eq('is_active', true)
          .eq('status', 'approved'),
        { data: [] },
        'superAdminUsers'
      ), QUERY_TIMEOUT, { data: [] }, 'superAdminUsers'),
    ]);

    // Synchronous computations from batch 1
    const lowStockProducts = Array.isArray(lowStockRows) ? lowStockRows : [];
    const totalTransactions = summaryData.periodTxCount || 0;

    // Chart data from raw query — already in { date, sales, profit } format
    const chartData: { date: string; sales: number; profit: number }[] = (summaryData.chartData || [])
      .map((row: any) => ({
        date: row.date,
        sales: Number(row.sales) || 0,
        profit: Number(row.profit) || 0,
      }));

    // Compute top products — items already filtered by transaction date/status server-side
    const productMap = new Map<string, { name: string; qty: number; subtotal: number }>();
    for (const row of (topProductsRaw.data || [])) {
      const key = row.product_id;
      if (!productMap.has(key)) {
        productMap.set(key, { name: row.product_name, qty: 0, subtotal: 0 });
      }
      const entry = productMap.get(key)!;
      entry.qty += row.qty || 0;
      entry.subtotal += row.subtotal || 0;
    }
    const topProducts = Array.from(productMap.entries())
      .map(([id, p]) => ({ id, name: p.name, sold: p.qty, revenue: p.subtotal }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Compute top sales from raw data
    const salesByUser = new Map<string, { count: number; total: number }>();
    for (const row of (topSalesRaw.data || [])) {
      if (!salesByUser.has(row.created_by_id)) {
        salesByUser.set(row.created_by_id, { count: 0, total: 0 });
      }
      const entry = salesByUser.get(row.created_by_id)!;
      entry.count += 1;
      entry.total += row.total || 0;
    }
    const topSalesData = Array.from(salesByUser.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5);

    const salesTargets = rowsToCamelCase(salesTargetsData.data || []);
    const superAdminUsers = rowsToCamelCase(superAdminUsersData.data || []);

    // ========== BATCH 2: Queries depending on batch 1 results ==========
    const topSalesUserIds = topSalesData.map(([id]) => id);
    const targetUserIds = salesTargets.map((t: any) => t.userId);
    const superAdminIds = superAdminUsers.map((u: any) => u.id);

    const [
      topSalesUsers,
      achievedByUser,
      superAdminMonthlySales,
    ] = await Promise.all([
      // Get names for the top sales
      withTimeout(safeQuery(
        topSalesUserIds.length > 0
          ? db.from('users').select('id, name, role').in('id', topSalesUserIds)
          : Promise.resolve({ data: [] }),
        { data: [] },
        'topSalesUsers'
      ), QUERY_TIMEOUT, { data: [] }, 'topSalesUsers'),
      // Achieved amounts per target user
      withTimeout(safeQuery(
        targetUserIds.length > 0
          ? (() => {
              let q = db.from('transactions')
                .select('created_by_id, total')
                .eq('type', 'sale')
                .in('status', ['approved', 'paid'])
                .gte('transaction_date', filterStart.toISOString())
                .lte('transaction_date', filterEnd.toISOString())
                .in('created_by_id', targetUserIds);
              if (unitId) q = q.eq('unit_id', unitId);
              return q;
            })()
          : Promise.resolve({ data: [] }),
        { data: [] },
        'achievedByUser'
      ), QUERY_TIMEOUT, { data: [] }, 'achievedByUser'),
      // Super admin sales contribution
      withTimeout(safeQuery(
        superAdminIds.length > 0
          ? (() => {
              let q = db.from('transactions')
                .select('total')
                .eq('type', 'sale')
                .in('status', ['approved', 'paid'])
                .gte('transaction_date', filterStart.toISOString())
                .lte('transaction_date', filterEnd.toISOString())
                .in('created_by_id', superAdminIds);
              if (unitId) q = q.eq('unit_id', unitId);
              return q.then(({ data }) => (data || []).reduce((sum: number, r: any) => sum + (r.total || 0), 0));
            })()
          : Promise.resolve(0),
        0,
        'superAdminMonthlySales'
      ), QUERY_TIMEOUT, 0, 'superAdminMonthlySales'),
    ]);

    // Synchronous computations from batch 2
    const userMap = new Map(
      rowsToCamelCase(topSalesUsers.data || []).map((u: any) => [u.id, { name: u.name, role: u.role }])
    );

    const topSales = topSalesData.map(([id, s]) => {
      const u = userMap.get(id);
      return {
        id,
        name: u?.name || 'Unknown',
        role: u?.role || 'unknown',
        transactions: s.count,
        revenue: s.total
      };
    });

    const achievedMap = new Map(
      rowsToCamelCase(achievedByUser.data || []).reduce((acc: Map<string, number>, r: any) => {
        const key = r.createdById;
        acc.set(key, (acc.get(key) || 0) + (r.total || 0));
        return acc;
      }, new Map() as Map<string, number>)
    );

    const salesTargetsWithProgress = salesTargets.map((target: any) => {
      const achievedAmount = achievedMap.get(target.userId) || 0;
      const remaining = Math.max(0, target.targetAmount - achievedAmount);
      const percent = target.targetAmount > 0
        ? Math.round((achievedAmount / target.targetAmount) * 100)
        : 0;

      return {
        id: target.id,
        userId: target.userId,
        userName: target.user?.name || 'Unknown',
        targetAmount: target.targetAmount,
        achievedAmount,
        remaining,
        percent,
        notes: target.notes
      };
    });

    const superAdminContribution = superAdminMonthlySales;

    const totalTarget = salesTargetsWithProgress.reduce((sum: number, t: any) => sum + t.targetAmount, 0);
    const totalTeamAchieved = salesTargetsWithProgress.reduce((sum: number, t: any) => sum + t.achievedAmount, 0);
    const totalWithAdmin = totalTeamAchieved + superAdminContribution;
    const totalPercent = totalTarget > 0 ? Math.round((totalWithAdmin / totalTarget) * 100) : 0;

    return NextResponse.json({
      dashboard: {
        totalSales: Number(summaryData.totalSales) || 0,
        totalProfit: Number(summaryData.totalProfit) || 0,
        totalTransactions,
        pendingApprovals: pendingApprovalsCount.count || 0,
        lowStockProducts,
        onlineUsers: onlineUsersCount.count || 0,
        todaySales: Number(summaryData.todaySales) || 0,
        todayProfit: Number(summaryData.todayProfit) || 0,
        monthlySales: Number(summaryData.monthlySales) || 0,
        monthlyProfit: Number(summaryData.monthlyProfit) || 0,
        receivables: receivablesData,
        chartData,
        topProducts,
        topSales,
        salesTargets: salesTargetsWithProgress,
        superAdminContribution,
        totalTarget,
        totalTeamAchieved,
        totalWithAdmin,
        totalPercent,
        totalPaid: Number(summaryData.totalPaid) || 0,
        totalHpp: Number(summaryData.totalHpp) || 0,
        totalReceivables: Number(summaryData.totalReceivables) || 0,
        hppInHand: Number(summaryData.hppInHand) || 0,
        hppUnpaid: Number(summaryData.hppUnpaid) || 0,
        profitInHand: Number(summaryData.profitInHand) || 0,
        profitUnpaid: Number(summaryData.profitUnpaid) || 0,
      }
    }, {
      headers: {
        'Cache-Control': 'private, s-maxage=30, stale-while-revalidate=90',
      }
    });
  } catch (error) {
    console.error('Get dashboard error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
