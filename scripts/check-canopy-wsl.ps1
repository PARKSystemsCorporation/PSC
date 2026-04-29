param(
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Write-Check {
    param(
        [bool]$Ok,
        [string]$Message
    )
    if ($Quiet) {
        return
    }
    $color = if ($Ok) { "Green" } else { "Yellow" }
    $prefix = if ($Ok) { "OK" } else { "MISSING" }
    Write-Host "[$prefix] $Message" -ForegroundColor $color
}

function Test-WslShell {
    $output = & wsl.exe sh -lc "printf PSC_WSL_READY" 2>$null
    return ($LASTEXITCODE -eq 0 -and $output -eq "PSC_WSL_READY")
}

function Test-WslCommand {
    param([string]$Name)
    & wsl.exe sh -lc "command -v $Name >/dev/null 2>&1" 2>$null
    return $LASTEXITCODE -eq 0
}

$ok = $true

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Check $false "wsl.exe was not found."
    $ok = $false
} elseif (-not (Test-WslShell)) {
    Write-Check $false "No ready WSL distro was detected."
    $ok = $false
} else {
    Write-Check $true "WSL shell is ready."

    foreach ($command in @("tmux", "git", "canopy")) {
        if (Test-WslCommand $command) {
            Write-Check $true "$command is available inside WSL."
        } else {
            Write-Check $false "$command is missing inside WSL."
            $ok = $false
        }
    }
}

if (-not $ok) {
    if (-not $Quiet) {
        Write-Host ""
        Write-Host "Offline-primary setup means PSC will not install these automatically." -ForegroundColor Yellow
        Write-Host "Prepare WSL once using your offline package cache or an approved online maintenance window." -ForegroundColor Yellow
        Write-Host "Required inside WSL: tmux, git, canopy." -ForegroundColor Yellow
        Write-Host "Canopy source: https://github.com/isacssw/canopy" -ForegroundColor Yellow
    }
    exit 1
}

if (-not $Quiet) {
    Write-Host "Canopy prerequisites are ready." -ForegroundColor Green
}
