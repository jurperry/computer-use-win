#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the computer-use-win MCP server and prepares its DeepSeek Harness plugin bundle.

.DESCRIPTION
    Copies the server source, resolves a Node.js runtime, creates a policy file if none exists,
    renders the DSH bundle patch with absolute paths, and runs the server's own environment check.
    File changes stay under -InstallDir and -PolicyPath; no DSH profile is modified.

.PARAMETER InstallDir
    Target directory. Default: %LOCALAPPDATA%\computer-use-win

.PARAMETER PolicyPreset
    Which example policy to create when -PolicyPath does not exist yet.
      standard  observe anything, click/type only listed apps (default)
      open      every window at full tier; built-in deny list still applies
      safe      nothing works until apps are listed

.PARAMETER PolicyPath
    Policy file. Default: %USERPROFILE%\.computer-use-win\policy.json

.PARAMETER NodePath
    Node.js executable to use. Default: node on PATH, else the runtime that DSH downloaded,
    else %ProgramFiles%\nodejs\node.exe.

.PARAMETER ResetPolicy
    Overwrite an existing policy file with the chosen preset (a timestamped backup is kept).

.PARAMETER SkipCheck
    Do not run `server.mjs --check` after installing.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -PolicyPreset open

.EXAMPLE
    .\install.ps1 -InstallDir D:\tools\computer-use-win -Force
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'computer-use-win'),
    [ValidateSet('standard', 'open', 'safe')]
    [string]$PolicyPreset = 'standard',
    [string]$PolicyPath = (Join-Path $env:USERPROFILE '.computer-use-win\policy.json'),
    [string]$NodePath,
    [switch]$Force,
    [switch]$ResetPolicy,
    [switch]$SkipCheck
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
    # A redirected or legacy console may refuse the change; child output is ASCII in that case.
}

$script:Failures = 0
function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Stop-Install([string]$Text) {
    Write-Host ""
    Write-Host "install failed: $Text" -ForegroundColor Red
    exit 1
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

# JSON-encode a value so it can be dropped into a YAML double-quoted scalar verbatim.
function ConvertTo-YamlScalar([string]$Value) {
    return (ConvertTo-Json -InputObject $Value -Compress)
}

# Run a native command and capture stdout. Windows PowerShell turns a native command's stderr into an
# ErrorRecord, which terminates the script under $ErrorActionPreference = 'Stop', so stderr is dropped
# locally and the preference is restored afterwards.
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

function Test-NodeVersion([string]$Exe) {
    $result = Invoke-Capture $Exe @('--version')
    $raw = $result.Output
    if ($result.ExitCode -ne 0 -or -not $raw) { return $null }
    if ($raw -notmatch '^v(\d+)\.') { return $null }
    if ([int]$Matches[1] -lt 20) { return $null }
    return $raw.Trim()
}

function Resolve-NodeExe([string]$Explicit) {
    $candidates = New-Object System.Collections.ArrayList
    if ($Explicit) { [void]$candidates.Add(@{ Path = $Explicit; Source = 'parameter' }) }

    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { [void]$candidates.Add(@{ Path = $onPath.Source; Source = 'PATH' }) }

    $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
    if (Test-Path -LiteralPath $runtimes) {
        Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = Join-Path $_.FullName 'dependencies\node\bin\node.exe'
            if (Test-Path -LiteralPath $exe) {
                [void]$candidates.Add(@{ Path = $exe; Source = 'DSH runtime' })
            }
        }
    }

    if ($env:ProgramFiles) {
        $pf = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        [void]$candidates.Add(@{ Path = $pf; Source = 'Program Files' })
    }

    foreach ($candidate in $candidates) {
        if (-not $candidate.Path) { continue }
        if (-not (Test-Path -LiteralPath $candidate.Path)) { continue }
        $version = Test-NodeVersion $candidate.Path
        if ($version) {
            return @{ Path = (Resolve-Path -LiteralPath $candidate.Path).Path; Version = $version; Source = $candidate.Source }
        }
    }

    Stop-Install @'
no Node.js >= 20 found. Install Node.js 20 or newer (https://nodejs.org) and re-run,
or pass the executable explicitly:  .\install.ps1 -NodePath "C:\Program Files\nodejs\node.exe"
'@
}

# ---------------------------------------------------------------- preconditions

Write-Host ""
Write-Host "computer-use-win installer" -ForegroundColor White
Write-Host ""

if ($env:OS -ne 'Windows_NT') { Stop-Install 'this package only runs on Windows.' }

$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$payloadServer = Join-Path $root 'payload\computer-use-win'
$payloadBundle = Join-Path $root 'payload\dsh-bundle'
$manifestPath = Join-Path $root 'manifest.json'

if (-not (Test-Path -LiteralPath (Join-Path $payloadServer 'src\server.mjs'))) {
    Stop-Install "payload is incomplete or this script was moved out of the release: $payloadServer"
}
if (-not (Test-Path -LiteralPath (Join-Path $payloadBundle 'cordis.patch.yml.template'))) {
    Stop-Install "bundle payload is missing: $payloadBundle"
}

$version = '0.2.0'
if (Test-Path -LiteralPath $manifestPath) {
    try { $version = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version } catch { }
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$PolicyPath = [System.IO.Path]::GetFullPath($PolicyPath)
$serverDir = Join-Path $InstallDir 'server'
$bundleDir = Join-Path $InstallDir 'dsh-bundle'
$statePath = Join-Path $InstallDir 'install-state.json'

Write-Step "release $version"
Write-Ok "install dir : $InstallDir"
Write-Ok "policy file : $PolicyPath"

if ((Test-Path -LiteralPath $InstallDir) -and -not $Force) {
    Stop-Install @"
$InstallDir already exists.
Use -Force to upgrade in place (the policy file is kept), for example:
  .\install.ps1 -Force
"@
}

# ---------------------------------------------------------------- node runtime

Write-Step 'resolving Node.js'
$node = Resolve-NodeExe $NodePath
$nodeExe = $node.Path
Write-Ok "$nodeExe  $($node.Version)  ($($node.Source))"

# ---------------------------------------------------------------- copy server

Write-Step 'copying server source'
if (Test-Path -LiteralPath $serverDir) { Remove-Item -LiteralPath $serverDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
Copy-Item -Path (Join-Path $payloadServer '*') -Destination $serverDir -Recurse -Force

$serverMjs = Join-Path $serverDir 'src\server.mjs'
foreach ($required in @('src\server.mjs', 'engine\engine.ps1', 'engine\Interop.cs', 'engine\elevated.ps1',
        'engine\launch-elevated.ps1', 'engine\release.ps1', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $serverDir $required))) {
        Stop-Install "copied server is missing $required"
    }
}
Get-ChildItem -LiteralPath $serverDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
Write-Ok $serverDir

# ---------------------------------------------------------------- policy file

Write-Step 'preparing policy file'
$policyCreated = $false
$policyBackup = $null
$examplePolicy = Join-Path $serverDir "examples\policy.$PolicyPreset.json"
if (-not (Test-Path -LiteralPath $examplePolicy)) {
    Stop-Install "example policy not found: $examplePolicy"
}

if (Test-Path -LiteralPath $PolicyPath) {
    if ($ResetPolicy) {
        $policyBackup = "$PolicyPath.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
        Copy-Item -LiteralPath $PolicyPath -Destination $policyBackup -Force
        Copy-Item -LiteralPath $examplePolicy -Destination $PolicyPath -Force
        Write-Warn "existing policy replaced with preset '$PolicyPreset' (backup: $policyBackup)"
    } else {
        Write-Ok "kept existing policy (preset stays as written in the file)"
    }
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PolicyPath) | Out-Null
    Copy-Item -LiteralPath $examplePolicy -Destination $PolicyPath -Force
    $policyCreated = $true
    Write-Ok "created from preset '$PolicyPreset'"
}

# ---------------------------------------------------------------- render bundle

Write-Step 'rendering DSH bundle'
if (Test-Path -LiteralPath $bundleDir) { Remove-Item -LiteralPath $bundleDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
Copy-Item -Path (Join-Path $payloadBundle '*') -Destination $bundleDir -Recurse -Force

$templatePath = Join-Path $bundleDir 'cordis.patch.yml.template'
$template = Get-Content -LiteralPath $templatePath -Raw -Encoding UTF8
$rendered = $template.
    Replace('__NODE__', (ConvertTo-YamlScalar $node.Path)).
    Replace('__SERVER__', (ConvertTo-YamlScalar $serverMjs)).
    Replace('__POLICY__', (ConvertTo-YamlScalar $PolicyPath)).
    Replace('__CWD__', (ConvertTo-YamlScalar $serverDir))
Write-Utf8NoBom (Join-Path $bundleDir 'cordis.patch.yml') $rendered
Write-Ok $bundleDir

# ---------------------------------------------------------------- self check

$check = $null
if (-not $SkipCheck) {
    Write-Step 'running environment check'
    $result = Invoke-Capture $nodeExe @($serverMjs, '--check', '--policy', $PolicyPath)
    $checkExit = $result.ExitCode
    $text = $result.Output
    if (-not $text) { Stop-Install "server --check produced no output (exit $checkExit)" }
    try {
        $check = $text | ConvertFrom-Json
    } catch {
        Stop-Install "--check output was not JSON: $($text.Substring(0, [Math]::Min(400, $text.Length)))"
    }
    if (-not $check.ok) {
        Stop-Install "--check reported a problem: $($text | ConvertTo-Json -Compress -Depth 4)"
    }
    $monitors = @($check.monitors).Count
    Write-Ok "session interactive, $monitors monitor(s), DPI $($check.engine.dpiAwareness), integrity $($check.engine.integrity)"
    Write-Ok "policy preset '$($check.policy.preset)', unlisted '$($check.policy.unlisted)'"
}

# ---------------------------------------------------------------- state file

$state = [ordered]@{
    schema     = 1
    product    = 'computer-use-win'
    version    = $version
    installedAt = (Get-Date).ToString('o')
    installDir = $InstallDir
    serverDir  = $serverDir
    bundleDir  = $bundleDir
    node       = [ordered]@{ path = $node.Path; version = $node.Version; source = $node.Source }
    policy     = [ordered]@{ path = $PolicyPath; preset = $PolicyPreset; created = $policyCreated; backup = $policyBackup }
    check      = $(if ($check) { [ordered]@{
                    ok        = $check.ok
                    preset    = $check.policy.preset
                    unlisted  = $check.policy.unlisted
                    integrity = $check.engine.integrity
                    node      = $check.server.node
                } } else { $null })
}
Write-Utf8NoBom $statePath (ConvertTo-Json -InputObject $state -Depth 6)

# ---------------------------------------------------------------- summary

Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host ""
Write-Host "  server : $serverDir"
Write-Host "  bundle : $bundleDir"
Write-Host "  policy : $PolicyPath"
Write-Host "  node   : $($node.Path) ($($node.Version))"
Write-Host ""
Write-Host "Finish the DSH side (once per profile):" -ForegroundColor White
Write-Host "  1. Open DeepSeek Harness -> Plugins -> Add plugin."
Write-Host "  2. Choose this directory:"
Write-Host "       $bundleDir"
Write-Host "  3. Start a new session and ask the agent to call list_granted_applications with include_desktop:true."
Write-Host ""
Write-Host "  Or tell the agent: install the DSH bundle at $bundleDir"
Write-Host ""
Write-Host "Then verify from any shell:" -ForegroundColor White
Write-Host "  .\verify.ps1"
Write-Host ""
Write-Host "Capability is decided by the policy file, not by the installer." -ForegroundColor White
Write-Host "  default 'standard': observe anything, click/type only listed apps."
Write-Host '  expand:    add  { "app": "notepad.exe", "tier": "full" }  to the apps array.'
Write-Host "  widen:     .\install.ps1 -PolicyPreset open -ResetPolicy -Force"
Write-Host ""

exit 0
