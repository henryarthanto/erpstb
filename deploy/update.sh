#!/bin/bash
# ============================================================
# Razkindo ERP STB - Update Script
# Pulls latest image and restarts the container
# Usage: cd /opt/erpstb && ./update.sh
# ============================================================

set -e

echo "🚀 Updating Razkindo ERP STB..."
echo ""

DEPLOY_DIR="/opt/erpstb"
cd "$DEPLOY_DIR"

# Pull latest image
echo "📦 Pulling latest image..."
docker pull ghcr.io/henryarthanto/erpstb:latest

# Restart with new image
echo "🔄 Restarting container..."
docker-compose down
docker-compose up -d

# Cleanup old images
echo "🧹 Cleaning up old images..."
docker image prune -f

# Health check
echo "⏳ Running health check..."
sleep 10
for i in $(seq 1 12); do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✅ Update successful! ERP is running at http://localhost:3000"
    echo ""
    docker-compose ps
    exit 0
  fi
  echo "  Waiting... ($i/12)"
  sleep 5
done

echo "⚠️ Health check timeout. Check logs with: docker-compose logs -f"
docker logs razkindo-erp --tail 30
exit 1
