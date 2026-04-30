#!/usr/bin/env bash
###############################################################################
# Gemma Theia IDE — Setup Script
# =================================
# Prepares the environment: checks GPU, downloads model, creates directories.
###############################################################################

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║     PARK Systems Coder Setup Wizard      ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Step 1: Check prerequisites ────────────────────────────────────

echo -e "${BLUE}[1/5] Checking prerequisites...${NC}"

check_cmd() {
    if command -v "$1" &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} $1 found"
        return 0
    else
        echo -e "  ${RED}✗${NC} $1 not found"
        return 1
    fi
}

MISSING=0
check_cmd docker || MISSING=1
check_cmd docker compose 2>/dev/null || check_cmd "docker-compose" || MISSING=1
check_cmd curl || MISSING=1

if [ $MISSING -eq 1 ]; then
    echo -e "\n${RED}Missing required tools. Please install Docker and try again.${NC}"
    exit 1
fi

# ── Step 2: Check GPU ──────────────────────────────────────────────

echo -e "\n${BLUE}[2/5] Checking GPU...${NC}"

GPU_AVAILABLE=false
VRAM_GB=0

if command -v nvidia-smi &>/dev/null; then
    GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true)
    if [ -n "$GPU_INFO" ]; then
        GPU_NAME=$(echo "$GPU_INFO" | cut -d',' -f1 | xargs)
        VRAM_MIB=$(echo "$GPU_INFO" | cut -d',' -f2 | xargs | sed 's/ MiB//')
        VRAM_GB=$((VRAM_MIB / 1024))
        GPU_AVAILABLE=true
        echo -e "  ${GREEN}✓${NC} GPU: $GPU_NAME ($VRAM_GB GB VRAM)"
    fi
fi

if [ "$GPU_AVAILABLE" = false ]; then
    echo -e "  ${YELLOW}⚠${NC} No NVIDIA GPU detected. Will use CPU mode (slower)."
    VRAM_GB=0
fi

# ── Step 3: Select model ──────────────────────────────────────────

echo -e "\n${BLUE}[3/5] Selecting Gemma 4 model...${NC}"

if [ $VRAM_GB -ge 24 ]; then
    MODEL="gemma-4-27b-it-Q4_K_M.gguf"
    MODEL_REPO="bartowski/gemma-4-27b-it-GGUF"
    echo -e "  Selected: ${GREEN}Gemma 4 27B${NC} (you have ${VRAM_GB}GB VRAM)"
elif [ $VRAM_GB -ge 12 ]; then
    MODEL="gemma-4-12b-it-Q4_K_M.gguf"
    MODEL_REPO="bartowski/gemma-4-12b-it-GGUF"
    echo -e "  Selected: ${GREEN}Gemma 4 12B${NC} (recommended for ${VRAM_GB}GB VRAM)"
else
    MODEL="gemma-4-4b-it-Q4_K_M.gguf"
    MODEL_REPO="bartowski/gemma-4-4b-it-GGUF"
    echo -e "  Selected: ${GREEN}Gemma 4 4B${NC} (lightweight, works with ${VRAM_GB}GB VRAM)"
fi

# ── Step 4: Download model ────────────────────────────────────────

echo -e "\n${BLUE}[4/5] Downloading model...${NC}"

mkdir -p models

if [ -f "models/$MODEL" ]; then
    echo -e "  ${GREEN}✓${NC} Model already downloaded: models/$MODEL"
else
    echo -e "  Downloading $MODEL from HuggingFace..."
    echo -e "  This may take a while depending on your connection."

    if command -v huggingface-cli &>/dev/null; then
        huggingface-cli download "$MODEL_REPO" "$MODEL" --local-dir models/
    else
        # Use curl fallback
        DOWNLOAD_URL="https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL}"
        curl -L --progress-bar -o "models/$MODEL" "$DOWNLOAD_URL"
    fi

    if [ -f "models/$MODEL" ]; then
        echo -e "  ${GREEN}✓${NC} Download complete"
    else
        echo -e "  ${RED}✗${NC} Download failed. Please download manually:"
        echo -e "     huggingface-cli download $MODEL_REPO $MODEL --local-dir models/"
        exit 1
    fi
fi

# ── Step 5: Create .env ──────────────────────────────────────────

echo -e "\n${BLUE}[5/5] Creating configuration...${NC}"

mkdir -p workspace
mkdir -p nginx/ssl

if [ ! -f .env ]; then
    cp .env.example .env
    # Update model name in .env
    sed -i "s/GEMMA_MODEL=.*/GEMMA_MODEL=$MODEL/" .env
    if [ "$GPU_AVAILABLE" = false ]; then
        sed -i "s/GPU_LAYERS=.*/GPU_LAYERS=0/" .env
    fi
    echo -e "  ${GREEN}✓${NC} Created .env (from .env.example)"
else
    echo -e "  ${YELLOW}⚠${NC} .env already exists, skipping"
fi

# ── Done ──────────────────────────────────────────────────────────

echo -e "\n${GREEN}╔══════════════════════════════════════════╗"
echo "║           Setup Complete!                 ║"
echo "╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Model:     ${GREEN}$MODEL${NC}"
echo -e "  GPU:       ${GPU_AVAILABLE:+${GREEN}Yes${NC} ($GPU_NAME)}${GPU_AVAILABLE:-${YELLOW}CPU mode${NC}}"
echo ""
echo -e "  ${BLUE}Start the IDE:${NC}"
echo "    docker compose up -d"
echo ""
echo -e "  ${BLUE}Then open:${NC}"
echo "    http://localhost:3000"
echo ""
echo -e "  ${BLUE}For mobile/iPad access:${NC}"
echo "    Open the Connection Manager panel in the IDE"
echo "    to get your local URL or start a Railway tunnel."
echo ""
