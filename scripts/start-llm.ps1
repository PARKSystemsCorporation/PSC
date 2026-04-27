$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$llmServerDir = "$repoRoot\IPE\llm-server"
$modelsDir = "$repoRoot\IPE\models"
$llamaExe = "$modelsDir\llama-server.exe"

Write-Host "Starting local LLM Server..." -ForegroundColor Cyan

# 1. Start llama-server.exe if present
$llamaJob = $null
if (Test-Path $llamaExe) {
    Write-Host "Found llama-server.exe. Starting background inference server..." -ForegroundColor Green
    
    # We look for the downloaded gguf in the models dir
    $ggufModel = Get-ChildItem -Path $modelsDir -Filter "*.gguf" | Select-Object -First 1
    
    if ($ggufModel) {
        Write-Host "Using model: $($ggufModel.Name)" -ForegroundColor Green
        
        $llamaArgs = @(
            "--model", "$($ggufModel.FullName)",
            "--ctx-size", "8192",
            "--n-gpu-layers", "-1",
            "--host", "127.0.0.1",
            "--port", "8080",
            "--embedding"
        )
        
        # Start in background via Start-Process
        $llamaJob = Start-Process -FilePath $llamaExe -ArgumentList $llamaArgs -NoNewWindow -PassThru
        Start-Sleep -Seconds 3 # Give it a moment to boot
    } else {
        Write-Host "Warning: llama-server.exe found but no .gguf model present in $modelsDir" -ForegroundColor Yellow
    }
}

# 2. Setup python environment
if (-not (Test-Path "$llmServerDir\.venv")) {
    Write-Host "Virtual environment not found. Creating one..." -ForegroundColor Yellow
    python -m venv "$llmServerDir\.venv"
    Write-Host "Installing requirements..." -ForegroundColor Yellow
    & "$llmServerDir\.venv\Scripts\pip.exe" install -r "$llmServerDir\requirements.txt"
}

Write-Host "Virtual environment ready. Starting Python proxy..." -ForegroundColor Green
$env:CONFIG_PATH = "$llmServerDir\config.yaml"
$env:ENV_FILE = "$repoRoot\IPE\.env"
$env:PROJECT_DIR = "$repoRoot"

try {
    & "$llmServerDir\.venv\Scripts\python.exe" "$llmServerDir\server.py"
} finally {
    if ($llamaJob) {
        Write-Host "Stopping llama-server..." -ForegroundColor Yellow
        Stop-Process -Id $llamaJob.Id -Force -ErrorAction SilentlyContinue
    }
}
