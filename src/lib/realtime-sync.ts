// =====================================================================
// REALTIME SYNC — Server-side change broadcasting via WebSocket
//
// Provides a fallback realtime mechanism using socket.io relay:
//   1. A Socket.io client connecting to the monitor-ws service (port 3004)
//   2. API routes call broadcastChange() after mutations
//   3. The monitor-ws service relays change events to all browser clients
//
// PRIMARY: Supabase Realtime (postgres_changes) handles instant updates
//          directly from PostgreSQL WAL. This module is the FALLBACK.
//
// ws-dispatch.ts calls broadcastChange() from API routes.
// use-realtime-sync.ts listens on the browser via use-websocket.ts.
// =====================================================================

import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';

type ChangeAction = 'INSERT' | 'UPDATE' | 'DELETE' | 'UPSERT';
type ChangeEvent = {
  table: string;
  action: ChangeAction;
  recordId?: string;
  record?: Record<string, any>;
  unitId?: string;
  timestamp: string;
};

const MONITOR_WS_PORT = 3004;

class RealtimeSync extends EventEmitter {
  private client: Socket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents: ChangeEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // ─── LIFECYCLE ─────────────────────────────────────────────────

  /** Start realtime sync — connect to monitor-ws service */
  start(): void {
    if (this.client?.connected) {
      console.log('[RealtimeSync] Already connected');
      return;
    }

    console.log(`[RealtimeSync] Connecting to monitor-ws (port ${MONITOR_WS_PORT}) as fallback...`);

    this.client = io('/?XTransformPort=' + MONITOR_WS_PORT, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 15000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log('[RealtimeSync] Connected ✓ — change broadcasting active');
      // Flush any pending events
      this.flushPending();
    });

    this.client.on('disconnect', (reason) => {
      this.connected = false;
      console.warn(`[RealtimeSync] Disconnected (${reason}) — queuing events`);
    });

    this.client.on('connect_error', (err) => {
      this.connected = false;
      console.warn(`[RealtimeSync] Connect error: ${err.message}`);
    });

    // Start periodic flush for queued events (every 2s)
    this.flushTimer = setInterval(() => this.flushPending(), 2000);
  }

  /** Stop realtime sync */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    this.pendingEvents = [];
    console.log('[RealtimeSync] Stopped');
  }

  /** Check if realtime sync is active */
  isActive(): boolean {
    return this.connected;
  }

  // ─── CHANGE BROADCASTING ────────────────────────────────────────

  /**
   * Broadcast a database change event to all connected clients.
   * Call this after any INSERT/UPDATE/DELETE in API routes.
   *
   * @param table - The table that changed (e.g., 'transactions', 'products')
   * @param action - The type of change
   * @param recordId - ID of the affected record (optional)
   * @param record - The changed record data (optional, for UPDATE/INSERT)
   * @param unitId - Unit ID if the change is unit-specific (for multi-unit filtering)
   */
  broadcastChange(
    table: string,
    action: ChangeAction,
    recordId?: string,
    record?: Record<string, any>,
    unitId?: string
  ): void {
    const event: ChangeEvent = {
      table,
      action,
      recordId,
      record,
      unitId,
      timestamp: new Date().toISOString(),
    };

    if (this.connected && this.client) {
      // Send immediately if connected
      this.client.emit('db:change', event);
      // Also emit locally for same-process subscribers
      this.emit('change', event);
    } else {
      // Queue for later if not connected
      this.pendingEvents.push(event);
      // Keep queue manageable (max 100 pending)
      if (this.pendingEvents.length > 100) {
        this.pendingEvents = this.pendingEvents.slice(-50);
      }
    }
  }

  /** Flush pending events when connection is restored */
  private flushPending(): void {
    if (!this.connected || !this.client || this.pendingEvents.length === 0) return;

    const batch = [...this.pendingEvents];
    this.pendingEvents = [];

    // Emit each event
    for (const event of batch) {
      this.client.emit('db:change', event);
      this.emit('change', event);
    }

    if (batch.length > 0) {
      console.log(`[RealtimeSync] Flushed ${batch.length} queued events`);
    }
  }

  // ─── LOCAL SUBSCRIPTIONS ───────────────────────────────────────

  /**
   * Subscribe to changes for a specific table.
   * Returns an unsubscribe function.
   */
  onTable(table: string, callback: (event: ChangeEvent) => void): () => void {
    const handler = (event: ChangeEvent) => {
      if (event.table === table) callback(event);
    };
    this.on('change', handler);
    return () => this.off('change', handler);
  }

  /**
   * Subscribe to changes for multiple tables.
   * Returns an unsubscribe function.
   */
  onTables(tables: string[], callback: (event: ChangeEvent) => void): () => void {
    const tableSet = new Set(tables);
    const handler = (event: ChangeEvent) => {
      if (tableSet.has(event.table)) callback(event);
    };
    this.on('change', handler);
    return () => this.off('change', handler);
  }

  /**
   * Subscribe to all changes for a specific unit.
   * Returns an unsubscribe function.
   */
  onUnit(unitId: string, callback: (event: ChangeEvent) => void): () => void {
    const handler = (event: ChangeEvent) => {
      if (!event.unitId || event.unitId === unitId) callback(event);
    };
    this.on('change', handler);
    return () => this.off('change', handler);
  }
}

// ─── SINGLETON ──────────────────────────────────────────────────────

export const realtimeSync = new RealtimeSync();

/** Start realtime sync — convenience function */
export function startRealtimeSync(): void {
  realtimeSync.start();
}

/** Stop realtime sync — convenience function */
export function stopRealtimeSync(): void {
  realtimeSync.stop();
}

/** Check if realtime sync is active — convenience function */
export function isRealtimeSyncActive(): boolean {
  return realtimeSync.isActive();
}

/** Broadcast a change — convenience function */
export function broadcastChange(
  table: string,
  action: ChangeAction,
  recordId?: string,
  record?: Record<string, any>,
  unitId?: string
): void {
  realtimeSync.broadcastChange(table, action, recordId, record, unitId);
}

export type { ChangeAction, ChangeEvent };
