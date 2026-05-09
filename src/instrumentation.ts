// =====================================================================
// INSTRUMENTATION — Next.js Server Startup Hook
//
// Minimal instrumentation — avoids ALL Node.js APIs to prevent
// Turbopack Edge Runtime analysis failures.
// =====================================================================

export async function register() {
  if (typeof window !== 'undefined') return;
  console.log('[Instrumentation] Server starting...');

  // Realtime Sync (no Node.js APIs used)
  try {
    const { startRealtimeSync } = await import('./lib/realtime-sync');
    startRealtimeSync();
    console.log('[Instrumentation] Realtime sync: starting...');
  } catch (e) {
    console.warn(`[Instrumentation] Realtime sync: failed (${(e as Error).message})`);
  }
}
