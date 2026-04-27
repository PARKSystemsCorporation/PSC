$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$modelsDir = "$repoRoot\IPE\models"

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
}

$modelFilename = "gemma-2-2b-it-Q4_K_M.gguf"
$modelUrl = "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/$modelFilename"
$modelPath = "$modelsDir\$modelFilename"

if (-not (Test-Path $modelPath)) {
    Write-Host "Downloading Gemma 2 2B (Q4_K_M) model (approx 1.6GB) for fast local testing..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
    Write-Host "Model downloaded successfully to $modelPath" -ForegroundColor Green
} else {
    Write-Host "Model $modelFilename already exists in $modelsDir" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Magenta
Write-Host " MANUAL STEP REQUIRED: llama.cpp " -ForegroundColor Magenta
Write-Host "=================================================================" -ForegroundColor Magenta
Write-Host "To serve this model with GPU acceleration:"
Write-Host "1. Download the latest Windows release of llama.cpp from:"
Write-Host "   https://github.com/ggerganov/llama.cpp/releases"
Write-Host "   (Look for a 'bin-win-cuda-cu12.x-x64.zip' if you have an NVIDIA GPU)"
Write-Host "2. Extract it and place 'llama-server.exe' in your '$modelsDir' folder."
Write-Host "3. Alternatively, you can use LM Studio or Ollama and point the IDE to it."
Write-Host "=================================================================" -ForegroundColor Magenta
