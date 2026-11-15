[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PythonCacheRoot,
    [Parameter(Mandatory=$true)][string]$UvPath,
    [Parameter(Mandatory=$true)][string]$WheelPath,
    [string]$RunId = ('offline-runtime-' + [guid]::NewGuid().ToString('N'))
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'ETEST_POWERSHELL: PowerShell 7 or newer is required' }
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sandbox = Join-Path $workspace ('sandbox\' + $RunId)
$evidence = Join-Path $workspace ('evidence\' + $RunId)
if ((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)) { throw 'ETEST_PATH: run paths already exist; evidence will not be overwritten' }
if (-not (Test-Path -LiteralPath $PythonCacheRoot -PathType Container)) { throw 'ETEST_CACHE: cache fixture must be an existing directory' }
if (-not (Test-Path -LiteralPath $UvPath -PathType Leaf) -or -not (Test-Path -LiteralPath $WheelPath -PathType Leaf)) { throw 'ETEST_ARTIFACT: pinned uv and candidate wheel are required' }
[IO.Directory]::CreateDirectory($sandbox) | Out-Null
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$cache = [IO.Path]::GetFullPath($PythonCacheRoot)
$uv = [IO.Path]::GetFullPath($UvPath)
$wheel = [IO.Path]::GetFullPath($WheelPath)
$installer = Join-Path $PSScriptRoot 'install-managed.ps1'
$runtimePreparer = Join-Path $PSScriptRoot 'prepare-python-runtime.ps1'
$started = [DateTimeOffset]::Now

function Invoke-Process([string]$File,[string[]]$Arguments,[string]$StdoutPath,[string]$StderrPath,[string]$WorkingDirectory) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $File
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($arg in $Arguments) { [void]$psi.ArgumentList.Add([string]$arg) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'ETEST_SPAWN: child did not start' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(1800000)) { try { $process.Kill($true) } catch {}; $process.WaitForExit(); throw 'ETEST_TIMEOUT: child exceeded its bound; preserve its state' }
        $process.WaitForExit(); $outText = $stdout.GetAwaiter().GetResult(); $errText = $stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText($StdoutPath,$outText,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($StderrPath,$errText,[Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{exitCode=[int]$process.ExitCode;stdout=$outText;stderr=$errText;pid=$process.Id;stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($outText);stderrBytes=[Text.Encoding]::UTF8.GetByteCount($errText)}
    } finally { $process.Dispose() }
}
function Invoke-Shim([string]$ShimPath,[string[]]$Arguments,[string]$StdoutPath,[string]$StderrPath,[string]$WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
        $output = @(& $ShimPath @Arguments 2>&1)
        $code = $LASTEXITCODE
        $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
        [IO.File]::WriteAllText($StdoutPath,$text,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($StderrPath,'',[Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{exitCode=[int]$code;stdout=$text;stderr='';pid=$PID;stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($text);stderrBytes=0}
    } finally { Pop-Location }
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$rows = [System.Collections.Generic.List[object]]::new()
try {
    $preparedRuntime = Join-Path $sandbox 'runtime-direct'
    $prepared = Invoke-Process $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$runtimePreparer,'-Action','Prepare','-RuntimeRoot',$preparedRuntime,'-UvPath',$uv,'-PythonCacheRoot',$cache,'-Offline') (Join-Path $evidence 'prepare-cached.stdout.log') (Join-Path $evidence 'prepare-cached.stderr.log') $workspace
    $preparedOkay = $prepared.exitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $preparedRuntime 'cpython-3.12.13-windows-x86_64-none\python.exe'))
    $preparedIdentity = if ($preparedOkay) { try { $prepared.stdout | ConvertFrom-Json } catch { $null } } else { $null }
    $aliasPath = Join-Path $preparedRuntime 'cpython-3.12-windows-x86_64-none'
    $noAliasPublished = $null -ne $preparedIdentity -and $preparedIdentity.aliasMode -ceq 'versioned-runtime-no-alias' -and -not (Test-Path -LiteralPath $aliasPath)
    $rows.Add([ordered]@{case='cached-offline-runtime-prepare';exitCode=$prepared.exitCode;result=if($preparedOkay){'PASS'}else{'FAIL'};runtimePresent=(Test-Path -LiteralPath (Join-Path $preparedRuntime 'cpython-3.12.13-windows-x86_64-none\python.exe'));aliasMode=if($preparedIdentity){$preparedIdentity.aliasMode}else{$null};aliasAbsentWhenNotRequired=if($preparedIdentity.aliasMode -ceq 'versioned-runtime-no-alias'){$noAliasPublished}else{$null};runtimeTreeSha256=if($preparedIdentity){$preparedIdentity.treeSha256}else{$null};stdoutLog='prepare-cached.stdout.log';stderrLog='prepare-cached.stderr.log'})
    if (-not $preparedOkay) { throw 'ETEST_PREPARE: cached offline runtime preparation did not publish a verifiable runtime' }
    if ($null -eq $preparedIdentity -or $preparedIdentity.pythonVersion -cne '3.12.13' -or [version]$preparedIdentity.sqliteVersion -lt [version]'3.51.3' -or
        $preparedIdentity.uvSha256 -cne '1791d7a9ed5b6df13ccf80f102e025c333010d96326b4ff0262aa3b578835c5a' -or
        ($preparedIdentity.aliasMode -eq 'versioned-runtime-no-alias' -and -not $noAliasPublished)) {
        throw 'ETEST_RUNTIME_IDENTITY: published runtime or explicit no-alias layout did not match the pinned contract'
    }
    $inspect = Invoke-Process $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$runtimePreparer,'-Action','Inspect','-RuntimeRoot',$preparedRuntime) (Join-Path $evidence 'inspect-cached.stdout.log') (Join-Path $evidence 'inspect-cached.stderr.log') $workspace
    $inspectOkay = $inspect.exitCode -eq 0 -and $inspect.stdout.Trim() -eq $prepared.stdout.Trim()
    $rows.Add([ordered]@{case='published-runtime-inspect-identity';exitCode=$inspect.exitCode;result=if($inspectOkay){'PASS'}else{'FAIL'};sameCanonicalIdentity=$inspectOkay;stdoutLog='inspect-cached.stdout.log';stderrLog='inspect-cached.stderr.log'})
    if (-not $inspectOkay) { throw 'ETEST_RUNTIME_INSPECT: published runtime did not independently reproduce its bound identity' }

    $packageDir = Join-Path $sandbox 'package'
    [IO.Directory]::CreateDirectory($packageDir) | Out-Null
    $wheelCopy = Join-Path $packageDir ([IO.Path]::GetFileName($wheel))
    [IO.File]::WriteAllBytes($wheelCopy,[IO.File]::ReadAllBytes($wheel))
    $wheelHash = (Get-FileHash -LiteralPath $wheelCopy -Algorithm SHA256).Hash.ToLowerInvariant()
    $wheelBytes = [long](Get-Item -LiteralPath $wheelCopy).Length
    $versionMatch = [regex]::Match([IO.Path]::GetFileName($wheelCopy),'project_state_python_candidate-(\d+\.\d+\.\d+[a-zA-Z0-9.-]*)-py3-none-any\.whl')
    if (-not $versionMatch.Success) { throw 'ETEST_WHEEL: wheel filename did not contain the expected local candidate version' }
    $version = $versionMatch.Groups[1].Value
    $manifest = [ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$version;wheel=[ordered]@{file=[IO.Path]::GetFileName($wheelCopy);sha256=$wheelHash;bytes=$wheelBytes};uv=[ordered]@{version='0.13.7';sha256='1791d7a9ed5b6df13ccf80f102e025c333010d96326b4ff0262aa3b578835c5a'}}
    $manifestPath = Join-Path $packageDir 'manifest.json'
    [IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 5)+"`n",[Text.UTF8Encoding]::new($false))
    $installRoot = Join-Path $sandbox 'install-root'
    $offlineRuntimeRoot = Join-Path $sandbox 'runtime-managed'
    $installed = Invoke-Process $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$installer,'-Action','Install','-InstallRoot',$installRoot,'-RuntimeRoot',$offlineRuntimeRoot,'-ManifestPath',$manifestPath,'-UvPath',$uv,'-PythonCacheRoot',$cache,'-OfflineRuntime') (Join-Path $evidence 'wrapper-offline-install.stdout.log') (Join-Path $evidence 'wrapper-offline-install.stderr.log') $workspace
    $cli = Join-Path $installRoot 'bin\project-state.cmd'
    $cliResult = if (Test-Path -LiteralPath $cli -PathType Leaf) { Invoke-Shim $cli @('--version') (Join-Path $evidence 'installed-version.stdout.log') (Join-Path $evidence 'installed-version.stderr.log') $workspace } else { [pscustomobject]@{exitCode=$null;stdout='';stderr='installed CLI missing';pid=$null} }
    $installOkay = $installed.exitCode -eq 0 -and $cliResult.exitCode -eq 0 -and $cliResult.stdout.Trim() -eq $version
    $rows.Add([ordered]@{case='managed-wrapper-fresh-install-offline';exitCode=$installed.exitCode;cliExitCode=$cliResult.exitCode;installedVersion=$cliResult.stdout.Trim();expectedVersion=$version;result=if($installOkay){'PASS'}else{'FAIL'};stdoutLog='wrapper-offline-install.stdout.log';stderrLog='wrapper-offline-install.stderr.log'})
    if (-not $installOkay) { throw 'ETEST_WRAPPER: offline managed install or installed CLI verification failed' }

    $emptyCache = Join-Path $sandbox 'empty-cache'
    [IO.Directory]::CreateDirectory($emptyCache) | Out-Null
    $missingRuntime = Join-Path $sandbox 'runtime-empty-cache'
    $missing = Invoke-Process $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$runtimePreparer,'-Action','Prepare','-RuntimeRoot',$missingRuntime,'-UvPath',$uv,'-PythonCacheRoot',$emptyCache,'-Offline') (Join-Path $evidence 'prepare-empty-cache.stdout.log') (Join-Path $evidence 'prepare-empty-cache.stderr.log') $workspace
    $missingOkay = $missing.exitCode -eq 2 -and $missing.stderr -match 'ERUNTIME_OFFLINE_CACHE_UNAVAILABLE' -and -not (Test-Path -LiteralPath $missingRuntime)
    $rows.Add([ordered]@{case='empty-cache-refused-without-runtime-publication';exitCode=$missing.exitCode;result=if($missingOkay){'PASS'}else{'FAIL'};runtimePublished=(Test-Path -LiteralPath $missingRuntime);diagnosticClass=if($missing.stderr -match 'ERUNTIME_OFFLINE_CACHE_UNAVAILABLE'){'ERUNTIME_OFFLINE_CACHE_UNAVAILABLE'}else{'OTHER'};stdoutLog='prepare-empty-cache.stdout.log';stderrLog='prepare-empty-cache.stderr.log'})
    if (-not $missingOkay) { throw 'ETEST_EMPTY_CACHE: empty offline cache was not refused with the expected stable class' }

    $noCacheRuntime = Join-Path $sandbox 'runtime-no-cache-argument'
    $noCache = Invoke-Process $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$runtimePreparer,'-Action','Prepare','-RuntimeRoot',$noCacheRuntime,'-UvPath',$uv,'-Offline') (Join-Path $evidence 'prepare-no-cache-argument.stdout.log') (Join-Path $evidence 'prepare-no-cache-argument.stderr.log') $workspace
    $noCacheOkay = $noCache.exitCode -ne 0 -and $noCache.stderr -match 'ERUNTIME_OFFLINE_CACHE_REQUIRED' -and -not (Test-Path -LiteralPath $noCacheRuntime)
    $rows.Add([ordered]@{case='offline-without-cache-path-refused-before-runtime';exitCode=$noCache.exitCode;result=if($noCacheOkay){'PASS'}else{'FAIL'};runtimePublished=(Test-Path -LiteralPath $noCacheRuntime);diagnosticClass=if($noCache.stderr -match 'ERUNTIME_OFFLINE_CACHE_REQUIRED'){'ERUNTIME_OFFLINE_CACHE_REQUIRED'}else{'OTHER'};stdoutLog='prepare-no-cache-argument.stdout.log';stderrLog='prepare-no-cache-argument.stderr.log'})
    if (-not $noCacheOkay) { throw 'ETEST_NO_CACHE: offline preparation without a cache path was not rejected before runtime publication' }
} finally {
    $result = [ordered]@{schemaVersion=1;runId=$RunId;candidateVersion='0.1.0a49';startedAt=$started.ToString('o');finishedAt=[DateTimeOffset]::Now.ToString('o');cwd=$workspace;pwsh=$PSVersionTable.PSVersion.ToString();uvVersion='0.13.7';uvSha256=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant();cachePath='<explicit isolated cache supplied by caller>';cases=@($rows.ToArray());pass=@($rows|Where-Object result -eq 'PASS').Count;fail=@($rows|Where-Object result -eq 'FAIL').Count;result=if($rows.Count -eq 5 -and @($rows|Where-Object result -ne 'PASS').Count -eq 0){'PASS'}else{'FAIL'}}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($result|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
    $result | ConvertTo-Json -Depth 8
}
if ($result.result -ne 'PASS') { exit 1 }
