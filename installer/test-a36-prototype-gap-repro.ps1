param([string]$RunId = 'prototype-gap-b01')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$here=$PSScriptRoot
$workspace=(Resolve-Path (Join-Path $here '..\..')).Path
$sandbox=Join-Path $workspace ('sandbox\'+$RunId)
$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)){throw 'Refusing to reuse prototype reproduction paths'}
[IO.Directory]::CreateDirectory($sandbox)|Out-Null
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$baseline=Join-Path $here '..\reference-a36\installer\install-core-prototype.ps1'
$instrumented=Join-Path $sandbox 'install-core-prototype-instrumented.ps1'
$baselineBytes=[IO.File]::ReadAllBytes($baseline)
$baselineHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($baselineBytes)).ToLowerInvariant()
$text=[IO.File]::ReadAllText($baseline,[Text.Encoding]::UTF8)
$hook=@'
function Test-PrototypeBarrier([string]$Name) {
    if ($env:PROJECT_STATE_BASELINE_GATE_PHASE -cne $Name) { return }
    $gate=$env:PROJECT_STATE_BASELINE_GATE_ROOT
    [IO.Directory]::CreateDirectory($gate)|Out-Null
    $ready=Join-Path $gate ($PID.ToString()+'.'+$Name+'.ready')
    $release=Join-Path $gate ($PID.ToString()+'.'+$Name+'.release')
    [IO.File]::WriteAllText($ready,$Name,[Text.UTF8Encoding]::new($false))
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    while(-not(Test-Path -LiteralPath $release)){
        if([DateTime]::UtcNow -gt $deadline){throw 'TEST_GATE_TIMEOUT'}
        Start-Sleep -Milliseconds 20
    }
}
'@
$anchor=@'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
'@.TrimEnd()
if(-not $text.Contains($anchor)){throw 'baseline instrumentation anchor missing'}
$text=$text.Replace($anchor,$anchor+"`r`n"+$hook)
$rootAnchor=@'
        $script:Receipt = [ordered]@{ schemaVersion=1; installId=[guid]::NewGuid().ToString('N'); installRoot=$script:Root; createdAt=(Get-Date).ToUniversalTime().ToString('o'); versions=@(); userPathRegistered=$false; shimSha256=$null }
        Save-Receipt $script:Receipt
'@
$rootReplacement=@'
        $script:Receipt = [ordered]@{ schemaVersion=1; installId=[guid]::NewGuid().ToString('N'); installRoot=$script:Root; createdAt=(Get-Date).ToUniversalTime().ToString('o'); versions=@(); userPathRegistered=$false; shimSha256=$null }
        Test-PrototypeBarrier 'before-root-receipt'
        Save-Receipt $script:Receipt
'@
if(-not $text.Contains($rootAnchor)){throw 'baseline root receipt instrumentation anchor missing'}
$text=$text.Replace($rootAnchor,$rootReplacement)
$venvAnchor="            if ((Invoke-Native `$uv @('venv','--offline','--python',`$pythonBase,`$stage)) -ne 0) { throw 'EINSTALL_VENV: uv could not create the isolated environment' }"
if(-not $text.Contains($venvAnchor)){throw 'baseline venv instrumentation anchor missing'}
$text=$text.Replace($venvAnchor,$venvAnchor+"`r`n            Test-PrototypeBarrier 'after-venv-created'")
$pointerAnchor=@'
    Write-AtomicText (Join-Path $script:Root 'state\active-version.txt') ($Version + "`n")
'@
if(-not $text.Contains($pointerAnchor)){throw 'baseline pointer instrumentation anchor missing'}
$text=$text.Replace($pointerAnchor,"    Test-PrototypeBarrier 'before-pointer-publish'`r`n"+$pointerAnchor+"`r`n    Test-PrototypeBarrier 'after-pointer-publish'")
$publishAnchor='            [IO.Directory]::Move($stage,$final)'
if(-not $text.Contains($publishAnchor)){throw 'baseline version publish instrumentation anchor missing'}
$text=$text.Replace($publishAnchor,"            Test-PrototypeBarrier 'before-version-publish'`r`n"+$publishAnchor)
$uninstallAnchor='    if (Test-Path -LiteralPath $shim) { Remove-Item -LiteralPath $shim -Force }'
if(-not $text.Contains($uninstallAnchor)){throw 'baseline uninstall instrumentation anchor missing'}
$text=$text.Replace($uninstallAnchor,$uninstallAnchor+"`r`n    Test-PrototypeBarrier 'after-shim-removed'")
[IO.File]::WriteAllText($instrumented,$text,[Text.UTF8Encoding]::new($false))
$instrumentedHash=(Get-FileHash -LiteralPath $instrumented -Algorithm SHA256).Hash.ToLowerInvariant()
$python=(Get-Command python.exe -ErrorAction Stop).Source
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$uv=Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'
$wheel=Join-Path $workspace 'artifacts\product\project_state_python_candidate-0.1.0a36-py3-none-any.whl'
$wheelHash=(Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant()
$wheelSize=[long](Get-Item -LiteralPath $wheel).Length
$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant()
$uvVersion=((& $uv --version 2>&1)|Out-String).Trim() -replace '^uv ([^ ]+).*$','$1'
$manifest=Join-Path $sandbox 'manifest-a36.json'
$baselineWheel=Join-Path $sandbox (Split-Path -Leaf $wheel)
Copy-Item -LiteralPath $wheel -Destination $baselineWheel
function Write-Manifest([string]$WheelPath,[string]$Version,[string]$Path){
    $hash=(Get-FileHash -LiteralPath $WheelPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $size=[long](Get-Item -LiteralPath $WheelPath).Length
    $obj=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$Version;wheel=[ordered]@{file=(Split-Path -Leaf $WheelPath);sha256=$hash;bytes=$size};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
    [IO.File]::WriteAllText($Path,($obj|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    return [pscustomobject]@{path=$Path;wheel=$WheelPath;wheelSha256=$hash;wheelBytes=$size;version=$Version}
}
$baseManifest=Write-Manifest $baselineWheel '0.1.0a36' $manifest
$localApp=Join-Path $sandbox 'local-app-data';$temp=Join-Path $sandbox 'temp';$uvCache=Join-Path $sandbox 'uv-cache'
foreach($path in @($localApp,$temp,$uvCache)){[IO.Directory]::CreateDirectory($path)|Out-Null}
$envBefore=[ordered]@{}
foreach($name in @('LOCALAPPDATA','TEMP','TMP','UV_CACHE_DIR','PROJECT_STATE_BASELINE_GATE_PHASE','PROJECT_STATE_BASELINE_GATE_ROOT')){$envBefore[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$script:ActiveChildren=[System.Collections.Generic.List[object]]::new()
function Start-Baseline([string]$Action,[string]$Root,$Manifest,[string]$GatePhase,[string]$GateRoot){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',$instrumented,'-Action',$Action,'-InstallRoot',$Root)){[void]$psi.ArgumentList.Add([string]$arg)}
    if($Manifest){foreach($arg in @('-ManifestPath',$Manifest.path,'-UvPath',$uv,'-PythonPath',$python)){[void]$psi.ArgumentList.Add($arg)}}
    foreach($pair in @(@('LOCALAPPDATA',$localApp),@('TEMP',$temp),@('TMP',$temp),@('UV_CACHE_DIR',$uvCache),@('UV_NO_CONFIG','1'))){$psi.Environment[$pair[0]]=$pair[1]}
    if($GatePhase){$psi.Environment['PROJECT_STATE_BASELINE_GATE_PHASE']=$GatePhase;$psi.Environment['PROJECT_STATE_BASELINE_GATE_ROOT']=$GateRoot}else{[void]$psi.Environment.Remove('PROJECT_STATE_BASELINE_GATE_PHASE');[void]$psi.Environment.Remove('PROJECT_STATE_BASELINE_GATE_ROOT')}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;if(-not $process.Start()){throw 'could not start instrumented prototype process'}
    $child=[pscustomobject]@{process=$process;stdout=$process.StandardOutput.ReadToEndAsync();stderr=$process.StandardError.ReadToEndAsync()}
    $script:ActiveChildren.Add($child)
    return $child
}
function Wait-Baseline($Child,[int]$Seconds=180){
    if(-not $Child.process.WaitForExit($Seconds*1000)){try{$Child.process.Kill($true)}catch{};throw 'prototype child timed out'}
    $Child.process.WaitForExit();[void]$script:ActiveChildren.Remove($Child);return [pscustomobject]@{exitCode=$Child.process.ExitCode;stdout=$Child.stdout.GetAwaiter().GetResult();stderr=$Child.stderr.GetAwaiter().GetResult();pid=$Child.process.Id}
}
function Wait-Barrier([string]$Gate,[string]$Name,$Child,[int]$Seconds=90){
    $ready=Join-Path $Gate ($Child.process.Id.ToString()+'.'+$Name+'.ready');$deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    while(-not(Test-Path -LiteralPath $ready)){if($Child.process.HasExited){$r=Wait-Baseline $Child;throw ('prototype exited before barrier '+$Name+': '+$r.stderr)};if([DateTime]::UtcNow -gt $deadline){throw ('timeout waiting barrier '+$Name)};Start-Sleep -Milliseconds 20}
    if($Child.process.HasExited){throw 'prototype exited before barrier observation'}
    return $ready
}
function Kill-AtBarrier([string]$Action,[string]$Root,$Manifest,[string]$Phase,[string]$Gate){
    [IO.Directory]::CreateDirectory($Gate)|Out-Null;$child=Start-Baseline $Action $Root $Manifest $Phase $Gate
    $ready=Wait-Barrier $Gate $Phase $child;$pidValue=$child.process.Id
    $child.process.Kill($true);$child.process.WaitForExit()
    [void]$script:ActiveChildren.Remove($child)
    return [pscustomobject]@{child=$child;ready=$ready;pid=$pidValue;exitCode=$child.process.ExitCode;stdout=$child.stdout.GetAwaiter().GetResult();stderr=$child.stderr.GetAwaiter().GetResult()}
}
function Invoke-Logged([string]$Action,[string]$Root,$Manifest,[string]$Name){
    $child=Start-Baseline $Action $Root $Manifest '' ''; $r=Wait-Baseline $child
    [IO.File]::WriteAllText((Join-Path $evidence $Name),($r.stdout+$r.stderr),[Text.UTF8Encoding]::new($false));return $r
}
$cases=[System.Collections.Generic.List[object]]::new()
try{
    # Original source has no Resume/Inspect actions. Keep an exact byte copy and
    # instrument only an isolated reproduction copy with deterministic gates.
    $root=Join-Path $sandbox 'root-before-receipt';$gate=Join-Path $evidence 'gate-root-before-receipt'
    $crash=Kill-AtBarrier 'Install' $root $baseManifest 'before-root-receipt' $gate
    $receiptExists=Test-Path -LiteralPath (Join-Path $root 'state\install-receipt.json')
    $rootDirs=@(@('versions','bin','state')|ForEach-Object{Test-Path -LiteralPath (Join-Path $root $_)})
    $resume=Invoke-Logged 'Resume' $root $null 'baseline-root-resume-rejected.log'
    $retry=Invoke-Logged 'Install' $root $baseManifest 'baseline-root-install-retry.log'
    if($receiptExists -or @($rootDirs|Where-Object{$_ -ne $true}).Count -gt 0 -or $retry.exitCode -eq 0 -or ($retry.stderr -notmatch 'EINSTALL_CONFLICT')){throw 'prototype root-before-receipt reproduction did not preserve the expected blocked state'}
    $cases.Add([ordered]@{case='root-created-before-receipt-process-termination';status='REPRODUCED';killedPid=$crash.pid;exitAfterKill=$crash.exitCode;rootPresent=(Test-Path $root);receiptPresent=$receiptExists;subdirectoriesPresent=@($rootDirs|Where-Object{$_}).Count;retryExit=$retry.exitCode;retryRefusal='EINSTALL_CONFLICT';resumeExit=$resume.exitCode;resumeUnsupported=($resume.stderr -match 'ValidateSet|valid values')})

    # Venv exists but is not registered. The retry can create a second stage;
    # the first stage remains an unowned entry that blocks uninstall.
    $root=Join-Path $sandbox 'venv-before-registration';$gate=Join-Path $evidence 'gate-after-venv'
    $crash=Kill-AtBarrier 'Install' $root $baseManifest 'after-venv-created' $gate
    $stage=@(Get-ChildItem -LiteralPath (Join-Path $root 'versions') -Directory -Force)
    if($stage.Count -ne 1 -or -not(Test-Path -LiteralPath (Join-Path $stage[0].FullName 'Scripts\python.exe')) -or (Test-Path -LiteralPath (Join-Path $stage[0].FullName '.project-state-installer-owner.json'))){throw 'prototype venv interruption state was not observed'}
    $retry=Invoke-Logged 'Install' $root $baseManifest 'baseline-venv-install-retry.log'
    $orphanStillPresent=Test-Path -LiteralPath $stage[0].FullName
    $uninstall=Invoke-Logged 'Uninstall' $root $null 'baseline-venv-uninstall-refused.log'
    if($retry.exitCode -ne 0 -or -not $orphanStillPresent -or $uninstall.exitCode -eq 0 -or $uninstall.stderr -notmatch 'EUNINSTALL_CONFLICT'){throw 'prototype venv interruption did not leave an unowned stage that blocks safe uninstall'}
    $cases.Add([ordered]@{case='venv-created-before-version-registration-process-termination';status='REPRODUCED';killedPid=$crash.pid;stagingCountAtKill=$stage.Count;venvPythonPresent=$true;stageOwnerMarkerPresent=$false;retryExit=$retry.exitCode;orphanRetained=$orphanStillPresent;uninstallExit=$uninstall.exitCode;uninstallRefusal='EUNINSTALL_CONFLICT'})

    # Establish a baseline active command, then interrupt a second version on
    # both sides of the active-pointer write.
    $root=Join-Path $sandbox 'pointer-boundaries'
    $initial=Invoke-Logged 'Install' $root $baseManifest 'baseline-pointer-initial-install.log'
    if($initial.exitCode -ne 0){throw 'could not establish baseline pointer fixture'}
    $post1=Join-Path $sandbox 'project_state_python_candidate-0.1.0a36.post1-py3-none-any.whl'
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $post1 '0.1.0a36' '0.1.0a36.post1'
    if($LASTEXITCODE -ne 0){throw 'could not generate synthetic pointer fixture wheel'}
    $post1Manifest=Write-Manifest $post1 '0.1.0a36.post1' (Join-Path $sandbox 'manifest-post1.json')
    $beforeGate=Join-Path $evidence 'gate-pointer-before';$crashBefore=Kill-AtBarrier 'Install' $root $post1Manifest 'before-pointer-publish' $beforeGate
    $pointerBefore=(Get-Content -LiteralPath (Join-Path $root 'state\active-version.txt') -Raw).Trim()
    $resumeBefore=Invoke-Logged 'Resume' $root $null 'baseline-pointer-before-resume-rejected.log'
    $statusBefore=Invoke-Logged 'Status' $root $null 'baseline-pointer-before-status.log'
    if($pointerBefore -cne '0.1.0a36' -or $resumeBefore.exitCode -eq 0 -or $statusBefore.exitCode -ne 0){throw 'prototype pre-pointer interruption state differs from expected observation'}
    $repairBefore=Invoke-Logged 'Install' $root $post1Manifest 'baseline-pointer-before-retry.log'
    if($repairBefore.exitCode -ne 0){throw 'manual rerun could not finish the pre-pointer state'}
    $post2=Join-Path $sandbox 'project_state_python_candidate-0.1.0a36.post2-py3-none-any.whl'
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $post2 '0.1.0a36' '0.1.0a36.post2'
    if($LASTEXITCODE -ne 0){throw 'could not generate second synthetic pointer fixture wheel'}
    $post2Manifest=Write-Manifest $post2 '0.1.0a36.post2' (Join-Path $sandbox 'manifest-post2.json')
    $afterGate=Join-Path $evidence 'gate-pointer-after';$crashAfter=Kill-AtBarrier 'Install' $root $post2Manifest 'after-pointer-publish' $afterGate
    $pointerAfter=(Get-Content -LiteralPath (Join-Path $root 'state\active-version.txt') -Raw).Trim()
    $resumeAfter=Invoke-Logged 'Resume' $root $null 'baseline-pointer-after-resume-rejected.log'
    if($pointerAfter -cne '0.1.0a36.post2' -or $resumeAfter.exitCode -eq 0){throw 'prototype post-pointer interruption was not represented as expected'}
    $cases.Add([ordered]@{case='active-pointer-before-and-after-publication-termination';status='REPRODUCED';beforePid=$crashBefore.pid;beforePointer=$pointerBefore;beforeResumeExit=$resumeBefore.exitCode;beforeStatusExit=$statusBefore.exitCode;manualRetryExit=$repairBefore.exitCode;afterPid=$crashAfter.pid;afterPointer=$pointerAfter;afterResumeExit=$resumeAfter.exitCode;transactionEvidencePresent=$false})

    # Partial uninstall: remove the managed shim, then terminate before the
    # version and receipt cleanup; demonstrate no resume journal exists.
    $sentinel=Join-Path $root 'user-added.txt';[IO.File]::WriteAllText($sentinel,'synthetic external sentinel',[Text.UTF8Encoding]::new($false))
    $uninstallGate=Join-Path $evidence 'gate-uninstall-after-shim';$crashUninstall=Kill-AtBarrier 'Uninstall' $root $null 'after-shim-removed' $uninstallGate
    $shim=Join-Path $root 'bin\project-state.cmd';$receipt=Join-Path $root 'state\install-receipt.json';$pointer=Join-Path $root 'state\active-version.txt'
    $partial=@{shimPresent=(Test-Path $shim);receiptPresent=(Test-Path $receipt);pointerPresent=(Test-Path $pointer);rootPresent=(Test-Path $root)}
    $resumeUninstall=Invoke-Logged 'Resume' $root $null 'baseline-uninstall-resume-rejected.log'
    $uninstallRetry=Invoke-Logged 'Uninstall' $root $null 'baseline-uninstall-retry.log'
    if($partial.shimPresent -or -not $partial.receiptPresent -or -not $partial.pointerPresent -or $resumeUninstall.exitCode -eq 0 -or $uninstallRetry.exitCode -ne 0 -or -not(Test-Path $sentinel)){throw 'prototype uninstall interruption did not preserve/reveal the expected state'}
    $cases.Add([ordered]@{case='partial-uninstall-after-first-managed-object-removal';status='REPRODUCED';killedPid=$crashUninstall.pid;partialState=$partial;resumeExit=$resumeUninstall.exitCode;retryExit=$uninstallRetry.exitCode;externalSentinelPreserved=$true;transactionEvidencePresent=$false})

    # The exact a36 input already has a same-session named mutex. Hold the
    # first process at publication and require the second to be rejected
    # before reaching that boundary. This classifies, rather than repeats, the
    # older no-mutex result from the a43 reference baseline.
    $concurrentRoot=Join-Path $sandbox 'same-root-race';$seed=Invoke-Logged 'Install' $concurrentRoot $baseManifest 'baseline-concurrency-seed.log'
    if($seed.exitCode -ne 0){throw 'could not establish concurrency baseline'}
    $raceVersion=Join-Path $sandbox 'project_state_python_candidate-0.1.0a36.post3-py3-none-any.whl'
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $raceVersion '0.1.0a36' '0.1.0a36.post3'
    if($LASTEXITCODE -ne 0){throw 'could not generate synthetic concurrency wheel'}
    $raceManifest=Write-Manifest $raceVersion '0.1.0a36.post3' (Join-Path $sandbox 'manifest-race.json')
    $raceGate=Join-Path $evidence 'gate-same-root-race';[IO.Directory]::CreateDirectory($raceGate)|Out-Null
    $a=Start-Baseline 'Install' $concurrentRoot $raceManifest 'before-version-publish' $raceGate
    $readyA=Wait-Barrier $raceGate 'before-version-publish' $a
    $b=Start-Baseline 'Install' $concurrentRoot $raceManifest 'before-version-publish' $raceGate
    $rb=Wait-Baseline $b 30
    $contenderRefused=$rb.exitCode -eq 2 -and $rb.stderr -match 'EINSTALL_BUSY'
    $releaseA=$readyA -replace '\.ready$','.release';[IO.File]::WriteAllText($releaseA,'release',[Text.UTF8Encoding]::new($false))
    $ra=Wait-Baseline $a
    $stageEntries=@(Get-ChildItem -LiteralPath (Join-Path $concurrentRoot 'versions') -Directory -Force|Where-Object{$_.Name -like '.stage-*'})
    $activeAfter=(Get-Content -LiteralPath (Join-Path $concurrentRoot 'state\active-version.txt') -Raw).Trim()
    $postStatus=Invoke-Logged 'Status' $concurrentRoot $null 'a36-concurrency-post-status.log'
    if(-not $contenderRefused -or $ra.exitCode -ne 0 -or $stageEntries.Count -ne 0 -or $activeAfter -cne '0.1.0a36.post3' -or $postStatus.exitCode -ne 0){throw 'a36 same-session mutex did not serialize the two-process install'}
    $cases.Add([ordered]@{case='two-process-same-install-root';status='NOT_REPRODUCED_PROTECTED';protection='same-session named mutex';ownerPid=$a.process.Id;contenderPid=$b.process.Id;ownerExit=$ra.exitCode;contenderExit=$rb.exitCode;contenderReason='EINSTALL_BUSY';contenderReachedPublicationGate=$false;activeAfter=$activeAfter;unownedStagesRemaining=$stageEntries.Count;followupStatusExit=$postStatus.exitCode;note='Cross-session mutex behavior is not established by this test.'})

    $result=[ordered]@{schemaVersion=1;runId=$RunId;baselinePath=$baseline;baselineSha256=$baselineHash;instrumentedCopySha256=$instrumentedHash;instrumentation='Only deterministic test barriers inserted at named operations; original baseline bytes retained separately.';wheelSha256=$wheelHash;uvSha256=$uvHash;cases=@($cases.ToArray());result='PASS_GAP_CLASSIFICATION'}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($result|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    Write-Output ($result|ConvertTo-Json -Depth 10 -Compress)
} finally {
    foreach($child in @($script:ActiveChildren.ToArray())){
        if(-not $child.process.HasExited){try{$child.process.Kill($true);$child.process.WaitForExit()}catch{}}
    }
    $script:ActiveChildren.Clear()
    foreach($name in $envBefore.Keys){if($null -eq $envBefore[$name]){Remove-Item -LiteralPath ('Env:'+ $name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,[string]$envBefore[$name],'Process')}}
}
