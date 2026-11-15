[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(Mandatory=$true)][string]$WheelPath,
    [Parameter(Mandatory=$true)][string]$UvPath,
    [Parameter(Mandatory=$true)][string]$WorkRoot,
    [ValidateRange(0,4)][int]$CleanupIndex=1,
    [string]$RunId=('a49-cleanup-index-'+[guid]::NewGuid().ToString('N'))
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.Major -lt 7){throw 'ETEST_POWERSHELL: PowerShell 7 or newer is required'}
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path;$work=[IO.Path]::GetFullPath($WorkRoot);$evidence=Join-Path $root ('evidence\'+$RunId)
if(-not [IO.Path]::IsPathRooted($WorkRoot)){throw 'ETEST_PATH: WorkRoot must be absolute'}
if((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $evidence)){throw 'ETEST_PATH: run paths already exist'}
foreach($p in @($RuntimeRoot,$WheelPath,$UvPath)){if(-not(Test-Path -LiteralPath $p)){throw 'ETEST_INPUT: runtime, exact wheel, and pinned uv are required'}}
[IO.Directory]::CreateDirectory($work)|Out-Null;[IO.Directory]::CreateDirectory($evidence)|Out-Null
$utf8=[Text.UTF8Encoding]::new($false);$started=[DateTimeOffset]::Now;$commands=[System.Collections.Generic.List[object]]::new();$failure=$null;$summary=$null;$version=$null;$wheelHash=$null;$uvHash=$null;$uvVersion=$null
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source;$installer=Join-Path $PSScriptRoot 'install-managed.ps1';$core=Join-Path $PSScriptRoot 'install-core-prototype.ps1';$runtimeInspector=Join-Path $PSScriptRoot 'prepare-python-runtime.ps1';$txnModule=Join-Path $PSScriptRoot 'installer-transaction.psm1'
$runtime=[IO.Path]::GetFullPath($RuntimeRoot);$wheel=[IO.Path]::GetFullPath($WheelPath);$uv=[IO.Path]::GetFullPath($UvPath)
function Start-Child([string[]]$Arguments,[string]$Cwd,[string]$GatePhase='',[string]$GateRoot=''){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$script:pwsh;$psi.WorkingDirectory=$Cwd;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$psi.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $fullArgv=@('-NoProfile','-ExecutionPolicy','Bypass')+$Arguments
    if($GatePhase){$fullArgv+=@('-EnableTestHooks','-TestGateRoot',$GateRoot,'-TestGatePhase',$GatePhase)}
    foreach($a in $fullArgv){[void]$psi.ArgumentList.Add([string]$a)}
    $p=[Diagnostics.Process]::new();$p.StartInfo=$psi;if(-not$p.Start()){throw 'ETEST_SPAWN: child did not start'}
    return [pscustomobject]@{process=$p;stdout=$p.StandardOutput.ReadToEndAsync();stderr=$p.StandardError.ReadToEndAsync();arguments=$fullArgv}
}
function Wait-Child($Child,[int]$TimeoutSeconds=240){if(-not$Child.process.WaitForExit($TimeoutSeconds*1000)){try{$Child.process.Kill($true)}catch{};$Child.process.WaitForExit();throw 'ETEST_TIMEOUT: child timed out; preserve installer state'};$Child.process.WaitForExit();return [pscustomobject]@{exitCode=[int]$Child.process.ExitCode;stdout=$Child.stdout.GetAwaiter().GetResult();stderr=$Child.stderr.GetAwaiter().GetResult();pid=$Child.process.Id}}
function Record-Process([string]$Label,$Child,$Outcome){
    [IO.File]::WriteAllText((Join-Path $script:evidence ($Label+'.stdout.log')),$Outcome.stdout,$script:utf8);[IO.File]::WriteAllText((Join-Path $script:evidence ($Label+'.stderr.log')),$Outcome.stderr,$script:utf8)
    $script:commands.Add([ordered]@{label=$Label;file=$script:pwsh;argv=@($Child.arguments);cwd=$script:root;pid=$Outcome.pid;exitCode=$Outcome.exitCode;stdoutLog=$Label+'.stdout.log';stderrLog=$Label+'.stderr.log'})
}
function Invoke-Action([string]$Action,[string]$InstallRoot,[string]$Label,[string]$TransactionId=''){
    $args=@('-File',$script:core,'-Action',$Action,'-InstallRoot',$InstallRoot);if($TransactionId){$args+=@('-TransactionId',$TransactionId)}
    $child=Start-Child $args $script:root;$outcome=Wait-Child $child;Record-Process $Label $child $outcome;return $outcome
}
function Assert([bool]$Condition,[string]$Code){if(-not$Condition){throw ('ETEST_ASSERT: '+$Code)}}
function Get-TreeObservation([string]$Path){
    $base=[IO.Path]::GetFullPath($Path).TrimEnd('\');$items=Get-ChildItem -LiteralPath $base -Force -Recurse | ForEach-Object {
        $relative=$_.FullName.Substring($base.Length).TrimStart('\')
        if($_.PSIsContainer){[ordered]@{relative=$relative;kind='directory'}}else{[ordered]@{relative=$relative;kind='file';bytes=[long]$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
    }
    return @(($items|Sort-Object relative|ConvertTo-Json -Depth 5 -Compress)) -join "`n"
}
try{
    $script:pwsh=$pwsh;$script:root=$root;$script:evidence=$evidence;$script:utf8=$utf8;$script:core=$core;$script:commands=$commands
    Import-Module -Name $txnModule -Force
    $pkg=Join-Path $work 'package';[IO.Directory]::CreateDirectory($pkg)|Out-Null;$wheelCopy=Join-Path $pkg ([IO.Path]::GetFileName($wheel));[IO.File]::Copy($wheel,$wheelCopy,$false)
    $wheelHash=(Get-FileHash -LiteralPath $wheelCopy -Algorithm SHA256).Hash.ToLowerInvariant();$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant();$uvVersion=((& $uv --version 2>&1)|Out-String).Trim() -replace '^uv ([^ ]+).*$','$1'
    $versionMatch=[regex]::Match([IO.Path]::GetFileName($wheelCopy),'project_state_python_candidate-(\d+\.\d+\.\d+[a-zA-Z0-9.-]*)-py3-none-any\.whl');Assert $versionMatch.Success 'exact candidate wheel version is not identifiable';$version=$versionMatch.Groups[1].Value
    $manifest=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$version;wheel=[ordered]@{file=[IO.Path]::GetFileName($wheelCopy);sha256=$wheelHash;bytes=[long](Get-Item $wheelCopy).Length};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
    $manifestPath=Join-Path $pkg 'manifest.json';[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 6)+"`n",$utf8)
    $runtimeBefore=(& $pwsh -NoProfile -ExecutionPolicy Bypass -File $runtimeInspector -Action Inspect -RuntimeRoot $runtime | ConvertFrom-Json)
    $installRoot=Join-Path $work 'i';$installArgs=@('-File',$installer,'-Action','Install','-InstallRoot',$installRoot,'-RuntimeRoot',$runtime,'-ManifestPath',$manifestPath,'-UvPath',$uv,'-Version',$version)
    $installChild=Start-Child $installArgs $root;$installResult=Wait-Child $installChild;Record-Process 'fresh-exact-wheel-install' $installChild $installResult
    Assert ($installResult.exitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $installRoot 'bin\project-state.cmd') -PathType Leaf)) 'exact wheel managed install failed'
    $sentinel=Join-Path $work 'outside-install-sentinel.txt';[IO.File]::WriteAllText($sentinel,'synthetic external data stays unchanged',$utf8);$sentinelHash=(Get-FileHash $sentinel -Algorithm SHA256).Hash.ToLowerInvariant()
    $gate=Join-Path $evidence 'gate';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $uninstallArgs=@('-File',$core,'-Action','Uninstall','-InstallRoot',$installRoot)
    $phase='cleanup-intent-{0:D4}' -f $CleanupIndex
    $uninstall=Start-Child $uninstallArgs $root $phase $gate
    $deadline=[DateTime]::UtcNow.AddSeconds(180);$ready=$null
    do{$ready=@(Get-ChildItem -LiteralPath $gate -Filter ('*.'+$phase+'.ready') -File -ErrorAction SilentlyContinue|Select-Object -First 1);if($ready.Count){break};if($uninstall.process.HasExited){$early=Wait-Child $uninstall 2;Record-Process 'uninstall-before-cleanup-index' $uninstall $early;throw ('ETEST_GATE: child exited before '+$phase+' barrier: '+$early.stderr)};Start-Sleep -Milliseconds 20}while([DateTime]::UtcNow -lt $deadline)
    Assert ($ready.Count -eq 1 -and -not$uninstall.process.HasExited) ('deterministic '+$phase+' barrier was not reached by a live process')
    $transactionId=$ready[0].Name.Split('.')[0]
    $journal=Read-InstallerTransaction $installRoot $transactionId
    Assert ($journal.Latest.phase -ceq $phase) ('durable journal is not at '+$phase)
    $priorDone=$true
    for($i=0;$i -lt $CleanupIndex;$i++){$priorDone=$priorDone -and (@($journal.Records|Where-Object phase -ceq ('cleanup-done-{0:D4}' -f $i)).Count -eq 1)}
    $currentIntent=@($journal.Records|Where-Object phase -ceq $phase).Count -eq 1
    Assert ($priorDone -and $currentIntent -and $journal.Latest.plan.retireItems.Count -gt $CleanupIndex) 'journal does not prove the selected pending cleanup index and all earlier completions'
    $killedPid=$uninstall.process.Id;$uninstall.process.Kill($true);$uninstall.process.WaitForExit(15000)|Out-Null
    Assert $uninstall.process.HasExited 'uninstall owner process did not terminate after the barrier'
    $killed=[pscustomobject]@{exitCode=$uninstall.process.ExitCode;stdout=$uninstall.stdout.GetAwaiter().GetResult();stderr=$uninstall.stderr.GetAwaiter().GetResult();pid=$killedPid};Record-Process 'uninstall-terminated-at-selected-cleanup-index' $uninstall $killed
    $inspect=Invoke-Action 'Inspect' $installRoot 'third-process-inspect' $transactionId;$inspectJson=$inspect.stdout|ConvertFrom-Json
    Assert ($inspect.exitCode -eq 0 -and $inspectJson.transactionId -ceq $transactionId -and $inspectJson.phase -ceq $phase -and $inspectJson.permittedActions -ceq 'Resume') 'third process did not inspect selected cleanup-index state or advertised actions incorrectly'
    $quarantineRoot=[string]$journal.Latest.plan.quarantineRoot;$remainingBefore=@(Get-ChildItem -LiteralPath $quarantineRoot -File -Recurse|ForEach-Object{[ordered]@{relative=$_.FullName.Substring($quarantineRoot.Length).TrimStart('\');bytes=$_.Length;sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
    Assert ($remainingBefore.Count -ge 1) 'cleanup interruption did not preserve at least one remaining quarantined object'
    $resume=Invoke-Action 'Resume' $installRoot 'third-process-resume' $transactionId
    Assert ($resume.exitCode -eq 0 -and $resume.stdout -match '"phase":"completed"') 'third process did not complete committed uninstall cleanup'
    $finalRead=Read-InstallerTransaction $installRoot $transactionId;$cleanupDone=@($finalRead.Records|Where-Object {$_.phase -match '^cleanup-done-[0-9]{4}$'}).Count
    Assert ($cleanupDone -eq $journal.Latest.plan.retireItems.Count -and $finalRead.Latest.phase -ceq 'completed') 'cleanup completion journal does not cover the exact retirement set'
    foreach($item in $journal.Latest.plan.retireItems){Assert (-not(Test-Path -LiteralPath ([string]$item.quarantine)) -and -not(Test-Path -LiteralPath ([string]$item.source))) 'retired object remains or reappeared after committed cleanup'}
    Assert ((Test-Path -LiteralPath $installRoot -PathType Container) -and -not(Test-Path -LiteralPath (Join-Path $installRoot 'bin\project-state.cmd')) -and -not(Test-Path -LiteralPath (Join-Path $installRoot 'state\install-receipt.json'))) 'uninstall did not preserve only its owned root boundary'
    Assert ((Get-FileHash $sentinel -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $sentinelHash) 'external synthetic sentinel changed'
    $runtimeAfter=(& $pwsh -NoProfile -ExecutionPolicy Bypass -File $runtimeInspector -Action Inspect -RuntimeRoot $runtime | ConvertFrom-Json)
    Assert ($runtimeBefore.treeSha256 -ceq $runtimeAfter.treeSha256 -and $runtimeBefore.rootIdentity -ceq $runtimeAfter.rootIdentity) 'separately managed runtime changed during product uninstall'
    $rootBeforeRepeat=Get-TreeObservation $installRoot;$journalDigestBeforeRepeat=$finalRead.Digest
    $repeat=Invoke-Action 'Uninstall' $installRoot 'repeat-uninstall-after-completion'
    $rootAfterRepeat=Get-TreeObservation $installRoot;$journalAfterRepeat=Read-InstallerTransaction $installRoot $transactionId
    Assert ($repeat.exitCode -eq 2 -and $repeat.stderr -match 'EINSTALL_RECEIPT') 'repeat uninstall did not safely refuse after owned receipt retirement'
    Assert ($rootBeforeRepeat -ceq $rootAfterRepeat -and $journalDigestBeforeRepeat -ceq $journalAfterRepeat.Digest) 'repeat uninstall changed completed install evidence or journal'
    Assert ((Get-FileHash $sentinel -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $sentinelHash) 'repeat uninstall changed the external synthetic sentinel'
    $runtimeFinal=(& $pwsh -NoProfile -ExecutionPolicy Bypass -File $runtimeInspector -Action Inspect -RuntimeRoot $runtime | ConvertFrom-Json)
    Assert ($runtimeAfter.treeSha256 -ceq $runtimeFinal.treeSha256 -and $runtimeAfter.rootIdentity -ceq $runtimeFinal.rootIdentity) 'repeat uninstall altered the separately managed runtime'
    $summary=[ordered]@{schemaVersion=1;runId=$RunId;candidateVersion=$version;wheelSha256=$wheelHash;uvVersion=$uvVersion;uvSha256=$uvHash;startedAt=$started.ToString('o');finishedAt=[DateTimeOffset]::Now.ToString('o');cwd=$root;terminatedPid=$killedPid;cleanupIndex=$CleanupIndex;interruptionPhase=$phase;cleanupItemCount=$journal.Latest.plan.retireItems.Count;cleanupDoneRecords=$cleanupDone;remainingQuarantineObjectsBeforeResume=$remainingBefore.Count;commands=@($commands.ToArray());cases=@([ordered]@{case='third-process-inspects-selected-cleanup-index';status='PASS'},[ordered]@{case='third-process-resumes-exact-committed-cleanup-set';status='PASS'},[ordered]@{case='external-sentinel-and-owned-runtime-unchanged';status='PASS'},[ordered]@{case='repeat-uninstall-refuses-without-mutating-completed-evidence';status='PASS'});pass=4;fail=0;skip=0;result='PASS'}
}catch{$failure=$_.Exception.Message;[IO.File]::WriteAllText((Join-Path $evidence 'failure.txt'),$failure+"`n",$utf8)}
finally{
    if(-not$summary){$summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=$started.ToString('o');finishedAt=[DateTimeOffset]::Now.ToString('o');cwd=$root;commands=@($commands.ToArray());pass=0;fail=1;skip=0;result='FAIL';failure=$failure}}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 14)+"`n",$utf8);$summary|ConvertTo-Json -Depth 14
}
if($summary.result -ne 'PASS'){exit 1}
