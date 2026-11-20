# Emergency input release, run as a short-lived separate process.
#
# Why a separate process: the resident engine executes operations synchronously, so a hung or
# killed engine cannot answer a release request. SendInput is system-global, so any process can
# send the "button up / modifier up" events and they will take effect.
#
# This script sends nothing but releases, and never writes to stdout.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -ReferencedAssemblies System.Drawing.dll -Path (Join-Path $PSScriptRoot 'Interop.cs')
  [void][CuWin.Engine]::EnablePerMonitorV2()
  [void][CuWin.Engine]::ForceIdle()
} catch {
  # Nothing sensible to do here; the caller is already handling a failure.
}
exit 0
