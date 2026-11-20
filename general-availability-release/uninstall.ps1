#Requires -Version 5.1
<#
.SYNOPSIS
    Removes an installed computer-use-win and its DSH bundle directory.

.DESCRIPTION
    Refuses to delete files while any DSH profile still lists the bundle, because that profile would
    fail to start its MCP client afterwards. Remove the plugin in DSH first (Plugins page, or ask the
    agent), then run this script.

.PARAMETER InstallDir
    Installation root. Default: read from install-state.json, else %LOCALAPPDATA%\computer-use-win

.PARAMETER KeepPolicy
    Keep the policy file even when -RemovePolicy would otherwise delete it (this is the default).

.PARAMETER RemovePolicy
    Delete the policy file at the recorded path.

.PARAMETER RemoveState
    Delete the whole state directory %USERPROFILE%\.computer-use-win (policy, control lock, saved
    screenshots). Implies -RemovePolicy.

.PARAMETER Force
    Delete even when a DSH profile still references the bundle.

.EXAMPLE
    .\uninstall.ps1

.EXAMPLE
    .\uninstall.ps1 -RemoveState
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$KeepPolicy,
    [switch]$RemovePolicy,
    [switch]$RemoveState,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" }
function Write-Bad([string]$Text) { Write-Host "    $Text" -ForegroundColor Red }

if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'computer-use-win' }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

$statePath = Join-Path $InstallDir 'install-state.json'
$state = $null
if (Test-Path -LiteralPath $statePath) {
    try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $state = $null }
}

$serverDir = if ($state -and $state.serverDir) { $state.serverDir } else { Join-Path $InstallDir 'server' }
$bundleDir = if ($state -and $state.bundleDir) { $state.bundleDir } else { Join-Path $InstallDir 'dsh-bundle' }
$policyPath = if ($state -and $state.policy -and $state.policy.path) { $state.policy.path } else { Join-Path $env:USERPROFILE '.computer-use-win\policy.json' }
$stateDir = Join-Path $env:USERPROFILE '.computer-use-win'

Write-Host ""
Write-Host "computer-use-win uninstaller" -ForegroundColor White
Write-Host ""
Write-Ok "install dir : $InstallDir"
Write-Ok "policy      : $policyPath"

if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Bad "nothing installed at $InstallDir"
    exit 1
}

# ------------------------------------------------------- is any DSH profile using it?

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $dshHome 'profiles'
$references = @()
if (Test-Path -LiteralPath $profilesRoot) {
    $needle = $InstallDir.Replace('\', '/').ToLowerInvariant()
    Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $pkg = Join-Path $_.FullName 'package.json'
        if (-not (Test-Path -LiteralPath $pkg)) { return }
        $raw = Get-Content -LiteralPath $pkg -Raw
        if ($raw -match 'computer-use-win-mcp') { $references += $_.Name }
        elseif ($raw.Replace('\', '/').ToLowerInvariant().Contains($needle)) { $references += $_.Name }
    }
}

if ($references.Count -gt 0) {
    Write-Host ""
    Write-Bad "still installed as a plugin in DSH profile(s): $($references -join ', ')"
    Write-Host ""
    Write-Host "Remove the plugin there first, otherwise that profile fails to start its MCP client:" -ForegroundColor Yellow
    Write-Host "  Plugins -> computer-use-win -> Remove"
    Write-Host "  or tell the agent: remove the computer-use-win-mcp bundle"
    Write-Host ""
    if (-not $Force) {
        Write-Host "Nothing was deleted. Re-run with -Force to delete anyway." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Continuing because -Force was given." -ForegroundColor Yellow
}

# ------------------------------------------------------------------ delete files

Write-Step 'removing installed files'
foreach ($dir in @($serverDir, $bundleDir)) {
    if (Test-Path -LiteralPath $dir) {
        Remove-Item -LiteralPath $dir -Recurse -Force
        Write-Ok "removed $dir"
    }
}
if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force
    Write-Ok "removed $statePath"
}

$leftover = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
if ($leftover.Count -eq 0) {
    Remove-Item -LiteralPath $InstallDir -Force
    Write-Ok "removed $InstallDir"
} else {
    Write-Host "    kept $InstallDir (not empty: $($leftover.Name -join ', '))" -ForegroundColor Yellow
}

# ------------------------------------------------------------------ policy / state

if ($RemoveState -and (Test-Path -LiteralPath $stateDir)) {
    Remove-Item -LiteralPath $stateDir -Recurse -Force
    Write-Ok "removed $stateDir (policy, control lock, saved screenshots)"
} elseif ($RemovePolicy -and -not $KeepPolicy -and (Test-Path -LiteralPath $policyPath)) {
    Remove-Item -LiteralPath $policyPath -Force
    Write-Ok "removed $policyPath"
} elseif (Test-Path -LiteralPath $policyPath) {
    Write-Ok "kept $policyPath"
    Write-Host "    delete it yourself, or re-run with -RemovePolicy / -RemoveState" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Uninstalled." -ForegroundColor Green
Write-Host ""
exit 0
