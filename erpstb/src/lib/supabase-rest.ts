// =====================================================================
// SUPABASE REST CLIENT — Stub (migrated to MariaDB/Prisma)
//
// The real Supabase REST client has been replaced by a Prisma-based
// PostgREST-compatible wrapper in supabase.ts.
//
// This module provides empty stubs for backward compatibility with
// files that still import from here (health checks, setup-env, etc.)
// =====================================================================

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
}

/** Get Supabase configuration — returns empty defaults (no longer used) */
export function getSupabaseConfig(): SupabaseConfig {
  return {
    url: '',
    anonKey: '',
    serviceKey: '',
  };
}

/** Backward-compatible exports */
export let SUPABASE_URL = '';
export let SUPABASE_ANON_KEY = '';
export let SUPABASE_SERVICE_KEY = '';

/** Stub Supabase REST client — all operations are no-ops */
export const supabaseRestClient = {
  from: (_tableName: string) => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null, count: null }) }) }),
    insert: () => ({ select: async () => ({ data: null, error: null, count: null }) }),
    update: () => ({ eq: async () => ({ data: null, error: null, count: null }) }),
    delete: () => ({ eq: async () => ({ data: null, error: null, count: null }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
  rpc: async () => ({ data: null, error: null }),
  auth: null,
  storage: null,
  channel: () => null,
  removeChannel: () => {},
  removeAllChannels: () => {},
} as any;
