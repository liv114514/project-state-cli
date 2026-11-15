param([string]$RunId = ('installer-io-' + [guid]::NewGuid().ToString('N')))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$here = $PSScriptRoot
$workspace = (Resolve-Path (Join-Path $here '..\..')).Path
$sandbox = Join-Path $workspace ('sandbox\' + $RunId)
$evidence = Join-Path $workspace ('evidence\' + $RunId)
if ((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)) { throw 'Refusing to reuse installer I/O test paths' }
[IO.Directory]::CreateDirectory($sandbox) | Out-Null
[IO.Directory]::CreateDirectory($evidence) | Out-Null

$installer = Join-Path $here 'install-core-prototype.ps1'
$module = Join-Path $here 'installer-transaction.psm1'
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source
$wheel = Get-ChildItem -LiteralPath (Join-Path $workspace 'artifacts\product') -Filter '*0.1.0a36*.whl' | Select-Object -First 1
$uv = Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'
if (-not $wheel -or -not (Test-Path -LiteralPath $uv -PathType Leaf)) { throw 'Pinned a36 wheel or uv executable is missing' }
$wheelHash = (Get-FileHash -LiteralPath $wheel.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$uvHash = (Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant()
$uvVersion = (& $uv --version 2>&1 | Out-String).Trim()
$wheelLocal = Join-Path $sandbox $wheel.Name
Copy-Item -LiteralPath $wheel.FullName -Destination $wheelLocal
if ((Get-FileHash -LiteralPath $wheelLocal -Algorithm SHA256).Hash.ToLowerInvariant() -cne $wheelHash) { throw 'Sandbox wheel copy differs from the pinned product artifact' }
$manifest = Join-Path $sandbox 'manifest-a36.json'
$manifestValue = [ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version='0.1.0a36';wheel=[ordered]@{file=$wheel.Name;sha256=$wheelHash;bytes=[long]$wheel.Length};uv=[ordered]@{version=($uvVersion -replace '^uv ([^ ]+).*$','$1');sha256=$uvHash}}
[IO.File]::WriteAllText($manifest,($manifestValue | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))

$envNames = @('LOCALAPPDATA','TEMP','TMP','UV_CACHE_DIR','UV_NO_CONFIG')
$envBefore = [ordered]@{}
$envTable = [Environment]::GetEnvironmentVariables('Process')
foreach ($name in $envNames) { $exists=$envTable.Contains($name);$envBefore[$name]=[ordered]@{present=$exists;value=$(if($exists){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null})} }
$envRoot = Join-Path $sandbox 'process-environment'
foreach ($dir in @('localappdata','temp','uv-cache')) { [IO.Directory]::CreateDirectory((Join-Path $envRoot $dir)) | Out-Null }
[Environment]::SetEnvironmentVariable('LOCALAPPDATA',(Join-Path $envRoot 'localappdata'),'Process')
[Environment]::SetEnvironmentVariable('TEMP',(Join-Path $envRoot 'temp'),'Process')
[Environment]::SetEnvironmentVariable('TMP',(Join-Path $envRoot 'temp'),'Process')
[Environment]::SetEnvironmentVariable('UV_CACHE_DIR',(Join-Path $envRoot 'uv-cache'),'Process')
[Environment]::SetEnvironmentVariable('UV_NO_CONFIG','1','Process')
$envIsolated = [ordered]@{}
foreach ($name in $envNames) { $envIsolated[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }

function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Start-Installer([string[]]$Arguments,[string]$GatePhase,[string]$GateRoot) {
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',$installer)+$Arguments){[void]$psi.ArgumentList.Add([string]$arg)}
    if($GatePhase){foreach($arg in @('-EnableTestHooks','-TestGateRoot',$GateRoot,'-TestGatePhase',$GatePhase)){[void]$psi.ArgumentList.Add([string]$arg)}}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;if(-not $process.Start()){throw 'Could not start installer subprocess'}
    return [pscustomobject]@{Process=$process;Stdout=$process.StandardOutput.ReadToEndAsync();Stderr=$process.StandardError.ReadToEndAsync()}
}
function Wait-Installer($Child,[int]$TimeoutSeconds=180) {
    if(-not $Child.Process.WaitForExit($TimeoutSeconds*1000)){try{$Child.Process.Kill($true)}catch{};throw 'Installer child exceeded the bounded test timeout'}
    $Child.Process.WaitForExit()
    return [pscustomobject]@{exitCode=$Child.Process.ExitCode;stdout=$Child.Stdout.GetAwaiter().GetResult();stderr=$Child.Stderr.GetAwaiter().GetResult();pid=$Child.Process.Id}
}
function Invoke-Action([string]$Action,[string]$Root,[string]$LogName,[string]$TransactionId='',[string]$Version='',[string]$ManifestPath='') {
    $args=@('-Action',$Action,'-InstallRoot',$Root)
    if($TransactionId){$args+=@('-TransactionId',$TransactionId)}
    if($Version){$args+=@('-Version',$Version)}
    if($Action -in @('Install','Upgrade')){$chosen=if($ManifestPath){$ManifestPath}else{$manifest};$args+=@('-ManifestPath',$chosen,'-UvPath',$uv,'-PythonPath',$python)}
    $r=Wait-Installer (Start-Installer $args '' '')
    [IO.File]::WriteAllText((Join-Path $evidence $LogName),($r.stdout+$r.stderr),[Text.UTF8Encoding]::new($false))
    return $r
}
function Get-StoreDigest([string]$Root) {
    Import-Module -Name $module -Force
    $paths=Get-InstallerTxnStore $Root
    $rows=[System.Collections.Generic.List[string]]::new()
    foreach($f in Get-ChildItem -LiteralPath $paths.Store -File -Force -Recurse | Sort-Object FullName){$rows.Add(($f.FullName.Substring($paths.Store.Length).TrimStart('\')+'|'+(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()))}
    return [string]::Join("`n",$rows)
}
function Wait-Gate([string]$GateRoot,[string]$Phase,$Child) {
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    do{$found=@(Get-ChildItem -LiteralPath $GateRoot -Filter ('*.'+$Phase+'.ready') -ErrorAction SilentlyContinue | Select-Object -First 1);if($found.Count){break};if($Child.Process.HasExited){$r=Wait-Installer $Child 5;throw ('Installer exited before deterministic gate: '+$r.stderr)};Start-Sleep -Milliseconds 25}while([DateTime]::UtcNow -lt $deadline)
    if(-not $found.Count -or $Child.Process.HasExited){throw 'Failed to observe a live installer at the deterministic gate'}
    return $found[0]
}

$results=[System.Collections.Generic.List[object]]::new()
$started=(Get-Date).ToUniversalTime().ToString('o')
$outRoot=Join-Path $sandbox 'synthetic-project-outside-install'
$outsideState=Join-Path $sandbox 'synthetic-user-state'
$root=Join-Path $sandbox 'managed install (中文)'
[IO.Directory]::CreateDirectory($outRoot)|Out-Null;[IO.Directory]::CreateDirectory($outsideState)|Out-Null
$sentinel=[Text.UTF8Encoding]::new($false).GetBytes('synthetic external project and user state must remain untouched')
[IO.File]::WriteAllBytes((Join-Path $outRoot 'sentinel.txt'),$sentinel)
[IO.File]::WriteAllBytes((Join-Path $outsideState 'user-data.marker'),$sentinel)
$beforeSentinel=(Get-FileHash -LiteralPath (Join-Path $outRoot 'sentinel.txt') -Algorithm SHA256).Hash
$beforeUser=(Get-FileHash -LiteralPath (Join-Path $outsideState 'user-data.marker') -Algorithm SHA256).Hash
$summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=$started;cwd=(Get-Location).Path;powershell=$PSVersionTable.PSVersion.ToString();python=((& $python --version 2>&1|Out-String).Trim());uv=$uvVersion;wheelSha256=$wheelHash;uvSha256=$uvHash;processEnvironment=$envIsolated;cases=@();result='FAIL'}
try {
    # Establish a real a36 installation and a disposable metadata-only second version.
    $install=Invoke-Action 'Install' $root 'install.log'
    Assert ($install.exitCode -eq 0) 'initial exact-a36 installation failed'
    $fixture=Join-Path $sandbox 'project_state_python_candidate-0.1.0a36.post8-py3-none-any.whl'
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel.FullName $fixture '0.1.0a36' '0.1.0a36.post8'
    Assert ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $fixture -PathType Leaf)) 'could not create synthetic version-label wheel'
    $fixtureHash=(Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $fixtureManifest=Join-Path $sandbox 'manifest-post8.json'
    $fixtureManifestValue=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version='0.1.0a36.post8';wheel=[ordered]@{file=(Split-Path -Leaf $fixture);sha256=$fixtureHash;bytes=[long](Get-Item $fixture).Length};uv=[ordered]@{version=($uvVersion -replace '^uv ([^ ]+).*$','$1');sha256=$uvHash}}
    [IO.File]::WriteAllText($fixtureManifest,($fixtureManifestValue|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))

    # Lock the receipt against replacement after the plan is durable. The old
    # active command must continue to work, and a new process must resume.
    $receiptPath=Join-Path $root 'state\install-receipt.json'
    $oldReceiptHash=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $receiptStream=[IO.File]::Open($receiptPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$failedUpgrade=Invoke-Action 'Upgrade' $root 'receipt-write-blocked.log' '' '' $fixtureManifest}finally{$receiptStream.Dispose()}
    $receiptLog=Get-Content -LiteralPath (Join-Path $evidence 'receipt-write-blocked.log') -Raw
    $receiptId=[regex]::Match($receiptLog,'EINSTALL_TRANSACTION_ID: ([a-f0-9]{32})').Groups[1].Value
    Assert ($failedUpgrade.exitCode -eq 2 -and $receiptId.Length -eq 32) 'receipt replacement failure was not reported with a durable transaction ID'
    Assert ((Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $oldReceiptHash) 'failed receipt replacement changed the previous receipt bytes'
    $oldCommand=& (Join-Path $root 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $oldCommand.Trim() -ceq '0.1.0a36') 'old active entry stopped working after receipt write failure'
    $beforeInspect=Get-StoreDigest $root
    $inspect=Invoke-Action 'Inspect' $root 'receipt-write-inspect.log' $receiptId
    $afterInspect=Get-StoreDigest $root
    Assert ($inspect.exitCode -eq 0 -and $inspect.stdout -match 'receipt-intent' -and $beforeInspect -ceq $afterInspect) 'inspect changed journal/store or missed receipt-intent state'
    $resume=Invoke-Action 'Resume' $root 'receipt-write-resume.log' $receiptId
    Assert ($resume.exitCode -eq 0 -and $resume.stdout -match '"phase":"completed"') 'third process did not resume receipt publication'
    $newCommand=& (Join-Path $root 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $newCommand.Trim() -ceq '0.1.0a36.post8') 'resumed upgrade did not activate verified second version'
    $results.Add([ordered]@{case='receipt-replace-blocked-old-active-preserved-inspect-readonly-third-process-resume';status='PASS';failedUpgradeExit=$failedUpgrade.exitCode;transactionId=$receiptId;inspectExit=$inspect.exitCode;resumeExit=$resume.exitCode;oldActiveAfterFailure='0.1.0a36';activeAfterResume='0.1.0a36.post8';receiptUnchangedDuringFailure=$true;inspectStoreBytesUnchanged=$true})

    # Lock the active pointer to force atomic replacement to fail. The pointer
    # remains byte-identical until a later process resumes the same operation.
    $pointerPath=Join-Path $root 'state\active-version.txt'
    $pointerBytes=[IO.File]::ReadAllBytes($pointerPath)
    $pointerBefore=[Convert]::ToBase64String($pointerBytes)
    $pointerStream=[IO.File]::Open($pointerPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$failedActivate=Invoke-Action 'Activate' $root 'pointer-write-blocked.log' '' '0.1.0a36'}finally{$pointerStream.Dispose()}
    $pointerLog=Get-Content -LiteralPath (Join-Path $evidence 'pointer-write-blocked.log') -Raw
    $pointerId=[regex]::Match($pointerLog,'EINSTALL_TRANSACTION_ID: ([a-f0-9]{32})').Groups[1].Value
    Assert ($failedActivate.exitCode -eq 2 -and $pointerId.Length -eq 32) 'active-pointer write failure lacked a transaction record'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($pointerPath)) -ceq $pointerBefore) 'blocked pointer replacement changed active version bytes'
    $activeCommand=& (Join-Path $root 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $activeCommand.Trim() -ceq '0.1.0a36.post8') 'active command stopped working during pointer write refusal'
    $pointerInspect=Invoke-Action 'Inspect' $root 'pointer-write-inspect.log' $pointerId
    Assert ($pointerInspect.exitCode -eq 0 -and $pointerInspect.stdout -match 'activate-intent') 'pointer failure was not inspectable at activate-intent'
    $pointerResume=Invoke-Action 'Resume' $root 'pointer-write-resume.log' $pointerId
    Assert ($pointerResume.exitCode -eq 0 -and $pointerResume.stdout -match '"phase":"completed"') 'pointer transaction did not resume after lock release'
    $rollback=Invoke-Action 'Rollback' $root 'program-rollback.log'
    Assert ($rollback.exitCode -eq 0) 'program-version rollback action failed'
    $rolledCommand=& (Join-Path $root 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $rolledCommand.Trim() -ceq '0.1.0a36.post8') 'program rollback did not restore the recorded previous active version'
    $results.Add([ordered]@{case='active-pointer-replace-blocked-byte-preserved-resume-and-program-rollback';status='PASS';failedActivateExit=$failedActivate.exitCode;transactionId=$pointerId;inspectExit=$pointerInspect.exitCode;resumeExit=$pointerResume.exitCode;rollbackExit=$rollback.exitCode;pointerBytesPreservedAtFailure=$true;activeAfterRecovery='0.1.0a36.post8'})

    # Kill a real PowerShell installer child after its exact journal-authorized
    # pointer bytes have been flushed to the deterministic transaction temp.
    # A third process must inspect without writes and resume that same object.
    $atomicGate=Join-Path $evidence 'gate-atomic-temp';[IO.Directory]::CreateDirectory($atomicGate)|Out-Null
    $atomicArgs=@('-Action','Activate','-InstallRoot',$root,'-Version','0.1.0a36')
    $atomicChild=Start-Installer $atomicArgs 'atomic-temp-flushed' $atomicGate
    $atomicReady=Wait-Gate $atomicGate 'atomic-temp-flushed' $atomicChild
    $atomicId=$atomicReady.Name.Split('.')[0]
    $atomicTemp=[IO.File]::ReadAllText($atomicReady.FullName,[Text.Encoding]::UTF8)
    Assert ($atomicTemp -match '\\.write-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{16}\.tmp$' -and (Test-Path -LiteralPath $atomicTemp -PathType Leaf)) 'durable atomic-write barrier did not expose the deterministic temp object'
    $tempHash=(Get-FileHash -LiteralPath $atomicTemp -Algorithm SHA256).Hash.ToLowerInvariant();$tempBytes=[long](Get-Item -LiteralPath $atomicTemp).Length
    $atomicPid=$atomicChild.Process.Id;$atomicChild.Process.Kill($true);$atomicKill=Wait-Installer $atomicChild
    [IO.File]::WriteAllText((Join-Path $evidence 'atomic-temp-process-killed.log'),($atomicKill.stdout+$atomicKill.stderr),[Text.UTF8Encoding]::new($false))
    Assert ($atomicChild.Process.HasExited -and $atomicKill.exitCode -ne 0 -and (Test-Path -LiteralPath $atomicTemp -PathType Leaf) -and (Get-FileHash -LiteralPath $atomicTemp -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $tempHash) 'actual child termination or durable temp preservation was not verified'
    $atomicStoreBefore=Get-StoreDigest $root
    $atomicInspect=Invoke-Action 'Inspect' $root 'atomic-temp-inspect.log' $atomicId
    $atomicStoreAfter=Get-StoreDigest $root
    Assert ($atomicInspect.exitCode -eq 0 -and $atomicInspect.stdout -match 'activate-intent' -and $atomicStoreBefore -ceq $atomicStoreAfter) 'inspect changed journal bytes or missed the interrupted atomic publication'
    $atomicResume=Invoke-Action 'Resume' $root 'atomic-temp-resume.log' $atomicId
    Assert ($atomicResume.exitCode -eq 0 -and $atomicResume.stdout -match '"phase":"completed"' -and -not(Test-Path -LiteralPath $atomicTemp)) 'third process failed to publish and retire the exact deterministic temp'
    $atomicCommand=& (Join-Path $root 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $atomicCommand.Trim() -ceq '0.1.0a36') 'resumed atomic publication did not activate its journaled version'
    $restoreActive=Invoke-Action 'Activate' $root 'restore-active-after-atomic-recovery.log' '' '0.1.0a36.post8'
    Assert ($restoreActive.exitCode -eq 0) 'could not restore the test version pointer before uninstall scenario'
    $results.Add([ordered]@{case='process-kill-after-atomic-temp-flush-third-process-inspect-and-resume';status='PASS';killedPid=$atomicPid;killedProcessObserved=$atomicChild.Process.HasExited;childExitCode=$atomicKill.exitCode;transactionId=$atomicId;tempBytes=$tempBytes;tempSha256=$tempHash;inspectExit=$atomicInspect.exitCode;resumeExit=$atomicResume.exitCode;tempRemovedByAuthorizedPublication=$true;activeAfterResume='0.1.0a36'})

    # Pause after the shim is retired to quarantine. Holding the exact owned
    # quarantine object forces post-commit cleanup to fail; recovery may only
    # continue cleanup after the handle is released.
    $gate=Join-Path $evidence 'gate-uninstall-retired';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $uninstallArgs=@('-Action','Uninstall','-InstallRoot',$root)
    $child=Start-Installer $uninstallArgs 'retired-0000' $gate
    $ready=Wait-Gate $gate 'retired-0000' $child
    $uninstallId=$ready.Name.Split('.')[0]
    Import-Module -Name $module -Force
    $transaction=Read-InstallerTransaction $root $uninstallId
    $firstItem=@($transaction.Latest.plan.retireItems)[0]
    $quarantinePath=[string]$firstItem.quarantine
    Assert ((Test-Path -LiteralPath $quarantinePath -PathType Leaf) -and $firstItem.kind -ceq 'file') 'retired shim was not in the planned quarantine position'
    $quarantineStream=[IO.File]::Open($quarantinePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    [IO.File]::WriteAllText((Join-Path $gate ($uninstallId+'.retired-0000.release')),'continue',[Text.UTF8Encoding]::new($false))
    $cleanupFailure=Wait-Installer $child
    [IO.File]::WriteAllText((Join-Path $evidence 'uninstall-cleanup-blocked.log'),($cleanupFailure.stdout+$cleanupFailure.stderr),[Text.UTF8Encoding]::new($false))
    Assert ($cleanupFailure.exitCode -eq 2) 'locked quarantine item did not make committed cleanup fail closed'
    $cleanupRead=Read-InstallerTransaction $root $uninstallId
    Assert ($cleanupRead.Latest.phase -match '^cleanup-(pending|intent-0000)$') 'cleanup failure did not leave an explicit resumable cleanup phase'
    $postCommitRollback=Invoke-Action 'Rollback' $root 'post-commit-rollback-refused.log' $uninstallId
    Assert ($postCommitRollback.exitCode -eq 2 -and (Get-Content -LiteralPath (Join-Path $evidence 'post-commit-rollback-refused.log') -Raw) -match 'EINSTALL_ROLLBACK_REFUSED') 'committed uninstall was incorrectly rolled back'
    $quarantineStream.Dispose()
    $cleanupResume=Invoke-Action 'Resume' $root 'cleanup-resume.log' $uninstallId
    Assert ($cleanupResume.exitCode -eq 0 -and $cleanupResume.stdout -match '"phase":"completed"') 'cleanup did not resume after the synthetic file handle was released'
    Assert ((Test-Path -LiteralPath $root -PathType Container) -and -not(Test-Path -LiteralPath (Join-Path $root 'bin\project-state.cmd')) -and -not(Test-Path -LiteralPath (Join-Path $root 'state\install-receipt.json'))) 'uninstall cleanup final state does not match committed plan'
    $remainingAtomicTemps=@(Get-ChildItem -LiteralPath $root -Force -File -Recurse | Where-Object{$_.Name -match '^\.write-'})
    Assert ($remainingAtomicTemps.Count -eq 0) 'uninstall reported completion while transaction metadata temp artifacts remained'
    Assert ((Get-FileHash -LiteralPath (Join-Path $outRoot 'sentinel.txt') -Algorithm SHA256).Hash -ceq $beforeSentinel -and (Get-FileHash -LiteralPath (Join-Path $outsideState 'user-data.marker') -Algorithm SHA256).Hash -ceq $beforeUser) 'uninstall touched synthetic external project or user data'
    $results.Add([ordered]@{case='post-commit-cleanup-file-busy-then-third-process-resume-only';status='PASS';killedHandleObject=$quarantinePath;uninstallExitAfterBusy=$cleanupFailure.exitCode;phaseAfterBusy=$cleanupRead.Latest.phase;rollbackAfterCommitExit=$postCommitRollback.exitCode;resumeExit=$cleanupResume.exitCode;installRootRetained=$true;noAtomicTempArtifacts=$true;externalProjectAndUserSentinelsUnchanged=$true})

    $envAfter=[ordered]@{}
    $current=[Environment]::GetEnvironmentVariables('Process')
    foreach($name in $envNames){$exists=$current.Contains($name);$envAfter[$name]=[ordered]@{present=$exists;value=$(if($exists){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null})}}
    $runnerEnvironmentIsolated=$true
    foreach($name in $envNames){if($envAfter[$name].value -cne $envIsolated[$name]){$runnerEnvironmentIsolated=$false}}
    Assert $runnerEnvironmentIsolated 'installer test process environment escaped its synthetic root during the run'
    $summary.runnerProcessStayedIsolated=$runnerEnvironmentIsolated;$summary.cases=@($results);$summary.result='PASS';$summary.endedAt=(Get-Date).ToUniversalTime().ToString('o')
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $summary|ConvertTo-Json -Depth 12
} catch {
    $summary.cases=@($results);$summary.failure=$_.Exception.Message;$summary.result='FAIL';$summary.endedAt=(Get-Date).ToUniversalTime().ToString('o')
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    [Console]::Error.WriteLine($_.Exception.ToString())
    throw
} finally {
    foreach($name in $envNames){if($envBefore[$name].present){[Environment]::SetEnvironmentVariable($name,[string]$envBefore[$name].value,'Process')}else{Remove-Item -LiteralPath ('Env:'+ $name) -ErrorAction SilentlyContinue}}
}
$finalEnvironment=[Environment]::GetEnvironmentVariables('Process')
$restored=$true
foreach($name in $envNames){$exists=$finalEnvironment.Contains($name);if($exists -ne $envBefore[$name].present -or ($exists -and [Environment]::GetEnvironmentVariable($name,'Process') -cne $envBefore[$name].value)){$restored=$false}}
$resultPath=Join-Path $evidence 'results.json'
$finalResult=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json -AsHashtable
$finalResult.parentProcessEnvironmentRestored=$restored
[IO.File]::WriteAllText($resultPath,($finalResult|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
if(-not $restored){throw 'I/O test harness failed to restore its inherited process environment'}
