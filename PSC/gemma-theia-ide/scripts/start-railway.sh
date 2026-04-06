#!/usr/bin/env bash
###############################################################################
# Gemma Theia IDE — Start Railway Tunnel
# =========================================
# Creates a Railway tunnel for remote access from any network.
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}Starting Railway tunnel for remote access...${NC}"

# Check Railway CLI
if ! command -v railway &>/dev/null; then
    echo -e "${RED}Railway CLI not found. Install it:${NC}"
    echo "  npm install -g @railway/cli"
    echo "  railway login"
    exit 1
fi

# Check if logged in
if ! railway whoami &>/dev/null 2>&1; then
    echo -e "${RED}Not logged into Railway. Run:${NC}"
    echo "  railway login"
    exit 1
fi

# Ensure local stack is running
if ! curl -sf http://localhost:${IDE_PORT:-3000} > /dev/null 2>&1; then
    echo "Local IDE not running. Starting it first..."
    bash "$SCRIPT_DIR/start-local.sh"
fi

# Start tunnel
echo -e "${BLUE}Creating secure tunnel to localhost:${IDE_PORT:-3000}...${NC}"
echo ""

# Use Railway's tunnel feature
# This creates a public HTTPS URL that tunnels to localhost
railway tunnel --port ${IDE_PORT:-3000} &
TUNNEL_PID=$!

# Wait for tunnel URL
sleep 5

echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Railway tunnel is active!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "  Access your IDE from any device at the"
echo "  Railway URL shown above."
echo ""
echo "  Stop tunnel: kill $TUNNEL_PID"
echo "  Stop everything: docker compose down && kill $TUNNEL_PID"
echo ""

# Keep script running
wait $TUNNEL_PID
