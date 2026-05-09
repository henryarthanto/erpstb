// =====================================================================
// FAST QUERY LAYER — Disabled (Supabase PostgreSQL mode)
//
// Previously used mysql2 direct pool for MariaDB performance.
// In Supabase PostgreSQL mode, all queries go through Prisma.
// This module is kept for backward compatibility but pool init
// will gracefully fail (DATABASE_URL is now a postgresql:// URL).
//
// Connection: DISABLED — use Prisma Client instead
// =====================================================================

import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;
let poolReady = false;

// ─────────────────────────────────────────────────────────────────────
// POOL MANAGEMENT
// ─────────────────────────────────────────────────────────────────────

/** Parse mysql://user:pass@host:port/db from DATABASE_URL */
function parseMysqlUrl(url: string) {
  const cleaned = url.replace(/^mysql:\/\//, '');
  const atIndex = cleaned.lastIndexOf('@');
  const slashIndex = cleaned.indexOf('/', atIndex);
  const credentials = cleaned.substring(0, atIndex);
  const colonIndex = credentials.indexOf(':');
  const user = decodeURIComponent(credentials.substring(0, colonIndex));
  const password = decodeURIComponent(credentials.substring(colonIndex + 1));
  const hostPort = cleaned.substring(atIndex + 1, slashIndex);
  const database = cleaned.substring(slashIndex + 1).split('?')[0];
  const lastColon = hostPort.lastIndexOf(':');
  const host = hostPort.substring(0, lastColon);
  const port = parseInt(hostPort.substring(lastColon + 1), 10);
  return { user, password, host, port, database };
}

/** Initialize the fast query pool */
export async function initFastPool(): Promise<boolean> {
  if (poolReady && pool) return true;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[FastQuery] DATABASE_URL not set — pool disabled');
    return false;
  }

  try {
    const cfg = parseMysqlUrl(url);
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 3,
      enableKeepAlive: true,
      idleTimeout: 60_000,
    });

    // Verify connection
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();

    poolReady = true;
    console.log(`[FastQuery] Pool ready (${cfg.host}:${cfg.port}/${cfg.database}, 3 connections)`);
    return true;
  } catch (e) {
    console.error('[FastQuery] Failed to initialize pool:', (e as Error).message);
    pool = null;
    poolReady = false;
    return false;
  }
}

/** Check if fast pool is ready */
export async function isFastPoolReady(): Promise<boolean> {
  return poolReady && pool !== null;
}

/** Close the fast query pool */
export async function closeFastPool(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
    } catch {
      // ignore
    }
    pool = null;
    poolReady = false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// QUERY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────

/** Execute a raw SQL query and return all rows */
export async function fastQuery<T = Record<string, any>>(
  text: string,
  params: unknown[] = [],
  retries: number = 1
): Promise<T[]> {
  if (!pool) {
    await initFastPool();
  }
  if (!pool) return [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const [rows] = await pool.execute(text, params);
      return rows as T[];
    } catch (e) {
      if (attempt < retries) {
        console.warn(`[FastQuery] Retry ${attempt + 1}/${retries}:`, (e as Error).message);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      } else {
        console.error('[FastQuery] Query failed:', text.substring(0, 100), (e as Error).message);
        // Reset pool on connection error
        if ((e as any).code === 'PROTOCOL_CONNECTION_LOST' || (e as any).code === 'ECONNRESET') {
          poolReady = false;
          pool = null;
        }
        return [];
      }
    }
  }
  return [];
}

/** Execute a raw SQL query and return the first row */
export async function fastQueryOne<T = Record<string, any>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await fastQuery<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Execute a raw SQL query and return only the first column of each row */
export async function fastQueryColumn<T = string | number>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const rows = await fastQuery<Array<{ [key: string]: T }>>(text, params);
  const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
  return rows.map(r => keys.length > 0 ? r[keys[0]] : null).filter(Boolean) as T[];
}

// ─────────────────────────────────────────────────────────────────────
// HIGH-PERFORMANCE BUSINESS QUERIES
// ─────────────────────────────────────────────────────────────────────

/** Get products with unit prices (for sales, reports, PWA) */
export async function fastGetProductsWithUnits(): Promise<{
  products: any[];
  unitProducts: any[];
}> {
  const products = await fastQuery(
    `SELECT id, name, sku, category, brand, unit, buy_price, sell_price, 
            stock, min_stock, weight, is_active, created_at, updated_at
     FROM products WHERE is_active = 1 ORDER BY name ASC`
  );
  const unitProducts = await fastQuery(
    `SELECT id, product_id, unit_id, price, stock, is_active 
     FROM unit_products WHERE is_active = 1`
  );
  return { products, unitProducts };
}

/** Get products for asset value calculation */
export async function fastGetProductsForAssetValue(): Promise<any[]> {
  return fastQuery(
    `SELECT id, name, sku, buy_price, sell_price, stock 
     FROM products WHERE is_active = 1 AND stock > 0 ORDER BY name ASC`
  );
}

/** Get stock movements with pagination */
export async function fastGetStockMovements(params: {
  productId?: string;
  unitId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}): Promise<{ movements: any[]; total: number }> {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (params.productId) {
    conditions.push('product_id = ?');
    queryParams.push(params.productId);
  }
  if (params.unitId) {
    conditions.push('unit_id = ?');
    queryParams.push(params.unitId);
  }
  if (params.startDate) {
    conditions.push('created_at >= ?');
    queryParams.push(params.startDate);
  }
  if (params.endDate) {
    conditions.push('created_at <= ?');
    queryParams.push(params.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await fastQueryOne<{ total: number }>(
    `SELECT COUNT(*) as total FROM stock_movements ${where}`,
    queryParams
  );
  const total = countResult?.total || 0;

  const page = params.page || 1;
  const limit = params.limit || 20;
  const offset = (page - 1) * limit;

  const movements = await fastQuery(
    `SELECT sm.*, p.name as product_name, u.name as unit_name
     FROM stock_movements sm
     LEFT JOIN products p ON sm.product_id = p.id
     LEFT JOIN units u ON sm.unit_id = u.id
     ${where}
     ORDER BY sm.created_at DESC
     LIMIT ? OFFSET ?`,
    [...queryParams, limit, offset]
  );

  return { movements, total };
}

/** Get PWA products for a specific customer/unit */
export async function fastGetPwaProducts(
  customerId: string,
  unitId: string
): Promise<{
  products: any[];
  unitProducts: any[];
  dealPrices: Map<string, number>;
  purchaseHistory: Map<string, number>;
}> {
  const [products, unitProducts, dealPrices, purchaseHistory] = await Promise.all([
    fastQuery(
      `SELECT id, name, sku, category, brand, unit, sell_price, stock, is_active,
              image_url, weight
       FROM products WHERE is_active = 1 ORDER BY name ASC`
    ),
    fastQuery(
      `SELECT up.id, up.product_id, up.unit_id, up.price, up.stock, up.is_active,
              u.name as unit_name, u.short_name
       FROM unit_products up
       LEFT JOIN units u ON up.unit_id = u.id
       WHERE up.is_active = 1 AND up.unit_id = ? AND up.stock > 0
       ORDER BY u.name ASC`,
      [unitId]
    ),
    fastQuery(
      `SELECT product_id, price FROM customer_prices 
       WHERE customer_id = ? AND unit_id = ? AND is_active = 1`,
      [customerId, unitId]
    ),
    fastQuery(
      `SELECT ti.product_id, SUM(ti.quantity) as total_qty
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE t.customer_id = ? AND t.unit_id = ? AND t.status = 'approved'
       GROUP BY ti.product_id`,
      [customerId, unitId]
    ),
  ]);

  const dealPriceMap = new Map<string, number>();
  for (const dp of dealPrices) {
    dealPriceMap.set(dp.product_id, dp.price);
  }

  const purchaseMap = new Map<string, number>();
  for (const ph of purchaseHistory) {
    purchaseMap.set(ph.product_id, ph.total_qty);
  }

  return {
    products,
    unitProducts,
    dealPrices: dealPriceMap,
    purchaseHistory: purchaseMap,
  };
}

/** Get a quick count of rows in a table */
export async function fastCount(table: string, whereClause?: string, params?: unknown[]): Promise<number> {
  const sql = `SELECT COUNT(*) as cnt FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ''}`;
  const row = await fastQueryOne<{ cnt: number }>(sql, params || []);
  return row?.cnt || 0;
}

/** Get MariaDB status variable */
export async function fastGetStatus(varName: string): Promise<string | null> {
  const row = await fastQueryOne<{ Variable_value: string }>(
    'SHOW GLOBAL STATUS WHERE Variable_name = ?',
    [varName]
  );
  return row?.Variable_value ?? null;
}

/** Get MariaDB system variable */
export async function fastGetVariable(varName: string): Promise<string | null> {
  const row = await fastQueryOne<{ Value: string }>(
    'SHOW GLOBAL VARIABLES WHERE Variable_name = ?',
    [varName]
  );
  return row?.Value ?? null;
}
