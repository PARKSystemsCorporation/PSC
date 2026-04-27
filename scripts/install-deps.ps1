$ErrorActionPreference = "Stop"

Write-Host "Installing Windows Build Tools (C++ Workload) via winget..." -ForegroundColor Cyan
Write-Host "Please accept any UAC prompts." -ForegroundColor Yellow

# Use winget to install the Visual Studio 2022 Build Tools
winget install Microsoft.VisualStudio.2022.BuildTools --force --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

Write-Host "`nDownloading standard VS Code extensions for the IDE..." -ForegroundColor Cyan
$repoRoot = Resolve-Path "$PSScriptRoot\.."
Push-Location "$repoRoot\IPE"

if (Get-Command "yarn" -ErrorAction SilentlyContinue) {
    yarn download:plugins
} else {
    Write-Host "Yarn is not installed or available in PATH. Please run 'corepack enable' or install yarn, then run 'yarn download:plugins' manually inside the IPE folder." -ForegroundColor Red
}

Pop-Location
Write-Host "`nDependencies and extensions installed!" -ForegroundColor Green
