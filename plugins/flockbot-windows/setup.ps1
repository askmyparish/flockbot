param([switch]$Launch, [switch]$Forget, [switch]$Stop, [string]$Bundle)
$ErrorActionPreference = 'Stop'

function Invoke-FlockbotFileOperation([scriptblock]$Operation) {
  # Windows can retain executable handles briefly after the process exits.
  # Retry filesystem work only; never rerun browser setup or an MCP operation.
  for ($flockbotAttempt = 0; $flockbotAttempt -lt 20; $flockbotAttempt++) {
    try { & $Operation; return }
    catch [IO.IOException], [UnauthorizedAccessException] {
      if ($flockbotAttempt -eq 19) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

$flockbotVersion = (Get-Content -Raw (Join-Path $PSScriptRoot 'runtime.version')).Trim()
if ($flockbotVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') { throw 'Invalid Flockbot release version.' }
$flockbotTarget = 'win32-x64'
$flockbotDigest = (Get-Content -Raw (Join-Path $PSScriptRoot 'runtime.sha256')).Trim()
if ($flockbotDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid Flockbot release digest.' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This candidate requires Windows x64.' }
$flockbotBase = if ($env:FLOCKBOT_INSTALL_ROOT) { $env:FLOCKBOT_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'Flockbot MCP' }
$flockbotRuntime = Join-Path $flockbotBase ('runtimes\' + $flockbotVersion + '-' + $flockbotTarget + '-' + $flockbotDigest.Substring(0,12))
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $flockbotBase 'browser-engines'
if ($Launch -or $Forget -or $Stop) {
  if (-not (Test-Path (Join-Path $flockbotRuntime '.complete'))) { throw 'Flockbot setup is required. Run the plugin setup skill.' }
  $flockbotArguments = @('--disable-warning=ExperimentalWarning', (Join-Path $flockbotRuntime 'server\index.mjs'))
  if ($Forget) { $flockbotArguments += 'forget' }
  elseif ($Stop) { $flockbotArguments += 'stop' }
  & (Join-Path $flockbotRuntime 'node.exe') @flockbotArguments
  exit $LASTEXITCODE
}
New-Item -ItemType Directory -Force (Join-Path $flockbotBase 'runtimes') | Out-Null
if ((Get-Item $flockbotBase).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Flockbot install directory must not be a reparse point.' }
if (-not (Test-Path (Join-Path $flockbotRuntime '.complete'))) {
  $flockbotStage = Join-Path $flockbotBase ('runtimes\stage-' + [Guid]::NewGuid().ToString())
  New-Item -ItemType Directory $flockbotStage | Out-Null
  $flockbotInstallError = $null
  try {
    $flockbotArchive = Join-Path $flockbotStage 'runtime.zip'
    if ($Bundle) { Copy-Item -LiteralPath $Bundle -Destination $flockbotArchive }
    else {
      $flockbotUrl = 'https://github.com/askmyparish/flockbot/releases/download/mcp-v' + $flockbotVersion + '/flockbot-codex-' + $flockbotVersion + '-' + $flockbotTarget + '.zip'
      Invoke-WebRequest -UseBasicParsing -Uri $flockbotUrl -OutFile $flockbotArchive
    }
    if ((Get-FileHash -Algorithm SHA256 $flockbotArchive).Hash.ToLowerInvariant() -cne $flockbotDigest) { throw 'Flockbot download failed its integrity check.' }
    $flockbotPayload = Join-Path $flockbotStage 'payload'
    Expand-Archive -LiteralPath $flockbotArchive -DestinationPath $flockbotPayload
    # Own the process lifetime and status instead of PowerShell's ambient
    # LASTEXITCODE. Release its handle before moving the staged executable.
    $flockbotSetupProcess = New-Object Diagnostics.Process
    try {
      $flockbotSetupProcess.StartInfo.FileName = Join-Path $flockbotPayload 'node.exe'
      $flockbotSetupProcess.StartInfo.Arguments = '"' + (Join-Path $flockbotPayload 'setup-browser.mjs') + '"'
      $flockbotSetupProcess.StartInfo.UseShellExecute = $false
      $flockbotSetupProcess.StartInfo.CreateNoWindow = $true
      if (-not $flockbotSetupProcess.Start()) { throw 'Flockbot browser setup could not start.' }
      $flockbotSetupProcess.WaitForExit()
      $flockbotSetupExitCode = $flockbotSetupProcess.ExitCode
    } finally {
      $flockbotSetupProcess.Dispose()
    }
    if ($flockbotSetupExitCode -ne 0) { throw ('Flockbot browser setup failed (exit code ' + $flockbotSetupExitCode + ').') }
    New-Item -ItemType File (Join-Path $flockbotPayload '.complete') | Out-Null
    if (-not (Test-Path $flockbotRuntime)) {
      Invoke-FlockbotFileOperation { Move-Item -LiteralPath $flockbotPayload -Destination $flockbotRuntime }
    }
  } catch {
    $flockbotInstallError = $_
  } finally {
    try {
      Invoke-FlockbotFileOperation {
        if (Test-Path -LiteralPath $flockbotStage) { Remove-Item -LiteralPath $flockbotStage -Recurse -Force }
      }
    } catch {
      # A cleanup failure must not replace the original setup error.
      if ($null -eq $flockbotInstallError) { throw }
    }
  }
  if ($null -ne $flockbotInstallError) { throw $flockbotInstallError }
}
if (-not (Test-Path (Join-Path $flockbotRuntime '.complete'))) { throw 'Flockbot runtime is incomplete. Remove the incomplete runtime directory and rerun setup.' }
Write-Output 'Flockbot runtime is ready. Restart the MCP connection or start a new Codex conversation, then use connect.'
