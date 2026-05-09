#!/bin/bash
# ============================================================
# Razkindo ERP STB - Health Check Script
# Run via cron every minute for monitoring
# Usage: ./healthcheck.sh
# ============================================================

DEPLOY_DIR="/opt/erpstb"
HEALTH_URL="http://localhost:3000/api/health"
MAX_RETRIES=3
RETRY_DELAY=5

check_health() {
  for i in $(seq 1 $MAX_RETRIES); do
    HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
    
    if [ "$HTTP_CODE" = "200" ]; then
      RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null || echo "{}")
      echo "✅ HEALTHY - HTTP $HTTP_CODE - $(date)"
      return 0
    fi
    
    echo "⚠️  Attempt $i/$MAX_RETRIES failed (HTTP $HTTP_CODE). Retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
  done
  
  echo "❌ UNHEALTHY - All $MAX_RETRIES attempts failed - $(date)"
  
  # Try to restart container
  echo "🔄 Attempting container restart..."
  cd "$DEPLOY_DIR" && docker-compose restart erp 2>/dev/null
  
  return 1
}

# Run health check
check_health
