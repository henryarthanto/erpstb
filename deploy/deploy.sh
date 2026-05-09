#!/bin/bash
# ============================================================
# Razkindo ERP - Fast Deploy Script untuk STB (ARM64)
#
# Cara pakai:
#   chmod +x deploy/deploy.sh
#   ./deploy/deploy.sh              # git pull + build lokal + restart
#   ./deploy/deploy.sh --artifact   # download artifact dari CI (paling cepat)
#   ./deploy/deploy.sh --docker     # pull Docker image dari GHCR + restart
#   ./deploy/deploy.sh --pull-only  # git pull saja, tanpa build
# ============================================================

set -euo pipefail

# ── Config ──
APP_DIR="/DATA/erpstb"
# Tag release "erp-latest" — selalu update di setiap push main
ARTIFACT_URL="https://github.com/henryarthanto/erpstb/releases/download/erp-latest/erp-standalone-arm64.tar.gz"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
HEALTH_URL="http://localhost:3000/api/health"
MAX_WAIT=120

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Auto-detect Node.js / npm / npx / bun paths ──
# Cron dan non-interactive shell tidak punya PATH lengkap
detect_node_env() {
    # 1. Source nvm jika ada
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        . "$NVM_DIR/nvm.sh"
    fi

    # 2. Source n jika ada
    if [ -s "$HOME/.n/nvm.sh" ]; then
        . "$HOME/.n/nvm.sh"
    fi

    # 3. Tambahkan common Node.js paths ke PATH
    local extra_paths=(
        "$HOME/.nvm/versions/node/$(ls -t "$HOME/.nvm/versions/node/" 2>/dev/null | head -1)/bin"
        "$HOME/.n/bin"
        "$HOME/.local/bin"
        "$HOME/.bun/bin"
        "/usr/local/bin"
        "/usr/bin"
        "$APP_DIR/node_modules/.bin"
    )

    for p in "${extra_paths[@]}"; do
        if [ -d "$p" ] && [[ ":$PATH:" != *":$p:"* ]]; then
            export PATH="$p:$PATH"
        fi
    done

    # 4. Verify
    if ! command -v node &>/dev/null; then
        log_error "Node.js TIDAK DITEMUKAN di PATH"
        log_error "PATH saat ini: $PATH"
        log_error "Install Node.js dulu atau jalankan script ini dari shell interaktif"
        exit 1
    fi

    log_info "Node.js: $(node -v) ($(command -v node))"
    log_info "npm: $(command -v npm 2>/dev/null || echo 'not found')"
    log_info "npx: $(command -v npx 2>/dev/null || echo 'not found')"
    log_info "bun: $(command -v bun 2>/dev/null || echo 'not found')"
}

# ── Wait for health check ──
wait_healthy() {
    local elapsed=0
    log_info "Menunggu aplikasi healthy..."
    while [ $elapsed -lt $MAX_WAIT ]; do
        if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
            log_ok "Aplikasi healthy (${elapsed}s)"
            return 0
        fi
        sleep 3
        elapsed=$((elapsed + 3))
        echo -ne "\r  Menunggu... ${elapsed}s / ${MAX_WAIT}s"
    done
    echo ""
    log_warn "Health check timeout (${MAX_WAIT}s), tapi proses jalan"
    return 1
}

# ── Stop current process ──
stop_app() {
    log_info "Menghentikan aplikasi..."

    # Coba stop Docker dulu
    if command -v docker &>/dev/null && [ -f "$COMPOSE_FILE" ]; then
        if docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; then
            docker compose -f "$COMPOSE_FILE" down 2>/dev/null && log_ok "Docker stopped"
            return
        fi
    fi

    # Coba stop PM2
    if command -v pm2 &>/dev/null && pm2 describe erp &>/dev/null; then
        pm2 stop erp 2>/dev/null && log_ok "PM2 stopped"
        return
    fi

    # Coba kill process di port 3000
    local pid
    pid=$(lsof -ti :3000 2>/dev/null || ss -tlnp 'sport = :3000' 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
    if [ -n "$pid" ]; then
        kill -15 "$pid" 2>/dev/null
        sleep 2
        kill -9 "$pid" 2>/dev/null || true
        log_ok "Process stopped (PID: $pid)"
        return
    fi

    log_warn "Tidak ada proses yang berjalan"
}

# ── Backup & Restore .env (supaya credentials tidak hilang saat git pull) ──
backup_env() {
    if [ -f "$APP_DIR/.env" ]; then
        cp "$APP_DIR/.env" "/tmp/erp-env-backup"
        log_info ".env backed up"
    fi
}

restore_env() {
    if [ -f "/tmp/erp-env-backup" ]; then
        cp "/tmp/erp-env-backup" "$APP_DIR/.env"
        log_ok ".env restored"
        rm -f "/tmp/erp-env-backup"
    fi
}

# ── MODE: Git Pull + Build Lokal ──
mode_local() {
    log_info "=== MODE: Git Pull + Build Lokal ==="
    cd "$APP_DIR"

    # 0. Backup .env sebelum git pull
    backup_env

    # 1. Git pull (reset --hard untuk overwrite local changes)
    log_info "Git pull..."
    git fetch origin main
    git reset --hard origin/main
    log_ok "Code updated"

    # 1b. Restore .env setelah git pull
    restore_env

    # 2. Install deps
    log_info "Installing dependencies..."
    if command -v bun &>/dev/null; then
        bun install --frozen-lockfile 2>/dev/null || bun install
    elif command -v npm &>/dev/null; then
        npm install --legacy-peer-deps
    else
        log_error "Tidak ada bun atau npm. Install salah satu."
        exit 1
    fi

    # 3. Generate Prisma client (bunx = pengganti npx di bun)
    log_info "Generating Prisma client..."
    if command -v bun &>/dev/null; then
        bunx prisma generate
    elif command -v npx &>/dev/null; then
        npx prisma generate
    else
        log_error "Tidak ada bunx atau npx untuk generate Prisma"
        exit 1
    fi

    # 4. Build
    log_info "Building Next.js (standalone)..."
    if command -v bun &>/dev/null; then
        bun run build
    elif command -v npm &>/dev/null; then
        npm run build
    else
        log_error "Tidak ada bun atau npm untuk build"
        exit 1
    fi
    log_ok "Build selesai"
}

# ── MODE: Download Artifact ( tercepat) ──
mode_artifact() {
    log_info "=== MODE: Download Artifact ( tercepat) ==="
    cd "$APP_DIR"

    # Backup .env sebelum extract (jika ada perubahan di repo)
    backup_env

    log_info "Downloading standalone artifact..."
    local tmpfile="/tmp/erp-standalone.tar.gz"

    if ! curl -fSL -o "$tmpfile" "$ARTIFACT_URL"; then
        log_error "Download artifact gagal. Coba gunakan mode --docker atau --local"
        exit 1
    fi

    log_ok "Download selesai ($(du -h "$tmpfile" | cut -f1))"

    # Backup lama
    if [ -d "$APP_DIR/.next/standalone" ]; then
        log_info "Backup versi lama..."
        mv "$APP_DIR/.next/standalone" "$APP_DIR/.next/standalone.bak"
    fi

    # Extract
    log_info "Extracting..."
    mkdir -p "$APP_DIR/.next/standalone"
    tar -xzf "$tmpfile" -C "$APP_DIR/.next/standalone"
    rm -f "$tmpfile"

    # Copy prisma & public jika ada
    if [ -d "$APP_DIR/.next/standalone/prisma" ]; then
        cp -r "$APP_DIR/.next/standalone/prisma" "$APP_DIR/prisma" 2>/dev/null || true
    fi

    log_ok "Artifact extracted"
}

# ── MODE: Docker Pull dari GHCR ──
mode_docker() {
    log_info "=== MODE: Docker Pull dari GHCR ==="
    cd "$APP_DIR"

    if ! command -v docker &>/dev/null; then
        log_error "Docker tidak ditemukan"
        exit 1
    fi

    # Pastikan docker-compose pakai image GHCR
    if ! grep -q "ghcr.io/henryarthanto/razkindo-erp" "$COMPOSE_FILE" 2>/dev/null; then
        log_error "docker-compose.yml belum set ke GHCR image"
        exit 1
    fi

    log_info "Pulling image..."
    docker compose -f "$COMPOSE_FILE" pull

    log_ok "Image pulled"
}

# ── MODE: Git Pull Only ──
mode_pull_only() {
    log_info "=== MODE: Git Pull Only ==="
    cd "$APP_DIR"

    backup_env
    git fetch origin main
    git reset --hard origin/main
    restore_env
    log_ok "Code updated (no build)"
}

# ── Force kill anything on port 3000 ──
kill_port_3000() {
    local pid
    pid=$(ss -tlnp 'sport = :3000' 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
    if [ -n "$pid" ]; then
        log_info "Menghentikan proses di port 3000 (PID: $pid)..."
        kill -9 "$pid" 2>/dev/null || true
        sleep 1
    fi
}

# ── Start aplikasi ──
start_app() {
    log_info "Memulai aplikasi..."

    # Coba Docker dulu
    if command -v docker &>/dev/null && [ -f "$COMPOSE_FILE" ]; then
        if grep -q "ghcr.io" "$COMPOSE_FILE" 2>/dev/null; then
            kill_port_3000
            docker compose -f "$COMPOSE_FILE" up -d
            log_ok "Started via Docker"
            wait_healthy
            return
        fi
    fi

    # Coba PM2
    if command -v pm2 &>/dev/null; then
        pm2 start "$APP_DIR/ecosystem.config.js" --name erp 2>/dev/null || \
        pm2 start "cd $APP_DIR && npm run start" --name erp
        log_ok "Started via PM2"
        wait_healthy
        return
    fi

    # Direct: nohup
    cd "$APP_DIR"
    export NODE_ENV=production
    export STB_MODE=true
    export HOSTNAME="0.0.0.0"
    export PORT=3000
    nohup node .next/standalone/server.js > server.log 2>&1 &
    log_ok "Started via nohup (PID: $!) with STB_MODE=true"
    wait_healthy
}

# ── MODE: Setup .env (interaktif) ──
mode_setup_env() {
    log_info "=== MODE: Setup .env ==="
    cd "$APP_DIR"

    # Jika .env sudah ada, tampilkan isinya (sembunyikan password)
    if [ -f "$APP_DIR/.env" ]; then
        log_info ".env sudah ada. Isi saat ini:"
        echo "────────────────────────────────────────"
        while IFS='=' read -r key value; do
            # Skip comments dan empty lines
            [[ "$key" =~ ^#.*$ ]] && continue
            [[ -z "$key" ]] && continue
            # Sembunyikan password/key
            if [[ "$key" =~ (PASSWORD|SECRET|TOKEN|KEY) ]]; then
                echo "  ${CYAN}${key}${NC}=***hidden***"
            else
                echo "  ${CYAN}${key}${NC}=${value}"
            fi
        done < "$APP_DIR/.env"
        echo "────────────────────────────────────────"
        echo ""
        read -p "Ingin mengedit? [y/N]: " edit_choice
        if [[ ! "$edit_choice" =~ ^[Yy]$ ]]; then
            log_ok ".env tidak diubah"
            return
        fi
    fi

    echo ""
    log_info "Masukkan konfigurasi Supabase:"
    echo "(Tekan Enter untuk menggunakan nilai default atau nilai sebelumnya)"
    echo ""

    # Baca nilai lama jika ada
    local old_supabase_url="" old_anon_key="" old_service_key="" old_db_url="" old_direct_url="" old_auth_secret=""
    if [ -f "$APP_DIR/.env" ]; then
        old_supabase_url=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- || echo "")
        old_anon_key=$(grep -E '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- || echo "")
        old_service_key=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- || echo "")
        old_db_url=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- || echo "")
        old_direct_url=$(grep -E '^DIRECT_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- || echo "")
        old_auth_secret=$(grep -E '^AUTH_SECRET=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- || echo "")
    fi

    # Prompt setiap field
    read -p "NEXT_PUBLIC_SUPABASE_URL [$old_supabase_url]: " supabase_url
    supabase_url="${supabase_url:-$old_supabase_url}"

    read -p "NEXT_PUBLIC_SUPABASE_ANON_KEY [$old_anon_key]: " anon_key
    anon_key="${anon_key:-$old_anon_key}"

    read -p "SUPABASE_SERVICE_ROLE_KEY [$old_service_key]: " service_key
    service_key="${service_key:-$old_service_key}"

    read -p "DATABASE_URL [$old_db_url]: " db_url
    db_url="${db_url:-$old_db_url}"

    read -p "DIRECT_URL [$old_direct_url]: " direct_url
    direct_url="${direct_url:-$old_direct_url}"

    read -p "AUTH_SECRET [$old_auth_secret]: " auth_secret
    auth_secret="${auth_secret:-$old_auth_secret}"

    # Validasi minimal
    if [[ -z "$supabase_url" || "$supabase_url" == *"your-project"* ]]; then
        log_error "Supabase URL tidak valid. Harus format: https://xxxxx.supabase.co"
        exit 1
    fi

    if [[ -z "$db_url" || "$db_url" == *"YOUR_PASSWORD"* ]]; then
        log_error "DATABASE_URL tidak valid. Harus format: postgresql://postgres.xxx:PASSWORD@..."
        exit 1
    fi

    # Generate AUTH_SECRET jika kosong
    if [[ -z "$auth_secret" ]]; then
        auth_secret=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
        log_info "AUTH_SECRET digenerate otomatis"
    fi

    # Tulis .env
    cat > "$APP_DIR/.env" << EOF
# ── Supabase ──
NEXT_PUBLIC_SUPABASE_URL=${supabase_url}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon_key}
SUPABASE_SERVICE_ROLE_KEY=${service_key}

# ── Database (PostgreSQL via Supabase Pooler) ──
DATABASE_URL=${db_url}
DIRECT_URL=${direct_url}

# ── Auth ──
AUTH_SECRET=${auth_secret}

# ── App ──
NEXT_PUBLIC_APP_NAME=Razkindo ERP
NEXT_PUBLIC_APP_URL=http://localhost:3000
LOG_LEVEL=info
NODE_ENV=production
STB_MODE=true
EOF

    chmod 600 "$APP_DIR/.env"
    log_ok ".env berhasil ditulis ke $APP_DIR/.env"
    log_warn "Pastikan Docker compose atau nohup restart agar .env terbaca"
}

# ── Check .env validity ──
check_env() {
    if [ ! -f "$APP_DIR/.env" ]; then
        log_error ".env TIDAK DITEMUKAN di $APP_DIR/.env"
        log_error "Jalankan: bash deploy/deploy.sh --setup-env"
        return 1
    fi

    # Cek apakah ada placeholder values
    if grep -qE '(your-project|YOUR_PASSWORD|your-secret|your-anon)' "$APP_DIR/.env" 2>/dev/null; then
        log_error ".env masih berisi placeholder values!"
        log_error "Jalankan: bash deploy/deploy.sh --setup-env"
        return 1
    fi

    # Cek DATABASE_URL
    if ! grep -qE '^DATABASE_URL=postgresql://' "$APP_DIR/.env" 2>/dev/null; then
        log_error "DATABASE_URL tidak valid di .env"
        log_error "Jalankan: bash deploy/deploy.sh --setup-env"
        return 1
    fi

    log_ok ".env valid"
    return 0
}

# ── Main ──
main() {
    local mode="${1:---local}"

    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  Razkindo ERP - Deploy${NC}"
    echo -e "${CYAN}  Mode: ${mode}${NC}"
    echo -e "${CYAN}  Waktu: $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    case "$mode" in
        --setup-env)
            mode_setup_env
            exit 0
            ;;
        --check-env)
            check_env
            exit $?
            ;;
    esac

    # Auto-detect Node environment (nvm, n, bun, etc.)
    detect_node_env

    # Check dependencies
    if ! command -v git &>/dev/null; then
        log_error "Git tidak ditemukan. Install dulu: apt install git"
        exit 1
    fi

    # Check .env before starting any deploy
    if ! check_env; then
        log_error "Fix .env dulu sebelum deploy"
        exit 1
    fi

    case "$mode" in
        --artifact)
            stop_app
            mode_artifact
            start_app
            ;;
        --docker)
            stop_app
            mode_docker
            start_app
            ;;
        --pull-only)
            mode_pull_only
            log_warn "Restart manual: docker compose restart atau pm2 restart erp"
            ;;
        --local|"")
            stop_app
            mode_local
            start_app
            ;;
        *)
            echo "Usage: $0 [--setup-env|--check-env|--artifact|--docker|--local|--pull-only]"
            echo ""
            echo "  --setup-env   Setup/edit .env file (kredensial Supabase)"
            echo "  --check-env   Cek apakah .env valid"
            echo "  --artifact    Download pre-built artifact dari CI (paling cepat ~30 detik)"
            echo "  --docker      Pull Docker image dari GHCR (~2-5 menit)"
            echo "  --local       Git pull + build di STB (~10-20 menit)"
            echo "  --pull-only   Git pull saja, tanpa build/restart"
            echo ""
            echo "Default: --local"
            exit 1
            ;;
    esac

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Deploy selesai!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
}

main "$@"
