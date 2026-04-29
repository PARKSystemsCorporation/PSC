param(
    [string]$Distro = "Ubuntu"
)

$ErrorActionPreference = "Stop"

Write-Host "This helper may use the internet to install WSL, tmux, Go, git, and Canopy." -ForegroundColor Yellow
Write-Host "It is intentionally not used by normal PSC startup or Canopy launch commands." -ForegroundColor Yellow

function Test-WslShell {
    $output = & wsl.exe sh -lc "printf PSC_WSL_READY" 2>$null
    return ($LASTEXITCODE -eq 0 -and $output -eq "PSC_WSL_READY")
}

function Invoke-Wsl {
    param([string]$Command)
    & wsl.exe bash -lc $Command
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed: $Command"
    }
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "wsl.exe was not found. Enable Windows Subsystem for Linux first."
}

if (-not (Test-WslShell)) {
    Write-Host "No ready WSL distro was detected. Installing $Distro through wsl.exe..." -ForegroundColor Yellow
    & wsl.exe --install -d $Distro
    if ($LASTEXITCODE -ne 0) {
        throw "WSL install did not complete. Try running PowerShell as Administrator: wsl --install -d $Distro"
    }

    Write-Host ""
    Write-Host "WSL install was started. If Windows asks for a reboot, reboot first." -ForegroundColor Yellow
    Write-Host "Then open $Distro once from the Start menu to create the Linux user." -ForegroundColor Yellow
    Write-Host "After that, run: npm run canopy:install-online" -ForegroundColor Cyan
    exit 0
}

Write-Host "WSL shell detected. Installing Canopy prerequisites inside WSL..." -ForegroundColor Cyan

Invoke-Wsl "if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y tmux golang-go git; else echo 'This setup script currently supports apt-based WSL distros. Install tmux, Go, and git manually.' >&2; exit 30; fi"
Invoke-Wsl "if ! command -v canopy >/dev/null 2>&1; then export PATH=`"`$PATH:`$HOME/go/bin`"; go install github.com/isacssw/canopy/cmd/canopy@latest; fi"

$profileLine = 'export PATH="$PATH:$HOME/go/bin"'
Invoke-Wsl "grep -qxF '$profileLine' ~/.profile 2>/dev/null || printf '\n%s\n' '$profileLine' >> ~/.profile"

Write-Host "Canopy prerequisites are ready." -ForegroundColor Green
Write-Host "Launch with: npm run canopy" -ForegroundColor Cyan
