// =====================================================================
// INSTRUMENTATION — Next.js Server Startup Hook
//
// Initializes:
//   1. Fast Query Pool — mysql2 direct connection pool (3 connections)
//   2. Realtime Sync — Socket.io client → monitor-ws (port 3004)
//
// Both features are enabled on startup and auto-reconnect.
// NOTE: Graceful shutdown handlers require Node.js runtime.
// =====================================================================

export async function register() {
  if (typeof window !== 'undefined') return;

  console.log('[Instrumentation] Server starting (Supabase PostgreSQL/Prisma mode)...');

  // ─── 1. Fast Query Pool ──────────────────────────────────────────
  try {
    const { initFastPool } = await import('@/lib/fast-query');
    const ready = await initFastPool();
    console.log(`[Instrumentation] Fast query pool: ${ready ? 'active ✓' : 'failed ✗'}`);
  } catch (e) {
    console.warn(`[Instrumentation] Fast query pool: failed (${(e as Error).message})`);
  }

  // ─── 2. Realtime Sync ────────────────────────────────────────────
  try {
    const { startRealtimeSync } = await import('@/lib/realtime-sync');
    startRealtimeSync();
    console.log('[Instrumentation] Realtime sync: starting...');
  } catch (e) {
    console.warn(`[Instrumentation] Realtime sync: failed (${(e as Error).message})`);
  }

  // ─── 3. Graceful Shutdown (Node.js only) ─────────────────────────
  try {
    const process = globalThis.process;
    if (process && typeof process.on === 'function') {
      process.on('SIGTERM', async () => {
        console.log('[Instrumentation] SIGTERM — shutting down...');
        try { const { closeFastPool } = await import('@/lib/fast-query'); await closeFastPool(); } catch {}
        try { const { stopRealtimeSync } = await import('@/lib/realtime-sync'); stopRealtimeSync(); } catch {}
      });
      process.on('SIGINT', async () => {
        console.log('[Instrumentation] SIGINT — shutting down...');
        try { const { closeFastPool } = await import('@/lib/fast-query'); await closeFastPool(); } catch {}
        try { const { stopRealtimeSync } = await import('@/lib/realtime-sync'); stopRealtimeSync(); } catch {}
      });
    }
  } catch {}
}
