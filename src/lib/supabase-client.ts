// =====================================================================
// SUPABASE CLIENT — Real browser-side Supabase client for Realtime
//
// Uses @supabase/supabase-js to connect to Supabase cloud.
// Provides:
//   - Realtime subscriptions (postgres_changes) for instant data sync
//   - Auth helpers (getSession, getUser, signOut, onAuthStateChange)
//   - Storage helpers (upload, getPublicUrl, remove)
//   - Database query helpers (from, rpc)
//
// This replaces the previous stub that disabled all features.
// =====================================================================

'use client';

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

// Lazy import to avoid importing stb-config on client bundle
let _IS_STB = false;
try { _IS_STB = process.env.NEXT_PUBLIC_STB_MODE === 'true'; } catch {}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ─────────────────────────────────────────────────────────────────────
// SINGLETON CLIENT
// ─────────────────────────────────────────────────────────────────────

let _client: SupabaseClient | null = null;
let _initialized = false;

/**
 * Get or create the Supabase client singleton.
 * Safe to call multiple times — always returns the same instance.
 */
export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[SupabaseClient] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY not configured');
  }

  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: _IS_STB ? 3 : 10,
      },
    },
    db: {
      schema: 'public',
    },
    global: {
      fetch: (url: string, options: RequestInit = {}) => {
        // Add timeout to every Supabase client request
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        return fetch(url, { ...options, signal: controller.signal })
          .finally(() => clearTimeout(timeout));
      },
    },
  });

  if (!_initialized) {
    _initialized = true;
    console.log('[SupabaseClient] Initialized ✓', SUPABASE_URL ? `(project: ${new URL(SUPABASE_URL).hostname})` : '(no URL)');
  }

  return _client;
}

// ─────────────────────────────────────────────────────────────────────
// CONVENIENCE EXPORTS
// ─────────────────────────────────────────────────────────────────────

/** The Supabase client — lazy-initialized singleton */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const value = (client as any)[prop];
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  },
});

// ─────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────

/** Check if Supabase is properly configured */
export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** Get the Supabase project URL */
export function getSupabaseUrl(): string {
  return SUPABASE_URL;
}

/** Get the Supabase anon key */
export function getSupabaseAnonKey(): string {
  return SUPABASE_ANON_KEY;
}

// Re-export types
export type { SupabaseClient, RealtimeChannel };
