# Builds the classic-USER32 target used by tools/e2e-channel.mjs.
#
# No SDK required: the .NET Framework compiler that ships with Windows PowerShell is enough.
# Output: tools/msg-target/MsgTarget.exe
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'MsgTarget.cs'
$output = Join-Path $here 'MsgTarget.exe'

if (Test-Path $output) { Remove-Item $output -Force }

Add-Type -Path $source -OutputAssembly $output -OutputType WindowsApplication -ErrorAction Stop

Write-Output "built $output ($((Get-Item $output).Length) bytes)"
