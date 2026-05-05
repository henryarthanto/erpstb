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
