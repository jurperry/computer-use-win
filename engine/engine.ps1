# Computer Use for Windows - resident local engine.
#
# Protocol: newline-delimited JSON on stdin/stdout, UTF-8.
#   request : {"id":"<str>","op":"<name>","args":{...}}
#   response: {"id":"<str>","ok":true,"result":{...}}
#             {"id":"<str>","ok":false,"error":{"code":"...","message":"..."}}
#   event   : {"event":"ready", ...} | {"event":"fatal", ...}
#
# This process runs at the caller's integrity level. High-integrity targets are handled by
# elevated.ps1 over a named pipe instead; both share common.ps1 so behaviour cannot drift.
#
# It is started once and reused: per-op cost is ~1-5ms instead of ~500ms for a fresh
# PowerShell + Add-Type cycle.
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'common.ps1')

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Send-Object($obj) { Write-Line ($obj | ConvertTo-Json -Compress -Depth 12) }

function Send-Ok([string]$id, $result) {
  Send-Object ([ordered]@{ id = $id; ok = $true; result = $result })
}

function Send-Err([string]$id, [string]$code, [string]$message) {
  Send-Object ([ordered]@{ id = $id; ok = $false; error = [ordered]@{ code = $code; message = $message } })
}

function Send-Event([string]$name, $payload) {
  $o = [ordered]@{ event = $name }
  if ($null -ne $payload) { foreach ($k in $payload.Keys) { $o[$k] = $payload[$k] } }
  Send-Object $o
}

# --- boot -------------------------------------------------------------------

try {
  [void](Initialize-CuEngine)
} catch {
  $msg = $_.Exception.Message
  $code = if ($msg -match '^(\w+):') { $Matches[1] } else { 'interop_compile_failed' }
  Send-Event 'fatal' ([ordered]@{ code = $code; message = $msg })
  exit 3
}

Send-Event 'ready' (Get-CuEnvInfo)

# --- request loop -----------------------------------------------------------

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = [string]$req.id
    $result = Invoke-CuOp ([string]$req.op) $req.args
    if ($result.ok) {
      Send-Ok $id $result.result
      if ($result.result -is [System.Collections.IDictionary] -and $result.result.Contains('exit')) { exit 0 }
    } else {
      Send-Err $id $result.code $result.message
    }
  } catch {
    Send-Err $id 'engine_exception' $_.Exception.Message
  }
}

# stdin closed (client exited or was killed): never leave a button or modifier held down.
try { [void][CuWin.Engine]::ForceIdle() } catch { }
exit 0
