import Redis from 'ioredis';
import { IS_STB, QUERY_CACHE } from './stb-config';

const REDIS_URL = process.env.REDIS_URL || '';

let redis: Redis | null = null;
let redisAvailable = false;

// ─────────────────────────────────────────────────────────────────────
// IN-MEMORY FALLBACK CACHE — LRU with max entries & memory budget
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
    // Find oldest accessed entry
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
// REDIS INITIALIZATION
// ─────────────────────────────────────────────────────────────────────

async function initRedis() {
  if (!REDIS_URL) return;
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      ...({
        retryDelayOnFailover: 100,
        retryDelayOnClusterDown: 300,
      } as any),
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5000,
      // STB: lower memory, force IPv4
      ...(IS_STB ? { family: 4 } : {}),
    });

    redis.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
      redisAvailable = false;
    });

    redis.on('ready', () => {
      console.log('[Redis] Connected');
      redisAvailable = true;
    });

    redis.on('close', () => {
      redisAvailable = false;
    });

    await redis.connect();
  } catch (err) {
    console.warn('[Redis] Unavailable, using in-memory cache fallback');
    redis = null;
    redisAvailable = false;
  }
}

// Initialize on import (non-blocking)
initRedis().catch(() => {});

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
 * Get a value from cache (Redis or in-memory fallback)
 */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  try {
    if (redisAvailable && redis) {
      const raw = await redis.get(key);
      if (raw) {
        return JSON.parse(raw) as T;
      }
      return null;
    }
  } catch {
    redisAvailable = false;
  }

  // In-memory fallback
  const entry = memCache.get(key);
  if (entry && Date.now() < entry.expiry) {
    // Update last access for LRU
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
 * Set a value in cache (Redis or in-memory fallback)
 */
export async function cacheSet(key: string, value: unknown, options?: CacheOptions): Promise<void> {
  const ttlMs = options?.ttlMs ?? getDefaultTtl();
  const raw = JSON.stringify(value);

  try {
    if (redisAvailable && redis) {
      await redis.setex(key, Math.ceil(ttlMs / 1000), raw);
      return;
    }
  } catch {
    redisAvailable = false;
  }

  // In-memory fallback with LRU eviction
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

  try {
    if (redisAvailable && redis) {
      await redis.del(...keys);
    }
  } catch {
    redisAvailable = false;
  }

  for (const k of keys) {
    const entry = memCache.get(k);
    if (entry) {
      memCacheBytes -= entry.sizeBytes;
      memCache.delete(k);
    }
  }
}

/**
 * Get multiple values by pattern (Redis SCAN or in-memory filter)
 */
export async function cacheGetByPattern(pattern: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  try {
    if (redisAvailable && redis) {
      const stream = redis.scanStream({ match: pattern, count: 100 });
      const keys: string[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (foundKeys: string[]) => keys.push(...foundKeys));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        for (let i = 0; i < keys.length; i++) {
          if (values[i]) result[keys[i]] = JSON.parse(values[i]!);
        }
      }
      return result;
    }
  } catch {
    redisAvailable = false;
  }

  // In-memory fallback — simple prefix match
  for (const [k, entry] of memCache) {
    if (Date.now() < entry.expiry) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(k)) result[k] = JSON.parse(entry.value);
    }
  }

  return result;
}

/**
 * Check Redis health status
 */
export function getCacheStatus(): {
  redis: boolean;
  memEntries: number;
  memBytes: number;
  memBytesMB: number;
  maxEntries: number;
  maxMemoryMB: number;
} {
  return {
    redis: redisAvailable,
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

  try {
    if (redisAvailable && redis) {
      const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
      const keys: string[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (foundKeys: string[]) => keys.push(...foundKeys));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      if (keys.length > 0) {
        count = keys.length;
        await redis.del(...keys);
      }
    }
  } catch {
    redisAvailable = false;
  }

  // In-memory fallback
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
