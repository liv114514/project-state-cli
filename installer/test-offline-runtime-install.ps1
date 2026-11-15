[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][string]$WheelPath,
    [Parameter(Mandatory=$true)][string]$UvPath,
    [Parameter(Mandatory=$true)][string]$WarmPythonCache,
    [Parameter(Mandatory=$true)][string]$SandboxRoot,
    [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$started = [DateTimeOffset]::Now
$candidate = [IO.Path]::GetFullPath($CandidateRoot)
$sandbox = [IO.Path]::GetFullPath($SandboxRoot)
$resultFull = [IO.Path]::GetFullPath($ResultPath)
foreach ($path in @($sandbox,$resultFull)) {
    if ($path.StartsWith($candidate + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'ETEST_LAYOUT: sandbox and result must be outside the frozen candidate tree'
    }
}
foreach ($path in @($sandbox,$resultFull)) {
    if (Test-Path -LiteralPath $path) { throw 'ETEST_REUSE: refusing to overwrite an existing test object' }
}
$null = New-Item -ItemType Directory -Path $sandbox
$evidenceDir = Split-Path -Parent $resultFull
$null = New-Item -ItemType Directory -Path $evidenceDir -Force
$inputDir = Join-Path $sandbox 'input'
$null = New-Item -ItemType Directory -Path $inputDir
$wheel = Join-Path $inputDir ([IO.Path]::GetFileName($WheelPath))
Copy-Item -LiteralPath $WheelPath -Destination $wheel
$wheelInfo = Get-Item -LiteralPath $wheel
$wheelHash = (Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant()
$uvInfo = (& $UvPath --version 2>&1 | Out-String).Trim()
$uvHash = (Get-FileHash -LiteralPath $UvPath -Algorithm SHA256).Hash.ToLowerInvariant()
$version = '0.1.0a49'
if ($uvInfo -cne 'uv 0.13.7 (316c827e0 2026-11-03 x86_64-pc-windows-msvc)' -or
    $uvHash -cne '1791d7a9ed5b6df13ccf80f102e025c333010d96326b4ff0262aa3b578835c5a') {
    throw 'ETEST_TOOL_IDENTITY: pinned uv identity did not match'
}
$manifestPath = Join-Path $inputDir 'manifest.json'
$manifest = [ordered]@{
    schemaVersion=1; kind='local-sandbox-candidate'; version=$version
    wheel=[ordered]@{file=$wheelInfo.Name;sha256=$wheelHash;bytes=[long]$wheelInfo.Length}
    uv=[ordered]@{version='0.13.7';sha256=$uvHash}
}
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$wrapper = Join-Path $candidate 'repo\installer\install-managed.ps1'
$pwshPath = (Get-Process -Id $PID).Path
$cases = [Collections.Generic.List[object]]::new()
$transcript = [Collections.Generic.List[string]]::new()
function Invoke-Process([string[]]$Arguments) {
    $process = [Diagnostics.Process]::new()
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pwshPath
    $psi.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32'))
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper) + $Arguments) { [void]$psi.ArgumentList.Add([string]$arg) }
    foreach ($name in @('UV_PYTHON_CACHE_DIR','UV_CACHE_DIR','UV_OFFLINE','UV_NO_CACHE','UV_CONFIG_FILE','PYTHONHOME','PYTHONPATH','PYTHONUSERBASE')) { [void]$psi.Environment.Remove($name) }
    $psi.Environment['UV_NO_CONFIG']='1'
    $process.StartInfo=$psi
    try {
        if (-not $process.Start()) { throw 'ETEST_CHILD_START' }
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(1800000)) { try{$process.Kill($true)}catch{}; $process.WaitForExit(); throw 'ETEST_CHILD_TIMEOUT' }
        $process.WaitForExit()
        return [pscustomobject]@{exitCode=[int]$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult();pid=$process.Id}
    } finally { $process.Dispose() }
}
function Invoke-Shim([string]$ShimPath,[string[]]$CliArguments) {
    $output = @(& $ShimPath @CliArguments 2>&1)
    $code = $LASTEXITCODE
    return [pscustomobject]@{exitCode=[int]$code;stdout=(($output|ForEach-Object{[string]$_}) -join "`n");stderr='';pid=$PID}
}
function Save-Case([string]$Name,[string]$Command,[object]$Observed,[string]$Status) {
    $record=[ordered]@{name=$Name;command=$Command;status=$Status;exitCode=$Observed.exitCode;stdout=$Observed.stdout;stderr=$Observed.stderr;pid=$Observed.pid}
    $cases.Add($record); $transcript.Add(($record|ConvertTo-Json -Depth 6 -Compress))
}

$cache = [IO.Path]::GetFullPath($WarmPythonCache)
$installRoot = Join-Path $sandbox 'install-offline'
$runtimeRoot = Join-Path $sandbox 'runtime-offline'
$args = @('-Action','Install','-InstallRoot',$installRoot,'-RuntimeRoot',$runtimeRoot,'-ManifestPath',$manifestPath,'-UvPath',[IO.Path]::GetFullPath($UvPath),'-PythonCacheRoot',$cache,'-OfflineRuntime','-Version',$version)
$ok = Invoke-Process $args
$transcript.Add("CASE cached-offline-install exit=$($ok.exitCode)`n$($ok.stdout)`n$($ok.stderr)")
$transcript.Add("runtimeExists=$([bool](Test-Path -LiteralPath $runtimeRoot)) installExists=$([bool](Test-Path -LiteralPath $installRoot))")
[IO.File]::WriteAllText([IO.Path]::ChangeExtension($resultFull,'.progress.log'),($transcript -join "`r`n`r`n"),[Text.UTF8Encoding]::new($false))
if ($ok.exitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $installRoot 'bin\project-state.cmd')) -or -not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'cpython-3.12.13-windows-x86_64-none\python.exe'))) {
    Save-Case 'cached-offline-install' 'install-managed Install -OfflineRuntime with isolated warm cache' $ok 'FAIL'
    throw 'ETEST_OFFLINE_INSTALL: cached offline install did not publish both managed runtime and product install'
}
Save-Case 'cached-offline-install' 'install-managed Install -OfflineRuntime with isolated warm cache' $ok 'PASS'
$shim = Join-Path $installRoot 'bin\project-state.cmd'
$versionProbe = Invoke-Shim $shim @('--version')
$transcript.Add("CASE installed-cli-version exit=$($versionProbe.exitCode)`n$($versionProbe.stdout)`n$($versionProbe.stderr)")
[IO.File]::WriteAllText([IO.Path]::ChangeExtension($resultFull,'.progress.log'),($transcript -join "`r`n`r`n"),[Text.UTF8Encoding]::new($false))
if ($versionProbe.exitCode -ne 0 -or $versionProbe.stdout.Trim() -cne $version) {
    Save-Case 'installed-cli-version' 'installed project-state.cmd --version' $versionProbe 'FAIL'
    throw 'ETEST_CLI_VERSION: installed CLI did not report the exact wheel version'
}
Save-Case 'installed-cli-version' 'installed project-state.cmd --version' $versionProbe 'PASS'

$emptyCache = Join-Path $sandbox 'empty-python-cache'
$null = New-Item -ItemType Directory -Path $emptyCache
$missRuntime = Join-Path $sandbox 'runtime-cache-miss'
$missInstall = Join-Path $sandbox 'install-cache-miss'
$missArgs = @('-Action','Install','-InstallRoot',$missInstall,'-RuntimeRoot',$missRuntime,'-ManifestPath',$manifestPath,'-UvPath',[IO.Path]::GetFullPath($UvPath),'-PythonCacheRoot',$emptyCache,'-OfflineRuntime','-Version',$version)
$miss = Invoke-Process $missArgs
$transcript.Add("CASE empty-cache-refusal exit=$($miss.exitCode)`n$($miss.stdout)`n$($miss.stderr)")
[IO.File]::WriteAllText([IO.Path]::ChangeExtension($resultFull,'.progress.log'),($transcript -join "`r`n`r`n"),[Text.UTF8Encoding]::new($false))
$missText = $miss.stdout + $miss.stderr
if ($miss.exitCode -eq 0 -or $missText -notmatch 'ERUNTIME_OFFLINE_CACHE_UNAVAILABLE' -or (Test-Path -LiteralPath $missRuntime) -or (Test-Path -LiteralPath $missInstall)) {
    Save-Case 'empty-cache-refusal' 'install-managed Install -OfflineRuntime with empty isolated cache' $miss 'FAIL'
    throw 'ETEST_CACHE_MISS: empty-cache request was not safely refused before publishing runtime or product state'
}
Save-Case 'empty-cache-refusal' 'install-managed Install -OfflineRuntime with empty isolated cache' $miss 'PASS'

$requiredRuntime = Join-Path $sandbox 'runtime-cache-required'
$requiredInstall = Join-Path $sandbox 'install-cache-required'
$required = Invoke-Process @('-Action','Install','-InstallRoot',$requiredInstall,'-RuntimeRoot',$requiredRuntime,'-ManifestPath',$manifestPath,'-UvPath',[IO.Path]::GetFullPath($UvPath),'-OfflineRuntime','-Version',$version)
$requiredText = $required.stdout + $required.stderr
$transcript.Add("CASE missing-cache-argument-refusal exit=$($required.exitCode)`n$($required.stdout)`n$($required.stderr)")
[IO.File]::WriteAllText([IO.Path]::ChangeExtension($resultFull,'.progress.log'),($transcript -join "`r`n`r`n"),[Text.UTF8Encoding]::new($false))
if ($required.exitCode -eq 0 -or $requiredText -notmatch 'ERUNTIME_OFFLINE_CACHE_REQUIRED' -or (Test-Path -LiteralPath $requiredRuntime) -or (Test-Path -LiteralPath $requiredInstall)) {
    Save-Case 'missing-cache-argument-refusal' 'install-managed Install -OfflineRuntime without PythonCacheRoot' $required 'FAIL'
    throw 'ETEST_CACHE_REQUIRED: missing offline cache argument was not safely refused before publication'
}
Save-Case 'missing-cache-argument-refusal' 'install-managed Install -OfflineRuntime without PythonCacheRoot' $required 'PASS'

$result = [ordered]@{
    schemaVersion=1; candidate='0.1.0a49'; startedAt=$started.ToString('o'); endedAt=[DateTimeOffset]::Now.ToString('o')
    powershell=$PSVersionTable.PSVersion.ToString(); pwshPath=$pwshPath; uvVersion=$uvInfo; uvSha256=$uvHash
    pythonCacheRoot=$cache; wheelBytes=[long]$wheelInfo.Length; wheelSha256=$wheelHash
    cases=@($cases.ToArray()); counts=[ordered]@{pass=@($cases|Where-Object status -eq 'PASS').Count;fail=@($cases|Where-Object status -eq 'FAIL').Count;skip=0;notRun=0}; result='PASS'
}
[IO.File]::WriteAllText($resultFull,($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$transcriptPath = [IO.Path]::ChangeExtension($resultFull,'.log')
[IO.File]::WriteAllText($transcriptPath,($transcript -join "`r`n`r`n"),[Text.UTF8Encoding]::new($false))
Get-Content -LiteralPath $resultFull
