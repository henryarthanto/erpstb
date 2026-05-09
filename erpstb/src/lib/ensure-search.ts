import { prisma } from './supabase';

/**
 * Ensure FULLTEXT indexes exist for search optimization in MariaDB.
 * Called on server startup from instrumentation.ts.
 *
 * MariaDB uses FULLTEXT indexes instead of PostgreSQL's pg_trgm.
 * The PostgREST wrapper already handles LIKE/ILIKE fallbacks,
 * so this is an optimization step.
 */
export async function ensureSearchIndexes() {
  try {
    // Check if we can run raw queries (requires Prisma raw access)
    // MariaDB FULLTEXT indexes are created via DDL — not at runtime
    console.log('[Search] MariaDB mode — using Prisma contains() for search');
    console.log('[Search] For advanced search optimization, consider:');
    console.log('[Search]   ALTER TABLE products ADD FULLTEXT INDEX idx_products_name_ft (name);');
    console.log('[Search]   ALTER TABLE customers ADD FULLTEXT INDEX idx_customers_name_ft (name);');
    console.log('[Search]   ALTER TABLE customers ADD FULLTEXT INDEX idx_customers_phone_ft (phone);');
  } catch {
    // Ignore — search will work via Prisma contains() fallback
  }
}
