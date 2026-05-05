#!/bin/bash
# ============================================================
# Razkindo ERP - Direct Node.js Deploy untuk STB (tanpa Docker)
# Usage: chmod +x deploy.sh && ./deploy.sh
# ============================================================

set -e

APP_DIR="/DATA/erpstb"
NODE_VERSION="20"

echo "=========================================="
echo "  Razkindo ERP - STB Direct Deploy"
echo "=========================================="

# 1. Cek Node.js
if ! command -v node &> /dev/null; then
    echo "[!] Node.js tidak ditemukan. Install dulu..."
    if command -v apt &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
        apt-get install -y nodejs
    elif command -v apk &> /dev/null; then
        apk add nodejs npm
    else
        echo "[ERROR] Tidak bisa install Node.js otomatis. Install manual dulu."
        exit 1
    fi
fi

echo "[OK] Node.js $(node --version)"

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
npm install --legacy-peer-deps --production=false 2>&1 | tail -5

# 4. Generate Prisma client
echo ""
echo "[2/4] Generate Prisma client..."
npx prisma generate 2>&1 | tail -3

# 5. Build Next.js (standalone)
echo ""
echo "[3/4] Build Next.js (ini bisa 5-15 menit)..."
export NODE_OPTIONS="--max-old-space-size=1536"
export NEXT_TELEMETRY_DISABLED=1
npm run build 2>&1 | tail -10

# 6. Stop service lama
echo ""
echo "[4/4] Setup service..."
if [ -f /etc/systemd/system/razkindo-erp.service ]; then
    systemctl stop razkindo-erp 2>/dev/null || true
fi

# 7. Buat systemd service
cat > /etc/systemd/system/razkindo-erp.service << 'SERVICE'
[Unit]
Description=Razkindo ERP
After=network.target

[Service]
Type=simple
WorkingDirectory=/DATA/erpstb
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOSTNAME=0.0.0.0
Environment=PORT=3000
Environment=STB_MODE=true
EnvironmentFile=/DATA/erpstb/.env
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
fi
echo "=========================================="
