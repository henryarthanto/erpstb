import { IS_STB, QUERY_CACHE } from './stb-config';

// ─────────────────────────────────────────────────────────────────────
// IN-MEMORY LRU CACHE (Primary cache for Supabase/PostgreSQL setup)
// Redis is optional — only used if REDIS_URL is configured
// ─────────────────────────────────────────────────────────────────────

interface MemCacheEntry {
  value: string;
  expiry: number;
  lastAccess: number;
  sizeBytes: number;
}

const memCache = new Map<string, MemCacheEntry>();

/** Approximate total bytes used by in-memory cache */
let memCacheBytes = 0;

/** Max bytes allowed for in-memory cache */
const MEM_CACHE_MAX_BYTES = QUERY_CACHE.maxMemoryMB * 1024 * 1024;

/**
 * Evict expired entries + LRU eviction if over budget.
 * Called before every set operation.
 */
function memCacheEvict(): void {
  const now = Date.now();

  // 1. Remove expired entries
  for (const [key, entry] of memCache) {
    if (now > entry.expiry) {
      memCache.delete(key);
      memCacheBytes -= entry.sizeBytes;
    }
  }

  // 2. LRU eviction if over max entries
  while (memCache.size > QUERY_CACHE.maxEntries) {
    let oldestKey = '';
    let oldestAccess = Infinity;
    for (const [key, entry] of memCache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = memCache.get(oldestKey)!;
      memCache.delete(oldestKey);
      memCacheBytes -= entry.sizeBytes;
    }
  }

  // 3. Evict by memory budget if over limit
  while (memCacheBytes > MEM_CACHE_MAX_BYTES && memCache.size > 0) {
    let oldestKey = '';
    let oldestAccess = Infinity;
    for (const [key, entry] of memCache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = memCache.get(oldestKey)!;
      memCache.delete(oldestKey);
      memCacheBytes -= entry.sizeBytes;
    }
  }
}

// Cleanup expired entries periodically (more frequent on STB)
const _memCacheTimer = setInterval(() => {
  memCacheEvict();
}, IS_STB ? 30_000 : 60_000);
if (_memCacheTimer.unref) _memCacheTimer.unref();

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

export interface CacheOptions {
  ttlMs?: number; // Time to live in ms (default: 60s standard, 120s STB)
}

/** Get default TTL based on STB mode */
export function getDefaultTtl(): number {
  return QUERY_CACHE.defaultTtlMs; // 30s STB / 60s standard
}

/**
 * Get a value from in-memory cache
 */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const entry = memCache.get(key);
  if (entry && Date.now() < entry.expiry) {
    entry.lastAccess = Date.now();
    return JSON.parse(entry.value) as T;
  }
  if (entry) {
    memCache.delete(key);
    memCacheBytes -= entry.sizeBytes;
  }
  return null;
}

/**
 * Set a value in in-memory cache
 */
export async function cacheSet(key: string, value: unknown, options?: CacheOptions): Promise<void> {
  const ttlMs = options?.ttlMs ?? getDefaultTtl();
  const raw = JSON.stringify(value);
  const sizeBytes = Buffer.byteLength(raw, 'utf-8');

  // Remove existing entry if present (to update size tracking)
  const existing = memCache.get(key);
  if (existing) {
    memCacheBytes -= existing.sizeBytes;
    memCache.delete(key);
  }

  memCacheEvict();

  memCache.set(key, {
    value: raw,
    expiry: Date.now() + ttlMs,
    lastAccess: Date.now(),
    sizeBytes,
  });
  memCacheBytes += sizeBytes;
}

/**
 * Delete a cache key
 */
export async function cacheDel(key: string | string[]): Promise<void> {
  const keys = Array.isArray(key) ? key : [key];

  for (const k of keys) {
    const entry = memCache.get(k);
    if (entry) {
      memCacheBytes -= entry.sizeBytes;
      memCache.delete(k);
    }
  }
}

/**
 * Get multiple values by pattern (in-memory prefix match)
 */
export async function cacheGetByPattern(pattern: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const [k, entry] of memCache) {
    if (Date.now() < entry.expiry) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(k)) result[k] = JSON.parse(entry.value);
    }
  }

  return result;
}

/**
 * Check cache health status
 */
export function getCacheStatus(): {
  memEntries: number;
  memBytes: number;
  memBytesMB: number;
  maxEntries: number;
  maxMemoryMB: number;
} {
  return {
    memEntries: memCache.size,
    memBytes: memCacheBytes,
    memBytesMB: Math.round((memCacheBytes / 1024 / 1024) * 100) / 100,
    maxEntries: QUERY_CACHE.maxEntries,
    maxMemoryMB: QUERY_CACHE.maxMemoryMB,
  };
}

/**
 * Invalidate cache by prefix pattern
 */
export async function cacheInvalidatePrefix(prefix: string): Promise<number> {
  let count = 0;

  for (const k of memCache.keys()) {
    if (k.startsWith(prefix)) {
      const entry = memCache.get(k);
      if (entry) memCacheBytes -= entry.sizeBytes;
      memCache.delete(k);
      count++;
    }
  }

  return count;
}

// ─────────────────────────────────────────────────────────────────────
// PRODUCT CACHE INVALIDATION — Bulk invalidate all product-related keys
// ─────────────────────────────────────────────────────────────────────

/**
 * Invalidate ALL product-related caches.
 * Call this on any product create/update/delete/stock change.
 *
 * Invalidates:
 *   - api:products:*          (product list)
 *   - api:product:{id}:*      (single product detail)
 *   - api:asset-value:*       (asset valuation)
 *   - api:stock-movements:*   (stock movement history)
 *   - api:pwa:products:*      (PWA public product list)
 */
export async function invalidateAllProductCaches(): Promise<void> {
  const prefixes = [
    'api:products:',
    'api:product:',
    'api:asset-value:',
    'api:stock-movements:',
    'api:pwa:products:',
  ];

  for (const prefix of prefixes) {
    try { await cacheInvalidatePrefix(prefix); } catch { /* non-fatal */ }
  }
}
