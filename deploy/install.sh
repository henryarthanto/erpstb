#!/bin/bash
# ============================================================
# Razkindo ERP STB - Initial Installation Script
# Run this script on the STB to install Docker and deploy ERP
# Usage: curl -sL https://raw.githubusercontent.com/henryarthanto/erpstb/main/deploy/install.sh | bash
# ============================================================

set -e

echo "╔══════════════════════════════════════════════════╗"
echo "║   Razkindo ERP STB - Installation Script         ║"
echo "║   For Set-Top Box (ARM64/AMD64) deployment       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (sudo)${NC}"
  exit 1
fi

DEPLOY_DIR="/opt/erpstb"

echo -e "${YELLOW}[1/6]${NC} Updating system packages..."
apt-get update -qq

echo -e "${YELLOW}[2/6]${NC} Installing prerequisites..."
apt-get install -y -qq curl wget git ca-certificates gnupg lsb-release > /dev/null 2>&1

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  DOCKER_ARCH="amd64" ;;
  aarch64|arm64) DOCKER_ARCH="arm64" ;;
  armv7l)  DOCKER_ARCH="armhf" ;;
  *)
    echo -e "${RED}Unsupported architecture: $ARCH${NC}"
    exit 1
    ;;
esac
echo -e "${GREEN}  Detected architecture: $ARCH (Docker: $DOCKER_ARCH)${NC}"

# Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo -e "${YELLOW}[3/6]${NC} Installing Docker..."
  # Use Docker's convenience script
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  rm get-docker.sh
  systemctl enable docker
  systemctl start docker
else
  echo -e "${YELLOW}[3/6]${NC} Docker already installed, skipping..."
fi

# Install docker-compose if not present
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo -e "${YELLOW}[4/6]${NC} Installing docker-compose..."
  if ! apt-get install -y -qq docker-compose-plugin > /dev/null 2>&1; then
    COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${DOCKER_ARCH}"
    curl -SL "$COMPOSE_URL" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
  fi
else
  echo -e "${YELLOW}[4/6]${NC} docker-compose already installed, skipping..."
fi

# Create deploy directory
echo -e "${YELLOW}[5/6]${NC} Setting up deployment directory..."
mkdir -p "$DEPLOY_DIR"

# Download docker-compose.yml
curl -sL https://raw.githubusercontent.com/henryarthanto/erpstb/main/docker-compose.yml \
  -o "$DEPLOY_DIR/docker-compose.yml"

# Create .env if not present
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo -e "${YELLOW}[6/6]${NC} Creating .env template..."
  curl -sL https://raw.githubusercontent.com/henryarthanto/erpstb/main/.env.example \
    -o "$DEPLOY_DIR/.env"
  echo -e "${RED}⚠️  IMPORTANT: Edit $DEPLOY_DIR/.env with your credentials!${NC}"
else
  echo -e "${YELLOW}[6/6]${NC} .env already exists, keeping existing configuration..."
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Installation complete!                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit the .env file:    nano $DEPLOY_DIR/.env"
echo "  2. Login to GHCR:         echo 'YOUR_GITHUB_TOKEN' | docker login ghcr.io -u henryarthanto --password-stdin"
echo "  3. Start the ERP:         cd $DEPLOY_DIR && docker-compose up -d"
echo "  4. Check status:          docker-compose ps"
echo "  5. View logs:             docker-compose logs -f"
echo ""
echo "To update later: cd $DEPLOY_DIR && docker-compose pull && docker-compose up -d"
echo ""
