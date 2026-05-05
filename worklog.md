---
Task ID: 1
Agent: Main
Task: Fix 4 ERP tasks — courier dashboard, realtime polling, realtime subscriptions, stock buttons

Work Log:
- Synced project from GitHub repo (henryarthanto/erpstb) via `git reset --hard origin/main`
- Installed dependencies with `bun install`
- Task 1 (Courier Dashboard): Verified "Setor ke Brankas" already exists — CourierDashboard.tsx has complete implementation (button, dialog, mutation, API endpoint)
- Task 2 (Realtime Polling): Changed `POLLING_CONFIG.refetchInterval` from `false` to `isSTB ? 60_000 : 45_000` so ALL modules using `...POLLING_CONFIG` get automatic polling as fallback when WebSocket is disconnected
- Task 3 (Realtime Subscriptions):
  - Added `['deliveries']` to `transactions` mapping in `TABLE_TO_QUERY_KEYS` (use-realtime-sync.ts)
  - Added `wsSupplierUpdate()` dispatch function (ws-dispatch.ts)
  - Added `wsCashbackUpdate()` dispatch function (ws-dispatch.ts)
  - Added dispatch calls to suppliers API routes (POST/PATCH/DELETE)
  - Added dispatch calls to cashback config and cashback withdrawals API routes
- Task 4 (Stock Buttons): Fixed role condition in ProductsModule.tsx line 1072 from negative checks (`!== 'kurir' && !== 'sales' && !== 'viewer' && !== 'super_admin'`) to positive check (`=== 'super_admin' || === 'keuangan'`), so both super_admin and keuangan can see inline stock management buttons
- Ran ESLint — no errors
- Verified dev server compiles and serves successfully (GET / 200)

Stage Summary:
- All 4 tasks completed
- Files modified: query-provider.tsx, use-realtime-sync.ts, ws-dispatch.ts, ProductsModule.tsx, suppliers/route.ts, suppliers/[id]/route.ts, cashback/config/route.ts, cashback/withdrawals/[id]/route.ts
- No new dependencies added
- App compiles and runs correctly

---
Task ID: 2
Agent: Main
Task: Implement Supabase Realtime for multi-user realtime data sync

Work Log:
- Installed @supabase/supabase-js v2.105.3
- Rewrote src/lib/supabase-client.ts — replaced dead MariaDB stub with real Supabase client (lazy singleton, browser-side)
- Created src/lib/supabase-realtime.ts — new Supabase Realtime manager that:
  - Subscribes to postgres_changes on 30+ tables via single channel
  - Provides onTableChange() and onAnyChange() callback API
  - Auto-reconnects with 10s delay
  - Reports availability status
- Rewrote src/hooks/use-realtime-sync.ts — now uses dual-source realtime:
  - PRIMARY: Supabase Realtime (postgres_changes, direct browser↔Supabase WebSocket)
  - FALLBACK: Socket.io relay via monitor-ws (port 3004)
  - Exports getRealtimeSource() and onRealtimeSourceChange() for UI status
- Cleaned MariaDB references in:
  - src/lib/realtime-sync.ts (comments: MariaDB → fallback)
  - src/lib/supabase.ts (comments: 4 MariaDB refs → PostgreSQL)
  - src/lib/stb-config.ts (DB budget comment)
  - src/lib/supabase-rest.ts, finance-engine.ts, atomic-ops.ts, ensure-search.ts, ensure-rpc.ts
  - src/components/erp/StorageTab.tsx (API endpoint comment)
- Updated mini-services/monitor-ws/package.json — removed mysql2 dependency
- bun install in monitor-ws to remove mysql2

Stage Summary:
- Supabase Realtime is now the PRIMARY realtime mechanism
- 30+ database tables subscribed for realtime changes
- Automatic fallback to socket.io if Supabase Realtime unavailable
- All MariaDB/MySQL comments cleaned to reference PostgreSQL
- Key files: supabase-client.ts, supabase-realtime.ts, use-realtime-sync.ts
