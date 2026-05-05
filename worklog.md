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
