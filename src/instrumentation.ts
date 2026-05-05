// =====================================================================
// INSTRUMENTATION — Next.js Server Startup Hook
//
// Initializes:
//   1. Fast Query Pool — mysql2 direct connection pool (3 connections)
//   2. Realtime Sync — Socket.io client → monitor-ws (port 3004)
//
// Both features are enabled on startup and auto-reconnect.
// NOTE: These features require Node.js runtime. In Edge Runtime,
// they are gracefully skipped.
// =====================================================================

export async function register() {
  if (typeof window !== 'undefined') return;

  console.log('[Instrumentation] Server starting...');

  // ─── 1. Fast Query Pool ──────────────────────────────────────────
  try {
    const { initFastPool } = await import('@/lib/fast-query');
    const ready = await initFastPool();
    console.log(`[Instrumentation] Fast query pool: ${ready ? 'active ✓' : 'failed ✗'}`);
  } catch (e) {
    console.warn(`[Instrumentation] Fast query pool: skipped (${(e as Error).message})`);
  }

  // ─── 2. Realtime Sync ────────────────────────────────────────────
  try {
    const { startRealtimeSync } = await import('@/lib/realtime-sync');
    startRealtimeSync();
    console.log('[Instrumentation] Realtime sync: starting...');
  } catch (e) {
    console.warn(`[Instrumentation] Realtime sync: skipped (${(e as Error).message})`);
  }
}
