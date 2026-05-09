#!/bin/bash
# ============================================================
# Razkindo ERP - Direct Node.js Deploy untuk STB (tanpa Docker)
# Usage: chmod +x deploy-stb.sh && ./deploy-stb.sh
# ============================================================

set -e

APP_DIR="/DATA/erpstb"
NODE_VERSION="20"

echo "=========================================="
echo "  Razkindo ERP - STB Direct Deploy"
echo "=========================================="

# 1. Cek bun (utamakan) atau Node.js
USE_BUN=false
BUN_PATH=""
NODE_PATH=""

if command -v bun &> /dev/null; then
    USE_BUN=true
    BUN_PATH=$(which bun)
    echo "[OK] bun $(bun --version)"
elif command -v node &> /dev/null; then
    NODE_PATH=$(which node)
    echo "[OK] Node.js $(node --version)"
else
    echo "[!] Node.js/bun tidak ditemukan. Install dulu..."
    if command -v apt &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
        apt-get install -y nodejs
    elif command -v apk &> /dev/null; then
        apk add nodejs npm
    else
        echo "[ERROR] Tidak bisa install Node.js otomatis. Install manual dulu."
        exit 1
    fi
    NODE_PATH=$(which node)
    echo "[OK] Node.js $(node --version)"
fi

# Cari node binary — bun punya node runtime, atau system node
if [ "$USE_BUN" = true ]; then
    # bun --bun node tidak bisa dipakai untuk standalone, cari system node
    # atau cek apakah bun bisa run .js langsung
    if command -v node &> /dev/null; then
        NODE_PATH=$(which node)
        echo "[OK] Runtime: node $(node --version)"
    else
        echo "[INFO] Tidak ada system node, pakai bun sebagai runtime"
        NODE_PATH="$BUN_PATH"
    fi
fi

# 2. Buat swap kalau RAM kurang (minimal 2GB untuk build)
TOTAL_MEM=$(free -m 2>/dev/null | awk '/Mem:/{print $2}' || echo "2048")
if [ "$TOTAL_MEM" -lt 3000 ]; then
    if [ ! -f /swapfile ]; then
        echo "[!] RAM ${TOTAL_MEM}MB kurang untuk build. Buat swap 2GB..."
        fallocate -l 2G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        echo "/swapfile none swap sw 0 0" >> /etc/fstab
        echo "[OK] Swap 2GB aktif"
    fi
fi

cd "$APP_DIR"

# 3. Install dependencies
echo ""
echo "[1/4] Install dependencies..."
if [ "$USE_BUN" = true ]; then
    bun install 2>&1 | tail -5
else
    npm install --legacy-peer-deps --production=false 2>&1 | tail -5
fi

# 4. Generate Prisma client
echo ""
echo "[2/4] Generate Prisma client..."
if [ "$USE_BUN" = true ]; then
    bunx prisma generate 2>&1 | tail -3
else
    npx prisma generate 2>&1 | tail -3
fi

# 5. Build Next.js (standalone)
echo ""
echo "[3/4] Build Next.js (ini bisa 5-15 menit)..."
export NODE_OPTIONS="--max-old-space-size=1536"
export NEXT_TELEMETRY_DISABLED=1
if [ "$USE_BUN" = true ]; then
    bun run build 2>&1 | tail -10
else
    npm run build 2>&1 | tail -10
fi

# 5b. Copy static assets & public ke standalone dir (wajib!)
echo ""
echo "[3b] Copy static assets..."
STANDALONE_DIR="$APP_DIR/.next/standalone"
if [ -d "$STANDALONE_DIR" ]; then
    # Copy .next/static ke standalone/.next/static
    if [ -d "$APP_DIR/.next/static" ]; then
        mkdir -p "$STANDALONE_DIR/.next/static"
        cp -r "$APP_DIR/.next/static/"* "$STANDALONE_DIR/.next/static/"
        echo "[OK] Copied .next/static"
    fi
    # Copy public ke standalone/public
    if [ -d "$APP_DIR/public" ]; then
        cp -r "$APP_DIR/public" "$STANDALONE_DIR/public"
        echo "[OK] Copied public/"
    fi
    # Copy Prisma client ke standalone node_modules
    if [ -d "$APP_DIR/node_modules/.prisma" ]; then
        mkdir -p "$STANDALONE_DIR/node_modules/.prisma"
        cp -r "$APP_DIR/node_modules/.prisma/"* "$STANDALONE_DIR/node_modules/.prisma/"
        echo "[OK] Copied node_modules/.prisma"
    fi
    if [ -d "$APP_DIR/node_modules/@prisma" ]; then
        mkdir -p "$STANDALONE_DIR/node_modules/@prisma"
        cp -r "$APP_DIR/node_modules/@prisma/"* "$STANDALONE_DIR/node_modules/@prisma/"
        echo "[OK] Copied node_modules/@prisma"
    fi
    # Copy prisma schema
    if [ -d "$APP_DIR/prisma" ]; then
        cp -r "$APP_DIR/prisma" "$STANDALONE_DIR/prisma"
        echo "[OK] Copied prisma/"
    fi
else
    echo "[ERROR] .next/standalone tidak ditemukan! Build gagal."
    exit 1
fi

# 6. Stop service lama
echo ""
echo "[4/4] Setup service..."
if [ -f /etc/systemd/system/razkindo-erp.service ]; then
    systemctl stop razkindo-erp 2>/dev/null || true
fi

# 7. Buat systemd service
# Gunakan node atau bun tergantung yang tersedia
if [ "$USE_BUN" = true ] && [ "$NODE_PATH" = "$BUN_PATH" ]; then
    EXEC_CMD="$BUN_PATH run $STANDALONE_DIR/server.js"
else
    EXEC_CMD="$NODE_PATH $STANDALONE_DIR/server.js"
fi

cat > /etc/systemd/system/razkindo-erp.service << SERVICE
[Unit]
Description=Razkindo ERP
After=network.target

[Service]
Type=simple
WorkingDirectory=$STANDALONE_DIR
ExecStart=$EXEC_CMD
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOSTNAME=0.0.0.0
Environment=PORT=3000
Environment=STB_MODE=true
EnvironmentFile=$APP_DIR/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable razkindo-erp
systemctl start razkindo-erp

# 8. Tunggu & cek status
sleep 5
echo ""
echo "=========================================="
if systemctl is-active --quiet razkindo-erp; then
    echo "  ✅ RAZKINDO ERP BERHASIL JALAN!"
    echo "  Akses: http://$(hostname -I 2>/dev/null | awk '{print $1}'):3000"
    echo "  Logs: journalctl -u razkindo-erp -f"
else
    echo "  ❌ Service gagal start. Cek logs:"
    echo "  journalctl -u razkindo-erp -n 50 --no-pager"
    echo ""
    echo "  Coba manual:"
    echo "  cd $STANDALONE_DIR && $EXEC_CMD"
fi
echo "=========================================="
