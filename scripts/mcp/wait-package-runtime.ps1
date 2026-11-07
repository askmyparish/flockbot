param([Parameter(Mandatory = $true)][string]$RuntimeNode)
$ErrorActionPreference = 'Stop'

# Only this check's copied executable is eligible. Never stop other Node hosts
# or an operator's installed Flockbot runtime.
$flockbotRuntimePath = [IO.Path]::GetFullPath($RuntimeNode)
$flockbotRemaining = @()
$flockbotProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.ExecutablePath -eq $flockbotRuntimePath
})
foreach ($flockbotProcessInfo in $flockbotProcesses) {
  try { $flockbotProcess = [Diagnostics.Process]::GetProcessById($flockbotProcessInfo.ProcessId) }
  catch [ArgumentException] { continue } # Already exited after enumeration.
  try {
    if ($flockbotProcess.HasExited) { continue }
    if ($flockbotProcess.MainModule.FileName -ne $flockbotRuntimePath) { continue }
    if (-not $flockbotProcess.WaitForExit(5000)) {
      $flockbotRemaining += $flockbotProcessInfo.ProcessId
      # Release failed fixture processes before deleting the disposable runtime.
      # Forced termination is a test failure, never a substitute for shutdown.
      $flockbotProcess.Kill()
      if (-not $flockbotProcess.WaitForExit(5000)) { throw 'The disposable Flockbot process could not be stopped.' }
    }
  } finally {
    $flockbotProcess.Dispose()
  }
}
if ($flockbotRemaining.Count -ne 0) {
  throw ('Flockbot runtime processes survived MCP shutdown: ' + ($flockbotRemaining -join ', '))
}
