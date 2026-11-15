[CmdletBinding()]
param(
    [string]$RunId = ('installer-suite-' + [guid]::NewGuid().ToString('N')),
    [ValidateRange(100,10800000)][int]$TimeoutMilliseconds = 1800000,
    [switch]$FailFast,
    [ValidateSet('none','timeout','spawn-fail','nonzero')][string]$RunnerProbe = 'none'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$installerDir=$PSScriptRoot
$workspace=(Resolve-Path (Join-Path $installerDir '..\..')).Path
$evidence=Join-Path $workspace ('evidence\'+$RunId)
$envRoot=Join-Path $workspace ('sandbox\runner-env-'+$RunId)
if((Test-Path -LiteralPath $evidence) -or (Test-Path -LiteralPath $envRoot)){throw 'Refusing to reuse installer validation paths'}
[IO.Directory]::CreateDirectory($evidence)|Out-Null
foreach($child in @('localappdata','temp','uv-cache')){[IO.Directory]::CreateDirectory((Join-Path $envRoot $child))|Out-Null}
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$paths=@{LOCALAPPDATA=(Join-Path $envRoot 'localappdata');TEMP=(Join-Path $envRoot 'temp');TMP=(Join-Path $envRoot 'temp');UV_CACHE_DIR=(Join-Path $envRoot 'uv-cache')}
$wheel=Get-ChildItem -LiteralPath (Join-Path $workspace 'artifacts\product') -Filter 'project_state_python_candidate-0.1.0a36-py3-none-any.whl' -File|Select-Object -First 1
$uv=Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'
if(-not $wheel -or -not(Test-Path -LiteralPath $uv -PathType Leaf)){throw 'Pinned installer test artifacts are unavailable'}
$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant();$uvVersion=((& $uv --version 2>&1)|Out-String).Trim() -replace '^uv ([^ ]+).*$','$1'
$manifestPath=Join-Path (Join-Path $workspace 'artifacts\product') ('manifest-runner-'+$RunId+'.json')
if(Test-Path -LiteralPath $manifestPath){throw 'Refusing to overwrite runner manifest'}
$manifest=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version='0.1.0a36';wheel=[ordered]@{file=$wheel.Name;sha256=(Get-FileHash -LiteralPath $wheel.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=[long]$wheel.Length};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$envNames=@('LOCALAPPDATA','TEMP','TMP','UV_CACHE_DIR','UV_NO_CONFIG','PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','PYTHONNOUSERSITE')
$beforeTable=[Environment]::GetEnvironmentVariables('Process');$before=[ordered]@{}
foreach($name in $envNames){$present=$beforeTable.Contains($name);$before[$name]=[ordered]@{present=$present;value=$(if($present){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null})}}
$testCases=@(
 @{id='environment';script='test-installer-environment.ps1';argument='-EvidenceSuffix';suffix='env';extraArgs=@('-ManifestPath',$manifestPath)},
 @{id='transaction-primitives';script='test-installer-transaction.ps1';argument='-RunId';suffix='txn'},
 @{id='cross-process-lock';script='test-installer-concurrency.ps1';argument='-RunId';suffix='lock'},
 @{id='boundary-recovery';script='test-installer-boundary-recovery.ps1';argument='-RunId';suffix='boundary'},
 @{id='io-recovery';script='test-installer-io-recovery.ps1';argument='-RunId';suffix='io'},
 @{id='lifecycle';script='test-installer-lifecycle.ps1';argument='-RunId';suffix='lifecycle'},
 @{id='uninstall-refusal-boundaries';script='test-installer-refusal-boundaries.ps1';argument='-RunId';suffix='refusal-boundaries'},
 @{id='exact-wheel-managed-entry';script='test-installer-managed-entry.ps1';argument='-RunId';suffix='managed-entry'},
 @{id='unknown-store-initialization';script='test-installer-store-initialization.ps1';argument='-RunId';suffix='store-initialization'},
 @{id='runner-failure-evidence';script='test-installer-runner-evidence.ps1';argument='-RunId';suffix='runner-evidence'}
)
if($RunnerProbe -ne 'none'){
    $testCases=@(@{id=('runner-probe-'+$RunnerProbe);script='test-installer-runner-probe-child.ps1';argument='-ProbeMode';suffix=('probe-'+$RunnerProbe);extraArgs=@($RunnerProbe)})
}
$runs=[System.Collections.Generic.List[object]]::new();$started=[DateTimeOffset]::UtcNow.ToString('o');$overall=0;$cancelled=$false;$topError=$null;$restoreOkay=$false;$restoration=[ordered]@{};$summaryPath=Join-Path $evidence 'results.json'
function Save-JsonAtomic([string]$Path,$Value){$tmp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 14)+"`n");$stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()};[IO.File]::Move($tmp,$Path,$true)}
function Write-Invocation([string]$Path,$Record){Save-JsonAtomic $Path $Record}
function New-CaseProcess($Test,[string]$ArgValue){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    $scriptPath=Join-Path $installerDir $Test.script
    if($RunnerProbe -ne 'none'){
        if($RunnerProbe -eq 'spawn-fail'){$psi.FileName=Join-Path $envRoot 'missing-runner-child.exe'}
        foreach($arg in @('-NoProfile','-File',$scriptPath,'-ProbeMode',$RunnerProbe,'-RunId',$RunId)){[void]$psi.ArgumentList.Add([string]$arg)}
        $psi.Environment['RUNNER_PROBE_PID_FILE']=Join-Path $evidence 'descendant.pid'
    }else{
        foreach($arg in @('-NoProfile','-File',$scriptPath,$Test.argument,$ArgValue)){[void]$psi.ArgumentList.Add([string]$arg)}
        if($Test.ContainsKey('extraArgs')){foreach($arg in $Test.extraArgs){[void]$psi.ArgumentList.Add([string]$arg)}}
    }
    foreach($name in @('LOCALAPPDATA','TEMP','TMP','UV_CACHE_DIR')){$psi.Environment[$name]=[string]$paths[$name]}
    $psi.Environment['UV_NO_CONFIG']='1';$psi.Environment['PYTHONNOUSERSITE']='1'
    foreach($name in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE')){[void]$psi.Environment.Remove($name)}
    return $psi
}
try{
    foreach($name in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE')){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
    [Environment]::SetEnvironmentVariable('PYTHONNOUSERSITE','1','Process');[Environment]::SetEnvironmentVariable('UV_NO_CONFIG','1','Process')
    foreach($name in $paths.Keys){[Environment]::SetEnvironmentVariable($name,[string]$paths[$name],'Process')}
    foreach($test in $testCases){
        $argValue=$RunId+'-'+$test.suffix;$stdoutPath=Join-Path $evidence ($test.id+'.stdout.log');$stderrPath=Join-Path $evidence ($test.id+'.stderr.log');$invocationPath=Join-Path $evidence ($test.id+'.invocation.json');$resultPath=switch($test.id){'environment'{Join-Path $workspace ('evidence\installer-environment-'+$argValue+'\run.json')} default{Join-Path $workspace ('evidence\'+$argValue+'\results.json')}}
        $case=[ordered]@{schemaVersion=1;runId=$RunId;caseId=$test.id;status='STARTING';command=@($pwsh,'-NoProfile','-File',(Join-Path $installerDir $test.script),$test.argument,$argValue);cwd=$workspace;environment=$paths;timeoutMilliseconds=$TimeoutMilliseconds;startedAt=[DateTimeOffset]::UtcNow.ToString('o');pid=$null;exitCode=$null;signal=$null;timeout=$false;spawnError=$null;stdoutPath=$stdoutPath;stderrPath=$stderrPath;stdoutBytes=0L;stderrBytes=0L;stdoutComplete=$false;stderrComplete=$false;outputError=$null;reportedResult='NOT_READ';resultPath=$resultPath}
        # Create both output files and the invocation before the process can run.
        $outStream=[IO.File]::Open($stdoutPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$outStream.Dispose();$errStream=[IO.File]::Open($stderrPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$errStream.Dispose();Write-Invocation $invocationPath $case
        $proc=$null;$outFile=$null;$errFile=$null;$outTask=$null;$errTask=$null
        try{
            $psi=New-CaseProcess $test $argValue;$case.command=@($psi.FileName)+@($psi.ArgumentList|ForEach-Object{[string]$_});Write-Invocation $invocationPath $case
            $proc=[Diagnostics.Process]::new();$proc.StartInfo=$psi
            try{if(-not $proc.Start()){throw 'Process.Start returned false'}}catch{$case.status='ERROR';$case.spawnError=$_.Exception.GetType().FullName;$case.exitCode=$null;$overall=1;[IO.File]::WriteAllText($stdoutPath,'',[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText($stderrPath,('SPAWN_ERROR: '+$_.Exception.Message),[Text.UTF8Encoding]::new($false));$case.stderrBytes=(Get-Item $stderrPath).Length;$case.stderrComplete=$true;throw [System.InvalidOperationException]::new('RUN_CASE_RECORDED')}
            $case.pid=$proc.Id;$case.startedAt=[DateTimeOffset]::UtcNow.ToString('o');Write-Invocation $invocationPath $case
            $outFile=[IO.File]::Open($stdoutPath,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read);$errFile=[IO.File]::Open($stderrPath,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
            $outTask=$proc.StandardOutput.BaseStream.CopyToAsync($outFile);$errTask=$proc.StandardError.BaseStream.CopyToAsync($errFile)
            if(-not $proc.WaitForExit($TimeoutMilliseconds)){$case.timeout=$true;$case.status='TIMEOUT';try{$proc.Kill($true)}catch{$case.outputError='PROCESS_TREE_KILL_FAILED'};try{$proc.WaitForExit()}catch{} }
            else{$proc.WaitForExit()}
            if($proc.HasExited){$case.exitCode=[int]$proc.ExitCode}
            try{if($outTask.Wait(5000)){[void]$outTask.GetAwaiter().GetResult();$case.stdoutComplete=$true}else{$case.outputError='STDOUT_DRAIN_TIMEOUT'}}catch{$case.outputError='STDOUT_READ_FAILED'}
            try{if($errTask.Wait(5000)){[void]$errTask.GetAwaiter().GetResult();$case.stderrComplete=$true}else{$case.outputError='STDERR_DRAIN_TIMEOUT'}}catch{$case.outputError='STDERR_READ_FAILED'}
            $outFile.Flush($true);$errFile.Flush($true);$case.stdoutBytes=[long](Get-Item $stdoutPath).Length;$case.stderrBytes=[long](Get-Item $stderrPath).Length
            if($case.status -ne 'TIMEOUT'){
                $testResult=$null;if(Test-Path -LiteralPath $resultPath -PathType Leaf){try{$testResult=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json -ErrorAction Stop}catch{}}
                $case.reportedResult=if($null -ne $testResult -and $testResult.PSObject.Properties.Name -contains 'result'){[string]$testResult.result}else{'MISSING'}
                $case.status=if($case.exitCode -eq 0 -and $case.reportedResult -eq 'PASS' -and $case.stdoutComplete -and $case.stderrComplete){'PASS'}else{'FAIL'}
            }
            if($case.status -ne 'PASS'){$overall=1}
        }catch [System.InvalidOperationException]{if($_.Exception.Message -ne 'RUN_CASE_RECORDED'){throw}}
        catch [System.Management.Automation.PipelineStoppedException]{$case.status='CANCELLED';$case.outputError='OPERATOR_CANCELLED';$cancelled=$true;$overall=1;try{if($case.pid -and -not $proc.HasExited){$proc.Kill($true);$proc.WaitForExit()}}catch{}}
        catch{$case.status='ERROR';if($null -eq $case.pid){$case.spawnError=$_.Exception.GetType().FullName}else{$case.outputError=$_.Exception.Message};$overall=1;try{if($case.pid -and -not $proc.HasExited){$proc.Kill($true);$proc.WaitForExit()}}catch{}}
        finally{
            if($outFile){try{$outFile.Dispose()}catch{$overall=1}};if($errFile){try{$errFile.Dispose()}catch{$overall=1}};if($proc){if($case.pid -and $proc.HasExited -and $null -eq $case.exitCode){try{$case.exitCode=[int]$proc.ExitCode}catch{}};$proc.Dispose()}
            $case.endedAt=[DateTimeOffset]::UtcNow.ToString('o');$case.stdoutBytes=if(Test-Path $stdoutPath){[long](Get-Item $stdoutPath).Length}else{0L};$case.stderrBytes=if(Test-Path $stderrPath){[long](Get-Item $stderrPath).Length}else{0L}
            try{Write-Invocation $invocationPath $case}catch{$overall=1;[Console]::Error.WriteLine('EVIDENCE_WRITE_FAILED: case invocation could not be updated')}
            $runs.Add($case)
        }
        if($FailFast -and $case.status -ne 'PASS'){
            foreach($remaining in @($testCases|Select-Object -Skip $runs.Count)){$runs.Add([ordered]@{caseId=$remaining.id;runId=($RunId+'-'+$remaining.suffix);status='NOT_RUN';reason='FAIL_FAST';exitCode=$null})};break
        }
    }
}catch [System.Management.Automation.PipelineStoppedException]{$cancelled=$true;$overall=1;$topError='OPERATOR_CANCELLED'}catch{$overall=1;$topError=$_.Exception.Message;[Console]::Error.WriteLine(('RUNNER_ERROR: '+$topError))}finally{
    foreach($name in $envNames){try{if($before[$name].present){[Environment]::SetEnvironmentVariable($name,[string]$before[$name].value,'Process')}else{Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}}catch{$overall=1}}
    $after=[Environment]::GetEnvironmentVariables('Process');$restoreOkay=$true
    foreach($name in $envNames){$present=$after.Contains($name);$value=if($present){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null};$same=$present -eq [bool]$before[$name].present -and (!$present -or $value -ceq [string]$before[$name].value);if(-not $same){$restoreOkay=$false};$restoration[$name]=[ordered]@{beforePresent=[bool]$before[$name].present;afterPresent=$present;restored=$same}}
    if(-not $restoreOkay){$overall=1}
    $summary=[ordered]@{schemaVersion=2;runId=$RunId;startedAt=$started;endedAt=[DateTimeOffset]::UtcNow.ToString('o');cwd=$workspace;powershell=$PSVersionTable.PSVersion.ToString();runnerPid=$PID;timeoutMilliseconds=$TimeoutMilliseconds;environmentRoots=$paths;ambientEnvironmentRestored=$restoreOkay;environmentRestoration=$restoration;cancelled=$cancelled;runnerError=$topError;runs=@($runs.ToArray());pass=@($runs|Where-Object status -eq 'PASS').Count;fail=@($runs|Where-Object status -in @('FAIL','ERROR','TIMEOUT')).Count;skip=@($runs|Where-Object status -eq 'SKIP').Count;notRun=@($runs|Where-Object status -eq 'NOT_RUN').Count;cancelledCount=@($runs|Where-Object status -eq 'CANCELLED').Count;todo=0;result=if($overall -eq 0 -and -not $cancelled -and $restoreOkay -and @($runs|Where-Object status -eq 'NOT_RUN').Count -eq 0){'PASS'}else{'FAIL'}}
    try{Save-JsonAtomic $summaryPath $summary}catch{$overall=1;[Console]::Error.WriteLine('EVIDENCE_WRITE_FAILED: suite summary could not be persisted')}
}
$summary|ConvertTo-Json -Depth 14
if($summary.result -ne 'PASS'){exit 1}
