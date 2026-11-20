#Requires -Version 5.1
<#
.SYNOPSIS
    Rebuilds the payload from the source tree and packs the distributable zip.

.DESCRIPTION
    Run this after changing the server sources under ..\ (the repository root). It copies the files
    that ship, validates every JSON file, writes the payload README note, packs
    dist\computer-use-win-<version>.zip with a top-level folder, and refreshes dist\SHA256SUMS.txt.

.PARAMETER NoZip
    Only refresh payload\ and the checksums of the loose files.

.PARAMETER Test
    Run the server unit tests from the copied payload before packing.

.EXAMPLE
    .\build-release.ps1

.EXAMPLE
    .\build-release.ps1 -Test
#>
[CmdletBinding()]
param(
    [switch]$NoZip,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" }
function Stop-Build([string]$Text) {
    Write-Host ""
    Write-Host "build failed: $Text" -ForegroundColor Red
    exit 1
}

# Native stderr becomes an ErrorRecord in Windows PowerShell and would terminate this script.
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
$source = Split-Path -Parent $root
$payload = Join-Path $root 'payload'
$serverOut = Join-Path $payload 'computer-use-win'
$manifestPath = Join-Path $root 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) { Stop-Build "manifest.json is missing" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { Stop-Build 'manifest.json has no version' }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Stop-Build 'node is required to validate the payload' }

Write-Host ""
Write-Host "building computer-use-win $version" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------- payload: server

Write-Step 'copying server sources'
if (Test-Path -LiteralPath $serverOut) { Remove-Item -LiteralPath $serverOut -Recurse -Force }
New-Item -ItemType Directory -Force -Path $serverOut, (Join-Path $serverOut 'docs') | Out-Null

foreach ($dir in @('src', 'engine', 'examples', 'test', 'tools')) {
    $from = Join-Path $source $dir
    if (-not (Test-Path -LiteralPath $from)) { Stop-Build "source directory not found: $from" }
    Copy-Item -LiteralPath $from -Destination $serverOut -Recurse -Force
}
foreach ($file in @('README.md', 'package.json', 'LICENSE')) {
    $from = Join-Path $source $file
    if (-not (Test-Path -LiteralPath $from)) { Stop-Build "source file not found: $from" }
    Copy-Item -LiteralPath $from -Destination $serverOut -Force
}
foreach ($doc in @('ARCHITECTURE.md', 'TOOLS.md', 'SECURITY.md', 'INTEGRATIONS.md')) {
    $from = Join-Path $source "docs\$doc"
    if (-not (Test-Path -LiteralPath $from)) { Stop-Build "documentation not found: $from" }
    Copy-Item -LiteralPath $from -Destination (Join-Path $serverOut 'docs') -Force
}
# Test artefacts are machine-specific and never shipped.
$artifacts = Join-Path $serverOut 'test\artifacts'
if (Test-Path -LiteralPath $artifacts) { Remove-Item -LiteralPath $artifacts -Recurse -Force }
foreach ($targetDir in @('test-target', 'msg-target')) {
    Get-ChildItem -LiteralPath (Join-Path $serverOut 'tools') -Directory -Filter $targetDir -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force }
}

$notePath = Join-Path $root 'tools\readme-note.md'
if (-not (Test-Path -LiteralPath $notePath)) { Stop-Build "README note is missing: $notePath" }
$note = Get-Content -LiteralPath $notePath -Raw -Encoding UTF8
if (-not $note.EndsWith("`n")) { $note += "`n" }
$readme = Join-Path $serverOut 'README.md'
$text = Get-Content -LiteralPath $readme -Raw -Encoding UTF8
if (-not $text.StartsWith('<!-- release-note -->')) {
    [System.IO.File]::WriteAllText($readme, $note + $text, (New-Object System.Text.UTF8Encoding $false))
}
Write-Ok $serverOut

# ---------------------------------------------------------------- validate json

Write-Step 'validating JSON'
$jsonFiles = @()
$jsonFiles += Get-ChildItem -LiteralPath $serverOut -Recurse -File -Filter '*.json'
$jsonFiles += Get-ChildItem -LiteralPath (Join-Path $root 'payload\dsh-bundle') -Recurse -File -Filter '*.json'
$jsonFiles += Get-Item -LiteralPath $manifestPath
foreach ($file in $jsonFiles) {
    $probe = Invoke-Capture $nodeExe @(
        '-e',
        "try{JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(0)}catch(e){console.error(e.message);process.exit(1)}",
        $file.FullName)
    if ($probe.ExitCode -ne 0) { Stop-Build "invalid JSON: $($file.FullName) - $($probe.Output)" }
}
Write-Ok "$($jsonFiles.Count) file(s)"

# ---------------------------------------------------------------- unit tests

if ($Test) {
    Write-Step 'running unit tests from the payload'
    Push-Location -LiteralPath $serverOut
    try {
        $tests = Invoke-Capture $nodeExe @('--test', 'test/*.test.mjs')
        Write-Host $tests.Output
    } finally {
        Pop-Location
    }
    if ($tests.ExitCode -ne 0) { Stop-Build "unit tests failed (exit $($tests.ExitCode))" }
    Write-Ok 'tests passed'
}

# ---------------------------------------------------------------- pack

function Get-ReleaseHashes([string]$BaseDir, [string]$ExcludeDir) {
    $lines = New-Object System.Collections.ArrayList
    Get-ChildItem -LiteralPath $BaseDir -Recurse -File -Force |
        Where-Object { -not $ExcludeDir -or -not $_.FullName.StartsWith($ExcludeDir) } |
        Sort-Object FullName |
        ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            $rel = $_.FullName.Substring($BaseDir.Length + 1).Replace('\', '/')
            [void]$lines.Add("$hash  $rel")
        }
    return $lines
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$payloadHashes = Get-ReleaseHashes $root $dist

if (-not $NoZip) {
    Write-Step "packing computer-use-win-$version.zip"
    $zip = Join-Path $dist "computer-use-win-$version.zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

    $stageBase = Join-Path ([System.IO.Path]::GetTempPath()) ("cuwin-release-" + [Guid]::NewGuid().ToString('N'))
    $stage = Join-Path $stageBase "computer-use-win-$version"
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    try {
        $topFiles = @('README.md', 'INSTALL.md', 'SECURITY.md', 'ARCHITECTURE.md', 'CHANGELOG.md',
            'LICENSE', 'NOTICE.md', 'manifest.json', 'install.ps1', 'uninstall.ps1', 'verify.ps1', 'build-release.ps1')
        foreach ($file in $topFiles) {
            $from = Join-Path $root $file
            if (-not (Test-Path -LiteralPath $from)) { Stop-Build "release file missing: $file" }
            Copy-Item -LiteralPath $from -Destination $stage -Force
        }
        foreach ($dir in @('payload', 'tools')) {
            Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $stage -Recurse -Force
        }
        Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force
    } finally {
        if (Test-Path -LiteralPath $stageBase) { Remove-Item -LiteralPath $stageBase -Recurse -Force }
    }
    Write-Ok $zip
}

# ---------------------------------------------------------------- checksums

Write-Step 'writing checksums'
$sums = New-Object System.Collections.ArrayList
foreach ($line in $payloadHashes) { [void]$sums.Add($line) }
$zipPath = Join-Path $dist "computer-use-win-$version.zip"
if (Test-Path -LiteralPath $zipPath) {
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$sums.Add("$zipHash  dist/computer-use-win-$version.zip")
}
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), ($sums -join "`n") + "`n",
    (New-Object System.Text.UTF8Encoding $false))
Write-Ok (Join-Path $dist 'SHA256SUMS.txt')

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
exit 0
