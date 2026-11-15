[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Install','Upgrade','Activate','Status','Rollback','Uninstall','Inspect','Resume','InspectRuntimeStage','PublishRuntimeStage')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [string]$ManifestPath,
    [string]$UvPath,
    [string]$PythonCacheRoot,
    [string]$StageRoot,
    [switch]$OfflineRuntime,
    [string]$Version,
    [string]$TransactionId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'EINSTALL_POWERSHELL: PowerShell 7 or newer is required' }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

$install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$runtime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
if ([string]::Equals($install,$runtime,[StringComparison]::OrdinalIgnoreCase) -or
    $install.StartsWith($runtime + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $runtime.StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'EINSTALL_OWNERSHIP: product install and managed runtime must be separate, non-nested roots'
}
$pythonCache = $null
if ($PythonCacheRoot) {
    $pythonCache = [IO.Path]::GetFullPath($PythonCacheRoot)
    $cacheVolumeRoot = [IO.Path]::GetPathRoot($pythonCache)
    if ($pythonCache.Length -gt $cacheVolumeRoot.Length) { $pythonCache = $pythonCache.TrimEnd('\') }
    foreach ($ownedRoot in @($install,$runtime)) {
        if ([string]::Equals($pythonCache,$ownedRoot,[StringComparison]::OrdinalIgnoreCase) -or
            $pythonCache.StartsWith($ownedRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
            $ownedRoot.StartsWith($pythonCache + '\',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'ERUNTIME_CACHE_PATH: Python download cache must be a separate directory outside install and runtime roots'
        }
    }
    if (-not (Test-Path -LiteralPath $pythonCache -PathType Container)) { throw 'ERUNTIME_CACHE_PATH: selected Python cache directory must already exist' }
    $cacheItem = Get-Item -LiteralPath $pythonCache -Force
    if (($cacheItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ERUNTIME_CACHE_PATH: selected Python cache directory is a reparse point' }
}
if ($OfflineRuntime -and -not $pythonCache) { throw 'ERUNTIME_OFFLINE_CACHE_REQUIRED: offline runtime preparation requires an explicit isolated Python cache directory' }

$runtimeManager = Join-Path $PSScriptRoot 'prepare-python-runtime.ps1'
$transactionEngine = Join-Path $PSScriptRoot 'install-core-prototype.ps1'
if (-not (Test-Path -LiteralPath $runtimeManager -PathType Leaf) -or -not (Test-Path -LiteralPath $transactionEngine -PathType Leaf)) {
    throw 'EINSTALL_COMPONENT: a required local installer component is missing'
}

function Invoke-Child([string]$ScriptPath,[string[]]$Arguments) {
    $pwshPath = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $pwshPath -PathType Leaf)) { throw 'EINSTALL_POWERSHELL: current PowerShell 7 executable is unavailable' }
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pwshPath
    $psi.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32'))
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($arg in @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ScriptPath) + $Arguments) { [void]$psi.ArgumentList.Add([string]$arg) }
    foreach ($name in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','PYTHONSTARTUP','PYTHONEXECUTABLE','PYTHONINSPECT','UV_CONFIG_FILE','UV_PYTHON_CACHE_DIR','UV_CACHE_DIR','UV_OFFLINE','UV_NO_CACHE')) { [void]$psi.Environment.Remove($name) }
    $psi.Environment['UV_NO_CONFIG'] = '1'
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'EINSTALL_CHILD: installer component did not start' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(1800000)) { try { $process.Kill($true) } catch {}; $process.WaitForExit(); throw 'EINSTALL_CHILD_TIMEOUT: installer component exceeded its time limit; preserve transaction state' }
        $process.WaitForExit(); $outText = $stdout.GetAwaiter().GetResult(); $errText = $stderr.GetAwaiter().GetResult()
        if ($outText.Length -gt 1048576 -or $errText.Length -gt 1048576) { throw 'EINSTALL_CHILD_OUTPUT: output exceeded the capture limit; preserve transaction state' }
        return [pscustomobject]@{exitCode=[int]$process.ExitCode;stdout=$outText;stderr=$errText;pid=$process.Id}
    } finally { $process.Dispose() }
}

if ($Action -in @('InspectRuntimeStage','PublishRuntimeStage')) {
    if (-not $StageRoot) { throw 'ERUNTIME_STAGE_ARGUMENT: -StageRoot is required for runtime stage inspection or publication' }
    $stagePath = [IO.Path]::GetFullPath($StageRoot).TrimEnd('\')
    if ([string]::Equals($install,$stagePath,[StringComparison]::OrdinalIgnoreCase) -or
        $install.StartsWith($stagePath + '\',[StringComparison]::OrdinalIgnoreCase) -or
        $stagePath.StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'EINSTALL_OWNERSHIP: install root and runtime stage must be separate, non-nested roots'
    }
    $stageAction = if ($Action -ceq 'InspectRuntimeStage') { 'InspectStage' } else { 'PublishStage' }
    $stageResult = Invoke-Child $runtimeManager @('-Action',$stageAction,'-RuntimeRoot',$runtime,'-StageRoot',[IO.Path]::GetFullPath($StageRoot))
    if ($stageResult.stdout) { [Console]::Out.Write($stageResult.stdout) }
    if ($stageResult.stderr) { [Console]::Error.Write($stageResult.stderr) }
    exit $stageResult.exitCode
}

$needsRuntime = $Action -in @('Install','Upgrade','Activate','Rollback','Resume')
$runtimeReady = Test-Path -LiteralPath $runtime
$runtimeInfo = $null
if ($Action -ceq 'Install' -and -not $runtimeReady) {
    if (-not $UvPath) { throw 'ERUNTIME_ARGUMENT: first install requires the bundled, hash-pinned uv executable' }
    $prepareArgs = @('-Action','Prepare','-RuntimeRoot',$runtime,'-UvPath',[IO.Path]::GetFullPath($UvPath))
    if ($pythonCache) { $prepareArgs += @('-PythonCacheRoot',$pythonCache) }
    if ($OfflineRuntime) { $prepareArgs += '-Offline' }
    $prepared = Invoke-Child $runtimeManager $prepareArgs
    if ($prepared.exitCode -ne 0) { [Console]::Error.Write($prepared.stderr); if ($prepared.stdout) { [Console]::Out.Write($prepared.stdout) }; exit $prepared.exitCode }
    if ($prepared.stdout) { [Console]::Out.Write($prepared.stdout) }
    $runtimeReady = $true
}
if ($needsRuntime -and -not $runtimeReady) { throw 'ERUNTIME_MISSING: expected managed runtime is missing; no product install state was changed' }
if ($runtimeReady) {
    $inspected = Invoke-Child $runtimeManager @('-Action','Inspect','-RuntimeRoot',$runtime)
    if ($inspected.exitCode -ne 0) { [Console]::Error.Write($inspected.stderr); if ($inspected.stdout) { [Console]::Out.Write($inspected.stdout) }; exit $inspected.exitCode }
    try { $runtimeInfo = $inspected.stdout.Trim() | ConvertFrom-Json } catch { throw 'ERUNTIME_OWNER: runtime verification did not return its structured receipt' }
}
$python = if ($runtimeInfo) { [string]$runtimeInfo.python } else { $null }
$argv = @('-Action',$Action,'-InstallRoot',$install)
if ($Action -in @('Install','Upgrade')) {
    if (-not $ManifestPath -or -not $UvPath) { throw 'EINSTALL_ARGUMENT: Install and Upgrade require a local package manifest and pinned uv executable' }
    $argv += @('-ManifestPath',[IO.Path]::GetFullPath($ManifestPath),'-UvPath',[IO.Path]::GetFullPath($UvPath),'-PythonPath',$python)
}
if ($Version) { $argv += @('-Version',$Version) }
if ($TransactionId) { $argv += @('-TransactionId',$TransactionId) }
$result = Invoke-Child $transactionEngine $argv
if ($result.stdout) { [Console]::Out.Write($result.stdout) }
if ($result.stderr) { [Console]::Error.Write($result.stderr) }
exit $result.exitCode
