#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies an installed computer-use-win: environment check plus a read-only MCP handshake.

.DESCRIPTION
    Runs `server.mjs --check` and then tools/handshake.mjs against the same node, server entry point
    and policy file the DSH bundle uses. Injects no input and takes no control lock, so it is safe to
    run while DSH is open.

.PARAMETER InstallDir
    Installation root. Default: read from install-state.json, else %LOCALAPPDATA%\computer-use-win

.PARAMETER PolicyPath
    Policy file to verify. Default: the one recorded at install time.

.PARAMETER SkipHandshake
    Only run the environment check.

.EXAMPLE
    .\verify.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$PolicyPath,
    [switch]$SkipHandshake
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" }
function Write-Bad([string]$Text) { Write-Host "    $Text" -ForegroundColor Red }

# Native stderr becomes an ErrorRecord in Windows PowerShell and stops the script here, so drop it
# locally instead of relying on 2>$null under $ErrorActionPreference = 'Stop'.
function Invoke-Capture([string]$Exe, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $Exe @Arguments 2>$null
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $code; Output = ($lines | Out-String).Trim() }
}

$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'computer-use-win' }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

$statePath = Join-Path $InstallDir 'install-state.json'
$state = $null
if (Test-Path -LiteralPath $statePath) {
    try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $state = $null }
}

$serverDir = if ($state -and $state.serverDir) { $state.serverDir } else { Join-Path $InstallDir 'server' }
$serverMjs = Join-Path $serverDir 'src\server.mjs'
$nodeExe = if ($state -and $state.node -and $state.node.path) { $state.node.path } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $PolicyPath) {
    $PolicyPath = if ($state -and $state.policy -and $state.policy.path) { $state.policy.path } else { Join-Path $env:USERPROFILE '.computer-use-win\policy.json' }
}

Write-Host ""
Write-Host "computer-use-win verification" -ForegroundColor White
Write-Host ""

if (-not (Test-Path -LiteralPath $serverMjs)) {
    Write-Bad "server not found: $serverMjs"
    Write-Host ""
    Write-Host "Run install.ps1 first, or pass -InstallDir." -ForegroundColor Yellow
    exit 1
}
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
    Write-Bad "node executable not found (install-state.json may be stale) - re-run install.ps1 -Force"
    exit 1
}

Write-Ok "install dir : $InstallDir"
Write-Ok "server      : $serverMjs"
Write-Ok "policy      : $PolicyPath"
Write-Ok "node        : $nodeExe"

# ------------------------------------------------------------------ environment

Write-Step 'environment check (server.mjs --check)'
$checkResult = Invoke-Capture $nodeExe @($serverMjs, '--check', '--policy', $PolicyPath)
$checkExit = $checkResult.ExitCode
$text = $checkResult.Output
if (-not $text) {
    Write-Bad "no output from --check (exit $checkExit)"
    exit 1
}
try {
    $check = $text | ConvertFrom-Json
} catch {
    Write-Bad '--check did not return JSON:'
    Write-Host $text
    exit 1
}
if (-not $check.ok) {
    Write-Bad '--check reported a problem'
    Write-Host ($check | ConvertTo-Json -Depth 6)
    exit 1
}

$monitors = @($check.monitors)
Write-Ok "server      : $($check.server.name) $($check.server.version) on node $($check.server.node)"
Write-Ok "engine      : PowerShell $($check.engine.powershell), DPI awareness $($check.engine.dpiAwareness), integrity $($check.engine.integrity)"
Write-Ok "session     : $($check.engine.session) (interactive: $($check.engine.interactiveDesktop))"
Write-Ok "monitors    : $($monitors.Count) -> $($monitors[0].width)x$($monitors[0].height) @ $($monitors[0].dpi) DPI"
Write-Ok "policy      : preset '$($check.policy.preset)', unlisted '$($check.policy.unlisted)' from $($check.policy.source)"
Write-Ok "elevation   : policy allows = $($check.elevation.policyAllows) (a UAC prompt still needs a human)"

# ------------------------------------------------------------------ handshake

if (-not $SkipHandshake) {
    Write-Step 'MCP handshake (initialize -> tools/list -> list_granted_applications)'
    $handshake = Join-Path $root 'tools\handshake.mjs'
    if (-not (Test-Path -LiteralPath $handshake)) {
        Write-Bad "handshake script missing: $handshake"
        exit 1
    }
    $hsArgs = @($handshake, '--server', $serverMjs, '--policy', $PolicyPath, '--screenshot')
    $hsResult = Invoke-Capture $nodeExe $hsArgs
    $hsExit = $hsResult.ExitCode
    $hsText = $hsResult.Output
    if (-not $hsText) {
        Write-Bad "handshake produced no output (exit $hsExit)"
        exit 1
    }
    try {
        $hs = $hsText | ConvertFrom-Json
    } catch {
        Write-Bad 'handshake did not return JSON:'
        Write-Host $hsText
        exit 1
    }
    if (-not $hs.ok) {
        Write-Bad "handshake failed: $($hs.error) $($hs.reason)"
        if ($hs.stderrTail) { Write-Host $hs.stderrTail -ForegroundColor DarkGray }
        exit 1
    }
    Write-Ok "protocol    : $($hs.protocol), server $($hs.serverName) $($hs.serverVersion)"
    Write-Ok "tools       : $($hs.toolCount) -> mcp__computeruse__*"
    if ($hs.screenshot) {
        if ($hs.screenshot.ok) {
            Write-Ok "screenshot  : $($hs.screenshot.width)x$($hs.screenshot.height)"
        } else {
            Write-Ok "screenshot  : unavailable ($($hs.screenshot.error)) - policy may deny observation"
        }
    }
}

# ------------------------------------------------------------------ verdict

Write-Host ""
Write-Host "Installation OK." -ForegroundColor Green
Write-Host ""
Write-Host "If the tools are not visible in DSH yet, add the bundle once per profile:" -ForegroundColor White
Write-Host "  Plugins -> Add plugin -> $(Join-Path $InstallDir 'dsh-bundle')"
Write-Host "  (or tell the agent: install the DSH bundle at that directory)"
Write-Host ""
Write-Host "Then ask the agent to call list_granted_applications with include_desktop: true, and check that it reports the policy above." -ForegroundColor White
Write-Host ""

exit 0
