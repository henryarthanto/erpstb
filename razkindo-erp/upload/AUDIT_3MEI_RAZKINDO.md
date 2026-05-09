# AUDIT LENGKAP — Razkindo ERP (Build: 3MEI)
## Bug, Error, Keamanan & Panduan Perbaikan untuk STB RAM 2GB

> **Target deployment:** STB (Set-Top Box) dengan RAM 2 GB  
> **Stack:** Next.js 16 · Bun · Supabase (PostgreSQL) · Prisma · Caddy · TypeScript  
> **Auditor:** Analisis statis + review kode seluruh file src/

---

## DAFTAR ISI

1. [Ringkasan Eksekutif](#1-ringkasan-eksekutif)
2. [KRITIS — Bug Fatal](#2-kritis--bug-fatal)
3. [TINGGI — Bug Fungsional](#3-tinggi--bug-fungsional)
4. [SEDANG — Keamanan & Robustness](#4-sedang--keamanan--robustness)
5. [STB / Memory — Hemat RAM 2 GB](#5-stb--memory--hemat-ram-2-gb)
6. [Kualitas Kode & Maintainability](#6-kualitas-kode--maintainability)
7. [Panduan Langkah Perbaikan](#7-panduan-langkah-perbaikan-step-by-step)

---

## 1. RINGKASAN EKSEKUTIF

| Kategori | Jumlah Issue | Prioritas |
|---|---|---|
| Bug Fatal (server crash / data salah) | 5 | 🔴 KRITIS |
| Bug Fungsional (fitur tidak bekerja) | 6 | 🟠 TINGGI |
| Keamanan & Robustness | 5 | 🟡 SEDANG |
| STB Memory / Performance | 7 | 🔵 STB |
| Kualitas Kode | 4 | ⚪ MINOR |

---

## 2. KRITIS — Bug Fatal

### BUG-01 ⚡ `prisma generate` hilang dari build script

**File:** `package.json` → script `"build"`  
**Dampak:** Server crash saat pertama run — `@prisma/client` tidak tergenerate, semua query DB gagal.

**Kode saat ini:**
```json
"build": "next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/"
```

**Fix — tambah `prisma generate` di awal:**
```json
"build": "prisma generate && next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/"
```

---

### BUG-02 ⚡ `STB_MODE` tidak pernah diaktifkan

**File:** `.env`, `.zscripts/start.sh`  
**Dampak:** Semua optimasi STB (memory guard, pool limit 3 koneksi, GC proaktif, dll) **tidak aktif** meskipun berjalan di STB 2 GB. Server akan kehabisan RAM tanpa peringatan.

**Bukti di kode:**
```typescript
// src/lib/stb-config.ts
export const IS_STB = process.env.STB_MODE === 'true' || process.env.STB_MODE === '1';
// → IS_STB = false karena env var tidak di-set!
```

**Fix — tambah di `.env`:**
```bash
STB_MODE=true
```

**Fix — tambah di `.zscripts/start.sh` sebelum `bun server.js`:**
```sh
export STB_MODE=true
```

---

### BUG-03 ⚡ Tidak ada batas heap untuk Bun/Node di start script

**File:** `.zscripts/start.sh`  
**Dampak:** V8 heap bisa tumbuh tak terbatas dan menyita seluruh RAM 2 GB → kernel OOM killer → server mati mendadak tanpa graceful shutdown.

**Kode saat ini:**
```sh
bun server.js &
```

**Fix:**
```sh
# Untuk STB 2GB, batas heap 384MB sesuai MEMORY_BUDGET di stb-config.ts
bun --max-old-space-size=384 server.js &
```

Jika menggunakan Node.js:
```sh
NODE_OPTIONS="--max-old-space-size=384" node server.js &
```

---

### BUG-04 ⚡ Discount item tidak ada di validator — nilai diskon selalu diabaikan

**File:** `src/lib/validators.ts` → `transactionItemSchema`  
**Dampak:** Diskon yang diinput di frontend **distrip oleh Zod validation** sebelum mencapai database. Semua transaksi tersimpan tanpa diskon meskipun user sudah mengisi.

**Kode saat ini — `transactionItemSchema` tidak punya field discount:**
```typescript
const transactionItemSchema = z.object({
  productId: z.string().min(1, 'Produk wajib dipilih'),
  productName: z.string().optional(),
  qty: z.number().positive('Jumlah harus lebih dari 0'),
  qtyInSubUnit: z.number().positive().optional(),
  qtyUnitType: z.enum(['main', 'sub']).optional().default('sub'),
  price: z.number().min(0, 'Harga tidak boleh negatif'),
  hpp: z.number().min(0).optional().default(0),
  subtotal: z.number().optional(),
  profit: z.number().optional(),
  // ❌ TIDAK ADA: discount, discountType, discountValue, discountAmount
});
```

**Fix — tambah field discount:**
```typescript
const transactionItemSchema = z.object({
  productId: z.string().min(1, 'Produk wajib dipilih'),
  productName: z.string().optional(),
  qty: z.number().positive('Jumlah harus lebih dari 0'),
  qtyInSubUnit: z.number().positive().optional(),
  qtyUnitType: z.enum(['main', 'sub']).optional().default('sub'),
  price: z.number().min(0, 'Harga tidak boleh negatif'),
  hpp: z.number().min(0).optional().default(0),
  subtotal: z.number().optional(),
  profit: z.number().optional(),
  // ✅ TAMBAH:
  discount: z.number().min(0).max(100).optional().default(0),        // persen 0-100
  discountAmount: z.number().min(0).optional().default(0),            // nominal rupiah
  discountType: z.enum(['percent', 'nominal']).optional().default('percent'),
});

// Dan di transactionSchemas.create, tambah globalDiscount:
create: z.object({
  // ... field yang sudah ada ...
  globalDiscount: z.number().min(0).max(100).optional().default(0),
  globalDiscountAmount: z.number().min(0).optional().default(0),
}),
```

---

### BUG-05 ⚡ Caddy tidak flush SSE — realtime update tidak berjalan

**File:** `Caddyfile`  
**Dampak:** Server-Sent Events (SSE) yang digunakan oleh `use-sse-fallback.ts` dan `use-realtime-sync.ts` **dibuffer oleh Caddy** dan tidak pernah dikirim ke client. Semua fitur realtime (stok update, notifikasi transaksi) tidak berfungsi.

**Kode saat ini:**
```caddyfile
handle {
  reverse_proxy localhost:3000 {
    header_up Host {host}
    # ❌ Tidak ada flush_interval → SSE di-buffer
  }
}
```

**Fix — tambah `flush_interval -1` untuk SSE route:**
```caddyfile
:81 {
  @transform_port_query {
    query XTransformPort=*
  }

  handle @transform_port_query {
    reverse_proxy localhost:{query.XTransformPort} {
      header_up Host {host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
      header_up X-Real-IP {remote_host}
      transport http {
        read_timeout  120s
        write_timeout 120s
        dial_timeout  10s
      }
    }
  }

  # ✅ Handle SSE endpoints — flush immediately (no buffering)
  @sse_endpoints {
    path /api/events* /api/ai/broadcast* /api/health/ready*
  }
  handle @sse_events {
    reverse_proxy localhost:3000 {
      header_up Host {host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
      header_up X-Real-IP {remote_host}
      flush_interval -1
      transport http {
        read_timeout  300s
        write_timeout 300s
        dial_timeout  10s
      }
    }
  }

  handle {
    reverse_proxy localhost:3000 {
      header_up Host {host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
      header_up X-Real-IP {remote_host}
      transport http {
        read_timeout  120s
        write_timeout 120s
        dial_timeout  10s
      }
    }
  }
}
```

---

## 3. TINGGI — Bug Fungsional

### BUG-06 🟠 TypeScript errors diabaikan saat build

**File:** `next.config.ts`  
**Dampak:** Bug tipe nyata di kode (termasuk null dereference, parameter salah tipe) lolos ke production tanpa peringatan.

```typescript
// ❌ Saat ini
typescript: {
  ignoreBuildErrors: true,
},

// ✅ Fix — hapus atau set false
typescript: {
  ignoreBuildErrors: false,
},
```

Jika ada error TS yang tersisa, perbaiki satu per satu. Jangan abaikan semua.

---

### BUG-07 🟠 `reactStrictMode: false` — bug double-mount tidak terdeteksi

**File:** `next.config.ts`

React Strict Mode dengan sengaja memanggil lifecycle dua kali di development untuk mendeteksi side effect. Dengan mode ini dimatikan, bug seperti:
- `useEffect` yang tidak dibersihkan (memory leak)
- Subscription yang didaftarkan dua kali
- State race condition

...tidak akan terdeteksi sampai production.

```typescript
// ✅ Fix — aktifkan kembali
reactStrictMode: true,
```

Setelah diaktifkan, perbaiki efek yang bergantung pada single-mount behavior.

---

### BUG-08 🟠 `AUTH_SECRET` lemah di `.env`

**File:** `.env`  
**Dampak:** Token HMAC-SHA256 bisa diprediksi/dipalsukan jika attacker mengetahui pola secret. Semua user token bisa diforge.

```bash
# ❌ Saat ini — mudah ditebak
AUTH_SECRET=razkindo-erp-secret-key-2024-production

# ✅ Fix — generate random 32 byte:
# Di terminal:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Contoh output (pakai nilai asli dari command di atas):
AUTH_SECRET=a3f8c2e1d9b7f045a8c3e2d1f9b7e4a2c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1
```

---

### BUG-09 🟠 In-memory rate limiter hilang saat restart

**File:** `src/lib/rate-limiter.ts`, `src/app/api/auth/login/route.ts`  
**Dampak:** Perlindungan brute-force login (max 10 percobaan per 15 menit) **reset** setiap kali server restart. Attacker bisa brute-force dengan memaksa server restart.

**Solusi untuk STB (tanpa Redis):** Gunakan file-based persistence sederhana.

```typescript
// src/lib/rate-limiter-persistent.ts — BARU
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const PERSIST_PATH = join(process.cwd(), '..', 'db', 'rate-limits.json');

function loadStore(): Map<string, { count: number; resetAt: number }> {
  try {
    if (existsSync(PERSIST_PATH)) {
      const raw = JSON.parse(readFileSync(PERSIST_PATH, 'utf-8'));
      const now = Date.now();
      const map = new Map<string, { count: number; resetAt: number }>();
      for (const [k, v] of Object.entries(raw as any)) {
        const entry = v as { count: number; resetAt: number };
        if (entry.resetAt > now) map.set(k, entry); // hanya load yang belum expired
      }
      return map;
    }
  } catch { /* ignore */ }
  return new Map();
}

function saveStore(store: Map<string, { count: number; resetAt: number }>): void {
  try {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of store) obj[k] = v;
    writeFileSync(PERSIST_PATH, JSON.stringify(obj), 'utf-8');
  } catch { /* ignore jika tidak bisa tulis */ }
}

// Gunakan ini sebagai pengganti _store di rate-limiter.ts
```

Atau alternatif lebih sederhana: gunakan Redis jika tersedia (sudah ada `redis-cache.ts`), fallback ke in-memory dengan peringatan.

---

### BUG-10 🟠 `build.sh` hardcode path `/home/z/my-project`

**File:** `.zscripts/build.sh`  
**Dampak:** Jika project di-deploy di path berbeda (sangat mungkin di STB), build gagal total.

```sh
# ❌ Saat ini
NEXTJS_PROJECT_DIR="/home/z/my-project"

# ✅ Fix — gunakan env var dengan fallback
NEXTJS_PROJECT_DIR="${NEXTJS_PROJECT_DIR:-/home/z/my-project}"
```

Dan set di environment:
```bash
# Di startup environment STB:
export NEXTJS_PROJECT_DIR=/path/ke/project/di/stb
```

---

### BUG-11 🟠 `NEXT_PUBLIC_APP_URL` hardcode ke localhost

**File:** `.env`  
**Dampak:** URL absolut yang digenerate (untuk PWA, share link, redirect) akan salah di production/STB.

```bash
# ❌ Saat ini
NEXT_PUBLIC_APP_URL=http://localhost:3000

# ✅ Fix — sesuaikan dengan URL deployment
NEXT_PUBLIC_APP_URL=http://<IP-STB>:81
# atau domain jika ada:
NEXT_PUBLIC_APP_URL=https://erp.razkindo.com
```

---

### BUG-12 🟠 Dua implementasi circuit breaker — STB config tidak dipakai

**File:** `src/lib/graceful-degradation.ts` vs `src/lib/circuit-breaker.ts`  
**Dampak:** `graceful-degradation.ts` punya circuit breaker sendiri dengan nilai hardcode (`MAX_FAILURES = 5`, `OPEN_DURATION_MS = 30_000`), mengabaikan `CIRCUIT_BREAKER` dari `stb-config.ts`. Di STB, circuit breaker seharusnya lebih sensitif (`failureThreshold: 3`, `resetTimeoutMs: 8_000`).

**Fix:** Gunakan satu circuit breaker saja.

```typescript
// src/lib/graceful-degradation.ts — ganti implementasi lokal dengan import
import { CircuitBreaker } from './circuit-breaker';
import { CIRCUIT_BREAKER } from './stb-config';

// Ganti getCircuit() lokal dengan:
function getCircuit(name: string): CircuitBreaker {
  return CircuitBreaker.get(name, {
    failureThreshold: CIRCUIT_BREAKER.failureThreshold,
    resetTimeout: CIRCUIT_BREAKER.resetTimeoutMs,
    halfOpenMaxAttempts: 1,
    monitorInterval: CIRCUIT_BREAKER.monitorIntervalMs,
  });
}
```

---

## 4. SEDANG — Keamanan & Robustness

### SEC-01 🟡 `.env` berisi credential sensitif dan mungkin ter-commit ke Git

**File:** `.env`, `.gitignore`  
**Dampak:** Database password, Supabase service key, Moota token, semua tersimpan plaintext di repository.

**Verifikasi:**
```bash
cat .gitignore | grep "\.env"
# Jika tidak ada output, .env TIDAK di-ignore!
```

**Fix — tambah ke `.gitignore`:**
```gitignore
# Environment variables — JANGAN COMMIT
.env
.env.local
.env.production
.env*.local

# Secret files
db/.auth-secret
```

**Ganti password database** (karena sudah terlanjur exposed): `Arthanto01091987` harus diubah di Supabase dashboard.

---

### SEC-02 🟡 `SUPABASE_URL` diekspor sebagai `let` mutable kosong

**File:** `src/lib/supabase-rest.ts`  
**Dampak:** Jika ada modul yang mengimport `SUPABASE_URL` sebelum lazy getter dipanggil, nilainya akan berupa string kosong `''`.

```typescript
// ❌ Saat ini
export let SUPABASE_URL = '';

// ✅ Fix — gunakan getter
export function getSupabaseUrl(): string {
  return getSupabaseConfig().url;
}
// ATAU gunakan lazy getter dengan defineProperty
```

---

### SEC-03 🟡 Cache-Control `no-store` terlalu agresif di STB mode

**File:** `next.config.ts`  
**Dampak:** Di STB mode, `Cache-Control: no-store, max-age=0` diaplikasikan ke **semua** route termasuk static assets (`/_next/static`). Ini membuat browser me-download ulang JS/CSS setiap page load → lebih lambat, lebih banyak CPU, lebih banyak network request.

```typescript
// ❌ Saat ini — berlaku untuk semua route termasuk static
...(isSTB ? [
  { key: 'Cache-Control', value: 'no-store, max-age=0' },
] : []),

// ✅ Fix — hanya terapkan ke API routes, bukan static assets
// Di headers(), pisahkan:
{
  source: '/api/(.*)',   // hanya API
  headers: [
    ...(isSTB ? [{ key: 'Cache-Control', value: 'no-store, max-age=0' }] : []),
  ],
},
{
  source: '/_next/static/:path*',  // static selalu cache
  headers: [
    { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
  ],
},
```

---

### SEC-04 🟡 `NODE_ENV=development` di `.env` konflik dengan `start.sh`

**File:** `.env`  
**Dampak:** Saat `next build` dijalankan, `NODE_ENV` bisa terbaca sebagai `development` dari `.env`, mengaktifkan development-only code paths di binary production.

**Fix — hapus dari `.env`** (biarkan `start.sh` yang mengeset):
```bash
# ❌ Hapus baris ini dari .env:
NODE_ENV=development

# Biarkan start.sh yang mengatur:
export NODE_ENV=production
```

---

### SEC-05 🟡 `set -e` di `start.sh` dengan penanganan error tidak konsisten

**File:** `.zscripts/start.sh`  
**Dampak:** `set -e` menyebabkan script berhenti di error apapun. Tapi ada beberapa bagian yang sengaja mengabaikan error (`⚠️ mini-services mungkin startup gagal, tapi continue`). Ini bisa menyebabkan partial startup state yang sulit di-debug.

**Fix:**
```sh
#!/bin/sh
# Jangan gunakan set -e karena ada intentional fallback
# Gunakan error handling eksplisit per perintah

# Contoh — check Next.js startup dengan retry:
start_nextjs() {
  local retries=3
  while [ $retries -gt 0 ]; do
    bun --max-old-space-size=384 server.js &
    NEXT_PID=$!
    sleep 2
    if kill -0 "$NEXT_PID" 2>/dev/null; then
      echo "✅ Next.js started (PID: $NEXT_PID)"
      return 0
    fi
    retries=$((retries - 1))
    echo "⚠️ Retry Next.js startup... ($retries left)"
    sleep 3
  done
  echo "❌ Next.js gagal start setelah 3 percobaan"
  return 1
}
```

---

## 5. STB / Memory — Hemat RAM 2 GB

### STB-01 🔵 BullMQ + ioredis diimport meskipun tidak ada Redis

**File:** `src/lib/job-queue.ts`  
**Dampak:** `bullmq` dan `ioredis` adalah library berat (~5-10MB memory) yang diload meskipun `REDIS_URL` tidak di-set dan sistem fallback ke in-memory queue.

**Fix — gunakan dynamic import bersyarat:**
```typescript
// src/lib/job-queue.ts
let _bullMQLoaded = false;

async function tryLoadBullMQ(): Promise<boolean> {
  if (!process.env.REDIS_URL) return false;
  try {
    // Hanya import jika Redis tersedia
    const { Queue, Worker } = await import('bullmq');
    // ... setup
    _bullMQLoaded = true;
    return true;
  } catch {
    console.warn('[JobQueue] BullMQ tidak tersedia, pakai in-memory fallback');
    return false;
  }
}
```

Dan di `package.json`, tandai sebagai optional atau pisahkan:
```json
"optionalDependencies": {
  "bullmq": "^5.35.0",
  "ioredis": "^5.6.1"
}
```

---

### STB-02 🔵 `@mdxeditor/editor` dan `framer-motion` tidak di-lazy load

**File:** Berbagai komponen ERP  
**Dampak:** Dua library terberat di bundle diload pada initial page load. Di STB, ini memperlambat startup dan menghabiskan RAM yang tidak perlu di halaman yang tidak pakai editor/animasi.

**Fix — gunakan Next.js dynamic import:**
```typescript
// Ganti import statis:
import { MDXEditor } from '@mdxeditor/editor';

// Dengan dynamic import:
import dynamic from 'next/dynamic';
const MDXEditor = dynamic(
  () => import('@mdxeditor/editor').then(m => m.MDXEditor),
  { ssr: false, loading: () => <div>Loading editor...</div> }
);

// Untuk framer-motion — gunakan CSS transition sebagai pengganti di STB:
// Atau:
const MotionDiv = dynamic(
  () => import('framer-motion').then(m => m.motion.div),
  { ssr: false }
);
```

---

### STB-03 🔵 Sentry diload tanpa kondisi STB

**File:** `package.json`, `next.config.ts`, `src/instrumentation.ts`  
**Dampak:** `@sentry/nextjs` menambahkan overhead ~15-20MB di runtime untuk error tracking. Di STB dengan RAM 2 GB, ini sia-sia jika tidak ada koneksi internet yang reliable untuk kirim error ke Sentry.

**Fix — kondisikan berdasarkan env:**
```typescript
// next.config.ts
const sentryConfig = process.env.SENTRY_DSN && !isSTB ? {
  // ... sentry withSentryConfig wrapper
} : {};
```

Dan di `.env`:
```bash
# Di STB — biarkan kosong untuk disable Sentry
SENTRY_DSN=
```

---

### STB-04 🔵 Worker process tidak dipisah dari main Next.js process

**File:** `src/lib/worker.ts`, `.zscripts/start.sh`  
**Dampak:** `worker.ts` seharusnya dijalankan sebagai proses terpisah (sudah ada filenya), tapi `start.sh` tidak menjalankannya. Semua background job (WhatsApp, stock sync, cleanup) akhirnya jalan di request thread Next.js, memperlambat API response.

**Fix — jalankan worker di `start.sh`:**
```sh
# Di start.sh, setelah start Next.js:
echo "🔧 Starting background worker..."
cd next-service-dist/ || exit 1
bun --max-old-space-size=64 worker.js &   # budget kecil untuk worker
WORKER_PID=$!
pids="$pids $WORKER_PID"
cd ../

# Note: worker.js harus di-build dari src/lib/worker.ts
# Tambah di package.json scripts:
# "build:worker": "bun build src/lib/worker.ts --outdir .next/standalone --target bun"
```

---

### STB-05 🔵 Memory Guard baseline tidak di-reset setelah GC

**File:** `src/lib/memory-guard.ts`  
**Dampak:** `baselineHeapMB` diset sekali saat startup. Jika GC berjalan dan heap menyusut signifikan, baseline tidak diupdate → threshold `HEAP_GROWTH_THRESHOLD_MB` (40 MB untuk STB) menjadi tidak akurat dan terlalu agresif.

**Fix:**
```typescript
// Di MemoryGuard.check(), update baseline jika heap menyusut:
private check(): void {
  const stats = this.getStats();
  const heapTotalMB = stats.heapTotalMB;

  // Update baseline jika heap menyusut (GC berhasil)
  if (heapTotalMB < this.baselineHeapMB * 0.8) {
    this.baselineHeapMB = heapTotalMB;
    console.log(`[MemoryGuard] Baseline diupdate ke ${this.baselineHeapMB.toFixed(1)}MB setelah GC`);
  }

  // ... rest of check()
}
```

---

### STB-06 🔵 `proactiveDrain` interval 2 menit bisa terlalu sering untuk SQLite

**File:** `src/lib/memory-guard.ts`  
**Dampak:** Jika menggunakan SQLite lokal (bukan Supabase), menutup semua pool setiap 2 menit menyebabkan connection setup overhead yang signifikan di STB yang lambat.

**Fix — sesuaikan interval:**
```typescript
// Naikkan interval untuk SQLite:
const drainInterval = process.env.DATABASE_URL?.startsWith('file:')
  ? 10 * 60 * 1000  // 10 menit untuk SQLite
  : 2 * 60 * 1000;  // 2 menit untuk Supabase

this.drainInterval = setInterval(() => {
  this.proactiveDrain();
}, drainInterval);
```

---

### STB-07 🔵 `next.config.ts` tidak set `compress: true` untuk STB

**File:** `next.config.ts`  
**Dampak:** Tanpa kompresi gzip/brotli di level Next.js, semua response dikirim uncompressed. Caddy memang bisa handle kompresi, tapi untuk endpoint yang bypass Caddy, tidak ada kompresi.

**Fix:**
```typescript
const nextConfig: NextConfig = {
  output: "standalone",
  compress: true,  // ✅ tambah ini — aktifkan gzip di Next.js
  // ... rest config
};
```

---

## 6. KUALITAS KODE & MAINTAINABILITY

### CODE-01 ⚪ `toCamelCase` tidak handle circular reference

**File:** `src/lib/supabase-helpers.ts`  
Fungsi rekursif `toCamelCase` tidak ada proteksi terhadap circular reference. Jika Supabase mengembalikan data dengan relasi melingkar (tidak biasa tapi mungkin), fungsi ini akan stack overflow.

**Fix — tambah Set untuk tracking:**
```typescript
export function toCamelCase<T = Record<string, any>>(
  row: Record<string, any> | null,
  _seen = new WeakSet()
): T | null {
  if (!row) return null;
  if (_seen.has(row)) return row as unknown as T; // prevent infinite loop
  _seen.add(row);
  // ... rest of function, pass _seen ke recursive calls
}
```

---

### CODE-02 ⚪ `generateInvoiceNo` tidak atomic — race condition di concurrent requests

**File:** `src/lib/supabase-helpers.ts` (atau equivalent)  
Pembuatan nomor invoice berdasarkan timestamp + count tidak atomic. Di concurrent requests (banyak sales order masuk bersamaan), bisa menghasilkan invoice number duplikat.

**Fix — gunakan database sequence atau RPC atomic:**
```sql
-- PostgreSQL function (tambah ke ensure-rpc.ts):
CREATE OR REPLACE FUNCTION generate_invoice_no(
  p_prefix TEXT DEFAULT 'INV',
  p_date DATE DEFAULT CURRENT_DATE
) RETURNS TEXT AS $$
DECLARE
  v_seq INTEGER;
  v_year TEXT;
  v_month TEXT;
  v_day TEXT;
BEGIN
  -- Atomic increment dengan sequence per-hari
  INSERT INTO invoice_sequences (date_key, last_seq)
  VALUES (p_date::TEXT, 1)
  ON CONFLICT (date_key) DO UPDATE
  SET last_seq = invoice_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;

  v_year  := to_char(p_date, 'YY');
  v_month := to_char(p_date, 'MM');
  v_day   := to_char(p_date, 'DD');

  RETURN p_prefix || '/' || v_year || v_month || v_day || '/' || lpad(v_seq::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;
```

---

### CODE-03 ⚪ `verifyAndGetAuthUser` melakukan 2 DB query per request

**File:** `src/lib/token.ts`  
Setiap authenticated API request melakukan:
1. Verify HMAC token (in-memory ✅)
2. Query DB untuk check `is_active` (DB query ❌)
3. Query DB lagi untuk ambil data user (DB query ❌)

Di STB dengan koneksi DB ke Supabase melalui network, ini 2 round-trip per request.

**Fix — gabungkan menjadi 1 query:**
```typescript
export async function verifyAndGetAuthUser(
  authHeader: string | null,
  options: { role?: boolean } = {}
): Promise<{ userId: string; user: any } | null> {
  const userId = verifyAuthToken(authHeader);
  if (!userId) return null;

  // ✅ Single query dengan select tergantung options
  const select = options.role
    ? 'id, name, role, is_active, status, unit_id'
    : 'id, is_active, status';

  const { data } = await db
    .from('users')
    .select(select)
    .eq('id', userId)
    .maybeSingle();

  if (!data || !data.is_active || data.status !== 'approved') return null;
  return { userId: data.id, user: toCamelCase(data) };
}
```

---

### CODE-04 ⚪ `worklog.md` mengandung credential dan internal path

**File:** `worklog.md`  
Worklog berisi detail internal path, error message, dan strategi yang bisa berguna bagi attacker untuk memahami arsitektur sistem.

**Rekomendasi:** Pindahkan ke file terpisah yang di-gitignore, atau hapus sebelum deploy ke production.

---

## 7. PANDUAN LANGKAH PERBAIKAN (Step-by-Step)

Jalankan semua fix berikut secara berurutan. **Mulai dari yang paling kritis.**

### FASE 1 — Kritis (Sebelum Deploy)

```bash
# ════════════════════════════════════════════════════════════
# STEP 1: Fix build script — tambah prisma generate
# ════════════════════════════════════════════════════════════
# Edit package.json:
# Ubah "build" script menjadi:
# "build": "prisma generate && next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/"

# ════════════════════════════════════════════════════════════
# STEP 2: Aktifkan STB_MODE di .env
# ════════════════════════════════════════════════════════════
echo "STB_MODE=true" >> .env

# Hapus NODE_ENV dari .env (biarkan start.sh yang handle):
sed -i '/^NODE_ENV=/d' .env

# Perbaiki APP_URL:
# Edit .env: NEXT_PUBLIC_APP_URL=http://<IP-STB>:81

# ════════════════════════════════════════════════════════════
# STEP 3: Generate AUTH_SECRET yang kuat
# ════════════════════════════════════════════════════════════
NEW_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# Atau dengan bun:
NEW_SECRET=$(bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Update di .env:
sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=$NEW_SECRET/" .env

# ════════════════════════════════════════════════════════════
# STEP 4: Fix .gitignore
# ════════════════════════════════════════════════════════════
cat >> .gitignore << 'EOF'

# Environment secrets — JANGAN COMMIT
.env
.env.local
.env.production
db/.auth-secret
db/rate-limits.json
EOF

# ════════════════════════════════════════════════════════════
# STEP 5: Fix validator — tambah discount fields
# ════════════════════════════════════════════════════════════
# Edit src/lib/validators.ts:
# Di transactionItemSchema tambah:
#   discount: z.number().min(0).max(100).optional().default(0),
#   discountAmount: z.number().min(0).optional().default(0),
#   discountType: z.enum(['percent', 'nominal']).optional().default('percent'),
#
# Di transactionSchemas.create tambah:
#   globalDiscount: z.number().min(0).max(100).optional().default(0),
#   globalDiscountAmount: z.number().min(0).optional().default(0),

# ════════════════════════════════════════════════════════════
# STEP 6: Fix Caddyfile — tambah flush_interval untuk SSE
# ════════════════════════════════════════════════════════════
# Edit Caddyfile sesuai fix BUG-05 di atas

# ════════════════════════════════════════════════════════════
# STEP 7: Fix start.sh — tambah memory limit dan STB_MODE
# ════════════════════════════════════════════════════════════
# Di .zscripts/start.sh, ubah bagian start Next.js:
# DARI:
#   bun server.js &
# MENJADI:
#   export STB_MODE=true
#   export NODE_OPTIONS="--max-old-space-size=384"
#   bun server.js &
```

### FASE 2 — Fungsional (Sprint Berikutnya)

```bash
# ════════════════════════════════════════════════════════════
# STEP 8: Fix TypeScript errors
# ════════════════════════════════════════════════════════════
# Edit next.config.ts:
# typescript: { ignoreBuildErrors: false }

# Lalu cek error:
bun run build 2>&1 | grep "Type error"

# Perbaiki satu per satu sebelum re-enable

# ════════════════════════════════════════════════════════════
# STEP 9: Aktifkan React Strict Mode
# ════════════════════════════════════════════════════════════
# Edit next.config.ts:
# reactStrictMode: true,
# Lalu jalankan dev dan perbaiki double-effect yang muncul

# ════════════════════════════════════════════════════════════
# STEP 10: Pindahkan BullMQ ke optionalDependencies
# ════════════════════════════════════════════════════════════
# Edit package.json:
# Pindahkan "bullmq" dan "ioredis" dari "dependencies" ke "optionalDependencies"
# Edit src/lib/job-queue.ts untuk dynamic import bersyarat

# ════════════════════════════════════════════════════════════
# STEP 11: Lazy load MDXEditor dan framer-motion
# ════════════════════════════════════════════════════════════
# Cari semua komponen yang import MDXEditor atau motion dari framer-motion:
grep -rn "from '@mdxeditor/editor'" src/
grep -rn "from 'framer-motion'" src/
# Ganti dengan dynamic import sesuai contoh di STB-02

# ════════════════════════════════════════════════════════════
# STEP 12: Fix Cache-Control di next.config.ts
# ════════════════════════════════════════════════════════════
# Edit next.config.ts sesuai fix SEC-03

# ════════════════════════════════════════════════════════════
# STEP 13: Unify circuit breaker
# ════════════════════════════════════════════════════════════
# Edit src/lib/graceful-degradation.ts sesuai fix BUG-12
```

### FASE 3 — Maintenance (Ongoing)

```bash
# ════════════════════════════════════════════════════════════
# STEP 14: Ganti password database
# ════════════════════════════════════════════════════════════
# Di Supabase Dashboard:
# Settings → Database → Reset database password
# Update DATABASE_URL, DIRECT_URL, SUPABASE_DB_URL, SUPABASE_POOLER_URL di .env

# ════════════════════════════════════════════════════════════
# STEP 15: Implementasi invoice number atomic
# ════════════════════════════════════════════════════════════
# Tambahkan fungsi generate_invoice_no ke src/lib/ensure-rpc.ts
# Buat tabel invoice_sequences di Supabase:
# CREATE TABLE invoice_sequences (date_key TEXT PRIMARY KEY, last_seq INTEGER);

# ════════════════════════════════════════════════════════════
# STEP 16: Monitor memory setelah deploy ke STB
# ════════════════════════════════════════════════════════════
# Setelah deploy, pantau dengan:
watch -n 30 'cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|Buffers|Cached"'

# Dan check endpoint health:
curl http://localhost:3000/api/health | jq .
curl http://localhost:3000/api/system-stats | jq .memory
```

---

## CHECKLIST DEPLOY KE STB

Gunakan checklist ini sebelum setiap deploy ke STB:

- [ ] `prisma generate` ada di script build
- [ ] `STB_MODE=true` ada di `.env` dan `start.sh`
- [ ] `--max-old-space-size=384` ada di command `bun server.js`
- [ ] `AUTH_SECRET` adalah random hex 64 karakter (bukan string sederhana)
- [ ] `.env` ada di `.gitignore`
- [ ] `NEXT_PUBLIC_APP_URL` mengarah ke IP/domain STB yang benar
- [ ] Caddyfile punya `flush_interval -1` untuk endpoint SSE
- [ ] `typescript.ignoreBuildErrors` = `false` (atau semua TS errors sudah diperbaiki)
- [ ] `NODE_ENV` tidak ada di `.env` (diset oleh `start.sh`)
- [ ] Database password sudah diganti setelah `.env` sempat ter-commit
- [ ] Discount fields ada di `transactionItemSchema`

---

*Laporan ini dihasilkan dari analisis statis kode sumber build 3MEI (3 Mei 2026).*  
*Prioritaskan Fase 1 sebelum deploy ke device STB manapun.*
