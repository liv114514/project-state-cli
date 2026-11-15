param([string]$RunId='runner-evidence-r01')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$here=$PSScriptRoot;$workspace=(Resolve-Path (Join-Path $here '..\..')).Path
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source;$runner=Join-Path $here 'run-validation-suite.ps1'
$cases=[System.Collections.Generic.List[object]]::new()
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
foreach($mode in @('timeout','spawn-fail','nonzero')){
    $id=$RunId+'-'+$mode;$psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    $timeout=if($mode -eq 'timeout'){1800}else{10000}
    foreach($arg in @('-NoProfile','-File',$runner,'-RunId',$id,'-TimeoutMilliseconds',[string]$timeout,'-RunnerProbe',$mode)){[void]$psi.ArgumentList.Add($arg)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi
    if(-not $process.Start()){throw 'Could not start validation runner probe'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(20000)){try{$process.Kill($true)}catch{};throw 'Runner probe wrapper timed out'}
    $process.WaitForExit();$out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
    $evidence=Join-Path $workspace ('evidence\'+$id);$summary=Get-Content (Join-Path $evidence 'results.json') -Raw|ConvertFrom-Json
    Assert ($process.ExitCode -eq 1 -and $summary.result -eq 'FAIL' -and $summary.ambientEnvironmentRestored) "$mode probe did not produce a persisted failure result"
    $run=$summary.runs[0];Assert ($run.status -in @('TIMEOUT','ERROR','FAIL')) "$mode was classified as $($run.status)"
    Assert ((Test-Path -LiteralPath $run.stdoutPath) -and (Test-Path -LiteralPath $run.stderrPath) -and (Test-Path -LiteralPath (Join-Path $evidence ($run.caseId+'.invocation.json')))) "$mode logs or invocation record missing"
    if($mode -eq 'timeout'){
        Assert ($run.status -eq 'TIMEOUT' -and $run.timeout -and $run.pid -and $run.stdoutBytes -gt 0 -and $run.stderrBytes -gt 0) 'timeout probe lost process/output facts'
        $descendantPath=Join-Path $evidence 'descendant.pid';Assert (Test-Path -LiteralPath $descendantPath) 'timeout child did not publish descendant PID'
        $descendantPid=[int](Get-Content -LiteralPath $descendantPath -Raw);Start-Sleep -Milliseconds 150
        Assert (-not(Get-Process -Id $descendantPid -ErrorAction SilentlyContinue)) 'runner timeout left its synthetic process-tree descendant alive'
    }elseif($mode -eq 'spawn-fail'){Assert ($run.status -eq 'ERROR' -and $run.spawnError) 'spawn failure was not retained as ERROR'}
    else{Assert ($run.status -eq 'FAIL' -and $run.exitCode -eq 7 -and $run.stdoutBytes -gt 0 -and $run.stderrBytes -gt 0) 'nonzero child failure/output was not retained'}
    $cases.Add([ordered]@{mode=$mode;exitCode=$process.ExitCode;status=$run.status;summary=$summary.result;outputBytes=@($run.stdoutBytes,$run.stderrBytes);environmentRestored=$summary.ambientEnvironmentRestored;processTreeEnded=($mode -ne 'timeout' -or -not(Get-Process -Id $descendantPid -ErrorAction SilentlyContinue))})
}
$result=[ordered]@{schemaVersion=1;runId=$RunId;cases=@($cases.ToArray());pass=$cases.Count;fail=0;result='PASS';finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
$dest=Join-Path $workspace ('evidence\'+$RunId);[IO.Directory]::CreateDirectory($dest)|Out-Null
[IO.File]::WriteAllText((Join-Path $dest 'results.json'),($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false));$result|ConvertTo-Json -Depth 8
