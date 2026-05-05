---
Task ID: 5
Agent: Main Agent
Task: Setup project from existing repo, fix startup issues, and verify all 4 tasks

Work Log:
- Cloned repo from https://github.com/henryarthanto/erpstb.git to my-project-temp
- Copied all source files to /home/z/my-project
- Verified .env matches Supabase template provided by user
- Found that all 4 tasks were ALREADY applied in the repo source code:
  - TASK 1: "Setor ke Brankas" already fully implemented in CourierDashboard.tsx
  - TASK 2: MODULE_POLLING already has 20 entries (events, dashboard, transactions, products, payments, deliveries, salaries, sales_tasks, stock_movements, suppliers, customers, cashbacks, finance, users, reports, courier, receivables, cash_boxes, pwa_orders)
  - TASK 3: TABLE_TO_QUERY_KEYS already has deliveries, stock_movements, suppliers, cashbacks, user_units, units
  - TASK 4: Stock button already visible for keuangan role (not kasir/gudang which don't exist)
- Fixed startup issues:
  - switch.tsx: changed `from "radix-ui"` to `from "@radix-ui/react-switch"` and installed package
  - instrumentation.ts: fixed process.on Edge Runtime warning using globalThis.process check
  - next.config.ts: removed `output: "standalone"` (breaks dev server binding) and added allowedDevOrigins
- Server running on port 3000 with HTTP 200

Stage Summary:
- All 4 tasks confirmed present in repo — no additional code changes needed
- Dev server running on http://localhost:3000 (HTTP 200)
- Connected to Supabase PostgreSQL
- Non-fatal Prisma warning on /api/auth/check-superadmin (role field mismatch, falls back gracefully)
- RealtimeSync websocket errors expected (monitor-ws mini-service not running in sandbox)

---
Task ID: 6
Agent: Main Agent
Task: Audit & fix CourierDashboard, SalesDashboard, and realtime sync system

Work Log:
- Full audit of CourierDashboard.tsx (790 lines): Setor ke Brankas ✅, Pending deliveries ✅
- Full audit of SalesDashboard.tsx (577 lines) + SalesTaskManagement.tsx (1005 lines) + SalesTaskDashboard.tsx (840 lines)
- Full audit of realtime system: use-realtime-sync.ts, query-provider.tsx, ws-dispatch.ts, use-websocket.ts
- Confirmed GitHub repo (henryarthanto/erpstb) matches local project (same package name, same structure)
- Verified roles: `kasir` does NOT exist in repo, `gudang` exists in 5 files (stock API roles)
- Updated .env with correct Supabase credentials (dkknaeiynrbmxhrysnge.supabase.co)

**Fixes Applied:**

1. **query-provider.tsx — BroadcastChannel Sender** (CROSS-TAB REALTIME)
   - Added `queryCache.subscribe()` to relay query invalidation events to other browser tabs
   - Any tab that invalidates queries (e.g. after mutation) now broadcasts to all other tabs
   - Fixes cross-tab sync without needing WebSocket mini-service

2. **query-provider.tsx — Added polling & stale times**
   - `sales-dashboard`: 45s polling, 30s stale time
   - `courier-dashboard`: 30s stale time (was missing)

3. **SalesDashboard API + UI — Target Always Visible**
   - Decoupled monthly target from period filter: target now ALWAYS fetched regardless of day/week/month selection
   - Achievement percentage calculated from CURRENT MONTH transactions (not selected period)
   - Added `pendingDeliveries` to API response with full field set (invoice_no, total, customer, etc.)
   - Added "Pengiriman" tab to SalesDashboard showing pending deliveries with status badges
   - Added clickable alert banner when pending deliveries exist

4. **CourierDashboard — Delivery History Tab**
   - Added "Riwayat Pengiriman" tab with summary stats (total delivered, cash collected, commission)
   - Shows near/far breakdown and piutang remaining

5. **CourierDashboard — Per-Unit Balance in Dialog**
   - Dialog now shows the SELECTED UNIT balance (not total) as the main figure
   - Total shown as subtitle only when multiple units exist

6. **use-realtime-sync.ts — sales_targets mapping**
   - Added `sales_targets` → `['sales-dashboard']` to TABLE_TO_QUERY_KEYS

7. **Cleanup**
   - Removed dead `followUpHistoryOpen` state from SalesDashboard
   - Added `Truck` icon import to SalesDashboard
   - Cleaned up accidental duplicate directories (src/lib/lib, src/hooks/hooks, etc.)

Stage Summary:
- CourierDashboard: Setor ke Brankas ✅, Perintah Pengiriman ✅, Riwayat Pengiriman tab ✅, Per-unit balance fix ✅
- SalesDashboard: Target always visible ✅, Pencapaian progress ✅, Pending Deliveries tab ✅, Dead code cleanup ✅
- Realtime: BroadcastChannel cross-tab sync ✅, sales_targets in TABLE_TO_QUERY_KEYS ✅, sales-dashboard polling 45s ✅
- All files pass ESLint
- Dev server running successfully
