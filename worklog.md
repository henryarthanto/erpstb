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

---
Task ID: 3
Agent: Main
Task: Enable semua — Final verification & cleanup of all remaining tasks

Work Log:
- Read worklog and assessed current state — found most tasks already completed from previous sessions
- Verified "Setor ke Brankas" feature: FULLY IMPLEMENTED (UI, API, RPC, DB models, finance integration)
- Verified Supabase Realtime: IMPLEMENTED (30+ tables, dual-source with socket.io fallback)
- Verified realtime polling: ACTIVE (45-60s fallback, BroadcastChannel multi-tab sync)
- Verified inline stock buttons: FIXED (super_admin + keuangan roles)
- Fixed last MariaDB reference: Renamed /api/storage/mariadb-monitor → /api/storage/db-monitor
  - Created new route file at src/app/api/storage/db-monitor/route.ts
  - Updated StorageTab.tsx to use new endpoint
- Started monitor-ws mini service on port 3004 (PostgreSQL monitoring + socket.io relay)
- Ran ESLint — 0 errors
- Verified dev server health: GET /api/health returns {"status":"ok"}
- Verified main page loads correctly (200 OK, full HTML)

Stage Summary:
- ALL tasks from original request are now COMPLETE
- Zero MariaDB/MySQL references remaining in source code
- Both realtime mechanisms active: Supabase Realtime (primary) + socket.io (fallback)
- monitor-ws service running on port 3004
- Clean lint, healthy server

---
Task ID: 4
Agent: Main
Task: Fix product creation — "tidak bisa membuat produk baru"

Work Log:
- Investigated ProductsModule.tsx — found role-gating mismatch
- Bug: "Produk Baru" button only rendered for `super_admin`, but API allows `keuangan` and `gudang` too
- Fix 1 (line 976): Changed `user?.role === 'super_admin'` → `['super_admin', 'keuangan', 'gudang'].includes(user?.role || '')` for Add Product button
- Fix 2 (line 1034): Same change for Track Stock toggle
- Fix 3 (line 1077): Same change for Edit/Delete dropdown — Edit visible to all 3 roles
- Fix 4: Delete menu item wrapped with `user?.role === 'super_admin'` guard (matches API restriction)
- Lint clean, dev server compiles successfully

Stage Summary:
- Product CRUD now accessible to `super_admin`, `keuangan`, and `gudang` roles (matching API permissions)
- Delete restricted to `super_admin` only (matching backend)
- File modified: src/components/erp/ProductsModule.tsx

---
Task ID: 5
Agent: Main
Task: Fix "tidak bisa membuat produk baru" — subUnit column mismatch

Work Log:
- User sent screenshot showing error: `The column 'subUnit' does not exist in the current database`
- Checked Prisma schema vs actual PostgreSQL database columns
- Database has `sub_unit` (snake_case) but Prisma schema had `subUnit` WITHOUT `@map("sub_unit")` directive
- Added `@map("sub_unit")` to `subUnit` field in prisma/schema.prisma line 139
- Regenerated Prisma client (`npx prisma generate`)
- Verified fix works by querying `product.findFirst({ select: { subUnit: true } })` — returns data correctly
- Restarted dev server with correct DATABASE_URL

Stage Summary:
- Root cause: Missing `@map("sub_unit")` on Prisma field `subUnit` in Product model
- Fix: Added `@map("sub_unit")` to align Prisma camelCase field with PostgreSQL snake_case column
- File modified: prisma/schema.prisma (line 139)
