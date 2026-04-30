param(
    [string]$VestraPath = "C:\vestra",
    [string]$LilaPath = "C:\lila",
    [string]$Model = "",
    [switch]$UseAiderOnly
)

$ErrorActionPreference = "Stop"

function Read-EnvValue {
    param(
        [string]$Path,
        [string]$Key
    )
    if (-not (Test-Path $Path)) {
        return ""
    }
    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))=" } | Select-Object -First 1
    if (-not $line) {
        return ""
    }
    return ($line -split "=", 2)[1].Trim()
}

function Assert-Path {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        throw "Path does not exist: $Path"
    }
}

function New-AgentCommand {
    param(
        [string]$Workspace,
        [string]$Label,
        [string]$ModelName,
        [bool]$AiderOnly
    )

    $repoRoot = Resolve-Path "$PSScriptRoot\.."
    $venvScripts = Join-Path $repoRoot "IPE\llm-server\.venv\Scripts"
    $raAid = Join-Path $venvScripts "ra-aid.exe"
    $aider = Join-Path $venvScripts "aider.exe"

    if ($AiderOnly) {
        if (-not (Test-Path $aider)) {
            throw "aider.exe was not found at $aider"
        }
        return "Set-Location -LiteralPath '$Workspace'; `$env:PSC_TARGET_WORKSPACE='$Workspace'; `$env:HERMES_MODEL='hermes3:8b'; `$env:LLM_MODEL='$ModelName'; `$env:OLLAMA_BASE_URL='http://127.0.0.1:11434'; Write-Host '[$Label] Lila Agent-managed aider motor on $Workspace'; & '$aider' --model 'ollama_chat/$ModelName'"
    }

    if (-not (Test-Path $raAid)) {
        throw "ra-aid.exe was not found at $raAid"
    }
    return "Set-Location -LiteralPath '$Workspace'; `$env:PSC_TARGET_WORKSPACE='$Workspace'; `$env:HERMES_MODEL='hermes3:8b'; `$env:LLM_MODEL='$ModelName'; `$env:OLLAMA_BASE_URL='http://127.0.0.1:11434'; Write-Host '[$Label] Lila Agent-managed RA.Aid + aider motor on $Workspace'; & '$raAid' --provider ollama --model '$ModelName' --num-ctx '8192' --expert-provider ollama --expert-model '$ModelName' --expert-num-ctx '8192' --use-aider --log-mode console"
}

Assert-Path $VestraPath
Assert-Path $LilaPath

$envFile = Resolve-Path "$PSScriptRoot\..\IPE\.env"
$modelName = if ($Model.Trim()) { $Model.Trim() } else { Read-EnvValue -Path $envFile -Key "LLM_MODEL" }
if (-not $modelName) {
    $modelName = "qwen2.5-coder:7b"
}

$vestraCommand = New-AgentCommand -Workspace $VestraPath -Label "Vestra" -ModelName $modelName -AiderOnly:$UseAiderOnly
$lilaCommand = New-AgentCommand -Workspace $LilaPath -Label "Lila" -ModelName $modelName -AiderOnly:$UseAiderOnly

if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
    & wt.exe new-tab --title "Lila Agent - Vestra" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -Command $vestraCommand `; new-tab --title "Lila Agent - Lila" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -Command $lilaCommand
} else {
    Start-Process powershell.exe -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $vestraCommand)
    Start-Process powershell.exe -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $lilaCommand)
}
