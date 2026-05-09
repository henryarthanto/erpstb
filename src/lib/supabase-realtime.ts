// =====================================================================
// SUPABASE REALTIME — PostgreSQL Realtime Change Subscriptions
//
// Uses Supabase Realtime (postgres_changes) to receive instant
// notifications when database records are INSERTed, UPDATEd, or DELETEd.
//
// Architecture:
//   Supabase PostgreSQL WAL → Supabase Realtime Server → Browser WebSocket
//
// This provides true realtime sync WITHOUT needing a custom relay service.
// Falls back to socket.io relay if Supabase Realtime is unavailable.
//
// Usage:
//   import { supabaseRealtime } from '@/lib/supabase-realtime';
//   supabaseRealtime.start();
//   supabaseRealtime.onTableChange('transactions', (event) => { ... });
// =====================================================================

'use client';

import { getSupabaseClient, isSupabaseConfigured } from './supabase-client';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────

export type RealtimeAction = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface RealtimeChangeEvent {
  /** The event type */
  eventType: RealtimeAction;
  /** The table that changed */
  table: string;
  /** The schema (usually 'public') */
  schema: string;
  /** The new record (for INSERT/UPDATE) */
  new: Record<string, any> | null;
  /** The old record (for UPDATE/DELETE) */
  old: Record<string, any> | null;
  /** Timestamp of the change */
  timestamp: string;
}

export type TableChangeCallback = (event: RealtimeChangeEvent) => void;

// ─────────────────────────────────────────────────────────────────────
// TABLES TO SUBSCRIBE
// All tables that need realtime change notifications
// ─────────────────────────────────────────────────────────────────────

const REALTIME_TABLES = [
  // Core transactions
  'transactions',
  'transaction_items',
  'payments',
  'payment_proofs',
  // Products & stock
  'products',
  'unit_products',
  // Customers
  'customers',
  'customer_follow_ups',
  'customer_prices',
  'customer_referral',
  // Users & roles
  'users',
  'user_units',
  'custom_roles',
  // Finance
  'finance_requests',
  'expenses',
  'fund_transfers',
  'company_debts',
  'company_debt_payments',
  'bank_accounts',
  'cash_boxes',
  'finance_ledger',
  'receivables',
  'receivable_follow_ups',
  // Sales
  'sales_tasks',
  'sales_task_reports',
  'sales_targets',
  // Courier
  'courier_cash',
  'courier_handovers',
  // Suppliers
  'suppliers',
  // Cashback
  'cashback_config',
  'cashback_log',
  'cashback_withdrawal',
  // Salary
  'salary_payments',
  // Units
  'units',
  // Events & logs
  'events',
  'logs',
] as const;

// ─────────────────────────────────────────────────────────────────────
// SUPABASE REALTIME MANAGER
// ─────────────────────────────────────────────────────────────────────

class SupabaseRealtimeManager {
  private channel: RealtimeChannel | null = null;
  private started = false;
  private available = false;
  private connecting = false;
  private tableCallbacks: Map<string, Set<TableChangeCallback>> = new Map();
  private anyCallbacks: Set<TableChangeCallback> = new Set();
  private error: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000; // Start at 1s (exponential backoff)
  private readonly MAX_RECONNECT_DELAY = 60_000; // Max 60s

  // ─── LIFECYCLE ───────────────────────────────────────────────────

  /**
   * Start Supabase Realtime subscriptions.
   * Creates a single channel that listens to postgres_changes on all tables.
   */
  start(): void {
    if (this.started) return;
    if (!isSupabaseConfigured()) {
      console.warn('[SupabaseRealtime] Not configured — NEXT_PUBLIC_SUPABASE_URL or ANON_KEY missing');
      this.error = 'not_configured';
      return;
    }

    this.started = true;
    this.connecting = true;
    console.log(`[SupabaseRealtime] Starting — subscribing to ${REALTIME_TABLES.length} tables...`);

    try {
      this.subscribeToChanges();
    } catch (err: any) {
      console.error('[SupabaseRealtime] Failed to start:', err.message);
      this.error = err.message;
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  /** Stop all subscriptions and disconnect */
  stop(): void {
    this.started = false;
    this.connecting = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.channel) {
      try {
        this.channel.unsubscribe();
      } catch { /* ignore */ }
      try {
        getSupabaseClient().removeChannel(this.channel);
      } catch { /* ignore */ }
      this.channel = null;
    }

    this.available = false;
    console.log('[SupabaseRealtime] Stopped');
  }

  /** Check if Supabase Realtime is available and working */
  isAvailable(): boolean {
    return this.available;
  }

  /** Check if currently connecting */
  isConnecting(): boolean {
    return this.connecting;
  }

  /** Get any error that occurred */
  getError(): string | null {
    return this.error;
  }

  // ─── SUBSCRIPTIONS ───────────────────────────────────────────────

  /**
   * Subscribe to changes on a specific table.
   * Returns an unsubscribe function.
   */
  onTableChange(table: string, callback: TableChangeCallback): () => void {
    if (!this.tableCallbacks.has(table)) {
      this.tableCallbacks.set(table, new Set());
    }
    this.tableCallbacks.get(table)!.add(callback);
    return () => {
      const set = this.tableCallbacks.get(table);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.tableCallbacks.delete(table);
      }
    };
  }

  /**
   * Subscribe to ALL table changes.
   * Returns an unsubscribe function.
   */
  onAnyChange(callback: TableChangeCallback): () => void {
    this.anyCallbacks.add(callback);
    return () => {
      this.anyCallbacks.delete(callback);
    };
  }

  // ─── INTERNAL ────────────────────────────────────────────────────

  private subscribeToChanges(): void {
    const client = getSupabaseClient();

    // Create a single channel for all postgres_changes
    this.channel = client
      .channel('erp-realtime', {
        config: {
          broadcast: { self: false },
          presence: { key: '' },
        },
      });

    // Subscribe to postgres_changes for each table
    // Supabase allows multiple postgres_changes on the same channel
    for (const table of REALTIME_TABLES) {
      this.channel.on(
        'postgres_changes',
        {
          event: '*',        // Listen for all events (INSERT, UPDATE, DELETE)
          schema: 'public',
          table: table,
        },
        (payload: any) => {
          this.handleChange(table, payload);
        }
      );
    }

    // Subscribe to channel status
    this.channel.subscribe((status: string, err?: Error) => {
      switch (status) {
        case 'SUBSCRIBED':
          this.available = true;
          this.connecting = false;
          this.error = null;
          this.reconnectDelay = 1_000; // Reset backoff on successful connection
          console.log('[SupabaseRealtime] ✅ Connected — realtime active for all tables');
          break;
        case 'TIMED_OUT':
          console.warn('[SupabaseRealtime] ⏱ Subscription timed out');
          this.connecting = false;
          this.error = 'timed_out';
          this.scheduleReconnect();
          break;
        case 'CLOSED':
          console.warn('[SupabaseRealtime] Channel closed');
          this.available = false;
          this.connecting = false;
          break;
        case 'CHANNEL_ERROR':
          console.error('[SupabaseRealtime] ❌ Channel error:', err?.message);
          this.available = false;
          this.connecting = false;
          this.error = err?.message || 'channel_error';
          this.scheduleReconnect();
          break;
      }
    });
  }

  private handleChange(table: string, payload: any): void {
    const event: RealtimeChangeEvent = {
      eventType: payload.eventType || 'UPDATE',
      table,
      schema: payload.schema || 'public',
      new: payload.new || null,
      old: payload.old || null,
      timestamp: new Date().toISOString(),
    };

    // Call table-specific callbacks
    const callbacks = this.tableCallbacks.get(table);
    if (callbacks) {
      for (const cb of callbacks) {
        try { cb(event); } catch (err) {
          console.error(`[SupabaseRealtime] Callback error for ${table}:`, err);
        }
      }
    }

    // Call global callbacks
    for (const cb of this.anyCallbacks) {
      try { cb(event); } catch (err) {
        console.error('[SupabaseRealtime] Global callback error:', err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.started) return;

    // Exponential backoff with jitter
    const jitter = Math.random() * 1000; // 0-1s random jitter
    const delay = Math.min(this.reconnectDelay + jitter, this.MAX_RECONNECT_DELAY);

    console.log(`[SupabaseRealtime] Scheduling reconnect in ${Math.round(delay / 1000)}s (base: ${this.reconnectDelay}ms)...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started) return;

      // Clean up old channel
      if (this.channel) {
        try {
          this.channel.unsubscribe();
          getSupabaseClient().removeChannel(this.channel);
        } catch { /* ignore */ }
        this.channel = null;
      }

      console.log('[SupabaseRealtime] Reconnecting...');
      this.connecting = true;
      try {
        this.subscribeToChanges();
      } catch (err: any) {
        console.error('[SupabaseRealtime] Reconnect failed:', err.message);
        this.connecting = false;
        this.scheduleReconnect();
      }
    }, delay);

    // Double delay for next attempt (exponential backoff)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
  }
}

// ─────────────────────────────────────────────────────────────────────
// SINGLETON EXPORT
// ─────────────────────────────────────────────────────────────────────

export const supabaseRealtime = new SupabaseRealtimeManager();

/** Start Supabase Realtime — convenience function */
export function startSupabaseRealtime(): void {
  supabaseRealtime.start();
}

/** Stop Supabase Realtime — convenience function */
export function stopSupabaseRealtime(): void {
  supabaseRealtime.stop();
}

/** Check if Supabase Realtime is available */
export function isSupabaseRealtimeAvailable(): boolean {
  return supabaseRealtime.isAvailable();
}
