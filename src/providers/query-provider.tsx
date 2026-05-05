'use client';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useState, useEffect } from 'react';

// STB mode: read from window.__STB_MODE__ injected by layout.tsx (or default false)
const isSTB = typeof window !== 'undefined' && (window as any).__STB_MODE__ === true;

// Polling configuration optimized for multi-user concurrent access
// With 10+ users, we must minimize unnecessary DB queries
export const POLLING_CONFIG = {
  // Default: 60s polling as fallback when WebSocket is disconnected.
  // WebSocket realtime sync (useRealtimeSync) handles instant updates.
  // This ensures all modules auto-refresh even without WS connection.
  refetchInterval: isSTB ? 60_000 : 45_000,
  refetchOnWindowFocus: true,
  // STB: 60s stale time to reduce DB load; Standard: 30s
  staleTime: isSTB ? 60_000 : 30_000,
  // Don't refetch when tab is in background (saves DB load)
  refetchIntervalInBackground: false as const,
  // Retry on failure with exponential backoff
  retry: 3,
  retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),
};

// Per-module polling override config
// With WebSocket realtime sync (useRealtimeSync), polling is only a fallback
// for when WebSocket is disconnected. Intervals are generous.
export const MODULE_POLLING: Record<string, number> = {
  // Events/notifications: 30s (fallback when WS disconnected)
  events: 30_000,
  // Dashboard: 300s — realtime sync handles most updates
  dashboard: 300_000,
  // Transactions: 60s
  transactions: 60_000,
  // Products: 60s
  products: 60_000,
  // Payments: 60s
  payments: 60_000,
  // Deliveries: 45s
  deliveries: 45_000,
  // Salaries: 60s
  salaries: 60_000,
  // Sales dashboard: 45s
  'sales-dashboard': 45_000,
  // Sales tasks: 45s
  sales_tasks: 45_000,
  // Stock movements: 60s
  stock_movements: 60_000,
  // Suppliers: 120s
  suppliers: 120_000,
  // Customers: 60s
  customers: 60_000,
  // Cashbacks: 60s
  cashbacks: 60_000,
  // Finance: 45s
  finance: 45_000,
  // Users: 120s
  users: 120_000,
  // Reports: 120s
  reports: 120_000,
  // Courier: 45s
  courier: 45_000,
  // Receivables: 60s
  receivables: 60_000,
  // Cash boxes: 45s
  cash_boxes: 45_000,
  // PWA orders: 30s
  pwa_orders: 30_000,
};

// Stale times for different query keys — used by useSharedData and other hooks
export const QUERY_STALE_TIMES: Record<string, number> = {
  'units': 10 * 60_000,
  'settings': 15 * 60_000,
  'users': 5 * 60_000,
  'products': 2 * 60_000,
  'suppliers': 3 * 60_000,
  'customers': 60_000,
  'transactions': 30_000,
  'finance': 30_000,
  'receivables': 30_000,
  'events': 15_000,
  'dashboard': 0,
  'salaries': 60_000,
  'sales-tasks': 30_000,
  'sales-dashboard': 30_000,
  'courier-dashboard': 30_000,
};

// =====================================================================
// NETWORK RECOVERY HOOK - Refetch all queries when coming back online
// =====================================================================
export function useNetworkRecovery() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      // When network recovers, invalidate all queries to get fresh data
      queryClient.invalidateQueries();
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [queryClient]);
}

// Internal component that activates network recovery + BroadcastChannel multi-tab sync
function NetworkRecoveryHandler() {
  useNetworkRecovery();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel('erp-cache-sync');

    // ── Listener: receive targeted invalidations from other tabs ──
    channel.onmessage = (event) => {
      if (event.data?.type === 'invalidate') {
        const queryKey = event.data.queryKey;
        if (queryKey && queryKey.length > 0) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
    };

    // ── Sender: relay query invalidations to other tabs ──
    // When any tab invalidates a query (e.g. after mutation onSuccess),
    // broadcast it to all other tabs so they also refetch.
    const queryUnsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'invalidated' && event.query?.queryKey) {
        try {
          channel.postMessage({ type: 'invalidate', queryKey: event.query.queryKey });
        } catch { /* channel closed */ }
      }
    });

    return () => {
      channel.close();
      queryUnsubscribe();
    };
  }, [queryClient]);

  return null;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            ...POLLING_CONFIG,
            // Deduplicate identical concurrent requests (common with multi-module pages)
            // When 5 components all query /api/dashboard, only 1 actual fetch happens
            structuralSharing: true,
          },
          mutations: {
            // POST/PUT mutations should NOT retry (risk of duplicate records)
            retry: 0,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <NetworkRecoveryHandler />
      {children}
    </QueryClientProvider>
  );
}
