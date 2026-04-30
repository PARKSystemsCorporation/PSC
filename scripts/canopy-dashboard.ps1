param(
    [string]$VestraPath = "C:\vestra",
    [string]$LilaPath = "C:\lila",
    [switch]$PrepareWorktrees
)

$ErrorActionPreference = "Stop"

function Test-Command {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Convert-ToWslPath {
    param([string]$WindowsPath)
    $converted = & wsl.exe wslpath -a -u $WindowsPath
    if ($LASTEXITCODE -ne 0 -or -not $converted) {
        throw "Could not convert path for WSL: $WindowsPath"
    }
    return $converted.Trim()
}

function Test-GitRepo {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return $false
    }
    & git -C $Path rev-parse --show-toplevel *> $null
    return $LASTEXITCODE -eq 0
}

function Test-WslShell {
    $output = & wsl.exe sh -lc "printf PSC_WSL_READY" 2>$null
    return ($LASTEXITCODE -eq 0 -and $output -eq "PSC_WSL_READY")
}

function Get-DefaultBranch {
    param([string]$RepoPath)
    $originHead = & git -C $RepoPath symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $originHead) {
        return ($originHead.Trim() -replace '^origin/', '')
    }

    $branch = & git -C $RepoPath branch --show-current 2>$null
    if ($branch) {
        return $branch.Trim()
    }

    return "main"
}

function Ensure-Worktree {
    param(
        [string]$RepoPath,
        [string]$Name
    )
    if (-not (Test-GitRepo $RepoPath)) {
        Write-Warning "$RepoPath is not a git repository; skipping worktree setup."
        return
    }

    $worktreeRoot = Join-Path $RepoPath ".canopy-worktrees"
    $worktreePath = Join-Path $worktreeRoot $Name
    $branch = "canopy/$Name"

    if (Test-Path $worktreePath) {
        Write-Host "Worktree already exists: $worktreePath"
        return
    }

    New-Item -ItemType Directory -Force -Path $worktreeRoot | Out-Null
    $branchExists = $false
    & git -C $RepoPath rev-parse --verify $branch *> $null
    if ($LASTEXITCODE -eq 0) {
        $branchExists = $true
    }

    if ($branchExists) {
        & git -C $RepoPath worktree add $worktreePath $branch
    } else {
        $base = Get-DefaultBranch $RepoPath
        & git -C $RepoPath worktree add -b $branch $worktreePath $base
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create worktree $worktreePath"
    }
}

if (-not (Test-Command "wsl.exe")) {
    throw "WSL is required for Canopy on Windows because Canopy depends on tmux."
}

if (-not (Test-WslShell)) {
    throw "No ready WSL distro was detected. PSC will not install WSL automatically in offline-primary mode. Run npm run canopy:check for details."
}

$repos = @(
    @{ Name = "Vestra"; Path = $VestraPath; Agent = "vestra-agent" },
    @{ Name = "Lila"; Path = $LilaPath; Agent = "lila-agent" }
)

if ($PrepareWorktrees) {
    foreach ($repo in $repos) {
        Ensure-Worktree -RepoPath $repo.Path -Name $repo.Agent
    }
}

$missing = @()
foreach ($repo in $repos) {
if (-not (Test-GitRepo $repo.Path)) {
        $missing += "$($repo.Name): $($repo.Path)"
    }
}
if ($missing.Count -gt 0) {
    throw "Canopy needs git repositories. Missing/non-git paths: $($missing -join ', ')"
}

$pscWsl = Convert-ToWslPath -WindowsPath (Resolve-Path "$PSScriptRoot\..")
$configScript = @"
set -e
mkdir -p ~/.config/canopy
cat > ~/.config/canopy/config.json <<'JSON'
{
  "agents": [
    { "name": "psc-aider-vestra", "command": "bash $pscWsl/scripts/canopy-agent.sh aider" },
    { "name": "psc-aider-lila", "command": "bash $pscWsl/scripts/canopy-agent.sh aider" }
  ],
  "left_panel_width": 42,
  "theme": "github-dark",
  "output_colors": "adaptive",
  "idle_timeout_secs": 90,
  "tmux_prefix": "C-Space"
}
JSON
if ! command -v tmux >/dev/null 2>&1; then
  echo 'tmux is required inside WSL. Install it from your offline package cache or during an approved online maintenance window.' >&2
  exit 20
fi
if ! command -v canopy >/dev/null 2>&1; then
  echo 'canopy is required inside WSL. Put a prebuilt canopy binary on PATH, or build it during an approved online maintenance window.' >&2
  exit 21
fi
"@

& wsl.exe bash -lc $configScript
if ($LASTEXITCODE -ne 0) {
    throw "WSL Canopy prerequisites are missing."
}

$vestraWsl = Convert-ToWslPath -WindowsPath $VestraPath
$lilaWsl = Convert-ToWslPath -WindowsPath $LilaPath
$vestraCmd = "cd '$vestraWsl' && canopy"
$lilaCmd = "cd '$lilaWsl' && canopy"

if (Test-Command "wt.exe") {
    & wt.exe new-tab --title "Canopy - Vestra" wsl.exe bash -lc $vestraCmd `; new-tab --title "Canopy - Lila" wsl.exe bash -lc $lilaCmd
} else {
    Start-Process wsl.exe -ArgumentList @("bash", "-lc", $vestraCmd)
    Start-Process wsl.exe -ArgumentList @("bash", "-lc", $lilaCmd)
}
