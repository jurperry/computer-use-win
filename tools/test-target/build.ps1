# Builds the instrumented test target with the .NET Framework compiler that ships with Windows
# PowerShell, so the test suite needs no SDK and no NuGet packages.
#
# Output: tools/test-target/CuTestTarget.exe
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'CuTestTarget.cs'
$output = Join-Path $here 'CuTestTarget.exe'

if (Test-Path $output) { Remove-Item $output -Force }

Add-Type -Path $source -OutputAssembly $output -OutputType WindowsApplication `
  -ReferencedAssemblies System.Windows.Forms.dll, System.Drawing.dll -ErrorAction Stop

Write-Output "built $output ($((Get-Item $output).Length) bytes)"
