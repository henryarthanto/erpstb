// =====================================================================
// API TIMEOUT — Request timeout wrapper for DB queries and API calls
//
// Prevents slow queries from blocking connections indefinitely.
// Usage: const result = await withTimeout(db.query(...), 12000, 'Query timeout')
// =====================================================================

/**
 * Wrap a promise with a timeout. If the promise doesn't resolve within
 * the specified time, rejects with a timeout error.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 15_000,
  errorMessage = 'Request timeout'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

/**
 * Create a timeout-aware version of an async function.
 */
export function withTimeoutFn<TArgs extends any[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  timeoutMs: number = 15_000,
  errorMessage?: string
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs) => {
    return withTimeout(fn(...args), timeoutMs, errorMessage);
  };
}
