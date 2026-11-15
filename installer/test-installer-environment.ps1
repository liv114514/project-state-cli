param([string]$EvidenceSuffix = 'a04', [string]$ManifestPath = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$here = $PSScriptRoot
$workspace = (Resolve-Path (Join-Path $here '..\..')).Path
$sandbox = Join-Path (Split-Path -Parent $workspace) ('.installer-environment-' + $EvidenceSuffix)
$evidence = Join-Path $workspace ('evidence\installer-environment-' + $EvidenceSuffix)
if (Test-Path -LiteralPath $sandbox) { throw 'Refusing to reuse installer environment sandbox' }
if (Test-Path -LiteralPath $evidence) { throw 'Refusing to reuse installer environment evidence' }
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$names = @('UV_CACHE_DIR','UV_LINK_MODE','PYTHONUTF8','PYTHONDONTWRITEBYTECODE')
$beforeHost = @{}
$processEnvironment=[Environment]::GetEnvironmentVariables('Process')
foreach ($name in $names) { $present=$processEnvironment.Contains($name);$beforeHost[$name]=[pscustomobject]@{present=$present;value=$(if($present){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null})} }
$python = (Get-Command python).Source
$uv = Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'
$wheel = Get-ChildItem -LiteralPath (Join-Path $workspace 'artifacts\product') -Filter '*.whl' | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $manifest = Join-Path (Split-Path -Parent $wheel.FullName) 'manifest-lifecycle-b20.json'
} else {
    $manifest = [IO.Path]::GetFullPath($ManifestPath)
}
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'Pinned installer manifest is missing' }
$installer = Join-Path $here 'install-core-prototype.ps1'
$badManifest = Join-Path $sandbox 'manifest-version-mismatch.json'
$badWheel = Join-Path $sandbox 'project_state_python_candidate-0.1.0a36-py3-none-any.whl'
Copy-Item -LiteralPath $wheel.FullName -Destination $badWheel
$manifestData = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$manifestData.version = '0.1.0a31'
$manifestData.wheel.file = Split-Path -Leaf $badWheel
$manifestData | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $badManifest -Encoding UTF8
$scriptText = 'param($ScriptPath,$Action,$InstallRoot,$ManifestPath,$UvPath,$PythonPath); & $ScriptPath -Action $Action -InstallRoot $InstallRoot -ManifestPath $ManifestPath -UvPath $UvPath -PythonPath $PythonPath'
function Invoke-InProcess([string]$root, [string]$manifestPath) {
    $runspace = [PowerShell]::Create()
    $consoleError = [IO.StringWriter]::new()
    $oldConsoleError = [Console]::Error
    try {
        [Console]::SetError($consoleError)
        [void]$runspace.AddScript($scriptText)
        foreach ($value in @($installer,'Install',$root,$manifestPath,$uv,$python)) { [void]$runspace.AddArgument($value) }
        $output = $runspace.Invoke()
        $errors = @($runspace.Streams.Error | ForEach-Object { $_.ToString() })
        return [pscustomobject]@{ state=$runspace.InvocationStateInfo.State.ToString(); output=@($output | ForEach-Object { [string]$_ }); errors=$errors; consoleError=$consoleError.ToString() }
    } finally { [Console]::SetError($oldConsoleError); $runspace.Dispose(); $consoleError.Dispose() }
}
function Read-EnvironmentState {
    $state = [ordered]@{}
    $current=[Environment]::GetEnvironmentVariables('Process')
    foreach ($name in $names) { $present=$current.Contains($name);$state[$name]=[pscustomobject]@{present=$present;value=$(if($present){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null})} }
    return $state
}
function Set-EnvironmentState([System.Collections.IDictionary]$state) {
    foreach ($name in $names) { if($state[$name].present){[Environment]::SetEnvironmentVariable($name,[string]$state[$name].value,'Process')}else{Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue} }
}
$results = [System.Collections.Generic.List[object]]::new()
try {
    foreach ($name in $names) { Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue }
    $success = Invoke-InProcess (Join-Path $sandbox 'success-root') $manifest
    $successState = Read-EnvironmentState
    $unsetRestored = @($names | Where-Object { $successState[$_].present }).Count -eq 0
    $results.Add([pscustomobject]@{ scenario='success-previously-unset'; runspaceState=$success.state; output=$success.output; errors=$success.errors; environment=$successState; restored=$unsetRestored })

    $sentinelCache = Join-Path $sandbox 'preserved-user-cache'
    New-Item -ItemType Directory -Path $sentinelCache -Force | Out-Null
    $preset = [ordered]@{ UV_CACHE_DIR=[pscustomobject]@{present=$true;value=$sentinelCache}; UV_LINK_MODE=[pscustomobject]@{present=$true;value='copy'}; PYTHONUTF8=[pscustomobject]@{present=$true;value='0'}; PYTHONDONTWRITEBYTECODE=[pscustomobject]@{present=$true;value='0'} }
    Set-EnvironmentState $preset
    $failed = Invoke-InProcess (Join-Path $sandbox 'failure-root') $badManifest
    $failureState = Read-EnvironmentState
    $presetRestored = $true
    foreach ($name in $names) { if (-not $failureState[$name].present -or $failureState[$name].value -cne $preset[$name].value) { $presetRestored = $false } }
    $expectedFailure = $failed.consoleError -match 'EINSTALL_VERIFY: module version or origin did not match the isolated environment'
    $results.Add([pscustomobject]@{ scenario='metadata-failure-previously-set'; runspaceState=$failed.state; output=$failed.output; errors=$failed.errors; consoleError=$failed.consoleError; environment=$failureState; expectedFailureObserved=$expectedFailure; restored=$presetRestored })

    $longRoot = Join-Path $sandbox ('long-' + ('x' * 220))
    $early = Invoke-InProcess $longRoot $manifest
    $earlyState = Read-EnvironmentState
    $earlyRestored = $true
    foreach ($name in $names) { if (-not $earlyState[$name].present -or $earlyState[$name].value -cne $preset[$name].value) { $earlyRestored = $false } }
    $earlyExpected = $early.consoleError -match 'EINSTALL_PATH_LIMIT'
    $results.Add([pscustomobject]@{ scenario='path-preflight-refusal-previously-set'; runspaceState=$early.state; output=$early.output; errors=$early.errors; consoleError=$early.consoleError; expectedFailureObserved=$earlyExpected; environment=$earlyState; installRootCreated=(Test-Path -LiteralPath $longRoot); restored=$earlyRestored })
} finally {
    Set-EnvironmentState $beforeHost
}
$passed = $results.Count -eq 3 -and @($results | Where-Object { -not $_.restored }).Count -eq 0 -and $results[1].expectedFailureObserved -and $results[2].expectedFailureObserved -and $results[2].installRootCreated -eq $false
$record = [ordered]@{ started=(Get-Date).ToString('o'); ended=(Get-Date).ToString('o'); cwd=(Get-Location).Path; powershell=$PSVersionTable.PSVersion.ToString(); python=((& $python --version 2>&1)|Out-String).Trim(); uv=((& $uv --version 2>&1)|Out-String).Trim(); installerPath=$installer; scenarios=@($results); result=if($passed){'PASS'}else{'FAIL'} }
$jsonPath = Join-Path $evidence 'run.json'
$logPath = Join-Path $evidence 'stdout-stderr.log'
[IO.File]::WriteAllText($jsonPath,($record | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
$lines = foreach ($row in $results) { $expectedText = if ($row.PSObject.Properties.Name -contains 'expectedFailureObserved') { [string]$row.expectedFailureObserved } else { 'n/a' }; "[$($row.scenario)] runspace=$($row.runspaceState) restored=$($row.restored) expectedFailure=$expectedText"; $row.output; $row.errors; if ($row.PSObject.Properties.Name -contains 'consoleError') { $row.consoleError } }
[IO.File]::WriteAllLines($logPath,$lines,[Text.UTF8Encoding]::new($false))
if (-not $passed) { exit 1 }
