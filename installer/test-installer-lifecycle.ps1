param(
    [string]$RunId = 'lifecycle-a01',
    [string]$WheelPath = '',
    [string]$ProductVersion = '0.1.0a36',
    [string]$UvPath = '',
    [string]$PythonPath = ''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$here=$PSScriptRoot
$workspace=(Resolve-Path (Join-Path $here '..\..')).Path
$sandbox=Join-Path (Split-Path -Parent $workspace) ('.installer-lifecycle-'+$RunId)
$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)){throw 'Refusing to reuse lifecycle test paths'}
[IO.Directory]::CreateDirectory($sandbox)|Out-Null
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$pythonShadowCwd=Join-Path $sandbox 'python-shadow-cwd';$pythonShadowPackage=Join-Path $pythonShadowCwd 'project_state';$pythonShadowPath=Join-Path $sandbox 'python-shadow-path';$pythonShadowHome=Join-Path $sandbox 'invalid-pythonhome';$pythonShadowUser=Join-Path $sandbox 'python-shadow-user';$pythonInjectionMarker=Join-Path $sandbox 'python-import-injection.marker'
[IO.Directory]::CreateDirectory($pythonShadowPackage)|Out-Null;[IO.Directory]::CreateDirectory((Join-Path $pythonShadowPath 'project_state'))|Out-Null;[IO.Directory]::CreateDirectory($pythonShadowHome)|Out-Null;[IO.Directory]::CreateDirectory($pythonShadowUser)|Out-Null
$poison="from pathlib import Path; Path(r'$pythonInjectionMarker').write_text('executed', encoding='utf-8'); __version__='shadow'"
[IO.File]::WriteAllText((Join-Path $pythonShadowPackage '__init__.py'),$poison,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $pythonShadowPackage 'cli.py'),$poison,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $pythonShadowCwd 'base64.py'),$poison,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $pythonShadowCwd 'sitecustomize.py'),$poison,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $pythonShadowPath 'project_state\__init__.py'),$poison,[Text.UTF8Encoding]::new($false))
$installer=Join-Path $here 'install-core-prototype.ps1'
$module=Join-Path $here 'installer-transaction.psm1'
Import-Module -Name $module -Force
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$python=if($PythonPath){(Get-Item -LiteralPath $PythonPath -ErrorAction Stop).FullName}else{(Get-Command python.exe -ErrorAction Stop).Source}
$uv=if($UvPath){(Get-Item -LiteralPath $UvPath -ErrorAction Stop).FullName}else{Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'}
$sourceWheel=if($WheelPath){Get-Item -LiteralPath $WheelPath -ErrorAction Stop}else{Get-ChildItem -LiteralPath (Join-Path $workspace 'artifacts\product') -Filter '*.whl'|Select-Object -First 1}
if(-not $sourceWheel){throw 'Pinned product wheel is missing'}
$localWheel=Join-Path $sandbox $sourceWheel.Name
Copy-Item -LiteralPath $sourceWheel.FullName -Destination $localWheel
$wheel=Get-Item -LiteralPath $localWheel -ErrorAction Stop
$baseVersion=$ProductVersion
$failedVersion="$baseVersion.post2"
$fixtureVersion="$baseVersion.post1"
$wheelHash=(Get-FileHash -LiteralPath $wheel.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant()
$uvVersion=(& $uv --version 2>&1|Out-String).Trim() -replace '^uv ([^ ]+).*$','$1'
$manifest=Join-Path $sandbox ('manifest-'+$RunId+'.json')
$manifestObject=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$baseVersion;wheel=[ordered]@{file=$wheel.Name;sha256=$wheelHash;bytes=[long]$wheel.Length};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
[IO.File]::WriteAllText($manifest,($manifestObject|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$results=[System.Collections.Generic.List[object]]::new()
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Start-Installer([string[]]$InstallerArgs,[string]$GatePhase,[string]$GateRoot){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$pythonShadowCwd;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    $psi.Environment['PYTHONPATH']=$pythonShadowPath;$psi.Environment['PYTHONHOME']=$pythonShadowHome;$psi.Environment['PYTHONUSERBASE']=$pythonShadowUser;$psi.Environment['PYTHONNOUSERSITE']='0'
    foreach($a in @('-NoProfile','-File',$installer)+$InstallerArgs){[void]$psi.ArgumentList.Add([string]$a)}
    if($GatePhase){foreach($x in @('-EnableTestHooks','-TestGateRoot',$GateRoot,'-TestGatePhase',$GatePhase)){[void]$psi.ArgumentList.Add($x)}}
    $p=[Diagnostics.Process]::new();$p.StartInfo=$psi;if(-not $p.Start()){throw 'Could not start installer child'}
    return [pscustomobject]@{Process=$p;Stdout=$p.StandardOutput.ReadToEndAsync();Stderr=$p.StandardError.ReadToEndAsync()}
}
function Wait-Child($Child,[int]$TimeoutSeconds=180){if(-not $Child.Process.WaitForExit($TimeoutSeconds*1000)){try{$Child.Process.Kill($true)}catch{};throw 'Installer child timed out'};$Child.Process.WaitForExit();return [pscustomobject]@{exitCode=$Child.Process.ExitCode;stdout=$Child.Stdout.GetAwaiter().GetResult();stderr=$Child.Stderr.GetAwaiter().GetResult();pid=$Child.Process.Id}}
function Wait-Gate([string]$Directory,[string]$Suffix,$Child){$path=Join-Path $Directory ('*.'+$Suffix+'.ready');$deadline=[DateTime]::UtcNow.AddSeconds(90);do{$ready=@(Get-ChildItem -LiteralPath $Directory -Filter ('*.'+$Suffix+'.ready') -ErrorAction SilentlyContinue|Select-Object -First 1);if($ready.Count){break};if($Child.Process.HasExited){$r=Wait-Child $Child 5;throw ('child exited before barrier: '+$r.stderr)};Start-Sleep -Milliseconds 25}while([DateTime]::UtcNow -lt $deadline);if(-not $ready.Count){throw 'Timed out waiting for deterministic installer barrier'};if($Child.Process.HasExited){throw 'Installer exited at or before barrier observation'};return $ready[0]}
function Invoke-Action([string]$Action,[string]$Root,[string]$Id,[string]$LogName,[string]$TargetVersion){
    $args=@('-Action',$Action,'-InstallRoot',$Root)
    if($Id){$args+=@('-TransactionId',$Id)}
    if($Action -in @('Install','Upgrade')){$args+=@('-ManifestPath',$script:manifest,'-UvPath',$script:uv,'-PythonPath',$script:python)}
    if($TargetVersion){$args+=@('-Version',$TargetVersion)}
    $child=Start-Installer $args '' '';$r=Wait-Child $child
    [IO.File]::WriteAllText((Join-Path $evidence $LogName),($r.stdout+$r.stderr),[Text.UTF8Encoding]::new($false))
    return $r
}

try{
    # Kill after a transaction-owned staged root directory and owner marker are
    # durable, but before its receipt exists; a third process must finish it.
    $rootCrash=Join-Path $sandbox '试用 安装根'
    $gate=Join-Path $evidence 'gate-first-root';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $child=Start-Installer @('-Action','Install','-InstallRoot',$rootCrash,'-ManifestPath',$manifest,'-UvPath',$uv,'-PythonPath',$python) 'root-stage-owned' $gate
    $ready=Wait-Gate $gate 'root-stage-owned' $child;$rootTx=$ready.Name.Split('.')[0]
    $rootStore=Get-InstallerTxnStore $rootCrash;$rootRecord=Read-InstallerTransaction $rootCrash $rootTx;$rootStage=[string]$rootRecord.Latest.plan.rootStagePath
    Assert (-not(Test-Path -LiteralPath $rootCrash) -and (Test-Path -LiteralPath (Join-Path $rootStage '.project-state-installer-root.json')) -and -not(Test-Path -LiteralPath (Join-Path $rootStage 'state\install-receipt.json'))) 'root-stage barrier did not capture owner marker before receipt publication'
    $rootPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    $rootResume=Invoke-Action 'Resume' $rootCrash $rootTx 'first-root-resume.log'
    Assert ($rootResume.exitCode -eq 0 -and $rootResume.stdout -match '"phase":"completed"') 'third-process first-root installation resume failed'
    $rootVersion=& (Join-Path $rootCrash 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $rootVersion.Trim() -ceq $baseVersion) 'resumed first-root command failed'
    $results.Add([ordered]@{case='first-root-directory-and-owner-before-receipt-interruption-and-third-process-resume';status='PASS';killedPid=$rootPid;phase=$rootRecord.Latest.phase;rootWasAbsentAtKill=$true;resumeExit=$rootResume.exitCode;version=$rootVersion.Trim()})

    # Hold one first-root installer inside its ownership protocol and prove a
    # second process cannot create a competing transaction at the same root.
    $concurrentRoot=Join-Path $sandbox 'same-root concurrent install'
    $concurrentGate=Join-Path $evidence 'gate-same-root-concurrency';[IO.Directory]::CreateDirectory($concurrentGate)|Out-Null
    $ownerChild=Start-Installer @('-Action','Install','-InstallRoot',$concurrentRoot,'-ManifestPath',$manifest,'-UvPath',$uv,'-PythonPath',$python) 'root-stage-owned' $concurrentGate
    $ownerReady=Wait-Gate $concurrentGate 'root-stage-owned' $ownerChild;$ownerTx=$ownerReady.Name.Split('.')[0]
    $contender=Invoke-Action 'Install' $concurrentRoot '' 'same-root-contender.log' ''
    $contenderRefused=$contender.exitCode -eq 2 -and (Get-Content -LiteralPath (Join-Path $evidence 'same-root-contender.log') -Raw) -match 'EINSTALL_BUSY'
    $ownerHeldAtDecision=-not $ownerChild.Process.HasExited
    [IO.File]::WriteAllText((Join-Path $concurrentGate ($ownerTx+'.root-stage-owned.release')),'continue',[Text.UTF8Encoding]::new($false))
    $ownerResult=Wait-Child $ownerChild
    [IO.File]::WriteAllText((Join-Path $evidence 'same-root-owner.log'),($ownerResult.stdout+$ownerResult.stderr),[Text.UTF8Encoding]::new($false))
    Assert $contenderRefused 'same-root concurrent installer was not refused by the active lock owner'
    Assert $ownerHeldAtDecision 'first installer exited before the same-root contender was checked'
    Assert ($ownerResult.exitCode -eq 0) 'locked first-root owner did not finish after contender refusal'
    $concurrentTransactions=@(Get-InstallerTransactions $concurrentRoot)
    Assert ($concurrentTransactions.Count -eq 1 -and $concurrentTransactions[0].Latest.phase -ceq 'completed') 'same-root contention produced competing or unfinished installer transactions'
    $concurrentVersion=& (Join-Path $concurrentRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $concurrentVersion.Trim() -ceq $baseVersion) 'same-root contender damaged the winning installed command'
    $results.Add([ordered]@{case='same-root-install-owner-excludes-second-process';status='PASS';ownerPid=$ownerChild.Process.Id;contenderPid=$contender.pid;contenderExit=$contender.exitCode;ownerExit=$ownerResult.exitCode;transactionCount=$concurrentTransactions.Count;commandVersion=$concurrentVersion.Trim()})

    # Kill after the staged receipt is durable but before the directory move.
    $rootReceiptCrash=Join-Path $sandbox '试用 安装根 receipt'
    $gate=Join-Path $evidence 'gate-root-receipt';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $child=Start-Installer @('-Action','Install','-InstallRoot',$rootReceiptCrash,'-ManifestPath',$manifest,'-UvPath',$uv,'-PythonPath',$python) 'root-receipt-published' $gate
    $ready=Wait-Gate $gate 'root-receipt-published' $child;$rootReceiptTx=$ready.Name.Split('.')[0]
    $rootReceiptRecord=Read-InstallerTransaction $rootReceiptCrash $rootReceiptTx;$rootReceiptStage=[string]$rootReceiptRecord.Latest.plan.rootStagePath
    $stagedReceipt=Join-Path $rootReceiptStage 'state\install-receipt.json'
    Assert (-not(Test-Path -LiteralPath $rootReceiptCrash) -and (Test-Path -LiteralPath $stagedReceipt -PathType Leaf) -and (Get-FileHash -LiteralPath $stagedReceipt -Algorithm SHA256).Hash.ToLowerInvariant() -ceq [string]$rootReceiptRecord.Latest.observed.receiptSha256) 'receipt boundary did not preserve the staged receipt before root publication'
    $rootReceiptPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    $rootReceiptResume=Invoke-Action 'Resume' $rootReceiptCrash $rootReceiptTx 'root-receipt-resume.log'
    Assert ($rootReceiptResume.exitCode -eq 0 -and $rootReceiptResume.stdout -match '"phase":"completed"') 'third process did not resume staged-receipt publication'
    $rootReceiptVersion=& (Join-Path $rootReceiptCrash 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $rootReceiptVersion.Trim() -ceq $baseVersion) 'command failed after staged receipt publication recovery'
    $results.Add([ordered]@{case='staged-receipt-before-root-move-interruption-and-third-process-resume';status='PASS';killedPid=$rootReceiptPid;phase=$rootReceiptRecord.Latest.phase;liveRootWasAbsentAtKill=$true;resumeExit=$rootReceiptResume.exitCode;version=$rootReceiptVersion.Trim()})

    # Install: terminate a real child after wheel installation and before publication.
    $installRoot=Join-Path $sandbox 'install-resume'
    $gate=Join-Path $evidence 'gate-install';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $child=Start-Installer @('-Action','Install','-InstallRoot',$installRoot,'-ManifestPath',$manifest,'-UvPath',$uv,'-PythonPath',$python) 'wheel-installed' $gate
    $ready=Wait-Gate $gate 'wheel-installed' $child
    $transactionId=$ready.Name.Split('.')[0]
    $killedPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    Assert ($child.Process.HasExited) 'install child was not terminated'
    $inspect=Invoke-Action 'Inspect' $installRoot $transactionId 'install-inspect.log'
    Assert ($inspect.exitCode -eq 0 -and $inspect.stdout -match 'wheel-installed') 'third-process inspect did not observe wheel-installed state'
    $resume=Invoke-Action 'Resume' $installRoot $transactionId 'install-resume.log'
    Assert ($resume.exitCode -eq 0 -and $resume.stdout -match '"phase":"completed"') 'third-process install resume did not complete'
    $version=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $version.Trim() -ceq $baseVersion) 'installed command failed version check after resume'
    $results.Add([ordered]@{case='install-process-termination-and-third-process-resume';status='PASS';killedPid=$killedPid;phase=$ready.Name.Split('.')[1];inspectExit=$inspect.exitCode;resumeExit=$resume.exitCode;commandVersion=$version.Trim();wheelSha256=$wheelHash})

    # A candidate that installs but fails module verification must leave the old
    # active command usable. Its owned stage is quarantined by a journaled,
    # resumable pre-commit rollback; no old version files are rewritten.
    $failedWheel=Join-Path $sandbox "project_state_python_candidate-$failedVersion-py3-none-any.whl"
    & $python (Join-Path $here 'make-failing-wheel-fixture.py') $wheel.FullName $failedWheel $baseVersion $failedVersion
    Assert ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $failedWheel -PathType Leaf)) 'could not create synthetic candidate verification failure'
    $failedHash=(Get-FileHash -LiteralPath $failedWheel -Algorithm SHA256).Hash.ToLowerInvariant()
    $failedManifest=Join-Path $sandbox 'manifest-failed-candidate.json'
    $failedManifestValue=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$failedVersion;wheel=[ordered]@{file=(Split-Path -Leaf $failedWheel);sha256=$failedHash;bytes=[long](Get-Item $failedWheel).Length};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
    [IO.File]::WriteAllText($failedManifest,($failedManifestValue|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    $script:manifest=$failedManifest
    $failedUpgrade=Invoke-Action 'Upgrade' $installRoot '' 'failed-upgrade.log' ''
    Assert ($failedUpgrade.exitCode -eq 2 -and (Get-Content -LiteralPath (Join-Path $evidence 'failed-upgrade.log') -Raw) -match 'EINSTALL_VERIFY') 'unimportable candidate was not rejected at module verification'
    $failedLog=Get-Content -LiteralPath (Join-Path $evidence 'failed-upgrade.log') -Raw
    $failedId=[regex]::Match($failedLog,'EINSTALL_TRANSACTION_ID: ([a-f0-9]{32})').Groups[1].Value
    Assert ($failedId.Length -eq 32) 'failed upgrade did not retain a diagnostic transaction id'
    $oldCommand=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $oldCommand.Trim() -ceq $baseVersion) 'old active command stopped working after failed upgrade'
    $rollbackGate=Join-Path $evidence 'gate-failed-upgrade-rollback';[IO.Directory]::CreateDirectory($rollbackGate)|Out-Null
    $child=Start-Installer @('-Action','Rollback','-InstallRoot',$installRoot,'-TransactionId',$failedId) 'rollback-started' $rollbackGate
    $rollbackReady=Wait-Gate $rollbackGate 'rollback-started' $child
    $failedRollbackPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    $failedRollback=Invoke-Action 'Resume' $installRoot $failedId 'failed-upgrade-rollback-resume.log'
    Assert ($failedRollback.exitCode -eq 0 -and $failedRollback.stdout -match 'rolled-back') 'third process did not finish failed-upgrade quarantine rollback'
    $oldCommand=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $oldCommand.Trim() -ceq $baseVersion) 'old command failed after failed-upgrade rollback'
    $failedTx=Read-InstallerTransaction $installRoot $failedId
    $failedQuarantine=[string]$failedTx.Latest.observed.quarantinePath
    Assert ((Test-Path -LiteralPath $failedQuarantine -PathType Container) -and -not(Test-Path -LiteralPath $failedTx.Latest.plan.stagePath)) 'failed upgrade stage was not identity-preserved in quarantine'
    $results.Add([ordered]@{case='failed-upgrade-preserves-old-command-and-interrupted-quarantine-rollback';status='PASS';failedUpgradeExit=$failedUpgrade.exitCode;rollbackKilledPid=$failedRollbackPid;rollbackResumeExit=$failedRollback.exitCode;oldVersionAfter=$oldCommand.Trim();quarantineRetained=$true;failedWheelSha256=$failedHash})
    $script:manifest=$manifest

    # A metadata-only disposable second-version wheel exercises upgrade, explicit
    # activation, and the user-facing version rollback without altering a36 bytes.
    $fixtureWheel=Join-Path $sandbox "project_state_python_candidate-$fixtureVersion-py3-none-any.whl"
    $maker=Join-Path $here 'make-versioned-wheel-fixture.py'
    & $python $maker $wheel.FullName $fixtureWheel $baseVersion $fixtureVersion
    Assert ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $fixtureWheel -PathType Leaf)) 'could not build isolated version-label wheel fixture'
    $script:manifest=Join-Path $sandbox 'manifest-post1.json'
    $fixtureHash=(Get-FileHash -LiteralPath $fixtureWheel -Algorithm SHA256).Hash.ToLowerInvariant()
    $fixtureManifest=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version=$fixtureVersion;wheel=[ordered]@{file=(Split-Path -Leaf $fixtureWheel);sha256=$fixtureHash;bytes=[long](Get-Item $fixtureWheel).Length};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
    [IO.File]::WriteAllText($script:manifest,($fixtureManifest|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    $upgrade=Invoke-Action 'Upgrade' $installRoot '' 'upgrade.log' ''
    Assert ($upgrade.exitCode -eq 0) 'synthetic second-version upgrade failed'
    $version=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $version.Trim() -ceq $fixtureVersion) 'upgraded command did not use synthetic second version'

    $gate=Join-Path $evidence 'gate-version-rollback';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $child=Start-Installer @('-Action','Rollback','-InstallRoot',$installRoot) 'active' $gate
    $ready=Wait-Gate $gate 'active' $child;$rollbackId=$ready.Name.Split('.')[0]
    $rollbackPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    $rollbackResume=Invoke-Action 'Resume' $installRoot $rollbackId 'version-rollback-resume.log' ''
    Assert ($rollbackResume.exitCode -eq 0 -and $rollbackResume.stdout -match '"phase":"completed"') 'rollback continuation did not commit after process termination'
    $version=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $version.Trim() -ceq $baseVersion) 'journaled rollback did not return to previous version'
    $activate=Invoke-Action 'Activate' $installRoot '' 'activate.log' $fixtureVersion
    Assert ($activate.exitCode -eq 0) 'journaled explicit activation failed'
    $version=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $version.Trim() -ceq $fixtureVersion) 'explicit activation did not select the requested version'
    $results.Add([ordered]@{case='upgrade-rollback-process-resume-and-activate';status='PASS';killedPid=$rollbackPid;upgradeExit=$upgrade.exitCode;rollbackResumeExit=$rollbackResume.exitCode;activateExit=$activate.exitCode;activeVersion=$version.Trim();syntheticWheelSha256=$fixtureHash})

    # Uninstall interruption after the shim has been retired, followed by rollback.
    $gate=Join-Path $evidence 'gate-uninstall-rollback';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $child=Start-Installer @('-Action','Uninstall','-InstallRoot',$installRoot) 'retired-0000' $gate
    $ready=Wait-Gate $gate 'retired-0000' $child;$uninstallId=$ready.Name.Split('.')[0]
    $uninstallPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    $inspect=Invoke-Action 'Inspect' $installRoot $uninstallId 'uninstall-inspect.log'
    Assert ($inspect.exitCode -eq 0 -and $inspect.stdout -match 'retired-0000') 'inspect did not expose the interrupted uninstall phase'
    $rollbackGate=Join-Path $evidence 'gate-uninstall-rollback';[IO.Directory]::CreateDirectory($rollbackGate)|Out-Null
    $rollbackChild=Start-Installer @('-Action','Rollback','-InstallRoot',$installRoot,'-TransactionId',$uninstallId) 'rollback-started' $rollbackGate
    $rollbackReady=Wait-Gate $rollbackGate 'rollback-started' $rollbackChild
    $rollbackPid=$rollbackChild.Process.Id;$rollbackChild.Process.Kill($true);$rollbackChild.Process.WaitForExit()
    $rollback=Invoke-Action 'Resume' $installRoot $uninstallId 'uninstall-rollback.log'
    Assert ($rollback.exitCode -eq 0 -and $rollback.stdout -match 'rolled-back') 'third-process rollback continuation did not restore the retired shim'
    Assert (Test-Path -LiteralPath (Join-Path $installRoot 'bin\project-state.cmd') -PathType Leaf) 'rollback failed to restore shim path'
    $version=& (Join-Path $installRoot 'bin\project-state.cmd') --version 2>&1|Out-String
    Assert ($LASTEXITCODE -eq 0 -and $version.Trim() -ceq $fixtureVersion) 'command failed after uninstall rollback'
    $results.Add([ordered]@{case='uninstall-interruption-rollback-interruption-and-third-process-resume';status='PASS';killedPids=@($uninstallPid,$rollbackPid);inspectExit=$inspect.exitCode;rollbackResumeExit=$rollback.exitCode;commandVersion=$version.Trim();rootPreserved=(Test-Path $installRoot)})

    # Repeat uninstall and resume it in a third process; product bytes are not rebuilt.
    $gate=Join-Path $evidence 'gate-uninstall-resume';[IO.Directory]::CreateDirectory($gate)|Out-Null
    $child=Start-Installer @('-Action','Uninstall','-InstallRoot',$installRoot) 'cleanup-pending' $gate
    $ready=Wait-Gate $gate 'cleanup-pending' $child;$uninstallId=$ready.Name.Split('.')[0]
    $uninstallPid=$child.Process.Id;$child.Process.Kill($true);$child.Process.WaitForExit()
    $inspect=Invoke-Action 'Inspect' $installRoot $uninstallId 'uninstall-cleanup-inspect.log'
    Assert ($inspect.exitCode -eq 0 -and $inspect.stdout -match 'cleanup-pending') 'post-commit inspect did not report cleanup-pending'
    $forbiddenRollback=Invoke-Action 'Rollback' $installRoot $uninstallId 'uninstall-post-commit-rollback.log'
    Assert ($forbiddenRollback.exitCode -eq 2 -and $forbiddenRollback.stderr -match 'EINSTALL_ROLLBACK_REFUSED') 'committed uninstall incorrectly allowed rollback'
    $resume=Invoke-Action 'Resume' $installRoot $uninstallId 'uninstall-resume.log'
    Assert ($resume.exitCode -eq 0 -and $resume.stdout -match '"phase":"completed"') 'third-process uninstall resume did not complete'
    Assert ((Test-Path -LiteralPath $installRoot -PathType Container) -and -not(Test-Path -LiteralPath (Join-Path $installRoot 'bin\project-state.cmd')) -and -not(Test-Path -LiteralPath (Join-Path $installRoot 'state\install-receipt.json'))) 'uninstall final state did not match committed result'
    $resultObject=Invoke-Action 'Inspect' $installRoot $uninstallId 'uninstall-final-inspect.log'
    Assert ($resultObject.exitCode -eq 0 -and $resultObject.stdout -match '"phase":"completed"') 'completed uninstall journal could not be independently inspected'
    $results.Add([ordered]@{case='uninstall-commit-cleanup-interruption-and-third-process-resume';status='PASS';killedPid=$uninstallPid;inspectExit=$inspect.exitCode;rollbackRefusalExit=$forbiddenRollback.exitCode;resumeExit=$resume.exitCode;finalInspectExit=$resultObject.exitCode;rootPreserved=$true;receiptAbsent=$true;commandAbsent=$true})

    # A committed cleanup-intent transaction may only advertise Resume; the
    # rollback action is forbidden after the durable commit point.
    $cleanupRoot=Join-Path $sandbox 'cleanup-action-list-root'
    $script:manifest=$manifest
    $cleanupInstall=Invoke-Action 'Install' $cleanupRoot '' 'cleanup-action-list-install.log' ''
    Assert ($cleanupInstall.exitCode -eq 0) 'cleanup action-list fixture install failed'
    $cleanupGate=Join-Path $evidence 'gate-cleanup-action-list';[IO.Directory]::CreateDirectory($cleanupGate)|Out-Null
    $cleanupChild=Start-Installer @('-Action','Uninstall','-InstallRoot',$cleanupRoot) 'cleanup-intent-0000' $cleanupGate
    $cleanupReady=Wait-Gate $cleanupGate 'cleanup-intent-0000' $cleanupChild;$cleanupId=$cleanupReady.Name.Split('.')[0]
    $cleanupPid=$cleanupChild.Process.Id;$cleanupChild.Process.Kill($true);$cleanupChild.Process.WaitForExit()
    $cleanupInspect=Invoke-Action 'Inspect' $cleanupRoot $cleanupId 'cleanup-action-list-inspect.log'
    $cleanupState=$cleanupInspect.stdout|ConvertFrom-Json
    Assert ($cleanupInspect.exitCode -eq 0 -and $cleanupState.phase -ceq 'cleanup-intent-0000' -and $cleanupState.permittedActions -contains 'Resume' -and $cleanupState.permittedActions -notcontains 'Rollback') 'committed cleanup inspect advertised an unavailable rollback action'
    $cleanupJournalDigest=[string]$cleanupState.lastRecordDigest
    $quarantinePath=Join-Path $cleanupRoot 'state\retired'
    $quarantineBefore=@(Get-ChildItem -LiteralPath $quarantinePath -File -Recurse|ForEach-Object{($_.FullName.Substring($cleanupRoot.Length))+':'+(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})
    $cleanupRollback=Invoke-Action 'Rollback' $cleanupRoot $cleanupId 'cleanup-action-list-rollback.log' ''
    $cleanupInspectAfter=Invoke-Action 'Inspect' $cleanupRoot $cleanupId 'cleanup-action-list-after-rollback.log' ''
    $cleanupStateAfter=$cleanupInspectAfter.stdout|ConvertFrom-Json
    $quarantineAfter=@(Get-ChildItem -LiteralPath $quarantinePath -File -Recurse|ForEach-Object{($_.FullName.Substring($cleanupRoot.Length))+':'+(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})
    Assert ($cleanupRollback.exitCode -eq 2 -and $cleanupRollback.stderr -match 'EINSTALL_ROLLBACK_REFUSED') 'rollback after committed cleanup was not refused'
    Assert ($cleanupStateAfter.lastRecordDigest -ceq $cleanupJournalDigest -and ($quarantineBefore -join "`n") -ceq ($quarantineAfter -join "`n")) 'refused rollback changed the committed journal or quarantine objects'
    $cleanupResume=Invoke-Action 'Resume' $cleanupRoot $cleanupId 'cleanup-action-list-resume.log' ''
    Assert ($cleanupResume.exitCode -eq 0 -and $cleanupResume.stdout -match '"phase":"completed"') 'committed cleanup did not resume after rollback refusal'
    $results.Add([ordered]@{case='committed-cleanup-inspect-advertises-resume-only-and-resumes';status='PASS';killedPid=$cleanupPid;phase=$cleanupState.phase;permittedActions=@($cleanupState.permittedActions);rollbackExit=$cleanupRollback.exitCode;journalUnchanged=$true;quarantineUnchangedAfterRefusal=$true;resumeExit=$cleanupResume.exitCode})

    # A completed append record is recoverable; a partial/invalid temp remains blocked.
    Import-Module -Name $module -Force
    $journalRoot=Join-Path $sandbox 'journal-temp-root';[IO.Directory]::CreateDirectory((Split-Path -Parent $journalRoot))|Out-Null
    $lock=Enter-InstallerFileLock $journalRoot
    $tx=New-InstallerTransaction $journalRoot Activate 'install-one' 'owner-token' ([ordered]@{version=$baseVersion;previousPointerSha256=$null}) ''
    try{[void](Set-InstallerTransactionPhase $tx 'activate-intent' ([ordered]@{to=$baseVersion}) 'journal-temp-flushed')}catch{if($_.Exception.Message -notmatch 'EINSTALL_TEST_STOP'){throw}}
    $read=Read-InstallerTransaction $journalRoot $tx.Id -AllowCompleteTemporary
    Assert ([bool]$read.PendingTemporary) 'durable append temp was not identified'
    $continued=Resume-InstallerTransaction $journalRoot $tx.Id
    Assert ($continued.Latest.phase -ceq 'activate-intent') 'complete journal temp was not promoted by resume'
    Exit-InstallerFileLock $lock
    $results.Add([ordered]@{case='complete-temporary-journal-promotion';status='PASS';phase=$continued.Latest.phase})

    Assert (-not(Test-Path -LiteralPath $pythonInjectionMarker)) 'a Python cwd/environment import sentinel executed during lifecycle, Resume, rollback, or activation'
    $results.Add([ordered]@{case='python-import-isolation-across-lifecycle-resume-rollback';status='PASS';cwdPackageAndCliPresent=$true;fakePythonPath=$true;invalidPythonHome=$true;userSiteMarkerPresent=$true;injectionMarkerAbsent=$true})
    $summary=[ordered]@{schemaVersion=1;runId=$RunId;candidateVersion=$baseVersion;installerVersion='0.3.4';startedAt=(Get-Date).ToUniversalTime().ToString('o');powershell=$PSVersionTable.PSVersion.ToString();python=((& $python --version 2>&1)|Out-String).Trim();uv=((& $uv --version 2>&1)|Out-String).Trim();wheelSha256=$wheelHash;cases=@($results);totals=@{pass=$results.Count;fail=0;skip=0};result='PASS';endedAt=(Get-Date).ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $summary|ConvertTo-Json -Depth 12
}catch{
    [Console]::Error.WriteLine($_.Exception.ToString())
    $summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=(Get-Date).ToUniversalTime().ToString('o');cases=@($results);totals=@{pass=$results.Count;fail=1;skip=0};failure=$_.Exception.Message;result='FAIL';endedAt=(Get-Date).ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    throw
}
