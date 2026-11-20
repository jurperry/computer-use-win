# Computer Use for Windows - elevated helper.
#
# Started on demand by launch-elevated.ps1 (which triggers UAC). It exposes the SAME operation
# set as the local engine over a named pipe, so high-integrity target windows can be captured and
# driven. It is deliberately not a general command channel: only the ops in common.ps1 are
# reachable, and process creation (app.*) is refused here.
#
# Trust rules:
#   * the pipe ACL grants only the current user SID (plus what the OS already grants admins/SYSTEM)
#   * the first frame must carry the nonce from this process's command line
#   * the parent PID must be alive and its start time must match what the launcher was told, so a
#     recycled PID cannot inherit the helper
#   * the helper exits as soon as the pipe disconnects (the MCP server died) and always releases
#     held buttons/modifiers on the way out
#
# Every step is written to -LogFile when given; diagnosis matters more than tidiness here because
# the process is invisible by design.
param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [long]$ParentStart = 0,
  [int]$WaitMs = 60000,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Log([string]$message) {
  if (-not $LogFile) { return }
  try {
    Add-Content -LiteralPath $LogFile -Value ("{0:HH:mm:ss.fff} [elevated {1}] {2}" -f (Get-Date), $PID, $message) -Encoding UTF8
  } catch { }
}

function Stop-Helper([int]$code, [string]$why) {
  Write-Log "exit $code : $why"
  try { [void][CuWin.Engine]::ForceIdle() } catch { }
  exit $code
}

Write-Log "start pipe=$PipeName parent=$ParentPid parentStart=$ParentStart"

try {
  . (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'common.ps1')
} catch {
  Write-Log "dot-source failed: $($_.Exception.Message)"
  exit 19
}

try {
  [void](Initialize-CuEngine)
  Write-Log 'interop ready'
} catch {
  Stop-Helper 20 "engine init failed: $($_.Exception.Message)"
}

$self = [CuWin.Engine]::SelfIntegrity()
Write-Log "self integrity=$self ($([CuWin.Engine]::IntegrityName($self)))"
if ($self -lt 0x3000) {
  Stop-Helper 21 "not elevated (integrity $self); refusing to serve"
}

# --- pipe with a same-user ACL -------------------------------------------------

$pipe = $null
try {
  # Explicit DACL: this user + Admins + SYSTEM. The elevated token's *default* pipe DACL does not
  # necessarily contain the user SID, which would leave the unelevated MCP server unable to connect.
  # The ACL-taking constructor is the 8-argument overload (buffer sizes precede the security arg).
  # Least privilege: grant only the user that owns the *calling* process (the parent), plus this
  # process's own user when UAC elevated with alternate credentials. No administrators/SYSTEM ACEs:
  # they are not needed to serve this connection and only widen the surface.
  $callerSid = [CuWin.Engine]::UserSidOf([uint32]$ParentPid)
  if ([string]::IsNullOrWhiteSpace($callerSid)) { $callerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
  $selfSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rights = [System.IO.Pipes.PipeAccessRights]::ReadWrite
  $security = New-Object System.IO.Pipes.PipeSecurity
  foreach ($sidValue in @($callerSid, $selfSid) | Select-Object -Unique) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object System.IO.Pipes.PipeAccessRule($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  Write-Log "pipe ACL target sid(s): $($callerSid), $($selfSid)"
  $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,
    0,
    0,
    $security)
  Write-Log "pipe created with explicit ACL (caller user only)"
} catch {
  Write-Log "explicit-ACL pipe failed ($($_.Exception.Message)); falling back to the default DACL"
  try {
    $pipe = New-Object System.IO.Pipes.NamedPipeServerStream(
      $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      [System.IO.Pipes.PipeOptions]::Asynchronous)
  } catch {
    Stop-Helper 23 "could not create the named pipe: $($_.Exception.Message)"
  }
}
# Diagnostics only: what the OS actually granted on the pipe.
try {
  $acl = $pipe.GetAccessControl()
  $rules = @($acl.Access | ForEach-Object { "$($_.IdentityReference)=$($_.PipeAccessRights)" })
  Write-Log ("pipe DACL: " + ($rules -join '; '))
} catch {
  Write-Log "could not read the pipe DACL: $($_.Exception.Message)"
}

function Send-PipeObject($obj) {
  $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 12))
  $writer.Flush()
}
function Send-PipeOk([string]$id, $result) { Send-PipeObject ([ordered]@{ id = $id; ok = $true; result = $result }) }
function Send-PipeErr([string]$id, [string]$code, [string]$message) {
  Send-PipeObject ([ordered]@{ id = $id; ok = $false; error = [ordered]@{ code = $code; message = $message } })
}

# --- accept exactly one client -------------------------------------------------

Write-Log "waiting up to ${WaitMs}ms for a client"
try {
  $async = $pipe.BeginWaitForConnection($null, $null)
  if (-not $async.AsyncWaitHandle.WaitOne($WaitMs)) {
    Stop-Helper 22 'no client connected in time'
  }
  $pipe.EndWaitForConnection($async)
} catch {
  Stop-Helper 23 "accept failed: $($_.Exception.Message)"
}
Write-Log 'client connected'

# The streams must be created only after a client is connected: constructing a StreamWriter on an
# unconnected pipe throws, which used to kill the helper before it ever waited for a client.
try {
  $reader = New-Object System.IO.StreamReader($pipe, [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)))
  $writer.AutoFlush = $true
} catch {
  Stop-Helper 26 "stream setup failed: $($_.Exception.Message)"
}

# --- handshake -----------------------------------------------------------------

try {
  $line = $reader.ReadLine()
  if ([string]::IsNullOrWhiteSpace($line)) { Stop-Helper 24 'client closed before the handshake' }
  $hello = $line | ConvertFrom-Json
} catch {
  Stop-Helper 24 "handshake read failed: $($_.Exception.Message)"
}

$helloArgs = $hello.args
$reject = $null
if ([string]$hello.op -ne 'hello') { $reject = 'bad_handshake' }
elseif ([string]$helloArgs.nonce -ne $Nonce) { $reject = 'nonce_mismatch' }
elseif ([int]$helloArgs.parentPid -ne $ParentPid) { $reject = 'parent_mismatch' }

if (-not $reject) {
  $alive = $false
  try { $null = [System.Diagnostics.Process]::GetProcessById($ParentPid); $alive = $true } catch { }
  if (-not $alive) { $reject = 'parent_gone' }
}

if (-not $reject -and $ParentStart -gt 0) {
  $actual = [CuWin.Engine]::ProcessStartTimeOf([uint32]$ParentPid)
  if ($actual -le 0) {
    $reject = 'parent_unknown'
  } else {
    # FILETIME (100ns since 1601) -> epoch milliseconds
    $actualMs = ([DateTime]::FromFileTimeUtc($actual) - [datetime]'1970-01-01').TotalMilliseconds
    if ([Math]::Abs($actualMs - $ParentStart) -gt 5000) { $reject = 'parent_reused' }
  }
}

if ($reject) {
  Write-Log "handshake rejected: $reject"
  Send-PipeErr ([string]$hello.id) $reject "Elevation handshake rejected: $reject."
  try { $pipe.Close() } catch { }
  Stop-Helper 25 "handshake rejected: $reject"
}

$envInfo = Get-CuEnvInfo
$envInfo.elevated = $true
$envInfo.helperPid = $PID
# Echo the request id: the client correlates responses by id, and 'hello' is not one.
Send-PipeOk ([string]$hello.id) $envInfo
Write-Log 'handshake accepted'

# --- request loop ---------------------------------------------------------------

$served = 0
while ($null -ne ($line = $reader.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = [string]$req.id
    $op = [string]$req.op
    if ($op -eq 'app.launch' -or $op -eq 'app.resolve') {
      Send-PipeErr $id 'unsupported_on_elevated' "The elevated helper never creates processes; $op must go through the local engine."
      continue
    }
    $result = Invoke-CuOp $op $req.args
    $served += 1
    if ($result.ok) {
      Send-PipeOk $id $result.result
      if ($result.result -is [System.Collections.IDictionary] -and $result.result.Contains('exit')) { break }
    } else {
      Send-PipeErr $id $result.code $result.message
    }
  } catch {
    Write-Log "op failed: $($_.Exception.Message)"
    Send-PipeErr $id 'engine_exception' $_.Exception.Message
  }
}

Write-Log "client disconnected after $served ops"
try { [void][CuWin.Engine]::ForceIdle() } catch { }
try { $pipe.Close() } catch { }
exit 0
