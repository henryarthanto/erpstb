// =====================================================================
// ENSURE RPC FUNCTIONS — Disabled (PostgreSQL functions removed)
//
// All PostgreSQL RPC functions (stored procedures) have been removed
// during the PostgreSQL migration. Atomic operations that previously
// used PostgreSQL RPCs will be reimplemented using Prisma transactions.
//
// This module provides an empty RPC_DEFINITIONS array for backward
// compatibility with setup-rpc route.
// =====================================================================

/** Empty RPC definitions — all PostgreSQL functions removed */
export const RPC_DEFINITIONS: { name: string; sql: string }[] = [];

/**
 * Deploy RPC functions — no-op in PostgreSQL mode.
 * Previously deployed PostgreSQL stored procedures.
 */
export async function deployRpcFunctions(): Promise<{ deployed: number; errors: string[] }> {
  console.log('[EnsureRPC] No PostgreSQL RPC functions to deploy — PostgreSQL mode');
  return { deployed: 0, errors: [] };
}
