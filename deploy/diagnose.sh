#!/bin/bash
# ============================================================
# Razkindo ERP - Diagnostic Script
# Cek koneksi Supabase + Database langsung dari STB
#
# Cara pakai:
#   bash deploy/diagnose.sh
# ============================================================

set -euo pipefail

APP_DIR="/DATA/erpstb"
ENV_FILE="$APP_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_fail()  { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_info()  { echo -e "${CYAN}[INFO]${NC} $1"; }

echo ""
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Razkindo ERP - Diagnostik${NC}"
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo ""

ERRORS=0

# ── 1. Cek .env exists ──
echo "━━━ 1. File .env ━━━"
if [ ! -f "$ENV_FILE" ]; then
    log_fail ".env TIDAK DITEMUKAN di $ENV_FILE"
    echo "  Solusi: jalankan → bash deploy/deploy.sh --setup-env"
    ERRORS=$((ERRORS + 1))
    echo ""
    echo "Diagnostik dihentikan — .env harus ada dulu."
    exit 1
fi
log_ok ".env ditemukan di $ENV_FILE"

# ── 2. Parse dan validasi .env ──
echo ""
echo "━━━ 2. Isi .env ━━━"

# Source .env (aman, hanya baca)
SUPABASE_URL=""
SUPABASE_ANON=""
SERVICE_ROLE=""
DATABASE_URL=""
DIRECT_URL=""
AUTH_SECRET=""

while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    # Trim whitespace
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)

    case "$key" in
        NEXT_PUBLIC_SUPABASE_URL) SUPABASE_URL="$value" ;;
        NEXT_PUBLIC_SUPABASE_ANON_KEY) SUPABASE_ANON="$value" ;;
        SUPABASE_SERVICE_ROLE_KEY) SERVICE_ROLE="$value" ;;
        DATABASE_URL) DATABASE_URL="$value" ;;
        DIRECT_URL) DIRECT_URL="$value" ;;
        AUTH_SECRET) AUTH_SECRET="$value" ;;
    esac
done < "$ENV_FILE"

# Tampilkan (sembunyikan password)
echo "  NEXT_PUBLIC_SUPABASE_URL: ${SUPABASE_URL:-<kosong>}"
echo "  NEXT_PUBLIC_SUPABASE_ANON_KEY: ${SUPABASE_ANON:0:20}... ($(echo -n "$SUPABASE_ANON" | wc -c) chars)"
echo "  SUPABASE_SERVICE_ROLE_KEY: ${SERVICE_ROLE:0:20}... ($(echo -n "$SERVICE_ROLE" | wc -c) chars)"
echo "  DATABASE_URL: ${DATABASE_URL%%@*}@*** ($(echo -n "$DATABASE_URL" | wc -c) chars)"
echo "  DIRECT_URL: ${DIRECT_URL:-<kosong>}"
echo "  AUTH_SECRET: ${AUTH_SECRET:0:10}... ($(echo -n "$AUTH_SECRET" | wc -c) chars)"

# ── 3. Validasi format ──
echo ""
echo "━━━ 3. Validasi Format ━━━"

# Supabase URL
if [[ "$SUPABASE_URL" =~ ^https://[a-z0-9]+\.supabase\.co$ ]]; then
    log_ok "Supabase URL valid: $SUPABASE_URL"
else
    log_fail "Supabase URL TIDAK valid: '$SUPABASE_URL'"
    echo "  Harus format: https://xxxxx.supabase.co"
    ERRORS=$((ERRORS + 1))
fi

# Anon Key
if [[ ${#SUPABASE_ANON} -gt 50 ]]; then
    log_ok "Supabase Anon Key terisi ($(echo -n "$SUPABASE_ANON" | wc -c) chars)"
else
    log_fail "Supabase Anon Key terlalu pendek atau kosong"
    ERRORS=$((ERRORS + 1))
fi

# Database URL
if [[ "$DATABASE_URL" =~ ^postgresql:// ]]; then
    log_ok "DATABASE_URL format valid (postgresql://)"

    # Cek placeholder
    if [[ "$DATABASE_URL" == *"YOUR_PASSWORD"* ]]; then
        log_fail "DATABASE_URL masih berisi placeholder YOUR_PASSWORD!"
        ERRORS=$((ERRORS + 1))
    elif [[ "$DATABASE_URL" == *"your-project"* ]]; then
        log_fail "DATABASE_URL masih berisi placeholder!"
        ERRORS=$((ERRORS + 1))
    else
        log_ok "DATABASE_URL terisi kredensial"
    fi
else
    log_fail "DATABASE_URL TIDAK valid: harus mulai dengan postgresql://"
    echo "  Saat ini: ${DATABASE_URL:0:30}..."
    ERRORS=$((ERRORS + 1))
fi

# Auth Secret
if [[ ${#AUTH_SECRET} -ge 16 ]]; then
    log_ok "AUTH_SECRET terisi ($(echo -n "$AUTH_SECRET" | wc -c) chars)"
else
    log_fail "AUTH_SECRET terlalu pendek (min 16 chars). Saat ini: ${#AUTH_SECRET} chars"
    ERRORS=$((ERRORS + 1))
fi

# ── 4. Cek koneksi jaringan ke Supabase ──
echo ""
echo "━━━ 4. Koneksi Jaringan ━━━"

if command -v curl &>/dev/null; then
    # Cek DNS
    if host=$(echo "$SUPABASE_URL" | sed 's|https://||;s|/.*||'); then
        if curl -sf --connect-timeout 10 "$SUPABASE_URL" > /dev/null 2>&1; then
            log_ok "Supabase reachable: $SUPABASE_URL"
        else
            log_fail "TIDAK bisa konek ke $SUPABASE_URL (timeout atau DNS gagal)"
            ERRORS=$((ERRORS + 1))
        fi
    fi

    # Cek koneksi ke DB host (dari DATABASE_URL)
    if [[ "$DATABASE_URL" =~ ^postgresql://([^:]+):([^@]+)@([^:/]+):([0-9]+)/(.*)$ ]]; then
        DB_USER="${BASH_REMATCH[1]}"
        DB_PASS="${BASH_REMATCH[2]}"
        DB_HOST="${BASH_REMATCH[3]}"
        DB_PORT="${BASH_REMATCH[4]}"
        DB_NAME="${BASH_REMATCH[5]}"

        log_info "DB Host: $DB_HOST:$DB_PORT, Database: ${DB_NAME%%\?*}"

        # Cek TCP koneksi ke DB port
        if timeout 10 bash -c "echo > /dev/tcp/$DB_HOST/$DB_PORT" 2>/dev/null; then
            log_ok "TCP koneksi ke $DB_HOST:$DB_PORT berhasil"
        else
            log_fail "TCP koneksi ke $DB_HOST:$DB_PORT GAGAL (firewall/tidak reachable)"
            ERRORS=$((ERRORS + 1))
        fi
    else
        log_warn "Tidak bisa parse DATABASE_URL untuk cek koneksi TCP"
    fi
else
    log_warn "curl tidak tersedia, skip cek jaringan"
fi

# ── 5. Cek proses aplikasi ──
echo ""
echo "━━━ 5. Status Aplikasi ━━━"

# Cek Docker
if command -v docker &>/dev/null; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "razkindo-erp"; then
        log_ok "Docker container 'razkindo-erp' berjalan"
        echo "  Container logs (20 baris terakhir):"
        docker logs razkindo-erp --tail=20 2>&1 | sed 's/^/  │ /'
    else
        log_warn "Docker container 'razkindo-erp' TIDAK berjalan"
    fi
fi

# Cek port 3000
if ss -tlnp 2>/dev/null | grep -q ':3000'; then
    PID=$(ss -tlnp 'sport = :3000' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    log_ok "Ada proses di port 3000 (PID: $PID)"
else
    log_warn "Tidak ada proses di port 3000 — aplikasi tidak berjalan"
fi

# Cek health endpoint
if curl -sf --connect-timeout 5 "http://localhost:3000/api/health" > /dev/null 2>&1; then
    HEALTH=$(curl -sf --connect-timeout 5 "http://localhost:3000/api/health" 2>/dev/null || echo "{}")
    DB_STATUS=$(echo "$HEALTH" | grep -o '"database":"[^"]*"' | head -1 || echo "")
    ENV_STATUS=$(echo "$HEALTH" | grep -o '"env_has_db_url":[^,}]*' | head -1 || echo "")
    log_ok "Health endpoint: $DB_STATUS, $ENV_STATUS"
else
    log_fail "Health endpoint (/api/health) tidak merespon — aplikasi mungkin crash"
    ERRORS=$((ERRORS + 1))
fi

# ── 6. Cek server.log ──
echo ""
echo "━━━ 6. Log Terakhir ━━━"
if [ -f "$APP_DIR/server.log" ]; then
    echo "  server.log (20 baris terakhir):"
    tail -20 "$APP_DIR/server.log" 2>&1 | sed 's/^/  │ /'
elif [ -f "$APP_DIR/.next/standalone/server.log" ]; then
    echo "  server.log (20 baris terakhir):"
    tail -20 "$APP_DIR/.next/standalone/server.log" 2>&1 | sed 's/^/  │ /'
else
    log_warn "server.log tidak ditemukan"
fi

# ── Summary ──
echo ""
echo -e "${CYAN}════════════════════════════════════════════${NC}"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}  Semua cek berhasil! ✅${NC}"
    echo -e "${GREEN}  Jika masih error, coba restart:${NC}"
    echo -e "    bash deploy/deploy.sh --artifact"
else
    echo -e "${RED}  Ditemukan $ERRORS masalah! ❌${NC}"
    echo ""
    echo "  Solusi umum:"
    echo "  1. Fix .env: bash deploy/deploy.sh --setup-env"
    echo "  2. Cek internet STB: ping google.com"
    echo "  3. Cek Supabase dashboard: apakah project aktif?"
    echo "  4. Cek password DB di Supabase > Settings > Database"
fi
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo ""
