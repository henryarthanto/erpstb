#!/bin/bash
# ============================================================
# Razkindo ERP STB - Setup Cron Jobs for Auto-Update & Health
# Run once after installation
# Usage: ./setup-cron.sh
# ============================================================

set -e

SCRIPT_DIR="/opt/erpstb/deploy"

echo "⏰ Setting up cron jobs for Razkindo ERP STB..."

# Health check every 2 minutes
(crontab -l 2>/dev/null | grep -v "healthcheck.sh"; echo "*/2 * * * * $SCRIPT_DIR/healthcheck.sh >> /var/log/erp-healthcheck.log 2>&1") | crontab -

# Auto-update check daily at 3 AM
(crontab -l 2>/dev/null | grep -v "auto-update"; echo "0 3 * * * cd /opt/erpstb && docker pull ghcr.io/henryarthanto/razkindo-erp:latest && docker-compose up -d >> /var/log/erp-auto-update.log 2>&1") | crontab -

# Docker image cleanup weekly (Sunday at 4 AM)
(crontab -l 2>/dev/null | grep -v "docker image prune"; echo "0 4 * * 0 docker image prune -af >> /var/log/erp-cleanup.log 2>&1") | crontab -

echo "✅ Cron jobs configured:"
echo "  - Health check: every 2 minutes"
echo "  - Auto-update:  daily at 3:00 AM"
echo "  - Cleanup:      weekly on Sunday at 4:00 AM"
echo ""
echo "View current crontab: crontab -l"
