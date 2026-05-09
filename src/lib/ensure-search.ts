import { prisma } from './supabase';

/**
 * Ensure FULLTEXT indexes exist for search optimization in PostgreSQL.
 * Called on server startup from instrumentation.ts.
 *
 * PostgreSQL uses GIN indexes with pg_trgm for full-text search optimization.
 * The PostgREST wrapper already handles LIKE/ILIKE fallbacks,
 * so this is an optimization step.
 */
export async function ensureSearchIndexes() {
  try {
    // Check if we can run raw queries (requires Prisma raw access)
    // PostgreSQL GIN/pg_trgm indexes are created via DDL — not at runtime
    console.log('[Search] PostgreSQL mode — using Prisma contains() for search');
    console.log('[Search] For advanced search optimization, consider:');
    console.log('[Search]   CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);');
    console.log('[Search]   CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);');
    console.log('[Search]   CREATE INDEX idx_customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);');
  } catch {
    // Ignore — search will work via Prisma contains() fallback
  }
}
