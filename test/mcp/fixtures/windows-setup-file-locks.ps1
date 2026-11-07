param([string]$Plugin, [string]$Bundle, [switch]$PreserveFailure)
$ErrorActionPreference = 'Stop'
$global:flockbotProbeMoveAttempts = 0
$global:flockbotProbeRemoveAttempts = 0
$global:flockbotProbePreserveFailure = $PreserveFailure.IsPresent

# Inject filesystem failures in the real installer while keeping archive
# verification, browser setup, activation and all later stdio checks intact.
function Move-Item([string]$LiteralPath, [string]$Destination) {
  if (-not (Test-Path -LiteralPath (Join-Path $LiteralPath 'browser-setup-ran'))) {
    throw 'Activation started before browser setup completed.'
  }
  $global:flockbotProbeMoveAttempts++
  if ($global:flockbotProbeMoveAttempts -le 2) {
    throw [IO.IOException]::new('Fictional transient runtime lock.')
  }
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}

function Remove-Item([string]$LiteralPath, [switch]$Recurse, [switch]$Force) {
  $global:flockbotProbeRemoveAttempts++
  if ($global:flockbotProbePreserveFailure -or $global:flockbotProbeRemoveAttempts -eq 1) {
    throw [UnauthorizedAccessException]::new('Fictional staged executable lock.')
  }
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
}

try {
  & (Join-Path $Plugin 'setup.ps1') -Bundle $Bundle
  if ($PreserveFailure) { throw 'The corrupt bundle unexpectedly succeeded.' }
  if ($global:flockbotProbeMoveAttempts -ne 3 -or $global:flockbotProbeRemoveAttempts -ne 2) {
    throw 'The installer did not retry transient activation and cleanup failures.'
  }
} catch {
  if (-not $PreserveFailure) { throw }
  if ($_.Exception.Message -notmatch 'Flockbot download failed its integrity check') { throw }
  if ($global:flockbotProbeRemoveAttempts -ne 20) {
    throw 'Cleanup did not exhaust its bounded retries.'
  }
}
