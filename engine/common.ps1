# Shared engine implementation used by both the local engine (engine.ps1) and the elevated
# helper (elevated.ps1). Keeping one dispatcher means the privileged channel can never drift
# from the unprivileged one.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InteropPath = Join-Path $ScriptDir 'Interop.cs'

function Initialize-CuEngine {
  <#
    Compiles the interop layer once and enforces Per-Monitor-V2. Throws on failure: callers turn
    that into their own fatal/error response.
  #>
  Add-Type -ReferencedAssemblies System.Drawing.dll -Path $InteropPath -ErrorAction Stop
  if (-not [CuWin.Engine]::EnablePerMonitorV2()) {
    throw [System.InvalidOperationException]::new('dpi_awareness_failed: SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) failed. Refusing to run with guessed coordinates.')
  }
  $awareness = [CuWin.Engine]::CurrentAwareness()
  if ($awareness -ne 2) {
    throw [System.InvalidOperationException]::new("dpi_awareness_verify_failed: expected PER_MONITOR_AWARE (2), got $awareness.")
  }
  return $awareness
}

function Get-CuEnvInfo {
  $m = [CuWin.Engine]::Monitors()
  $monitors = @()
  foreach ($x in $m) {
    $monitors += [ordered]@{
      id = $x.id; deviceName = $x.deviceName; x = $x.x; y = $x.y; width = $x.width; height = $x.height
      workX = $x.workX; workY = $x.workY; workWidth = $x.workWidth; workHeight = $x.workHeight
      dpi = $x.dpi; primary = $x.primary
    }
  }
  $self = [CuWin.Engine]::SelfIntegrity()
  return [ordered]@{
    pid = $PID
    powershell = $PSVersionTable.PSVersion.ToString()
    awareness = [CuWin.Engine]::CurrentAwareness()
    interactive = [CuWin.Engine]::IsInteractiveDesktop()
    session = [CuWin.Engine]::SessionReport()
    osVersion = [System.Environment]::OSVersion.VersionString
    is64 = [System.Environment]::Is64BitProcess
    integrity = $self
    integrityName = [CuWin.Engine]::IntegrityName($self)
    elevated = ($self -ge 0x3000)
    processStartTime = [CuWin.Engine]::ProcessStartTimeOf([uint32]$PID)
    monitors = $monitors
  }
}

function Convert-CuWindow($w) {
  if ($null -eq $w) { return $null }
  return [ordered]@{
    hwnd = $w.hwnd; title = $w.title; className = $w.className; pid = $w.pid
    processName = $w.processName; exePath = $w.exePath
    visible = $w.visible; enabled = $w.enabled; minimized = $w.minimized; maximized = $w.maximized
    rect = [ordered]@{ x = $w.x; y = $w.y; width = $w.width; height = $w.height }
    frame = [ordered]@{ x = $w.frameX; y = $w.frameY; width = $w.frameWidth; height = $w.frameHeight }
    client = [ordered]@{ x = $w.clientX; y = $w.clientY; width = $w.clientWidth; height = $w.clientHeight }
    dpiAwareness = $w.dpiAwareness; dpi = $w.dpi; monitorId = $w.monitorId
    isForeground = $w.isForeground
    processStartTime = $w.processStartTime
    integrity = $w.integrity; integrityValue = $w.integrityValue
    root = [ordered]@{
      hwnd = $w.rootHwnd; title = $w.rootTitle; pid = $w.rootPid; exePath = $w.rootExePath
      integrity = $w.rootIntegrity; integrityValue = $w.rootIntegrityValue
    }
  }
}

function Convert-CuInputResult($r) {
  $o = [ordered]@{
    ok = $r.ok; dispatchedEvents = $r.dispatchedEvents
    foregroundVerified = $r.foregroundVerified; foregroundHwnd = $r.foregroundHwnd
    targetHwnd = $r.targetHwnd; targetExePath = $r.targetExePath
    notes = @($r.notes)
  }
  if (-not $r.ok) { $o.error = [ordered]@{ code = $r.errorCode; message = $r.errorMessage } }
  return $o
}

function New-CuOk($result) { return [ordered]@{ ok = $true; result = $result } }
function New-CuErr([string]$code, [string]$message) { return [ordered]@{ ok = $false; code = $code; message = $message } }

function Invoke-CuOp([string]$op, $a) {
  <#
    Executes one engine operation and returns { ok, result } or { ok = $false, code, message }.
    `exit = $true` on the result asks the caller's loop to stop.
  #>
  switch ($op) {
    'ping' { return New-CuOk ([ordered]@{ pong = $true; rev = [CuWin.Engine]::CurrentRevision }) }

    'handshake' { return New-CuOk (Get-CuEnvInfo) }

    'monitors' {
      $out = @()
      foreach ($x in [CuWin.Engine]::Monitors()) {
        $out += [ordered]@{ id = $x.id; deviceName = $x.deviceName; x = $x.x; y = $x.y; width = $x.width; height = $x.height; dpi = $x.dpi; primary = $x.primary }
      }
      return New-CuOk ([ordered]@{ monitors = $out })
    }

    'capture' {
      $monitor = if ($null -ne $a.monitor) { [int]$a.monitor } else { -1 }
      $hwnd = if ($null -ne $a.hwnd) { [int64]$a.hwnd } else { [int64]0 }
      $maxW = if ($null -ne $a.maxWidth) { [int]$a.maxWidth } else { 0 }
      $maxH = if ($null -ne $a.maxHeight) { [int]$a.maxHeight } else { 0 }
      $quality = if ($null -ne $a.quality) { [int]$a.quality } else { 80 }
      $mode = if ($null -ne $a.mode) { [string]$a.mode } else { 'auto' }
      $cropX = 0; $cropY = 0; $cropW = 0; $cropH = 0
      if ($null -ne $a.crop) { $cropX = [int]$a.crop.x; $cropY = [int]$a.crop.y; $cropW = [int]$a.crop.width; $cropH = [int]$a.crop.height }
      $usePrintWindow = ($mode -ne 'screen')
      if ($hwnd -eq 0 -and $cropW -gt 0) {
        $r = [CuWin.Engine]::Capture(-1, 0, $maxW, $maxH, $quality, $false, $cropX, $cropY, $cropW, $cropH)
      } else {
        $r = [CuWin.Engine]::Capture($monitor, $hwnd, $maxW, $maxH, $quality, $usePrintWindow, $cropX, $cropY, $cropW, $cropH)
      }
      if (-not $r.ok) { return New-CuErr $r.errorCode $r.errorMessage }
      return New-CuOk ([ordered]@{
        base64 = $r.base64; mimeType = $r.mimeType
        image = [ordered]@{ width = $r.imageWidth; height = $r.imageHeight }
        source = [ordered]@{ width = $r.sourceWidth; height = $r.sourceHeight; originX = $r.originX; originY = $r.originY }
        scale = $r.scale; normalized = $r.normalized; captureMethod = $r.captureMethod
        revision = $r.revision; notes = @($r.notes)
      })
    }

    'windows.list' {
      $visibleOnly = if ($null -ne $a.visibleOnly) { [bool]$a.visibleOnly } else { $true }
      $max = if ($null -ne $a.max) { [int]$a.max } else { 200 }
      $excludePid = if ($null -ne $a.excludeOwn) { [uint32]$PID } else { [uint32]0 }
      $out = @()
      foreach ($w in [CuWin.Engine]::Windows($visibleOnly, $max, $excludePid)) { $out += (Convert-CuWindow $w) }
      return New-CuOk ([ordered]@{ count = $out.Count; windows = $out })
    }

    'window.info' {
      $w = [CuWin.Engine]::Window([int64]$a.hwnd)
      if ($null -eq $w) { return New-CuErr 'window_not_found' "No window with handle $($a.hwnd)." }
      return New-CuOk (Convert-CuWindow $w)
    }

    'window.foreground' {
      return New-CuOk ([ordered]@{ window = (Convert-CuWindow ([CuWin.Engine]::ForegroundWindow())) })
    }

    'window.activate' {
      $res = New-Object CuWin.InputResult
      $ok = [CuWin.Engine]::Activate([int64]$a.hwnd, $res)
      $w = [CuWin.Engine]::Window([int64]$a.hwnd)
      return New-CuOk ([ordered]@{ activated = $ok; window = (Convert-CuWindow $w); foregroundHwnd = $res.foregroundHwnd; notes = @($res.notes) })
    }

    'window.hittest' {
      return New-CuOk ([ordered]@{ window = (Convert-CuWindow ([CuWin.Engine]::HitTest([int]$a.x, [int]$a.y))) })
    }

    'window.find' {
      $w = [CuWin.Engine]::FindWindow([string]$a.title, [string]$a.className, [string]$a.exePath, [string]$a.processName)
      return New-CuOk ([ordered]@{ window = (Convert-CuWindow $w) })
    }

    'window.unoccluded' {
      return New-CuOk ([ordered]@{ unoccluded = [CuWin.Engine]::IsUnoccluded([int64]$a.hwnd) })
    }

    'window.classes' {
      $rows = [CuWin.Engine]::ClassTree([int64]$a.hwnd, 400)
      if ($rows.Count -eq 0) { return New-CuErr 'window_not_found' "No window with handle $($a.hwnd)." }
      $top = $null
      $children = @()
      foreach ($row in $rows) {
        $pipe = $row.IndexOf('|')
        $item = [ordered]@{ hwnd = [int64]$row.Substring(0, $pipe); className = $row.Substring($pipe + 1) }
        if ($null -eq $top) { $top = $item } else { $children += $item }
      }
      return New-CuOk ([ordered]@{
        hwnd = [int64]$a.hwnd
        top = $top.className
        topHwnd = $top.hwnd
        children = $children
        truncated = [CuWin.Engine]::ClassTreeTruncated
      })
    }

    'cursor.get' {
      $p = [CuWin.Engine]::CursorPosition()
      return New-CuOk ([ordered]@{ x = $p[0]; y = $p[1] })
    }

    'cursor.set' {
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Move([int]$a.x, [int]$a.y, [int64]0)))
    }

    'input.click' {
      $mods = @(); if ($null -ne $a.modifiers) { $mods = [string[]]@($a.modifiers) }
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      $message = if ($null -ne $a.message) { [bool]$a.message } else { $false }
      $count = if ($null -ne $a.count) { [int]$a.count } else { 1 }
      $button = if ($null -ne $a.button) { [string]$a.button } else { 'left' }
      $expectedPid = if ($null -ne $a.expectedPid) { [uint32]$a.expectedPid } else { [uint32]0 }
      $expectedStart = if ($null -ne $a.expectedStartTime) { [int64]$a.expectedStartTime } else { [int64]0 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Click([int]$a.x, [int]$a.y, $button, $count, $mods, $hwnd, $message, $expectedPid, $expectedStart)))
    }

    'input.move' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Move([int]$a.x, [int]$a.y, $hwnd)))
    }

    'input.scroll' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Scroll([int]$a.x, [int]$a.y, [string]$a.direction, [int]$a.amount, $hwnd)))
    }

    'input.drag' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      $button = if ($null -ne $a.button) { [string]$a.button } else { 'left' }
      $steps = if ($null -ne $a.steps) { [int]$a.steps } else { 12 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Drag([int]$a.fromX, [int]$a.fromY, [int]$a.toX, [int]$a.toY, $button, $steps, $hwnd)))
    }

    'input.down' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::MouseButton([string]$a.button, $true, $hwnd)))
    }

    'input.up' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::MouseButton([string]$a.button, $false, $hwnd)))
    }

    'input.type' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::TypeText([string]$a.text, $hwnd)))
    }

    'input.key' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      $repeat = if ($null -ne $a.repeat) { [int]$a.repeat } else { 1 }
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Key([string]$a.text, $repeat, $hwnd, $false, 0)))
    }

    'input.hold' {
      $hwnd = if ($null -ne $a.expectedHwnd) { [int64]$a.expectedHwnd } else { [int64]0 }
      $ms = [int]([double]$a.durationMs)
      return New-CuOk (Convert-CuInputResult ([CuWin.Engine]::Key([string]$a.text, 1, $hwnd, $true, $ms)))
    }

    'clipboard.get' { return New-CuOk ([ordered]@{ text = [CuWin.Engine]::ReadClipboard() }) }

    'clipboard.set' {
      $ok = [CuWin.Engine]::WriteClipboard([string]$a.text)
      if ($ok) { return New-CuOk ([ordered]@{ written = $true }) }
      return New-CuErr 'clipboard_write_failed' 'SetClipboardData failed.'
    }

    'overlay.show' {
      $err = [CuWin.Overlay]::Show([int64]$a.hwnd)
      if ($err) { return New-CuErr 'overlay_failed' ("The window frame could not be shown: " + $err) }
      return New-CuOk ([ordered]@{ visible = [CuWin.Overlay]::Visible; rect = [CuWin.Overlay]::Rect; hwnd = [int64]$a.hwnd })
    }

    'overlay.hide' {
      [CuWin.Overlay]::Hide()
      return New-CuOk ([ordered]@{ visible = [CuWin.Overlay]::Visible })
    }

    'overlay.state' {
      return New-CuOk ([ordered]@{ visible = [CuWin.Overlay]::Visible; rect = [CuWin.Overlay]::Rect; error = [CuWin.Overlay]::Error })
    }

    'esc.watch' {
      $err = [CuWin.EscWatch]::Start()
      if ($err) { return New-CuErr 'esc_unavailable' ("The Escape watcher could not start: " + $err) }
      return New-CuOk ([ordered]@{ watching = [CuWin.EscWatch]::Watching; count = [CuWin.EscWatch]::Count })
    }

    'esc.state' {
      return New-CuOk ([ordered]@{
        watching = [CuWin.EscWatch]::Watching
        count = [CuWin.EscWatch]::Count
        error = [CuWin.EscWatch]::Error
      })
    }

    'state' {
      return New-CuOk ([ordered]@{ revision = [CuWin.Engine]::CurrentRevision; leftButtonDown = [CuWin.Engine]::LeftButtonDown })
    }

    'release_all' { return New-CuOk ([ordered]@{ released = [CuWin.Engine]::ReleaseAll() }) }

    'process.info' {
      $pidValue = [uint32]$a.pid
      $alive = $false
      try { $null = [System.Diagnostics.Process]::GetProcessById([int]$pidValue); $alive = $true } catch { $alive = $false }
      return New-CuOk ([ordered]@{
        pid = $pidValue
        startTime = [CuWin.Engine]::ProcessStartTimeOf($pidValue)
        integrity = [CuWin.Engine]::IntegrityName([CuWin.Engine]::IntegrityLevelOf($pidValue))
        integrityValue = [CuWin.Engine]::IntegrityLevelOf($pidValue)
        alive = $alive
      })
    }

    'app.resolve' {
      # Resolve a name or path to a real executable *without* starting anything, so the caller can
      # apply policy before any process is created.
      $name = [string]$a.path
      if ([string]::IsNullOrWhiteSpace($name)) { return New-CuErr 'bad_args' 'app path is required' }
      $resolved = $null
      try {
        $cmd = Get-Command -Name $name -ErrorAction Stop
        if ($cmd -and $cmd.Source) { $resolved = $cmd.Source }
        elseif ($cmd -and $cmd.Definition) { $resolved = $cmd.Definition }
      } catch { }
      if (-not $resolved) {
        try { if (Test-Path -LiteralPath $name) { $resolved = (Resolve-Path -LiteralPath $name).Path } } catch { }
      }
      if (-not $resolved -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        return New-CuErr 'app_not_found' "Could not resolve '$name' to an executable file. Pass a full path or a name that is on PATH."
      }
      $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
      return New-CuOk ([ordered]@{
        path = $resolved
        fileName = [System.IO.Path]::GetFileName($resolved)
        processName = [System.IO.Path]::GetFileNameWithoutExtension($resolved)
        extension = $ext
        isExecutable = ($ext -eq '.exe')
      })
    }

    'app.launch' {
      $target = [string]$a.path
      $argString = if ($null -ne $a.arguments) { [string]$a.arguments } else { '' }
      $cwd = if ($null -ne $a.cwd -and $a.cwd) { [string]$a.cwd } else { $null }
      if (-not $cwd) {
        try {
          $resolved = (Get-Command -Name $target -ErrorAction Stop).Source
          if ($resolved) { $cwd = Split-Path -Parent $resolved }
        } catch { }
      }
      $params = @{ FilePath = $target; PassThru = $true }
      if ($argString) { $params.ArgumentList = $argString }
      if ($cwd) { $params.WorkingDirectory = $cwd }
      try {
        $proc = Start-Process @params
      } catch {
        return New-CuErr 'launch_failed' "Could not launch '$target': $($_.Exception.Message)"
      }
      return New-CuOk ([ordered]@{ pid = $proc.Id; processName = $proc.ProcessName; workingDirectory = $cwd })
    }

    'shutdown' {
      [void][CuWin.Engine]::ReleaseAll()
      $r = [ordered]@{ bye = $true }
      $r.exit = $true
      return New-CuOk $r
    }

    default { return New-CuErr 'unknown_op' "Unknown operation: $op" }
  }
}
