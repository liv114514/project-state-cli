[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PythonPath,
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(Mandatory=$true)][string]$WheelPath,
    [Parameter(Mandatory=$true)][string]$UvPath,
    [Parameter(Mandatory=$true)][string]$WorkRoot
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$core=Join-Path $PSScriptRoot 'install-core-prototype.ps1'
$managed=Join-Path $PSScriptRoot 'install-managed.ps1'
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
foreach($p in @($core,$managed,$PythonPath,$RuntimeRoot,$WheelPath,$UvPath)){
    if(-not(Test-Path -LiteralPath $p)){throw 'A required pinned installer test input is unavailable'}
}
if(Test-Path -LiteralPath $WorkRoot){throw 'Refusing to reuse committed-cleanup test root'}
[IO.Directory]::CreateDirectory($WorkRoot)|Out-Null
$root=Join-Path $WorkRoot 'install-root'
$gate=Join-Path $WorkRoot 'gate'
[IO.Directory]::CreateDirectory($gate)|Out-Null
function Get-Sha([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Write-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
function Invoke-Managed([string]$Name,[string[]]$Arguments){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$PSScriptRoot;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($x in @('-NoProfile','-ExecutionPolicy','Bypass','-File',$managed)+$Arguments){[void]$psi.ArgumentList.Add([string]$x)}
    foreach($n in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','PYTHONNOUSERSITE','UV_CONFIG_FILE','UV_CACHE_DIR','UV_PYTHON_CACHE_DIR','UV_OFFLINE')){[void]$psi.Environment.Remove($n)}
    $p=[Diagnostics.Process]::new();$p.StartInfo=$psi;if(-not $p.Start()){throw "Managed process did not start: $Name"};$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()
    if(-not $p.WaitForExit(900000)){try{$p.Kill($true)}catch{};$p.WaitForExit();throw "Managed process timed out: $Name"};$p.WaitForExit()
    $row=[ordered]@{name=$Name;argv=@($psi.FileName)+@($psi.ArgumentList|ForEach-Object{[string]$_});cwd=$psi.WorkingDirectory;pid=$p.Id;exitCode=$p.ExitCode;stdout=$o.GetAwaiter().GetResult();stderr=$e.GetAwaiter().GetResult()};$p.Dispose();return [pscustomobject]$row
}
function Get-QuarantineState([string]$Base){
    $dir=Join-Path $Base 'state\retired'
    if(-not(Test-Path -LiteralPath $dir -PathType Container)){return @()}
    return @(Get-ChildItem -LiteralPath $dir -File -Recurse|Sort-Object FullName|ForEach-Object{[ordered]@{relative=$_.FullName.Substring($Base.Length);bytes=[long]$_.Length;sha256=(Get-Sha $_.FullName)}})
}
$runs=[System.Collections.Generic.List[object]]::new()
try{
    $localWheel=Join-Path $WorkRoot (Split-Path -Leaf $WheelPath);Copy-Item -LiteralPath $WheelPath -Destination $localWheel
    $wheelBytes=[long](Get-Item -LiteralPath $localWheel).Length;$wheelSha=Get-Sha $localWheel;$uvSha=Get-Sha $UvPath
    $manifest=Join-Path $WorkRoot 'manifest.json'
    Write-Json $manifest ([ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version='0.1.0a49';wheel=[ordered]@{file=(Split-Path -Leaf $localWheel);sha256=$wheelSha;bytes=$wheelBytes};uv=[ordered]@{version='0.13.7';sha256=$uvSha}})
    $installed=Invoke-Managed 'install-a49' @('-Action','Install','-InstallRoot',$root,'-RuntimeRoot',$RuntimeRoot,'-ManifestPath',$manifest,'-UvPath',$UvPath,'-Version','0.1.0a49');$runs.Add($installed)
    if($installed.exitCode -ne 0){throw 'Synthetic baseline installation failed; inspect the recorded install-a49 stdout/stderr'}
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$PSScriptRoot;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($x in @('-NoProfile','-ExecutionPolicy','Bypass','-File',$core,'-Action','Uninstall','-InstallRoot',$root,'-EnableTestHooks','-TestGateRoot',$gate,'-TestGatePhase','cleanup-intent-0000')){[void]$psi.ArgumentList.Add([string]$x)}
    $child=[Diagnostics.Process]::new();$child.StartInfo=$psi;if(-not $child.Start()){throw 'Gated uninstall process did not start'};$co=$child.StandardOutput.ReadToEndAsync();$ce=$child.StandardError.ReadToEndAsync()
    $deadline=[DateTime]::UtcNow.AddSeconds(120);$ready=$null
    do{$ready=@(Get-ChildItem -LiteralPath $gate -Filter '*.cleanup-intent-0000.ready' -File -ErrorAction SilentlyContinue|Select-Object -First 1);if($ready.Count){break};if($child.HasExited){break};Start-Sleep -Milliseconds 25}while([DateTime]::UtcNow -lt $deadline)
    if(-not $ready.Count -or $child.HasExited){$child.WaitForExit();throw 'Uninstall did not reach deterministic cleanup-intent gate'}
    $txId=$ready[0].Name.Split('.')[0];$killedPid=$child.Id;$child.Kill($true);$child.WaitForExit();$killExit=$child.ExitCode;$runs.Add([pscustomobject]@{name='terminate-at-cleanup-intent-0000';pid=$killedPid;exitCode=$killExit;gateFile=$ready[0].Name;termination='Process.Kill(entireProcessTree=true) after ready gate';argv=@($psi.FileName)+@($psi.ArgumentList|ForEach-Object{[string]$_});cwd=$psi.WorkingDirectory;stdout=$co.GetAwaiter().GetResult();stderr=$ce.GetAwaiter().GetResult()});$child.Dispose()
    if($killExit -eq 0){throw 'Gated uninstall exited normally instead of being terminated'}
    $inspect=Invoke-Managed 'inspect-cleanup-intent' @('-Action','Inspect','-InstallRoot',$root,'-RuntimeRoot',$RuntimeRoot,'-TransactionId',$txId);$runs.Add($inspect);$state=$inspect.stdout|ConvertFrom-Json
    $actions=@($state.permittedActions)
    if($inspect.exitCode -ne 0 -or $state.phase -cne 'cleanup-intent-0000' -or $actions -notcontains 'Resume' -or $actions -contains 'Rollback'){throw 'Inspect must expose Resume and omit Rollback after the uninstall commit'}
    $digestBefore=[string]$state.lastRecordDigest;$quarantineBefore=Get-QuarantineState $root
    $rollback=Invoke-Managed 'rollback-after-commit' @('-Action','Rollback','-InstallRoot',$root,'-RuntimeRoot',$RuntimeRoot,'-TransactionId',$txId);$runs.Add($rollback)
    if($rollback.exitCode -ne 2 -or $rollback.stderr -notmatch 'EINSTALL_ROLLBACK_REFUSED'){throw 'Committed uninstall rollback was not safely refused'}
    $inspectAfter=Invoke-Managed 'inspect-after-refusal' @('-Action','Inspect','-InstallRoot',$root,'-RuntimeRoot',$RuntimeRoot,'-TransactionId',$txId);$runs.Add($inspectAfter);$stateAfter=$inspectAfter.stdout|ConvertFrom-Json;$quarantineAfter=Get-QuarantineState $root
    if($stateAfter.lastRecordDigest -cne $digestBefore -or (ConvertTo-Json -InputObject $quarantineBefore -Compress) -cne (ConvertTo-Json -InputObject $quarantineAfter -Compress)){throw 'Refused rollback changed the durable journal or quarantined data'}
    $resume=Invoke-Managed 'resume-committed-cleanup' @('-Action','Resume','-InstallRoot',$root,'-RuntimeRoot',$RuntimeRoot,'-TransactionId',$txId);$runs.Add($resume);$final=$resume.stdout|ConvertFrom-Json
    if($resume.exitCode -ne 0 -or $final.phase -cne 'completed' -or -not(Test-Path -LiteralPath $root -PathType Container) -or (Test-Path -LiteralPath (Join-Path $root 'state\install-receipt.json'))){throw 'Third process did not complete the committed cleanup while preserving the root boundary'}
    $result=[ordered]@{schemaVersion=1;installerVersion='0.3.5';candidateVersion='0.1.0a49';wheelSha256=$wheelSha;uvSha256=$uvSha;transactionId=$txId;inspectPhase=$state.phase;permittedActions=$actions;rollbackExit=$rollback.exitCode;journalStableAfterRefusal=$true;quarantineStableAfterRefusal=$true;resumeExit=$resume.exitCode;finalPhase=$final.phase;runs=@($runs.ToArray());result='PASS'}
    Write-Json (Join-Path $WorkRoot 'results.json') $result
    $result|ConvertTo-Json -Depth 12
}catch{
    $failure=[ordered]@{schemaVersion=1;installerVersion='0.3.5';candidateVersion='0.1.0a49';runs=@($runs.ToArray());result='FAIL';error=$_.Exception.Message}
    Write-Json (Join-Path $WorkRoot 'results.json') $failure
    throw
}
