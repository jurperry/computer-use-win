# Computer Use for Windows - UAC launcher.
#
# Runs unelevated. Triggers the UAC consent prompt and starts elevated.ps1 as a hidden elevated
# process. Prints {"pid":<launcher-observed-pid>} on success; on refusal/cancellation writes the
# reason to stderr and exits non-zero, which the MCP server turns into `elevation_denied`.
#
# There is deliberately no way to elevate silently: the human must approve the prompt.
param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [long]$ParentStart = 0,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$helper = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'elevated.ps1'
if (-not (Test-Path -LiteralPath $helper)) {
  [Console]::Error.WriteLine("elevated.ps1 not found next to the launcher: $helper")
  exit 2
}

$argumentList = @(
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-WindowStyle', 'Hidden',
  '-File', ('"' + $helper + '"'),
  '-PipeName', $PipeName,
  '-ParentPid', [string]$ParentPid,
  '-Nonce', $Nonce,
  '-ParentStart', [string]$ParentStart
)
if ($LogFile) { $argumentList += @('-LogFile', ('"' + $LogFile + '"')) }

try {
  # No -WindowStyle here: Start-Process rejects it together with -Verb in some PowerShell
  # versions. The child hides its own console via its own -WindowStyle argument.
  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argumentList -PassThru
  [ordered]@{ pid = $process.Id } | ConvertTo-Json -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
