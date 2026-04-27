$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$llmServerDir = "$repoRoot\IPE\llm-server"
$venvPython = "$llmServerDir\.venv\Scripts\python.exe"
$mempalaceCmd = "$llmServerDir\.venv\Scripts\mempalace.exe"

if (-not (Test-Path $mempalaceCmd)) {
    Write-Host "Virtual environment or MemPalace not found! Please run '.\scripts\start-llm.ps1' once first to set up the environment." -ForegroundColor Red
    exit 1
}

$env:ENV_FILE = "$repoRoot\IPE\.env"

Write-Host "Initializing MemPalace indexing for the workspace..." -ForegroundColor Cyan
& $mempalaceCmd init "$repoRoot" --yes

Write-Host "`nMining the codebase for context (this may take a moment)..." -ForegroundColor Cyan
& $mempalaceCmd mine "$repoRoot" --wing psc

Write-Host "`nWorkspace fully indexed! The IDE now has codebase-wide context." -ForegroundColor Green
