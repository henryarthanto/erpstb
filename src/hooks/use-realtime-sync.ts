'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthStore } from '@/stores/auth-store';

import { WEBSOCKET } from '@/lib/stb-config';

// =====================================================================
// REALTIME SYNC HOOK - Bridges WebSocket events → TanStack Query cache
//
// Two event sources:
//   1. data:change — From MariaDB realtime sync (Next.js server →
//      monitor-ws → browser). Emitted after every INSERT/UPDATE/DELETE.
//   2. erp:* events — Legacy event names for backward compatibility.
//
// When data changes, all connected clients automatically refresh
// their relevant TanStack Query cache keys.
// =====================================================================

// ─── TABLE → QUERY KEYS MAPPING ────────────────────────────────────────
// Maps MariaDB table names to TanStack Query cache keys to invalidate.

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

// ─── LEGACY EVENT → QUERY KEYS ─────────────────────────────────────────

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

/**
 * Hook that subscribes to WebSocket events and invalidates
 * TanStack Query cache keys for seamless real-time data sync.
 *
 * Now listens for both:
 *   - data:change events from MariaDB realtime sync (new)
 *   - erp:* events (legacy compatibility)
 */
export function useRealtimeSync() {
  const queryClient = useQueryClient();
  const { user, token } = useAuthStore();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const { on, off, isConnected } = useWebSocket({
    userId: user?.id || '',
    role: user?.role || '',
    unitId: user?.unitId || '',
    userName: user?.name || '',
    authToken: token || '',
    enabled: !!user?.id,
  });

  useEffect(() => {
    if (!isConnected || !user?.id) return;

    const handlers: { event: string; handler: (...args: any[]) => void }[] = [];

    // ─── 1. data:change handler (MariaDB realtime sync) ───────────────
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

      for (const key of queryKeys) {
        const keyStr = JSON.stringify(key);
        const existing = debounceTimers.current.get(keyStr);
        if (existing) clearTimeout(existing);

        debounceTimers.current.set(keyStr, setTimeout(() => {
          debounceTimers.current.delete(keyStr);
          queryClient.invalidateQueries({ queryKey: key });
        }, INVALIDATION_DEBOUNCE_MS));
      }
    };
    handlers.push({ event: 'data:change', handler: dataChangeHandler });
    on('data:change', dataChangeHandler);

    // ─── 2. Legacy erp:* event handlers ────────────────────────────────
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
          for (const key of queryKeys) {
            const keyStr = JSON.stringify(key);
            const existing = debounceTimers.current.get(keyStr);
            if (existing) clearTimeout(existing);
            debounceTimers.current.set(keyStr, setTimeout(() => {
              debounceTimers.current.delete(keyStr);
              queryClient.invalidateQueries({ queryKey: key });
            }, getDebounceMs(event)));
          }
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
      for (const timer of debounceTimers.current.values()) {
        clearTimeout(timer);
      }
      debounceTimers.current.clear();
    };
  }, [isConnected, user?.id, queryClient, on, off]);
}
