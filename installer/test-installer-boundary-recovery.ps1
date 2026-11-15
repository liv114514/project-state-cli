param(
    [string]$RunId='installer-boundary-b01',
    [string]$WheelPath,
    [string]$ProductVersion='0.1.0a36',
    [string]$UvPath,
    [string]$PythonPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$here=$PSScriptRoot;$workspace=(Resolve-Path (Join-Path $here '..\..')).Path
$sandbox=Join-Path (Split-Path -Parent $workspace) ('.installer-boundary-'+$RunId);$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)){throw 'Refusing to reuse boundary test paths'}
[IO.Directory]::CreateDirectory($sandbox)|Out-Null;[IO.Directory]::CreateDirectory($evidence)|Out-Null
$scriptPath=Join-Path $here 'install-core-prototype.ps1';$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source;$python=if($PythonPath){(Resolve-Path -LiteralPath $PythonPath).Path}else{(Get-Command python.exe -ErrorAction Stop).Source}
$module=Join-Path $here 'installer-transaction.psm1';Import-Module -Name $module -Force
$uv=if($UvPath){(Resolve-Path -LiteralPath $UvPath).Path}else{Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'}
$wheelSource=if($WheelPath){(Resolve-Path -LiteralPath $WheelPath).Path}else{Join-Path $workspace 'artifacts\product\project_state_python_candidate-0.1.0a36-py3-none-any.whl'}
$wheel=Join-Path $sandbox (Split-Path -Leaf $wheelSource);Copy-Item -LiteralPath $wheelSource -Destination $wheel
$wheelHash=(Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant();$wheelBytes=[long](Get-Item $wheel).Length
$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant();$uvVersion=((& $uv --version 2>&1)|Out-String).Trim() -replace '^uv ([^ ]+).*$','$1'
$manifestPath=Join-Path $sandbox ('manifest-'+$ProductVersion+'.json')
function Write-Manifest([string]$WheelPath,[string]$Version,[string]$OutPath){
    $digest=(Get-FileHash -LiteralPath $WheelPath -Algorithm SHA256).Hash.ToLowerInvariant();$size=[long](Get-Item $WheelPath).Length
    $obj=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$Version;wheel=[ordered]@{file=(Split-Path -Leaf $WheelPath);sha256=$digest;bytes=$size};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
    [IO.File]::WriteAllText($OutPath,($obj|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    return [pscustomobject]@{path=$OutPath;version=$Version;wheelPath=$WheelPath;wheelSha256=$digest;wheelBytes=$size}
}
$baseManifest=Write-Manifest $wheel $ProductVersion $manifestPath
function Get-PostVersion([int]$Number){return ($ProductVersion+'.post'+$Number)}
$localApp=Join-Path $sandbox 'local-app-data';$temp=Join-Path $sandbox 'temp';foreach($path in @($localApp,$temp)){[IO.Directory]::CreateDirectory($path)|Out-Null}
$script:Children=[System.Collections.Generic.List[object]]::new();$script:Runs=[System.Collections.Generic.List[object]]::new()
function Start-Action([string]$Action,[string]$Root,$Manifest,[string]$TransactionId,[string]$GatePhase,[string]$GateRoot){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',$scriptPath,'-Action',$Action,'-InstallRoot',$Root)){[void]$psi.ArgumentList.Add([string]$arg)}
    if($Manifest){foreach($arg in @('-ManifestPath',$Manifest.path,'-UvPath',$uv,'-PythonPath',$python)){[void]$psi.ArgumentList.Add([string]$arg)}}
    if($TransactionId){foreach($arg in @('-TransactionId',$TransactionId)){[void]$psi.ArgumentList.Add([string]$arg)}}
    if($GatePhase){foreach($arg in @('-EnableTestHooks','-TestGateRoot',$GateRoot,'-TestGatePhase',$GatePhase)){[void]$psi.ArgumentList.Add([string]$arg)}}
    foreach($pair in @(@('LOCALAPPDATA',$localApp),@('TEMP',$temp),@('TMP',$temp),@('UV_CACHE_DIR',(Join-Path $sandbox 'uv-cache')),@('UV_NO_CONFIG','1'))){$psi.Environment[$pair[0]]=$pair[1]}
    $proc=[Diagnostics.Process]::new();$proc.StartInfo=$psi;if(-not $proc.Start()){throw 'could not start installer process'}
    $child=[pscustomobject]@{Process=$proc;Out=$proc.StandardOutput.ReadToEndAsync();Err=$proc.StandardError.ReadToEndAsync();Action=$Action;Root=$Root}
    $script:Children.Add($child);return $child
}
function Complete-Action($Child,[string]$Label,[int]$Timeout=180){
    if(-not $Child.Process.WaitForExit($Timeout*1000)){try{$Child.Process.Kill($true)}catch{};throw "installer timed out: $Label"}
    $Child.Process.WaitForExit();[void]$script:Children.Remove($Child)
    $result=[pscustomobject]@{label=$Label;action=$Child.Action;exitCode=$Child.Process.ExitCode;pid=$Child.Process.Id;stdout=$Child.Out.GetAwaiter().GetResult();stderr=$Child.Err.GetAwaiter().GetResult()}
    [IO.File]::WriteAllText((Join-Path $evidence ($Label+'.log')),($result.stdout+$result.stderr),[Text.UTF8Encoding]::new($false))
    $script:Runs.Add([ordered]@{label=$Label;action=$Child.Action;exitCode=$result.exitCode;pid=$result.pid;stdoutFile=($Label+'.log')})
    return $result
}
function Wait-Gate([string]$Root,[string]$Phase,$Child){
    $deadline=[DateTime]::UtcNow.AddSeconds(120);$ready=$null
    while(-not $ready){$candidate=Get-ChildItem -LiteralPath $Root -Filter ('*.'+$Phase+'.ready') -File -ErrorAction SilentlyContinue|Select-Object -First 1;if($candidate){$ready=$candidate.FullName;break};if($Child.Process.HasExited){$done=Complete-Action $Child ('early-'+$Phase);throw ('installer exited before gate: '+$done.stderr)};if([DateTime]::UtcNow -gt $deadline){throw 'installer phase gate timed out'};Start-Sleep -Milliseconds 20}
    if($Child.Process.HasExited){throw 'installer exited at gate observation'}
    return $ready
}
function Kill-AtGate([string]$Action,[string]$Root,$Manifest,[string]$Phase,[string]$Name,[string]$TransactionId=''){
    $gate=Join-Path $evidence ('gate-'+$Name);[IO.Directory]::CreateDirectory($gate)|Out-Null;$child=Start-Action $Action $Root $Manifest $TransactionId $Phase $gate
    $ready=Wait-Gate $gate $Phase $child;$pidValue=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit();[void]$script:Children.Remove($child)
    $script:Runs.Add([ordered]@{label=$Name+'-terminated';action=$Action;exitCode=$child.Process.ExitCode;pid=$pidValue;phase=$Phase;termination='Process.Kill(entire process tree) after ready barrier'})
    return [pscustomobject]@{pid=$pidValue;exitCode=$child.Process.ExitCode;transactionId=([IO.Path]::GetFileName($ready) -split '\.')[0];phase=$Phase}
}
function Invoke-Captured([string]$Action,[string]$Root,[string]$TransactionId,[string]$Label,$Manifest=$null){
    $child=Start-Action $Action $Root $Manifest $TransactionId '' ''
    return Complete-Action $child $Label
}
function Assert([bool]$Ok,[string]$Message){if(-not $Ok){throw $Message}}
$cases=[System.Collections.Generic.List[object]]::new()
try{
    # A fresh install killed after venv creation but before wheel registration.
    $root=Join-Path $sandbox 'venv-created-resume';$kill=Kill-AtGate 'Install' $root $baseManifest 'venv-created' 'venv-created'
    $inspect=Invoke-Captured 'Inspect' $root $kill.transactionId 'venv-created-inspect'
    $inspectObj=$inspect.stdout|ConvertFrom-Json
    Assert ($inspect.exitCode -eq 0 -and $inspectObj.phase -ceq 'venv-created' -and $inspectObj.stagePresent -and $inspectObj.stageOwnerVerified -and -not $inspectObj.finalPresent) 'inspect did not classify owned venv-created state'
    $resume=Invoke-Captured 'Resume' $root $kill.transactionId 'venv-created-resume'
    Assert ($resume.exitCode -eq 0 -and $resume.stdout -match 'completed') 'third process failed to resume venv-created state'
    $command=Join-Path $root 'bin\project-state.cmd';$version=& $command --version 2>&1|Out-String;$versionExit=$LASTEXITCODE
    Assert ($versionExit -eq 0 -and $version.Trim() -ceq $ProductVersion) 'published relocated venv command failed after resume'
    $cases.Add([ordered]@{case='venv-created-before-receipt-registration';status='PASS';killedPid=$kill.pid;inspectPhase=$inspectObj.phase;stageOwnerVerified=$inspectObj.stageOwnerVerified;resumeExit=$resume.exitCode;installedCommandExit=$versionExit;installedCommandVersion=$version.Trim()})

    # Seed a second active version to verify durable intent before pointer change.
    $pointerRoot=Join-Path $sandbox 'active-pointer-resume';$seed=Invoke-Captured 'Install' $pointerRoot '' 'pointer-seed-install' $baseManifest
    Assert ($seed.exitCode -eq 0) 'could not seed pointer test install'
    $post1Version=Get-PostVersion 5;$post1=Join-Path $sandbox ('project_state_python_candidate-'+$post1Version+'-py3-none-any.whl')
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $post1 $ProductVersion $post1Version
    Assert ($LASTEXITCODE -eq 0) 'could not create first synthetic second-version wheel'
    $post1Manifest=Write-Manifest $post1 $post1Version (Join-Path $sandbox 'manifest-post5.json')
    $kill=Kill-AtGate 'Upgrade' $pointerRoot $post1Manifest 'activate-intent' 'activate-intent'
    $before=(Get-Content -LiteralPath (Join-Path $pointerRoot 'state\active-version.txt') -Raw).Trim()
    Assert ($before -ceq $ProductVersion) 'active pointer moved before durable activate intent'
    $inspect=Invoke-Captured 'Inspect' $pointerRoot $kill.transactionId 'activate-intent-inspect';$inspectObj=$inspect.stdout|ConvertFrom-Json
    Assert ($inspect.exitCode -eq 0 -and $inspectObj.phase -ceq 'activate-intent' -and $inspectObj.activeVersion -ceq $ProductVersion) 'inspect failed to show pre-pointer activation boundary'
    $resume=Invoke-Captured 'Resume' $pointerRoot $kill.transactionId 'activate-intent-resume'
    $after=(Get-Content -LiteralPath (Join-Path $pointerRoot 'state\active-version.txt') -Raw).Trim()
    Assert ($resume.exitCode -eq 0 -and $after -ceq $post1Version) 'third process failed to apply journaled pointer change'
    $cases.Add([ordered]@{case='activation-intent-process-termination-before-pointer';status='PASS';killedPid=$kill.pid;activeBefore=$before;inspectPhase=$inspectObj.phase;resumeExit=$resume.exitCode;activeAfter=$after})

    # A separate second version reaches the post-pointer `active` phase before
    # commit; a new process must validate the actual pointer and complete.
    $post2Version=Get-PostVersion 6;$post2=Join-Path $sandbox ('project_state_python_candidate-'+$post2Version+'-py3-none-any.whl')
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $post2 $ProductVersion $post2Version
    Assert ($LASTEXITCODE -eq 0) 'could not create second synthetic second-version wheel'
    $post2Manifest=Write-Manifest $post2 $post2Version (Join-Path $sandbox 'manifest-post6.json')
    $kill=Kill-AtGate 'Upgrade' $pointerRoot $post2Manifest 'active' 'active-record'
    $activeAtKill=(Get-Content -LiteralPath (Join-Path $pointerRoot 'state\active-version.txt') -Raw).Trim()
    Assert ($activeAtKill -ceq $post2Version) 'active gate did not follow pointer publication'
    $inspect=Invoke-Captured 'Inspect' $pointerRoot $kill.transactionId 'active-record-inspect';$inspectObj=$inspect.stdout|ConvertFrom-Json
    Assert ($inspect.exitCode -eq 0 -and $inspectObj.phase -ceq 'active' -and $inspectObj.activeVersion -ceq $activeAtKill) 'inspect did not verify published pointer phase'
    $resume=Invoke-Captured 'Resume' $pointerRoot $kill.transactionId 'active-record-resume'
    $status=Invoke-Captured 'Status' $pointerRoot '' 'post-pointer-status'
    Assert ($resume.exitCode -eq 0 -and $resume.stdout -match 'completed' -and $status.exitCode -eq 0) 'post-pointer transaction did not finish and permit next operation'
    $cases.Add([ordered]@{case='pointer-published-before-commit-process-termination';status='PASS';killedPid=$kill.pid;activeAtKill=$activeAtKill;inspectPhase=$inspectObj.phase;resumeExit=$resume.exitCode;nextStatusExit=$status.exitCode})

    # First-root mkdir/marker gaps: an unowned directory is terminally
    # abandoned without deletion; a flushed marker bound to the journal resumes.
    $rootGap=Join-Path $sandbox 'root-stage-before-marker'
    $kill=Kill-AtGate 'Install' $rootGap $baseManifest 'root-stage-directory-created' 'root-stage-directory-created'
    $rootTx=Read-InstallerTransaction $rootGap $kill.transactionId;$orphanPath=[string]$rootTx.Latest.plan.rootStagePath
    Assert ((Test-Path -LiteralPath $orphanPath -PathType Container) -and -not(Test-Path -LiteralPath (Join-Path $orphanPath '.project-state-installer-root.json'))) 'root directory gate did not preserve the unowned markerless stage'
    $rootSentinel=Join-Path $orphanPath 'external-sentinel.bin';$rootSentinelBytes=[byte[]](0,13,10,255);[IO.File]::WriteAllBytes($rootSentinel,$rootSentinelBytes)
    $abandon=Invoke-Captured 'Resume' $rootGap $kill.transactionId 'root-stage-directory-created-resume';$abandoned=$abandon.stdout|ConvertFrom-Json
    Assert ($abandon.exitCode -eq 0 -and $abandoned.phase -ceq 'abandoned-preserved' -and $abandoned.abandonedStagePresent -and $abandoned.evidencePreserved -and (Test-Path -LiteralPath $orphanPath) -and -not(Test-Path (Join-Path $orphanPath '.project-state-installer-root.json')) -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($rootSentinel)) -ceq [Convert]::ToBase64String($rootSentinelBytes)) 'markerless root stage was not safely abandoned with external bytes retained'
    $fresh=Invoke-Captured 'Install' $rootGap '' 'root-stage-directory-created-fresh-install' $baseManifest
    Assert ($fresh.exitCode -eq 0 -and (Test-Path (Join-Path $rootGap 'state\install-receipt.json'))) 'abandoned markerless stage blocked a fresh installation'
    $cases.Add([ordered]@{case='first-root-directory-created-before-owner-marker';status='PASS';killed=$true;markerlessStagePreserved=$true;transactionPhase=$abandoned.phase;freshOperationExit=$fresh.exitCode})

    $rootBound=Join-Path $sandbox 'root-stage-after-marker'
    $kill=Kill-AtGate 'Install' $rootBound $baseManifest 'root-stage-marker-flushed' 'root-stage-marker-flushed'
    $boundTx=Read-InstallerTransaction $rootBound $kill.transactionId;$boundPath=[string]$boundTx.Latest.plan.rootStagePath
    Assert (Test-Path (Join-Path $boundPath '.project-state-installer-root.json')) 'root owner marker was not flushed before the barrier'
    $resumed=Invoke-Captured 'Resume' $rootBound $kill.transactionId 'root-stage-marker-flushed-resume'
    Assert ($resumed.exitCode -eq 0 -and $resumed.stdout -match 'completed' -and (Test-Path (Join-Path $rootBound 'state\install-receipt.json'))) 'journal did not resume after flushed root marker'
    $cases.Add([ordered]@{case='first-root-owner-marker-flushed-before-phase-append';status='PASS';killed=$true;markerIdentityBound=$true;resumeExit=$resumed.exitCode})

    # Version-stage directory and marker windows use the same actual process
    # gate, then a distinct resolver process resumes or safely abandons.
    $versionRoot=Join-Path $sandbox 'version-stage-recovery';$seed=Invoke-Captured 'Install' $versionRoot '' 'version-stage-seed-install' $baseManifest
    Assert ($seed.exitCode -eq 0) 'could not seed version-stage recovery installation'
    foreach($item in @(@{phase='version-stage-directory-created';version=(Get-PostVersion 7);expected='abandoned-preserved'},@{phase='version-stage-marker-flushed';version=(Get-PostVersion 8);expected='completed'})){
        $newWheel=Join-Path $sandbox ('project_state_python_candidate-'+$item.version+'-py3-none-any.whl')
        & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $newWheel $ProductVersion $item.version
        Assert ($LASTEXITCODE -eq 0) "could not create synthetic wheel $($item.version)"
        $newManifest=Write-Manifest $newWheel $item.version (Join-Path $sandbox ($item.version+'.manifest.json'))
        $kill=Kill-AtGate 'Upgrade' $versionRoot $newManifest $item.phase $item.phase
        $tx=Read-InstallerTransaction $versionRoot $kill.transactionId;$stagePath=[string]$tx.Latest.plan.stagePath
        $hasMarker=Test-Path -LiteralPath (Join-Path $stagePath '.project-state-installer-owner.json')
        Assert ($hasMarker -eq ($item.phase -ceq 'version-stage-marker-flushed')) "unexpected owner marker state at $($item.phase)"
        $externalStageSentinel=$null;$externalStageBytes=$null;$partialOwnerPath=$null;$partialOwnerBytes=$null
        if(-not $hasMarker){
            $externalStageSentinel=Join-Path $stagePath 'external-sentinel.bin';$externalStageBytes=[byte[]](0,13,10,255);[IO.File]::WriteAllBytes($externalStageSentinel,$externalStageBytes)
            if($item.phase -ceq 'version-stage-directory-created'){$partialOwnerPath=Join-Path $stagePath '.project-state-installer-owner.json';$partialOwnerBytes=[Text.UTF8Encoding]::new($false).GetBytes('{"schemaVersion":2,"transactionId":');[IO.File]::WriteAllBytes($partialOwnerPath,$partialOwnerBytes)}
        }
        $resume=Invoke-Captured 'Resume' $versionRoot $kill.transactionId ($item.phase+'-resume')
        $resumeValue=$resume.stdout|ConvertFrom-Json
        Assert ($resume.exitCode -eq 0 -and $resumeValue.phase -ceq $item.expected) "unexpected transaction phase after recovery at $($item.phase)"
        $retainedPath=if($item.expected -eq 'completed'){[string]$tx.Latest.plan.finalPath}else{$stagePath}
        Assert (Test-Path -LiteralPath $retainedPath -PathType Container) "owned stage evidence disappeared after recovery at $($item.phase)"
        if($externalStageSentinel){Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($externalStageSentinel)) -ceq [Convert]::ToBase64String($externalStageBytes) -and $resumeValue.phase -ceq 'abandoned-preserved' -and $resumeValue.evidencePreserved) 'external bytes in an unowned version stage were changed or not reported preserved'}
        if($partialOwnerPath){Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($partialOwnerPath)) -ceq [Convert]::ToBase64String($partialOwnerBytes)) 'partial owner marker was changed or removed during safe abandonment'}
        if($item.expected -eq 'completed'){$status=Invoke-Captured 'Status' $versionRoot '' ($item.phase+'-next-operation');Assert ($status.exitCode -eq 0) 'completed resumed version did not permit a subsequent operation'}
        $cases.Add([ordered]@{case=$item.phase;status='PASS';killed=$true;markerPresentAtKill=$hasMarker;syntheticPartialOwnerMarker=($null -ne $partialOwnerPath);resumePhase=$resumeValue.phase;retainedOwnedPath=$retainedPath})
    }

    # The move is a business publication. Kill after the atomic move and before
    # its journal append, then prove a second interrupted resolver and a third
    # resolver converge from the durable candidate proof.
    $publishRoot=Join-Path $sandbox 'publish-move-recovery';$seed=Invoke-Captured 'Install' $publishRoot '' 'publish-move-seed' $baseManifest
    Assert ($seed.exitCode -eq 0) 'could not seed publication recovery root'
    $publishVersion=Get-PostVersion 11;$publishWheel=Join-Path $sandbox ('project_state_python_candidate-'+$publishVersion+'-py3-none-any.whl')
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $publishWheel $ProductVersion $publishVersion
    Assert ($LASTEXITCODE -eq 0) 'could not create publication recovery fixture'
    $publishManifest=Write-Manifest $publishWheel $publishVersion (Join-Path $sandbox 'publish-recovery.manifest.json')
    $moveKill=Kill-AtGate 'Upgrade' $publishRoot $publishManifest 'version-published-before-journal' 'publish-after-move'
    $pending=Invoke-Captured 'Inspect' $publishRoot $moveKill.transactionId 'inspect-after-move'
    $pendingValue=$pending.stdout|ConvertFrom-Json
    $publishTx=Read-InstallerTransaction $publishRoot $moveKill.transactionId
    Assert ($pending.exitCode -eq 0 -and $pendingValue.phase -ceq 'publish-intent' -and $pendingValue.publicationOutcome -ceq 'PUBLISHED' -and $pendingValue.finalOwnerVerified -and -not $pendingValue.stagePresent) 'inspect did not classify the proven moved final as PUBLISHED'
    Assert ($pendingValue.activeVersion -ceq $ProductVersion) 'upgrade became active before publication recovery'
    $retryKill=Kill-AtGate 'Resume' $publishRoot $null 'version-published-before-journal' 'resume-after-move-second-interrupt' $moveKill.transactionId
    Assert ($retryKill.transactionId -ceq $moveKill.transactionId) 'second resolver did not bind to the original transaction'
    $stillPending=Invoke-Captured 'Inspect' $publishRoot $moveKill.transactionId 'inspect-after-second-interrupt'
    $stillValue=$stillPending.stdout|ConvertFrom-Json
    Assert ($stillPending.exitCode -eq 0 -and $stillValue.phase -ceq 'publish-intent' -and $stillValue.publicationOutcome -ceq 'PUBLISHED' -and (Test-Path -LiteralPath ([string]$publishTx.Latest.plan.finalPath))) 'repeated interruption changed journal or removed the verified final'
    $done=Invoke-Captured 'Resume' $publishRoot $moveKill.transactionId 'resume-after-move-third-process'
    $doneValue=$done.stdout|ConvertFrom-Json
    $newActive=Invoke-Captured 'Status' $publishRoot '' 'active-after-publish-resume'
    Assert ($done.exitCode -eq 0 -and $doneValue.phase -ceq 'completed' -and $newActive.exitCode -eq 0 -and $newActive.stdout -match [regex]::Escape($publishVersion)) 'third process did not finish and activate the published version'
    $cases.Add([ordered]@{case='move-succeeded-journal-not-appended-repeated-interruption';status='PASS';firstKillPid=$moveKill.pid;secondKillPid=$retryKill.pid;transactionId=$moveKill.transactionId;inspectOutcome=$pendingValue.publicationOutcome;oldActivePreservedBeforeResume=$true;finalVerified=$pendingValue.finalOwnerVerified;finalActiveAfterThirdProcess=$true})

    # A same-byte directory replacement and a conflicting stage/final pair are
    # uncertain. Neither can be adopted or deleted by Resume.
    foreach($conflict in @('substituted-final','stage-and-final')){
        $conflictRoot=Join-Path $sandbox ('publish-'+$conflict);$seed=Invoke-Captured 'Install' $conflictRoot '' ($conflict+'-seed') $baseManifest
        Assert ($seed.exitCode -eq 0) "could not seed $conflict root"
        $conflictVersion=if($conflict -eq 'substituted-final'){Get-PostVersion 12}else{Get-PostVersion 13}
        $conflictWheel=Join-Path $sandbox ('project_state_python_candidate-'+$conflictVersion+'-py3-none-any.whl')
        & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $conflictWheel $ProductVersion $conflictVersion
        Assert ($LASTEXITCODE -eq 0) "could not create $conflict fixture"
        $conflictManifest=Write-Manifest $conflictWheel $conflictVersion (Join-Path $sandbox ($conflict+'.manifest.json'))
        $killed=Kill-AtGate 'Upgrade' $conflictRoot $conflictManifest 'version-published-before-journal' ($conflict+'-gate')
        $conflictTx=Read-InstallerTransaction $conflictRoot $killed.transactionId;$stage=[string]$conflictTx.Latest.plan.stagePath;$final=[string]$conflictTx.Latest.plan.finalPath
        if($conflict -eq 'substituted-final'){
            $original=Join-Path $sandbox ($conflict+'-original-final');[IO.Directory]::Move($final,$original);Copy-Item -LiteralPath $original -Destination $final -Recurse
        }else{Copy-Item -LiteralPath $final -Destination $stage -Recurse}
        $inspect=Invoke-Captured 'Inspect' $conflictRoot $killed.transactionId ($conflict+'-inspect');$inspectValue=$inspect.stdout|ConvertFrom-Json
        $beforeDigest=(Read-InstallerTransaction $conflictRoot $killed.transactionId).Digest
        $refused=Invoke-Captured 'Resume' $conflictRoot $killed.transactionId ($conflict+'-resume-refusal')
        $after=Read-InstallerTransaction $conflictRoot $killed.transactionId
        Assert ($inspect.exitCode -eq 0 -and $inspectValue.publicationOutcome -ceq 'UNCERTAIN_STATE' -and $inspectValue.permittedActions -ceq 'none') "$conflict was not classified as uncertain with no permitted action"
        $expectedConflictState=if($conflict -eq 'stage-and-final'){(Test-Path -LiteralPath $stage) -and (Test-Path -LiteralPath $final)}else{(Test-Path -LiteralPath $final) -and (Test-Path -LiteralPath (Join-Path $sandbox ($conflict+'-original-final'))) -and -not(Test-Path -LiteralPath $stage)}
        Assert ($refused.exitCode -ne 0 -and $after.Digest -ceq $beforeDigest -and $expectedConflictState) "$conflict was modified or journal advanced"
        $cases.Add([ordered]@{case=$conflict;status='PASS';killed=$true;inspectOutcome=$inspectValue.publicationOutcome;resumeExit=$refused.exitCode;journalUnchanged=$true;stagePresent=(Test-Path -LiteralPath $stage);finalPresent=(Test-Path -LiteralPath $final)})
    }

    # Upgrade move denial preserves the prior active install. A held file
    # denies the atomic move; Rollback first records intent, then an interrupted
    # quarantine move is retried by a fresh process.
    $rollbackRoot=Join-Path $sandbox 'publish-upgrade-rollback';$seed=Invoke-Captured 'Install' $rollbackRoot '' 'rollback-seed' $baseManifest
    Assert ($seed.exitCode -eq 0) 'could not seed rollback root'
    $rollbackVersion=Get-PostVersion 14;$rollbackWheel=Join-Path $sandbox ('project_state_python_candidate-'+$rollbackVersion+'-py3-none-any.whl')
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $rollbackWheel $ProductVersion $rollbackVersion
    Assert ($LASTEXITCODE -eq 0) 'could not create rollback fixture'
    $rollbackManifest=Write-Manifest $rollbackWheel $rollbackVersion (Join-Path $sandbox 'rollback.manifest.json')
    $publishGate=Join-Path $evidence 'rollback-publish-gate';[IO.Directory]::CreateDirectory($publishGate)|Out-Null
    $upgrade=Start-Action 'Upgrade' $rollbackRoot $rollbackManifest '' 'publish-intent' $publishGate
    $ready=Wait-Gate $publishGate 'publish-intent' $upgrade
    $upgradeTxId=([IO.Path]::GetFileName($ready)-split '\.')[0];$upgradeTx=Read-InstallerTransaction $rollbackRoot $upgradeTxId;$upgradeStage=[string]$upgradeTx.Latest.plan.stagePath
    $blockPath=Join-Path $upgradeStage 'pyvenv.cfg';$blockHandle=[IO.File]::Open($blockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $release=Join-Path $publishGate ($upgradeTxId+'.publish-intent.release');[IO.File]::WriteAllText($release,'release',[Text.UTF8Encoding]::new($false))
    $upgradeFailed=Complete-Action $upgrade 'upgrade-publish-denied'
    $afterDenied=Invoke-Captured 'Inspect' $rollbackRoot $upgradeTxId 'inspect-upgrade-publish-denied';$deniedValue=$afterDenied.stdout|ConvertFrom-Json
    Assert ($upgradeFailed.exitCode -ne 0 -and $deniedValue.phase -ceq 'publish-intent' -and $deniedValue.publicationOutcome -ceq 'RECOVERABLE_FAILURE' -and $deniedValue.stageOwnerVerified -and -not $deniedValue.finalPresent -and $deniedValue.activeVersion -ceq $ProductVersion) 'move denial did not preserve a recoverable upgrade state and old active version'
    $failedRollback=Invoke-Captured 'Rollback' $rollbackRoot $upgradeTxId 'rollback-while-stage-busy'
    $failedRollbackInspect=Invoke-Captured 'Inspect' $rollbackRoot $upgradeTxId 'inspect-rollback-while-stage-busy';$failedRollbackValue=$failedRollbackInspect.stdout|ConvertFrom-Json
    Assert ($failedRollback.exitCode -ne 0 -and $failedRollbackValue.phase -ceq 'rollback-started' -and (Test-Path -LiteralPath $upgradeStage) -and -not(Test-Path -LiteralPath ([string]$upgradeTx.Latest.plan.finalPath))) 'busy rollback did not preserve its intent and stage'
    $blockHandle.Dispose()
    $rollbackKill=Kill-AtGate 'Rollback' $rollbackRoot $null 'rollback-stage-quarantined-before-journal' 'rollback-quarantine-interrupt' $upgradeTxId
    Assert ($rollbackKill.transactionId -ceq $upgradeTxId) 'rollback recovery gate bound to another transaction'
    $quarantine=Join-Path $rollbackRoot ('state\failed-install\'+$upgradeTxId)
    Assert ((Test-Path -LiteralPath $quarantine -PathType Container) -and -not(Test-Path -LiteralPath $upgradeStage)) 'rollback process was not terminated after the stage quarantine move'
    $rolled=Invoke-Captured 'Rollback' $rollbackRoot $upgradeTxId 'rollback-third-process'
    $rolledValue=$rolled.stdout|ConvertFrom-Json;$rollbackStatus=Invoke-Captured 'Status' $rollbackRoot '' 'rollback-old-active-status'
    Assert ($rolled.exitCode -eq 0 -and $rolledValue.phase -ceq 'rolled-back' -and $rollbackStatus.exitCode -eq 0 -and $rollbackStatus.stdout -match [regex]::Escape($ProductVersion) -and (Test-Path -LiteralPath $quarantine)) 'third process failed to complete rollback or prior active version changed'
    $cases.Add([ordered]@{case='upgrade-publish-denial-rollback-retry-and-interruption';status='PASS';upgradeExit=$upgradeFailed.exitCode;busyRollbackExit=$failedRollback.exitCode;rollbackInterruptedPid=$rollbackKill.pid;rollbackFinalExit=$rolled.exitCode;priorActivePreserved=$true;quarantinedStagePreserved=$true})

    # Hold a resolver at the post-move barrier; Resume, Rollback, and a new
    # Upgrade contender must lose the same root transaction lock without
    # changing the in-flight journal or the verified final.
    $raceRoot=Join-Path $sandbox 'publish-recovery-race';$seed=Invoke-Captured 'Install' $raceRoot '' 'race-seed' $baseManifest
    Assert ($seed.exitCode -eq 0) 'could not seed recovery race root'
    $raceVersion=Get-PostVersion 15;$raceWheel=Join-Path $sandbox ('project_state_python_candidate-'+$raceVersion+'-py3-none-any.whl')
    & $python (Join-Path $here 'make-versioned-wheel-fixture.py') $wheel $raceWheel $ProductVersion $raceVersion
    Assert ($LASTEXITCODE -eq 0) 'could not create recovery race fixture'
    $raceManifest=Write-Manifest $raceWheel $raceVersion (Join-Path $sandbox 'race.manifest.json')
    $raceKill=Kill-AtGate 'Upgrade' $raceRoot $raceManifest 'version-published-before-journal' 'race-initial-publish'
    $recoveryGate=Join-Path $evidence 'race-recovery-gate';[IO.Directory]::CreateDirectory($recoveryGate)|Out-Null
    $winner=Start-Action 'Resume' $raceRoot $null $raceKill.transactionId 'version-published-before-journal' $recoveryGate
    $winnerReady=Wait-Gate $recoveryGate 'version-published-before-journal' $winner
    $raceTxBefore=Read-InstallerTransaction $raceRoot $raceKill.transactionId;$raceDigestBefore=$raceTxBefore.Digest;$raceFinal=[string]$raceTxBefore.Latest.plan.finalPath
    $loserResume=Invoke-Captured 'Resume' $raceRoot $raceKill.transactionId 'race-loser-resume'
    $loserRollback=Invoke-Captured 'Rollback' $raceRoot $raceKill.transactionId 'race-loser-rollback'
    $loserInstall=Invoke-Captured 'Upgrade' $raceRoot '' 'race-loser-new-operation' $baseManifest
    $raceTxAfter=Read-InstallerTransaction $raceRoot $raceKill.transactionId
    Assert ($loserResume.exitCode -ne 0 -and $loserRollback.exitCode -ne 0 -and $loserInstall.exitCode -ne 0 -and $raceTxAfter.Digest -ceq $raceDigestBefore -and (Test-Path -LiteralPath $raceFinal)) 'a competing operation advanced journal or changed final while recovery held the lock'
    $winnerPid=$winner.Process.Id;$winner.Process.Kill($true);$winner.Process.WaitForExit();[void]$script:Children.Remove($winner)
    $script:Runs.Add([ordered]@{label='recovery-race-winner-terminated';action='Resume';exitCode=$winner.Process.ExitCode;pid=$winnerPid;phase='version-published-before-journal';termination='Process.Kill after deterministic barrier'})
    $raceDone=Invoke-Captured 'Resume' $raceRoot $raceKill.transactionId 'race-third-process-resume';$raceDoneValue=$raceDone.stdout|ConvertFrom-Json
    Assert ($raceDone.exitCode -eq 0 -and $raceDoneValue.phase -ceq 'completed') 'fresh process did not resume after the gated recovery owner exited'
    $cases.Add([ordered]@{case='resume-vs-resume-rollback-and-upgrade-contention';status='PASS';firstRecoveryPid=$winnerPid;resumeLoserExit=$loserResume.exitCode;rollbackLoserExit=$loserRollback.exitCode;newOperationExit=$loserInstall.exitCode;thirdResumeExit=$raceDone.exitCode;onlyOneJournalAdvancer=$true})

    $summary=[ordered]@{schemaVersion=1;runId=$RunId;installerVersion='0.3.5';productVersion=$ProductVersion;wheelSha256=$wheelHash;uvSha256=$uvHash;python=((& $python --version 2>&1)|Out-String).Trim();powershell=$PSVersionTable.PSVersion.ToString();cases=@($cases.ToArray());runs=@($script:Runs.ToArray());result='PASS'}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));Write-Output ($summary|ConvertTo-Json -Depth 10 -Compress)
} finally {
    foreach($child in @($script:Children.ToArray())){if(-not $child.Process.HasExited){try{$child.Process.Kill($true);$child.Process.WaitForExit()}catch{}}};$script:Children.Clear()
}
