#!/usr/bin/env bash
###############################################################################
# Gemma Theia IDE — Start Local
# ================================
# Starts the IDE stack for local network access.
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "Starting Gemma Theia IDE (local mode)..."

# Load environment
if [ -f .env ]; then
    set -a; source .env; set +a
fi

# Start the stack
docker compose up -d

# Wait for Theia to be ready
echo "Waiting for IDE to start..."
for i in $(seq 1 60); do
    if curl -sf http://localhost:${IDE_PORT:-3000} > /dev/null 2>&1; then
        break
    fi
    sleep 2
done

# Get local IP for mobile access
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo "════════════════════════════════════════════"
echo "  Gemma Theia IDE is running!"
echo "════════════════════════════════════════════"
echo ""
echo "  Desktop:  http://localhost:${IDE_PORT:-3000}"
echo "  Mobile:   http://${LOCAL_IP}:${IDE_PORT:-3000}"
echo ""
echo "  Logs:     docker compose logs -f"
echo "  Stop:     docker compose down"
echo ""
