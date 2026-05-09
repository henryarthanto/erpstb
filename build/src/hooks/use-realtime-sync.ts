'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth-store';
import { useWebSocket } from '@/hooks/use-websocket';
import { WEBSOCKET } from '@/lib/stb-config';

// =====================================================================
// REALTIME SYNC HOOK — Bridges change events → TanStack Query cache
//
// TWO realtime sources (automatic fallback):
//   1. Supabase Realtime (primary) — Direct browser ↔ Supabase WebSocket
//      using postgres_changes. No custom relay needed. Scales better.
//   2. Socket.io relay (fallback) — Via monitor-ws service (port 3004).
//      Used when Supabase Realtime is unavailable or not configured.
//
// When data changes, all connected clients automatically refresh
// their relevant TanStack Query cache keys.
// =====================================================================

// ─── TABLE → QUERY KEYS MAPPING ────────────────────────────────────────
// Maps database table names to TanStack Query cache keys to invalidate.

const TABLE_TO_QUERY_KEYS: Record<string, string[][]> = {
  transactions: [
    ['transactions'],
    ['dashboard'],
    ['receivables'],
    ['finance-requests'],
    ['pwa-pending-orders'],
    ['pwa-approved-unpaid-orders'],
    ['sales-dashboard'],
    ['courier-dashboard'],
    ['deliveries'],
  ],
  transaction_items: [
    ['products', 'stock-movements'],
    ['dashboard'],
  ],
  payments: [
    ['transactions'],
    ['dashboard'],
    ['receivables'],
    ['pwa-approved-unpaid-orders'],
    ['sales-dashboard'],
  ],
  payment_proofs: [
    ['transactions'],
    ['events'],
    ['receivables'],
  ],
  products: [
    ['products'],
    ['dashboard'],
    ['asset-value'],
    ['stock-movements'],
  ],
  unit_products: [
    ['products'],
    ['asset-value'],
  ],
  customers: [
    ['customers'],
  ],
  users: [
    ['users'],
  ],
  logs: [
    ['events'],
  ],
  events: [
    ['events'],
  ],
  sales_tasks: [
    ['sales-tasks'],
  ],
  sales_task_reports: [
    ['sales-tasks'],
  ],
  finance_requests: [
    ['finance-requests'],
    ['dashboard'],
    ['finance-pools'],
  ],
  expenses: [
    ['finance-requests'],
    ['dashboard'],
  ],
  fund_transfers: [
    ['finance-pools'],
    ['dashboard'],
  ],
  company_debts: [
    ['finance-pools'],
    ['company-debts'],
  ],
  company_debt_payments: [
    ['finance-pools'],
  ],
  receivables: [
    ['receivables'],
    ['dashboard'],
  ],
  receivable_follow_ups: [
    ['receivables'],
  ],
  courier_cash: [
    ['courier-dashboard'],
    ['dashboard'],
  ],
  courier_handovers: [
    ['courier-dashboard'],
    ['transactions'],
  ],
  salary_payments: [
    ['salaries'],
  ],
  bank_accounts: [
    ['finance-pools'],
  ],
  cash_boxes: [
    ['finance-pools'],
  ],
  finance_ledger: [
    ['finance-pools'],
    ['dashboard'],
  ],
  cashback_config: [
    ['cashbacks'], ['customers'],
  ],
  customer_follow_ups: [
    ['customers'],
  ],
  custom_roles: [
    ['users'], ['custom-roles'],
  ],
  customer_prices: [
    ['customers'], ['products'],
  ],
  customer_referral: [
    ['customers'], ['cashbacks'],
  ],
  suppliers: [
    ['suppliers'], ['dashboard'],
  ],
  cashback_log: [
    ['cashbacks'], ['dashboard'], ['customers'],
  ],
  user_units: [
    ['users'],
  ],
  units: [
    ['units'], ['products'],
  ],
  sales_targets: [
    ['sales-dashboard'],
  ],
  cashback_withdrawal: [
    ['dashboard'], ['cashbacks'],
  ],
  settings: [], // Don't invalidate anything for settings changes
};

// ─── LEGACY EVENT → QUERY KEYS (socket.io fallback) ─────────────────────

const EVENT_TO_QUERY_KEYS: Record<string, string[][]> = {
  'erp:transaction_update': [
    ['transactions'], ['dashboard'], ['receivables'], ['finance-requests'],
    ['pwa-pending-orders'], ['pwa-approved-unpaid-orders'], ['products', 'stock-movements'],
    ['sales-dashboard'], ['courier-dashboard'],
  ],
  'erp:payment_update': [
    ['transactions'], ['dashboard'], ['receivables'], ['finance-pools'],
    ['pwa-approved-unpaid-orders'], ['sales-dashboard'],
  ],
  'erp:stock_update': [
    ['products'], ['dashboard'], ['asset-value'], ['stock-movements'],
  ],
  'erp:user_update': [['users']],
  'erp:task_update': [['sales-tasks']],
  'erp:finance_update': [['finance-requests'], ['dashboard'], ['finance-pools']],
  'erp:delivery_update': [
    ['transactions'], ['dashboard'], ['receivables'], ['finance-pools'], ['courier-dashboard'],
  ],
  'erp:courier_assignment': [['courier-dashboard'], ['transactions'], ['deliveries']],
  'erp:salary_update': [['salaries']],
  'erp:customer_update': [['customers']],
  'erp:product_update': [['products']],
  'erp:receivable_update': [['receivables']],
  'erp:courier_update': [['transactions'], ['dashboard']],
  'erp:new_event': [['events']],
  'erp:payment_proof_update': [['transactions'], ['events'], ['receivables']],
  'erp:refresh_all': [],
};

// ─── DEBOUNCE CONFIG ──────────────────────────────────────────────────

const INVALIDATION_DEBOUNCE_MS = WEBSOCKET.mediumDebounceMs;
const REFRESH_ALL_DEBOUNCE_MS = WEBSOCKET.refreshAllDebounceMs;

function getDebounceMs(event: string): number {
  if (['erp:transaction_update', 'erp:stock_update', 'erp:payment_proof_update'].includes(event)) {
    return WEBSOCKET.criticalDebounceMs;
  }
  if (['erp:payment_update', 'erp:delivery_update', 'erp:new_event'].includes(event)) {
    return WEBSOCKET.mediumDebounceMs;
  }
  return WEBSOCKET.nonCriticalDebounceMs;
}

// ─── REALTIME SOURCE STATE ─────────────────────────────────────────────

type RealtimeSource = 'supabase' | 'socketio' | 'none';
let _globalSource: RealtimeSource = 'none';
let _sourceListeners: Set<(source: RealtimeSource) => void> = new Set();

function setGlobalSource(source: RealtimeSource) {
  if (_globalSource !== source) {
    _globalSource = source;
    console.log(`[RealtimeSync] Active source: ${source}`);
    for (const listener of _sourceListeners) {
      try { listener(source); } catch { /* ignore */ }
    }
  }
}

export function getRealtimeSource(): RealtimeSource {
  return _globalSource;
}

export function onRealtimeSourceChange(listener: (source: RealtimeSource) => void): () => void {
  _sourceListeners.add(listener);
  return () => _sourceListeners.delete(listener);
}

/**
 * Hook that subscribes to data changes and invalidates
 * TanStack Query cache keys for seamless real-time data sync.
 *
 * Uses Supabase Realtime (postgres_changes) as primary source,
 * with socket.io relay as automatic fallback.
 */
export function useRealtimeSync() {
  const queryClient = useQueryClient();
  const { user, token } = useAuthStore();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [supabaseReady, setSupabaseReady] = useState(false);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);

  // Debounced invalidation helper
  const invalidateWithDebounce = useRef((queryKeys: string[][], debounceMs: number) => {
    for (const key of queryKeys) {
      const keyStr = JSON.stringify(key);
      const existing = debounceTimers.current.get(keyStr);
      if (existing) clearTimeout(existing);

      debounceTimers.current.set(keyStr, setTimeout(() => {
        debounceTimers.current.delete(keyStr);
        queryClient.invalidateQueries({ queryKey: key });
      }, debounceMs));
    }
  }).current;

  // ─── 1. SUPABASE REALTIME (primary) ───────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;

    let unsub: (() => void) | null = null;

    // Dynamic import to avoid SSR issues
    import('@/lib/supabase-realtime').then(({ supabaseRealtime, isSupabaseConfigured }) => {
      if (!isSupabaseConfigured()) {
        console.log('[useRealtimeSync] Supabase not configured — using socket.io fallback');
        setSupabaseError('not_configured');
        return;
      }

      // Subscribe to all table changes
      unsub = supabaseRealtime.onAnyChange((event) => {
        const queryKeys = TABLE_TO_QUERY_KEYS[event.table];
        if (!queryKeys || queryKeys.length === 0) return;

        invalidateWithDebounce(queryKeys, INVALIDATION_DEBOUNCE_MS);
      });

      // Start Supabase Realtime
      supabaseRealtime.start();

      // Check availability after a short delay
      const checkTimer = setTimeout(() => {
        if (supabaseRealtime.isAvailable()) {
          setSupabaseReady(true);
          setSupabaseError(null);
          setGlobalSource('supabase');
        } else if (supabaseRealtime.getError()) {
          setSupabaseError(supabaseRealtime.getError());
          // Don't set global source here — socket.io will take over
        }
      }, 3000);

      // Monitor availability changes
      const monitorTimer = setInterval(() => {
        if (supabaseRealtime.isAvailable() && !supabaseReady) {
          setSupabaseReady(true);
          setSupabaseError(null);
          setGlobalSource('supabase');
        }
      }, 5000);

      return () => {
        clearTimeout(checkTimer);
        clearInterval(monitorTimer);
        // Don't stop the realtime — let it persist across component mounts
        // supabaseRealtime.stop() is called at app unmount
      };
    }).catch((err) => {
      console.warn('[useRealtimeSync] Failed to load Supabase Realtime:', err.message);
      setSupabaseError(err.message);
    });

    return () => {
      if (unsub) unsub();
    };
  }, [user?.id]);

  // ─── 2. SOCKET.IO RELAY (fallback) ───────────────────────────────────
  const { on, off, isConnected } = useWebSocket({
    userId: user?.id || '',
    role: user?.role || '',
    unitId: user?.unitId || '',
    userName: user?.name || '',
    authToken: token || '',
    enabled: !!user?.id,
  });

  useEffect(() => {
    // If Supabase Realtime is active, skip socket.io data relay
    // (socket.io is still used for online presence, system monitoring)
    if (supabaseReady) return;
    if (!isConnected || !user?.id) return;

    // Set socket.io as fallback source
    setGlobalSource('socketio');

    const handlers: { event: string; handler: (...args: any[]) => void }[] = [];

    // ─── data:change handler (server-side relay) ──────────────────
    const dataChangeHandler = (event: {
      table: string;
      action: string;
      recordId?: string;
      record?: Record<string, unknown>;
      unitId?: string;
      timestamp: string;
    }) => {
      const queryKeys = TABLE_TO_QUERY_KEYS[event.table];
      if (!queryKeys) return;

      invalidateWithDebounce(queryKeys, INVALIDATION_DEBOUNCE_MS);
    };
    handlers.push({ event: 'data:change', handler: dataChangeHandler });
    on('data:change', dataChangeHandler);

    // ─── Legacy erp:* event handlers ───────────────────────────────
    const events = Object.keys(EVENT_TO_QUERY_KEYS);

    for (const event of events) {
      if (event === 'erp:refresh_all') {
        const handler = (_data: any) => {
          const keyStr = '__refresh_all__';
          const existing = debounceTimers.current.get(keyStr);
          if (existing) clearTimeout(existing);
          debounceTimers.current.set(keyStr, setTimeout(() => {
            debounceTimers.current.delete(keyStr);
            queryClient.invalidateQueries();
          }, REFRESH_ALL_DEBOUNCE_MS));
        };
        handlers.push({ event, handler });
        on(event, handler);
      } else {
        const queryKeys = EVENT_TO_QUERY_KEYS[event];
        if (!queryKeys) continue;

        const handler = (_data: any) => {
          invalidateWithDebounce(queryKeys, getDebounceMs(event));
        };
        handlers.push({ event, handler });
        on(event, handler);
      }
    }

    // Cleanup
    return () => {
      for (const { event, handler } of handlers) {
        off(event, handler);
      }
    };
  }, [isConnected, user?.id, supabaseReady, queryClient, on, off, invalidateWithDebounce]);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of debounceTimers.current.values()) {
        clearTimeout(timer);
      }
      debounceTimers.current.clear();
    };
  }, []);

  return {
    source: _globalSource as RealtimeSource,
    supabaseReady,
    supabaseError,
    socketIoConnected: isConnected,
  };
}
