// =====================================================================
// INSTRUMENTATION — Next.js Server Startup Hook
//
// Initializes:
//   1. Realtime Sync — Socket.io client → monitor-ws (port 3004)
//
// Auto-reconnect enabled. Graceful shutdown handlers for Node.js runtime.
// =====================================================================

export async function register() {
  if (typeof window !== 'undefined') return;

  console.log('[Instrumentation] Server starting (Supabase PostgreSQL/Prisma mode)...');

  // ─── 1. Realtime Sync ────────────────────────────────────────────
  try {
    const { startRealtimeSync } = await import('@/lib/realtime-sync');
    startRealtimeSync();
    console.log('[Instrumentation] Realtime sync: starting...');
  } catch (e) {
    console.warn(`[Instrumentation] Realtime sync: failed (${(e as Error).message})`);
  }

  // ─── 2. Graceful Shutdown (Node.js only) ─────────────────────────
  try {
    const process = globalThis.process;
    if (process && typeof process.on === 'function') {
      process.on('SIGTERM', async () => {
        console.log('[Instrumentation] SIGTERM — shutting down...');
        try { const { stopRealtimeSync } = await import('@/lib/realtime-sync'); stopRealtimeSync(); } catch {}
      });
      process.on('SIGINT', async () => {
        console.log('[Instrumentation] SIGINT — shutting down...');
        try { const { stopRealtimeSync } = await import('@/lib/realtime-sync'); stopRealtimeSync(); } catch {}
      });
    }
  } catch {}
}
