[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(Mandatory=$true)][string]$WheelPath,
    [Parameter(Mandatory=$true)][string]$UvPath,
    [Parameter(Mandatory=$true)][string]$WorkRoot,
    [string]$RunId = ('a49-installed-cli-' + [guid]::NewGuid().ToString('N'))
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'ETEST_POWERSHELL: PowerShell 7 or newer is required' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$work = [IO.Path]::GetFullPath($WorkRoot)
$evidence = Join-Path $workspace ('evidence\' + $RunId)
if (-not [IO.Path]::IsPathRooted($WorkRoot)) { throw 'ETEST_PATH: WorkRoot must be absolute' }
if ((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $evidence)) { throw 'ETEST_PATH: run paths already exist; evidence is never overwritten' }
foreach ($path in @($RuntimeRoot,$WheelPath,$UvPath)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf) -and -not (Test-Path -LiteralPath $path -PathType Container)) { throw 'ETEST_INPUT: pinned runtime, wheel, and uv are required' } }
[IO.Directory]::CreateDirectory($work) | Out-Null
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$started = [DateTimeOffset]::Now
$rows = [System.Collections.Generic.List[object]]::new()
$commands = [System.Collections.Generic.List[object]]::new()
$failure = $null
$version = $null; $runtime = $null; $wheelHash = $null
$Utf8 = [Text.UTF8Encoding]::new($false)

function Invoke-Recorded([string]$File,[string[]]$Arguments,[string]$Cwd,[string]$Label,[hashtable]$Environment=@{}) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $File; $psi.WorkingDirectory = $Cwd; $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($arg in $Arguments) { [void]$psi.ArgumentList.Add([string]$arg) }
    foreach ($key in $Environment.Keys) { $psi.Environment[[string]$key] = [string]$Environment[$key] }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'ETEST_SPAWN: child did not start' }
        $outTask = $process.StandardOutput.ReadToEndAsync(); $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(300000)) { try { $process.Kill($true) } catch {}; $process.WaitForExit(); throw 'ETEST_TIMEOUT: process exceeded five minutes; preserve the synthetic work root' }
        $process.WaitForExit(); $outText = $outTask.GetAwaiter().GetResult(); $errText = $errTask.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($outText) -gt 2097152 -or [Text.Encoding]::UTF8.GetByteCount($errText) -gt 2097152) { throw 'ETEST_OUTPUT: output exceeded the capture limit' }
        [IO.File]::WriteAllText((Join-Path $evidence ($Label + '.stdout.log')),$outText,$Utf8)
        [IO.File]::WriteAllText((Join-Path $evidence ($Label + '.stderr.log')),$errText,$Utf8)
        $observation=if($Label -eq 'installed-raw-rollback-command'){'cmd.exe PID observed; nested CLI PID not directly observed'}elseif($Label -like 'installed-*'){'PowerShell wrapper PID observed; nested .cmd/Python PID not directly observed'}else{'direct child process PID observed'}
        $record = [ordered]@{label=$Label;file=$File;argv=@($Arguments);cwd=$Cwd;pid=$process.Id;processObservation=$observation;exitCode=[int]$process.ExitCode;stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($outText);stderrBytes=[Text.Encoding]::UTF8.GetByteCount($errText);stdoutLog=($Label + '.stdout.log');stderrLog=($Label + '.stderr.log')}
        $commands.Add($record)
        return [pscustomobject]@{exitCode=[int]$process.ExitCode;stdout=$outText;stderr=$errText;pid=$process.Id;argv=@($Arguments)}
    } finally { $process.Dispose() }
}
function Require([bool]$Condition,[string]$Code) { if (-not $Condition) { throw ('ETEST_ASSERT: ' + $Code) } }
function Add-Case([string]$Name,[bool]$Passed,[string]$Evidence) {
    $rows.Add([ordered]@{case=$Name;result=if($Passed){'PASS'}else{'FAIL'};evidence=$Evidence})
    if (-not $Passed) { throw ('ETEST_CASE: ' + $Name) }
}
function Invoke-Installed([string]$Shim,[string[]]$CliArgs,[string]$Cwd,[string]$Label,[hashtable]$Env) {
    $argsPath=Join-Path $script:evidence ($Label + '.argv.json')
    [IO.File]::WriteAllText($argsPath,(ConvertTo-Json @($CliArgs) -Compress),$script:Utf8)
    $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:shimInvoker,'-ShimPath',$Shim,'-ArgsPath',$argsPath)
    Invoke-Recorded $script:pwsh $argv $Cwd $Label $Env
}

try {
    $wheel = [IO.Path]::GetFullPath($WheelPath); $uv = [IO.Path]::GetFullPath($UvPath); $runtime = [IO.Path]::GetFullPath($RuntimeRoot)
    $wheelName = [IO.Path]::GetFileName($wheel)
    $versionMatch = [regex]::Match($wheelName,'project_state_python_candidate-(\d+\.\d+\.\d+[a-zA-Z0-9.-]*)-py3-none-any\.whl')
    Require $versionMatch.Success 'wheel filename must identify one candidate version'
    $version = $versionMatch.Groups[1].Value
    $packageDir = Join-Path $work 'package'; [IO.Directory]::CreateDirectory($packageDir) | Out-Null
    $wheelCopy = Join-Path $packageDir $wheelName
    [IO.File]::Copy($wheel,$wheelCopy,$false)
    $wheelHash = (Get-FileHash -LiteralPath $wheelCopy -Algorithm SHA256).Hash.ToLowerInvariant()
    $wheelBytes = [long](Get-Item -LiteralPath $wheelCopy).Length
    $manifest = [ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$version;wheel=[ordered]@{file=$wheelName;sha256=$wheelHash;bytes=$wheelBytes};uv=[ordered]@{version='0.13.7';sha256='1791d7a9ed5b6df13ccf80f102e025c333010d96326b4ff0262aa3b578835c5a'}}
    $manifestPath = Join-Path $packageDir 'manifest.json'
    [IO.File]::WriteAllText($manifestPath,(ConvertTo-Json $manifest -Depth 5)+"`n",$Utf8)
    $installRoot = Join-Path $work 'install root with spaces'; $runtimeRoot = $runtime
    # Reuse the independently inspected runtime as read-only input: copying it would invalidate its
    # directory-identity-bound owner receipt and would test a forged runtime rather than installation.
    $runtimeSource = Join-Path $runtime 'cpython-3.12.13-windows-x86_64-none'
    Require (Test-Path -LiteralPath (Join-Path $runtimeSource 'python.exe') -PathType Leaf) 'verified versioned CPython runtime is required'
    $installer = Join-Path $PSScriptRoot 'install-managed.ps1'; $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source; $script:pwsh=$pwsh; $script:evidence=$evidence; $script:Utf8=$Utf8
    $script:shimInvoker=Join-Path $work 'invoke-installed-shim.ps1'
    [IO.File]::WriteAllText($script:shimInvoker,"param([Parameter(Mandatory=`$true)][string]`$ShimPath,[Parameter(Mandatory=`$true)][string]`$ArgsPath)`r`n`$CliArgs=@(Get-Content -LiteralPath `$ArgsPath -Raw | ConvertFrom-Json)`r`n`& `$ShimPath @CliArgs`r`nexit `$LASTEXITCODE`r`n",$Utf8)
    $install = Invoke-Recorded $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$installer,'-Action','Install','-InstallRoot',$installRoot,'-RuntimeRoot',$runtimeRoot,'-ManifestPath',$manifestPath,'-UvPath',$uv,'-Version',$version) $workspace 'fresh-installed-candidate' @{UV_NO_CONFIG='1'}
    $shim = Join-Path $installRoot 'bin\project-state.cmd'
    Require ($install.exitCode -eq 0 -and (Test-Path -LiteralPath $shim -PathType Leaf)) 'managed install must succeed and publish its owned command shim'
    $project = Join-Path $work '项目 with spaces'; [IO.Directory]::CreateDirectory($project) | Out-Null
    $state = Join-Path $work 's'; [IO.Directory]::CreateDirectory($state) | Out-Null
    $gitHome = Join-Path $work 'g'; [IO.Directory]::CreateDirectory($gitHome) | Out-Null
    $gitignore = ".env`n.project-state/`n"; [IO.File]::WriteAllText((Join-Path $project '.gitignore'),$gitignore,$Utf8)
    $gitEnv = @{GIT_CONFIG_NOSYSTEM='1';GIT_CONFIG_GLOBAL='NUL';HOME=$gitHome;USERPROFILE=$gitHome;GIT_AUTHOR_NAME='Synthetic Test';GIT_AUTHOR_EMAIL='synthetic@example.invalid';GIT_COMMITTER_NAME='Synthetic Test';GIT_COMMITTER_EMAIL='synthetic@example.invalid'}
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $init = Invoke-Recorded $git @('init','-b','main') $project 'git-init' $gitEnv
    Require ($init.exitCode -eq 0) 'synthetic Git init must succeed'
    $add = Invoke-Recorded $git @('add','--','.gitignore') $project 'git-add-baseline' $gitEnv
    Require ($add.exitCode -eq 0) 'synthetic baseline stage must succeed'
    $commit = Invoke-Recorded $git @('commit','-m','synthetic baseline') $project 'git-commit-baseline' $gitEnv
    Require ($commit.exitCode -eq 0) 'synthetic baseline commit must succeed'
    $headBefore = (Invoke-Recorded $git @('rev-parse','HEAD') $project 'git-head-before' $gitEnv).stdout.Trim()
    $indexBefore = (Get-FileHash -LiteralPath (Join-Path $project '.git\index') -Algorithm SHA256).Hash.ToLowerInvariant()
    $envA = "MODE=alpha`r`nPORT=12716`r`n"; $envB = "MODE=beta`r`nPORT=12717`r`n"
    [IO.File]::WriteAllText((Join-Path $project '.env'),$envA,[Text.UTF8Encoding]::new($false))
    $baseEnv = @{LOCALAPPDATA=$state;PATH=(Join-Path $installRoot 'bin')+';'+$env:PATH;UV_NO_CONFIG='1';PYTHONHOME='';PYTHONPATH='';PYTHONUSERBASE='';PYTHONSTARTUP='';PYTHONEXECUTABLE='';PYTHONINSPECT='';PYTHONNOUSERSITE='1'}
    $versionRun = Invoke-Installed $shim @('--version') $project 'installed-version' $baseEnv
    Add-Case 'exact-installed-entry-version' ($versionRun.exitCode -eq 0 -and $versionRun.stdout.Trim() -ceq $version) ('exit=' + $versionRun.exitCode)
    $help = Invoke-Installed $shim @('help') $project 'installed-help' $baseEnv
    Add-Case 'exact-installed-entry-help' ($help.exitCode -eq 0 -and $help.stdout -match 'restore' -and $help.stdout -match 'recover') ('exit=' + $help.exitCode)
    $doctor = Invoke-Installed $shim @('doctor','--json') $project 'installed-doctor' $baseEnv
    $doctorJson = $null; try { $doctorJson = $doctor.stdout | ConvertFrom-Json } catch {}
    Add-Case 'exact-installed-entry-doctor-json' ($doctor.exitCode -eq 0 -and $doctorJson.resultSchemaVersion -ge 1) ('exit=' + $doctor.exitCode)
    $demoEnv = @{} + $baseEnv; $demoEnv['PROJECT_STATE_DEMO_PARENT']=$work
    $demo = Invoke-Installed $shim @('demo') $project 'installed-demo' $demoEnv
    $demoJson = $null; try { $demoJson = $demo.stdout | ConvertFrom-Json } catch {}
    Add-Case 'exact-installed-entry-synthetic-demo' ($demo.exitCode -eq 0 -and $demoJson.state -ceq 'passed' -and $demoJson.fixture -ceq 'synthetic-config-only') ('exit=' + $demo.exitCode)
    $snapshot = Invoke-Installed $shim @('snapshot','before') $project 'installed-snapshot-a' $baseEnv
    Add-Case 'installed-config-snapshot-a' ($snapshot.exitCode -eq 0 -and $snapshot.stdout -match 'saved and verified') ('exit=' + $snapshot.exitCode)
    [IO.File]::WriteAllText((Join-Path $project '.env'),$envB,[Text.UTF8Encoding]::new($false))
    $compare = Invoke-Installed $shim @('compare','before') $project 'installed-compare-b' $baseEnv
    Add-Case 'installed-config-compare-a-to-b' ($compare.exitCode -eq 0 -and $compare.stdout -match 'changed') ('exit=' + $compare.exitCode)
    $preview = Invoke-Installed $shim @('restore','before','--only','config','--json') $project 'installed-restore-preview' $baseEnv
    $previewJson=$null;try{$previewJson=$preview.stdout|ConvertFrom-Json}catch{}
    $previewTargets=@($previewJson.targets)
    Add-Case 'installed-config-restore-preview' ($preview.exitCode -eq 0 -and $previewTargets.Count -eq 1 -and $previewTargets[0].target -ceq '.env') ('exit=' + $preview.exitCode)
    $apply = Invoke-Installed $shim @('restore','before','--only','config','--yes') $project 'installed-restore-apply-a' $baseEnv
    $match=[regex]::Match($apply.stdout,'(?m)^Operation: ([0-9a-f]{32}); rollback with: (project-state recover ([0-9a-f]{32}) --rollback --yes)\s*$')
    $envIsA=[IO.File]::ReadAllText((Join-Path $project '.env')) -ceq $envA
    Require ($match.Success -and $match.Groups[1].Value -ceq $match.Groups[3].Value) 'apply must report a parseable operation and exact raw rollback command'
    Add-Case 'installed-config-restore-bytes-a' ($apply.exitCode -eq 0 -and $envIsA) ('exit=' + $apply.exitCode)
    $inspect = Invoke-Installed $shim @('recover',$match.Groups[1].Value,'--inspect') $project 'installed-recover-inspect' $baseEnv
    $inspectJson=$null;try{$inspectJson=$inspect.stdout|ConvertFrom-Json}catch{}
    Add-Case 'installed-recovery-journal-inspect' ($inspect.exitCode -eq 0 -and $null -ne $inspectJson) ('exit=' + $inspect.exitCode)
    # Execute the exact one-line rollback command emitted by the installed CLI. Its grammar is tightly constrained above.
    $rawCommand = $match.Groups[2].Value
    Require ($rawCommand -match '^project-state recover [0-9a-f]{32} --rollback --yes$') 'printed rollback command must match the documented safe grammar'
    $cmdPath = Join-Path $env:WINDIR 'System32\cmd.exe'
    $rollback = Invoke-Recorded $cmdPath @('/d','/c',$rawCommand) $project 'installed-raw-rollback-command' $baseEnv
    $envIsB=[IO.File]::ReadAllText((Join-Path $project '.env')) -ceq $envB
    Add-Case 'installed-raw-rollback-command-restores-b' ($rollback.exitCode -eq 0 -and $envIsB) ('exit=' + $rollback.exitCode)
    $headAfter = (Invoke-Recorded $git @('rev-parse','HEAD') $project 'git-head-after' $gitEnv).stdout.Trim()
    $indexAfter = (Get-FileHash -LiteralPath (Join-Path $project '.git\index') -Algorithm SHA256).Hash.ToLowerInvariant()
    $scope = (Invoke-Recorded $git @('status','--porcelain=v1','--untracked-files=all') $project 'git-status-final' $gitEnv).stdout
    Add-Case 'git-head-index-and-tracked-scope-unchanged' ($headBefore -ceq $headAfter -and $indexBefore -ceq $indexAfter -and $scope.Trim() -eq '') ('headSame=' + ($headBefore -ceq $headAfter) + '; indexSame=' + ($indexBefore -ceq $indexAfter))
    $stateFiles=@(Get-ChildItem -LiteralPath $state -Recurse -File | ForEach-Object { [ordered]@{relative=$_.FullName.Substring($state.Length).TrimStart('\');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
    Require ($stateFiles.Count -gt 0) 'isolated per-user state must be created under the supplied synthetic LOCALAPPDATA'
    $rows.Add([ordered]@{case='isolated-state-root-contained-under-test-localappdata';result='PASS';fileCount=$stateFiles.Count})
} catch { $failure = $_.Exception.Message; [IO.File]::WriteAllText((Join-Path $evidence 'failure.txt'),$failure+"`n",$Utf8) }
finally {
    $passed=@($rows|Where-Object result -eq 'PASS').Count; $failed=@($rows|Where-Object result -eq 'FAIL').Count
    if ($failure -and $failed -eq 0) { $failed++ }
    $result=[ordered]@{schemaVersion=1;candidate='project-state-python-candidate';candidateVersion=if($version){$version}else{$null};runId=$RunId;startedAt=$started.ToString('o');finishedAt=[DateTimeOffset]::Now.ToString('o');cwd=$workspace;runtimeRoot=if($runtime){$runtime}else{$null};wheelSha256=if($wheelHash){$wheelHash}else{$null};installerPrototype='0.3.5';commands=@($commands.ToArray());cases=@($rows.ToArray());pass=$passed;fail=$failed;skip=0;result=if(-not $failure -and $failed -eq 0 -and $rows.Count -ge 10){'PASS'}else{'FAIL'};failure=$failure;syntheticProject='only';sourceFallback=$false}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),(ConvertTo-Json $result -Depth 10)+"`n",$Utf8)
    $result|ConvertTo-Json -Depth 10
}
if ($result.result -ne 'PASS') { exit 1 }
