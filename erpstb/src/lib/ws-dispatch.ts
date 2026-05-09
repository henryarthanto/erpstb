// =====================================================================
// WS DISPATCH — WebSocket Real-time Notification via RealtimeSync
//
// Fire-and-forget functions for broadcasting real-time updates.
// Each function calls realtimeSync.broadcastChange() to emit
// table-level change events to all connected clients via the
// monitor-ws service.
//
// The browser-side useRealtimeSync hook maps table names to
// TanStack Query cache keys for automatic invalidation.
// =====================================================================

import { broadcastChange } from './realtime-sync';

type WsEventData = Record<string, unknown>;

// ─── Transaction ────────────────────────────────────────────────────
export function wsTransactionUpdate(data?: WsEventData): void {
  try {
    broadcastChange('transactions', 'UPDATE', data?.transactionId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Stock ──────────────────────────────────────────────────────────
export function wsStockUpdate(data?: WsEventData): void {
  try {
    broadcastChange('products', 'UPDATE', data?.productId as string, data);
    broadcastChange('unit_products', 'UPDATE', data?.unitProductId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Payment ────────────────────────────────────────────────────────
export function wsPaymentUpdate(data?: WsEventData): void {
  try {
    broadcastChange('payments', 'UPDATE', data?.paymentId as string, data);
    if (data?.transactionId) {
      broadcastChange('transactions', 'UPDATE', data.transactionId as string, data);
    }
  } catch { /* non-blocking */ }
}

// ─── Receivable ─────────────────────────────────────────────────────
export function wsReceivableUpdate(data?: WsEventData): void {
  try {
    broadcastChange('receivables', 'UPDATE', data?.receivableId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Delivery ───────────────────────────────────────────────────────
export function wsDeliveryUpdate(data?: WsEventData): void {
  try {
    broadcastChange('transactions', 'UPDATE', data?.transactionId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Finance ────────────────────────────────────────────────────────
export function wsFinanceUpdate(data?: WsEventData): void {
  try {
    broadcastChange('finance_requests', 'UPDATE', data?.requestId as string, data);
    broadcastChange('bank_accounts', 'UPDATE', undefined, data);
    broadcastChange('cash_boxes', 'UPDATE', undefined, data);
  } catch { /* non-blocking */ }
}

// ─── Courier ────────────────────────────────────────────────────────
export function wsCourierUpdate(data?: WsEventData): void {
  try {
    broadcastChange('courier_cash', 'UPDATE', data?.courierId as string, data);
    broadcastChange('courier_handovers', 'UPDATE', undefined, data);
  } catch { /* non-blocking */ }
}

// ─── Customer ───────────────────────────────────────────────────────
export function wsCustomerUpdate(data?: WsEventData): void {
  try {
    broadcastChange('customers', 'UPDATE', data?.customerId as string, data);
  } catch { /* non-blocking */ }
}

// ─── User ───────────────────────────────────────────────────────────
export function wsUserUpdate(data?: WsEventData): void {
  try {
    broadcastChange('users', 'UPDATE', data?.userId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Salary ─────────────────────────────────────────────────────────
export function wsSalaryUpdate(data?: WsEventData): void {
  try {
    broadcastChange('salary_payments', 'UPDATE', data?.salaryId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Task ───────────────────────────────────────────────────────────
export function wsTaskUpdate(data?: WsEventData): void {
  try {
    broadcastChange('sales_tasks', 'UPDATE', data?.taskId as string, data);
    broadcastChange('sales_task_reports', 'UPDATE', data?.reportId as string, data);
  } catch { /* non-blocking */ }
}

// ─── Generic ────────────────────────────────────────────────────────
export function wsEmit(event: string, data?: WsEventData): void {
  try {
    // Extract table name from event (e.g., 'transaction:update' → 'transactions')
    const table = event.split(':')[0];
    broadcastChange(table, 'UPDATE', undefined, data);
  } catch { /* non-blocking */ }
}

export function wsNotifyAll(data?: WsEventData): void {
  try {
    // Broadcast to multiple key tables for full refresh
    broadcastChange('transactions', 'UPDATE');
    broadcastChange('events', 'UPDATE');
  } catch { /* non-blocking */ }
}

export function wsRefreshAll(_data?: WsEventData): void {
  try {
    // Broadcast changes to all critical tables to trigger full client refresh
    const tables = [
      'transactions', 'products', 'customers', 'payments', 'users',
      'finance_requests', 'receivables', 'salary_payments', 'sales_tasks',
      'courier_cash', 'events', 'bank_accounts', 'cash_boxes',
    ];
    for (const table of tables) {
      broadcastChange(table, 'UPDATE');
    }
  } catch { /* non-blocking */ }
}
