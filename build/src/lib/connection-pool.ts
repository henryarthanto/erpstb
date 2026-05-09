// =====================================================================
// CONNECTION POOL — Stub
//
// Prisma's built-in connection pool handles all database operations.
// This module provides stubs for backward compatibility.
// =====================================================================

/** Pool query — stub, always throws */
export async function poolQuery<T = any>(_text: string, _params?: unknown[]): Promise<T[]> {
  console.warn('[ConnectionPool:stub] poolQuery called — direct SQL queries not available in PostgreSQL mode');
  return [];
}

/** Pool query with retry — stub */
export async function poolQueryWithRetry<T = any>(_text: string, _params?: unknown[], _retries?: number): Promise<T[]> {
  console.warn('[ConnectionPool:stub] poolQueryWithRetry called — direct SQL queries not available in PostgreSQL mode');
  return [];
}

/** Get transaction pool URL — empty */
export function getTransactionPoolUrl(): string {
  return '';
}

/** Get session pool URL — empty */
export function getSessionPoolUrl(): string {
  return '';
}

/** Check if transaction pool is available — false */
export function hasTransactionPool(): boolean {
  return false;
}

/** Check if session pool is available — false */
export function hasSessionPool(): boolean {
  return false;
}

/** Get transaction pool — throws */
export async function getTransactionPool(): Promise<any> {
  throw new Error('Transaction pool not available in PostgreSQL mode');
}

/** Get session pool — throws */
export async function getSessionPool(): Promise<any> {
  throw new Error('Session pool not available in PostgreSQL mode');
}

/** Reconnect pool — no-op */
export function reconnectPool(_poolName: 'transaction' | 'session'): void {
  // no-op
}

/** Ensure pools are healthy — no-op */
export async function ensureHealthy(): Promise<{ transaction: boolean; session: boolean }> {
  return { transaction: false, session: false };
}

/** Reset pools — no-op */
export async function resetPools(): Promise<void> {
  // no-op
}

/** Session query — stub */
export async function sessionQuery<T = any>(_text: string, _params?: unknown[]): Promise<T[]> {
  return [];
}

/** Session transaction — stub */
export async function sessionTransaction(_statements: { text: string; params?: unknown[] }[]): Promise<{ results: any[][]; errors: string[] }> {
  return { results: [], errors: ['Not available in PostgreSQL mode'] };
}

/** Get pool stats — empty */
export async function getPoolStats(): Promise<{ transaction: any; session: any }> {
  return {
    transaction: { name: 'Transaction', url: '[unavailable]', mode: 'transaction', totalConnections: 0, idleConnections: 0, waitingRequests: 0, activeConnections: 0, isHealthy: false },
    session: { name: 'Session', url: '[unavailable]', mode: 'session', totalConnections: 0, idleConnections: 0, waitingRequests: 0, activeConnections: 0, isHealthy: false },
  };
}

/** Close all pools — no-op */
export async function closeAllPools(): Promise<void> {
  // no-op
}

/** Pool config — empty */
export const poolConfig = {};
export const POOL_HEALTH_CHECK_INTERVAL = 30_000;
