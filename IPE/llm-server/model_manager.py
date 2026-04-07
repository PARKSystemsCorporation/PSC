"""
Gemma Theia IDE - Model Manager
=================================
Handles downloading, validating, and managing Gemma 4 model files.
Supports both GGUF (llama.cpp) and HuggingFace (vLLM) formats.
"""

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))

# Available Gemma 4 model variants
GEMMA4_MODELS = {
    # GGUF models for llama.cpp
    "gemma-4-4b-it-Q4_K_M": {
        "repo": "bartowski/gemma-4-4b-it-GGUF",
        "filename": "gemma-4-4b-it-Q4_K_M.gguf",
        "format": "gguf",
        "size_gb": 2.8,
        "description": "Gemma 4 4B Instruct - Q4_K_M quantization (best for <8GB VRAM)",
    },
    "gemma-4-12b-it-Q4_K_M": {
        "repo": "bartowski/gemma-4-12b-it-GGUF",
        "filename": "gemma-4-12b-it-Q4_K_M.gguf",
        "format": "gguf",
        "size_gb": 7.4,
        "description": "Gemma 4 12B Instruct - Q4_K_M quantization (recommended, needs 12GB VRAM)",
    },
    "gemma-4-27b-it-Q4_K_M": {
        "repo": "bartowski/gemma-4-27b-it-GGUF",
        "filename": "gemma-4-27b-it-Q4_K_M.gguf",
        "format": "gguf",
        "size_gb": 16.2,
        "description": "Gemma 4 27B Instruct - Q4_K_M quantization (needs 24GB VRAM)",
    },
    # HuggingFace models for vLLM
    "gemma-4-12b-it-hf": {
        "repo": "google/gemma-4-12b-it",
        "format": "hf",
        "size_gb": 24.0,
        "description": "Gemma 4 12B Instruct - Full precision HuggingFace (for vLLM)",
    },
    "gemma-4-27b-it-hf": {
        "repo": "google/gemma-4-27b-it",
        "format": "hf",
        "size_gb": 54.0,
        "description": "Gemma 4 27B Instruct - Full precision HuggingFace (for vLLM)",
    },
}

DEFAULT_MODEL = "gemma-4-12b-it-Q4_K_M"


def list_available_models() -> list[dict]:
    """List all available model variants with download status."""
    results = []
    for name, info in GEMMA4_MODELS.items():
        downloaded = False
        if info["format"] == "gguf":
            downloaded = (MODELS_DIR / info["filename"]).exists()
        else:
            downloaded = (MODELS_DIR / name).exists()

        results.append({
            "name": name,
            "downloaded": downloaded,
            "size_gb": info["size_gb"],
            "description": info["description"],
            "format": info["format"],
            "filename": info.get("filename"),
            "supported_in_app": info["format"] == "gguf",
        })
    return results


def list_local_gguf_models() -> list[dict]:
    """List GGUF files already present in the local models directory."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    for path in sorted(MODELS_DIR.glob("*.gguf")):
        try:
            size_gb = round(path.stat().st_size / (1024 ** 3), 2)
        except OSError:
            size_gb = 0.0
        results.append({
            "filename": path.name,
            "path": str(path),
            "size_gb": size_gb,
        })
    return results


def download_model(model_name: str = DEFAULT_MODEL, token: str | None = None) -> Path:
    """Download a Gemma 4 model. Returns the path to the downloaded model."""
    if model_name not in GEMMA4_MODELS:
        raise ValueError(f"Unknown model: {model_name}. Available: {list(GEMMA4_MODELS.keys())}")

    info = GEMMA4_MODELS[model_name]
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[Model Manager] Downloading {model_name} ({info['size_gb']}GB)...")
    print(f"[Model Manager] Repository: {info['repo']}")

    if info["format"] == "gguf":
        target_path = MODELS_DIR / info["filename"]
        if target_path.exists():
            print(f"[Model Manager] Already downloaded: {target_path}")
            return target_path

        path = hf_hub_download(
            repo_id=info["repo"],
            filename=info["filename"],
            local_dir=str(MODELS_DIR),
            token=token,
        )
        print(f"[Model Manager] Downloaded to: {path}")
        return Path(path)

    else:
        target_dir = MODELS_DIR / model_name
        if target_dir.exists():
            print(f"[Model Manager] Already downloaded: {target_dir}")
            return target_dir

        path = snapshot_download(
            repo_id=info["repo"],
            local_dir=str(target_dir),
            token=token,
        )
        print(f"[Model Manager] Downloaded to: {path}")
        return Path(path)


def get_model_path(model_name: str = DEFAULT_MODEL) -> Path | None:
    """Get the path to an already-downloaded model, or None if not present."""
    if model_name not in GEMMA4_MODELS:
        return None

    info = GEMMA4_MODELS[model_name]
    if info["format"] == "gguf":
        p = MODELS_DIR / info["filename"]
        return p if p.exists() else None
    else:
        p = MODELS_DIR / model_name
        return p if p.exists() else None


def verify_gpu() -> dict:
    """Check GPU availability and VRAM."""
    result = {"nvidia": False, "vram_gb": 0, "device_name": ""}
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            text=True,
        ).strip()
        if output:
            parts = output.split(",")
            result["nvidia"] = True
            result["device_name"] = parts[0].strip()
            vram_str = parts[1].strip().replace(" MiB", "")
            result["vram_gb"] = round(int(vram_str) / 1024, 1)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return result


def recommend_model() -> str:
    """Recommend the best model based on available GPU VRAM."""
    gpu = verify_gpu()
    vram = gpu["vram_gb"]

    if vram >= 48:
        return "gemma-4-27b-it-hf"
    elif vram >= 24:
        return "gemma-4-27b-it-Q4_K_M"
    elif vram >= 12:
        return "gemma-4-12b-it-Q4_K_M"
    elif vram >= 6:
        return "gemma-4-4b-it-Q4_K_M"
    else:
        print("[Model Manager] Warning: No GPU or insufficient VRAM detected. Using smallest model (CPU mode).")
        return "gemma-4-4b-it-Q4_K_M"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Gemma 4 Model Manager")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("list", help="List available models")
    sub.add_parser("recommend", help="Recommend best model for your GPU")
    sub.add_parser("gpu", help="Check GPU status")

    dl_parser = sub.add_parser("download", help="Download a model")
    dl_parser.add_argument("--model", default=None, help="Model name (default: auto-recommend)")
    dl_parser.add_argument("--token", default=None, help="HuggingFace token")

    args = parser.parse_args()

    if args.command == "list":
        for m in list_available_models():
            status = "DOWNLOADED" if m["downloaded"] else "not downloaded"
            print(f"  {m['name']:40s} [{status}] {m['size_gb']}GB - {m['description']}")

    elif args.command == "recommend":
        rec = recommend_model()
        print(f"Recommended model: {rec}")

    elif args.command == "gpu":
        gpu = verify_gpu()
        if gpu["nvidia"]:
            print(f"GPU: {gpu['device_name']} ({gpu['vram_gb']}GB VRAM)")
        else:
            print("No NVIDIA GPU detected. Will run in CPU mode.")

    elif args.command == "download":
        model = args.model or recommend_model()
        download_model(model, args.token)

    else:
        parser.print_help()
