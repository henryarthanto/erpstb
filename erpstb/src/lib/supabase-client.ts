// =====================================================================
// SUPABASE CLIENT - Client-side stub (migrated to MariaDB/Prisma)
//
// Client-side Supabase features (realtime, auth, storage) are no longer
// available after MariaDB migration. This stub prevents import errors.
// =====================================================================

'use client';

/** Stub client — all features disabled after MariaDB migration */
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
  storage: {
    from: () => ({
      upload: async () => ({ data: null, error: { message: 'Storage not available (MariaDB migration)' } }),
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
      remove: async () => ({ data: null, error: null }),
    }),
  },
  from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
    insert: () => ({ select: async () => ({ data: null, error: null }) }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
    delete: () => ({ eq: async () => ({ data: null, error: null }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
  channel: () => ({ on: () => ({ subscribe: () => {} }), unsubscribe: () => {} }),
  removeChannel: () => {},
  removeAllChannels: () => {},
} as any;
