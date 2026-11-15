param([string]$RunId='managed-entry-a01')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$here=$PSScriptRoot
$workspace=(Resolve-Path (Join-Path $here '..\..')).Path
$trialBase=Join-Path (Split-Path -Parent $workspace) '.i'
$sandboxName=($RunId -replace '^managed-entry-','')
$sandbox=Join-Path $trialBase $sandboxName
$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)){throw 'Refusing to reuse managed-entry paths'}
[IO.Directory]::CreateDirectory($trialBase)|Out-Null
[IO.Directory]::CreateDirectory($sandbox)|Out-Null
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$installShadowCwd=Join-Path $sandbox 'cwd-install-shadow';$installShadowPackage=Join-Path $installShadowCwd 'project_state';$fakePath=Join-Path $sandbox 'fake pythonpath';$fakeHome=Join-Path $sandbox 'invalid pythonhome';$fakeUser=Join-Path $sandbox 'fake userbase';$injectionMarker=Join-Path $sandbox 'install-import-injection.marker'
$python=(Get-Command python.exe -ErrorAction Stop).Source
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$git=(Get-Command git.exe -ErrorAction Stop).Source
$cmd=$env:ComSpec
$uv=Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'
$wheel=Get-ChildItem -LiteralPath (Join-Path $workspace 'artifacts\product') -Filter '*.whl'|Select-Object -First 1
if(-not $wheel){throw 'Pinned a36 wheel is missing'}
$wheelHash=(Get-FileHash -LiteralPath $wheel.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$wheelCopy=Join-Path $evidence $wheel.Name;Copy-Item -LiteralPath $wheel.FullName -Destination $wheelCopy
if((Get-FileHash -LiteralPath $wheelCopy -Algorithm SHA256).Hash.ToLowerInvariant() -cne $wheelHash){throw 'Evidence-local wheel copy does not match pinned a36 bytes'}
$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant()
$uvVersion=((& $uv --version 2>&1)|Out-String).Trim()
$manifest=Join-Path $evidence 'manifest.json'
$manifestValue=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version='0.1.0a36';wheel=[ordered]@{file=$wheel.Name;sha256=$wheelHash;bytes=[long]$wheel.Length};uv=[ordered]@{version=($uvVersion -replace '^uv ([^ ]+).*$','$1');sha256=$uvHash}}
[IO.File]::WriteAllText($manifest,($manifestValue|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$installPoisonCode="from pathlib import Path; Path(r'$injectionMarker').write_text('executed', encoding='utf-8'); __version__='shadow'"
[IO.Directory]::CreateDirectory($installShadowPackage)|Out-Null;[IO.Directory]::CreateDirectory($fakePath)|Out-Null;[IO.Directory]::CreateDirectory($fakeHome)|Out-Null;[IO.Directory]::CreateDirectory($fakeUser)|Out-Null
[IO.File]::WriteAllText((Join-Path $installShadowPackage '__init__.py'),$installPoisonCode,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $installShadowPackage 'cli.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('cli executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $installShadowCwd 'base64.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('base64 executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $installShadowCwd 'sitecustomize.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('sitecustomize executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
$fakePathModule=Join-Path $fakePath 'project_state';[IO.Directory]::CreateDirectory($fakePathModule)|Out-Null
[IO.File]::WriteAllText((Join-Path $fakePathModule '__init__.py'),$installPoisonCode,[Text.UTF8Encoding]::new($false))
$installRoot=Join-Path $sandbox 'managed install (试用)'
$installArgs=@('-NoProfile','-File',(Join-Path $here 'install-core-prototype.ps1'),'-Action','Install','-InstallRoot',$installRoot,'-ManifestPath',$manifest,'-UvPath',$uv,'-PythonPath',$python)
$installLog=Join-Path $evidence 'install.stdout-stderr.log'
$installStart=[Diagnostics.ProcessStartInfo]::new();$installStart.FileName=$pwsh;$installStart.WorkingDirectory=$installShadowCwd;$installStart.UseShellExecute=$false;$installStart.CreateNoWindow=$true;$installStart.RedirectStandardOutput=$true;$installStart.RedirectStandardError=$true
$installStart.Environment['PYTHONPATH']=$fakePath;$installStart.Environment['PYTHONHOME']=$fakeHome;$installStart.Environment['PYTHONUSERBASE']=$fakeUser;$installStart.Environment['PYTHONNOUSERSITE']='0'
foreach($arg in $installArgs){[void]$installStart.ArgumentList.Add([string]$arg)}
$installProcess=[Diagnostics.Process]::new();$installProcess.StartInfo=$installStart;if(-not $installProcess.Start()){throw 'Could not start exact a36 local install'}
$installStdout=$installProcess.StandardOutput.ReadToEndAsync();$installStderr=$installProcess.StandardError.ReadToEndAsync();if(-not $installProcess.WaitForExit(120000)){try{$installProcess.Kill($true)}catch{};throw 'Exact a36 local install timed out'};$installProcess.WaitForExit()
$installOut=$installStdout.GetAwaiter().GetResult();$installErr=$installStderr.GetAwaiter().GetResult();[IO.File]::WriteAllText($installLog,($installOut+$installErr),[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $evidence 'install.stderr.log'),$installErr,[Text.UTF8Encoding]::new($false))
if($installProcess.ExitCode -ne 0){throw 'Exact a36 local install failed; see retained install logs'}
if(Test-Path -LiteralPath $injectionMarker){throw 'A cwd or Python environment import sentinel executed during install validation/activation'}
$shim=Join-Path $installRoot 'bin\project-state.cmd'
if(-not(Test-Path -LiteralPath $shim -PathType Leaf)){throw 'Installed stable command shim is missing'}
$project=Join-Path $sandbox '业务 项目 (config demo)'
$stateHome=Join-Path $sandbox 's'
[IO.Directory]::CreateDirectory($project)|Out-Null
[IO.Directory]::CreateDirectory($stateHome)|Out-Null
$fakeModule=Join-Path $fakePath 'project_state'
$marker=$injectionMarker
$projectPoisonPackage=Join-Path $project 'project_state';[IO.Directory]::CreateDirectory($projectPoisonPackage)|Out-Null
[IO.File]::WriteAllText((Join-Path $projectPoisonPackage '__init__.py'),$installPoisonCode,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $projectPoisonPackage 'cli.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('project cli executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $project 'project_state.py'),$installPoisonCode,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $project 'base64.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('project base64 executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $project 'sitecustomize.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('project sitecustomize executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
$userSite=Join-Path $fakeUser 'Python312\site-packages';[IO.Directory]::CreateDirectory($userSite)|Out-Null
[IO.File]::WriteAllText((Join-Path $userSite 'sitecustomize.py'),"from pathlib import Path; Path(r'$injectionMarker').write_text('user site executed', encoding='utf-8')",[Text.UTF8Encoding]::new($false))
$gitLog=[System.Collections.Generic.List[object]]::new();$cliLog=[System.Collections.Generic.List[object]]::new()
function Run-Tool([string]$File,[string[]]$Arguments,[string]$WorkingDirectory,[string]$LogName){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$File;$psi.WorkingDirectory=$WorkingDirectory;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in $Arguments){[void]$psi.ArgumentList.Add([string]$arg)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;if(-not $process.Start()){throw "Could not start $File"}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(120000)){try{$process.Kill($true)}catch{};throw "Timed out: $File"};$process.WaitForExit()
    $result=[pscustomobject]@{file=$File;arguments=@($Arguments);cwd=$WorkingDirectory;pid=$process.Id;exitCode=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult()}
    if($LogName){[IO.File]::WriteAllText((Join-Path $evidence $LogName),($result.stdout+$result.stderr),[Text.UTF8Encoding]::new($false))}
    return $result
}
function Invoke-Shim([string[]]$CliArguments,[string]$LogName){
    $prior=$ErrorActionPreference;$ErrorActionPreference='Continue'
    $oldLocation=(Get-Location).Path
    try{Set-Location -LiteralPath $project;$output=@(& $shim @CliArguments 2>&1);$exitCode=$LASTEXITCODE}finally{Set-Location -LiteralPath $oldLocation;$ErrorActionPreference=$prior}
    $stdout=($output|ForEach-Object{[string]$_}) -join "`n"
    $result=[pscustomobject]@{file=$shim;arguments=@($CliArguments);cwd=$project;harnessPid=$PID;processPidObserved=$false;exitCode=$exitCode;stdout=$stdout;stderr=''}
    if($LogName){[IO.File]::WriteAllText((Join-Path $evidence $LogName),$stdout,[Text.UTF8Encoding]::new($false))}
    $cliLog.Add([ordered]@{shim=$shim;arguments=@($CliArguments);cwd=$project;harnessPid=$PID;processPidObserved=$false;exitCode=$result.exitCode;stdout=$result.stdout;stderr=$result.stderr})
    return $result
}
$variables=@('LOCALAPPDATA','PYTHONPATH','PYTHONHOME','PYTHONUSERBASE','PYTHONNOUSERSITE','PYTHONUTF8','PYTHONDONTWRITEBYTECODE')
$envBefore=@{};$envPresent=@{};$envBlock=[Environment]::GetEnvironmentVariables('Process')
foreach($name in $variables){$envPresent[$name]=$envBlock.Contains($name);$envBefore[$name]=if($envPresent[$name]){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null}}
$gitBefore=$null;$indexBefore=$null;$configA=[Text.UTF8Encoding]::new($false).GetBytes("PORT=4100`nTOKEN=synthetic-config-A`n");$configB=[Text.UTF8Encoding]::new($false).GetBytes("PORT=4101`nTOKEN=synthetic-config-B`n")
$summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=(Get-Date).ToUniversalTime().ToString('o');cwd=(Get-Location).Path;python=((& $python --version 2>&1)|Out-String).Trim();git=((& $git --version 2>&1)|Out-String).Trim();uv=$uvVersion;wheelSha256=$wheelHash;installPid=$installProcess.Id;shim=$shim;cases=@();result='FAIL'}
try{
    foreach($name in $variables){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}
    $env:LOCALAPPDATA=$stateHome;$env:PYTHONPATH=$fakePath;$env:PYTHONHOME=$fakeHome;$env:PYTHONUSERBASE=$fakeUser;$env:PYTHONNOUSERSITE='0';$env:PYTHONUTF8='0';$env:PYTHONDONTWRITEBYTECODE='0'
    $version=Invoke-Shim @('--version') 'shim-version.log'
    if($version.exitCode -ne 0 -or $version.stdout.Trim() -cne '0.1.0a36'){throw 'Installed shim --version did not resolve the pinned candidate'}
    $help=Invoke-Shim @('help') 'shim-help.log';if($help.exitCode -ne 0 -or $help.stdout -notmatch 'snapshot <name>'){throw 'Installed shim help failed'}
    $cmdLine='chcp 65001>nul & call "'+$shim+'" --version';$prior=$ErrorActionPreference;$ErrorActionPreference='Continue'
    try{$cmdOutput=@(& $cmd /d /s /c $cmdLine 2>&1);$cmdExit=$LASTEXITCODE}finally{$ErrorActionPreference=$prior}
    $cmdVersion=($cmdOutput|ForEach-Object{[string]$_}) -join "`n";[IO.File]::WriteAllText((Join-Path $evidence 'cmd-utf8-version.log'),$cmdVersion,[Text.UTF8Encoding]::new($false))
    if($cmdExit -ne 0 -or $cmdVersion.Trim() -cne '0.1.0a36'){throw 'CMD UTF-8 code-page invocation of the installed shim failed'}
    if(Test-Path -LiteralPath $marker){throw 'Synthetic PYTHONPATH module unexpectedly executed'}
    $moduleOnlyCwd=Join-Path $sandbox 'cwd-module-shadow';[IO.Directory]::CreateDirectory($moduleOnlyCwd)|Out-Null
    [IO.File]::WriteAllText((Join-Path $moduleOnlyCwd 'project_state.py'),$installPoisonCode,[Text.UTF8Encoding]::new($false))
    $projectBeforeModuleOnly=$project;$project=$moduleOnlyCwd
    try{$moduleOnly=Invoke-Shim @('--version') 'shim-module-shadow.log'}finally{$project=$projectBeforeModuleOnly}
    if($moduleOnly.exitCode -ne 0 -or $moduleOnly.stdout.Trim() -cne '0.1.0a36' -or (Test-Path -LiteralPath $marker)){throw 'Installed .cmd entry imported a cwd project_state.py module'}
    $summary.cases+=@([ordered]@{case='installed-shim-isolates-cwd-package-module-stdlib-and-python-environment';status='PASS';versionExit=$version.exitCode;helpExit=$help.exitCode;cmdUtf8CodePageExit=$cmdExit;moduleOnlyCwdExit=$moduleOnly.exitCode;fakePythonPathSupplied=$true;invalidPythonHomeSupplied=$true;userBaseSupplied=$true;cwdPackageAndCliPresent=$true;cwdProjectStatePyPresent=$true;cwdBase64AndSitecustomizePresent=$true;injectionMarkerAbsent=$true;unicodePathInPowerShellAndCmd=$true})

    Set-Content -LiteralPath (Join-Path $project '.gitignore') -Value @('.env','*.sqlite','*.sqlite-wal','*.sqlite-shm') -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $project 'README.md') -Value 'synthetic project baseline' -Encoding utf8NoBOM
    $init=Run-Tool $git @('init','-q') $project $null;if($init.exitCode -ne 0){throw 'git init failed'}
    [void](Run-Tool $git @('config','user.name','Synthetic Installer Test') $project $null)
    [void](Run-Tool $git @('config','user.email','synthetic@example.invalid') $project $null)
    [void](Run-Tool $git @('add','.gitignore','README.md','project_state','project_state.py','base64.py','sitecustomize.py') $project $null)
    $commit=Run-Tool $git @('commit','-m','synthetic baseline') $project $null;if($commit.exitCode -ne 0){throw 'synthetic Git baseline commit failed'}
    $headBefore=(& $git -C $project rev-parse HEAD).Trim();$indexPath=Join-Path $project '.git\index';$indexBefore=(Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash
    [IO.File]::WriteAllBytes((Join-Path $project '.env'),$configA)
    $snapA=Invoke-Shim @('snapshot','config-a') 'snapshot-config-a.log';if($snapA.exitCode -ne 0){throw 'snapshot A failed'}
    [IO.File]::WriteAllBytes((Join-Path $project '.env'),$configB)
    $compare=Invoke-Shim @('compare','config-a') 'compare-config-a.log';if($compare.exitCode -ne 0 -or $compare.stdout -notmatch 'config'){throw 'configuration comparison did not report the changed config layer'}
    if($compare.stdout.Contains('synthetic-config-A') -or $compare.stdout.Contains('synthetic-config-B')){throw 'compare output leaked a synthetic private config value'}
    $preview=Invoke-Shim @('restore','config-a','--only','config','--json') 'restore-config-preview.json';if($preview.exitCode -ne 0){throw 'configuration restore preview failed'}
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $project '.env'))) -cne [Convert]::ToBase64String($configB)){throw 'dry-run changed configuration bytes'}
    $applied=Invoke-Shim @('restore','config-a','--only','config','--yes') 'restore-config-apply.log';if($applied.exitCode -ne 0){throw 'configuration restore A failed'}
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $project '.env'))) -cne [Convert]::ToBase64String($configA)){throw 'configuration restore did not produce exact A bytes'}
    $operationId=[regex]::Match($applied.stdout,'Operation: ([a-f0-9]{32})').Groups[1].Value;if($operationId.Length -ne 32){throw 'restore output did not provide an operation ID'}
    $rollback=Invoke-Shim @('recover',$operationId,'--rollback','--yes') 'restore-config-rollback.log';if($rollback.exitCode -ne 0){throw 'configuration rollback B failed'}
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $project '.env'))) -cne [Convert]::ToBase64String($configB)){throw 'configuration rollback did not restore exact B bytes'}
    $gitAfter=& $git -C $project status --porcelain
    if($gitAfter -or (& $git -C $project rev-parse HEAD).Trim() -cne $headBefore -or (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash -cne $indexBefore){throw 'config restore/rollback changed Git HEAD, index, or tracked worktree'}
    $summary.cases+=@([ordered]@{case='installed-entry-config-A-B-A-B-preview-restore-and-rollback';status='PASS';snapshotExit=$snapA.exitCode;compareExit=$compare.exitCode;previewExit=$preview.exitCode;applyExit=$applied.exitCode;rollbackExit=$rollback.exitCode;restoreOperationId=$operationId;headUnchanged=$true;indexSha256Unchanged=$true;worktreeClean=$true;configValuesRedacted=$true})

    $database=Join-Path $project 'app.sqlite';$dbHelper=Join-Path $here 'run-installed-wal-snapshot.py'
    $wal=Run-Tool $python @('-E','-s',$dbHelper,$pwsh,$database,$shim,$project,$stateHome,$fakePath,$fakeHome,$fakeUser) $project 'wal-snapshot-writer.json'
    if($wal.exitCode -ne 0){throw 'open-WAL writer failed during installed-shim seed snapshot'}
    $walResult=$wal.stdout|ConvertFrom-Json
    if($walResult.snapshotExit -ne 0 -or -not $walResult.walPresentBeforeSnapshot -or -not $walResult.writerStillReadCommittedRow){throw 'WAL snapshot evidence is incomplete'}
    $preservedDatabase=Join-Path $sandbox 'source-database-preserved.sqlite';Move-Item -LiteralPath $database -Destination $preservedDatabase
    foreach($sidecar in @($database+'-wal',$database+'-shm')){if(Test-Path -LiteralPath $sidecar){Move-Item -LiteralPath $sidecar -Destination (Join-Path $sandbox (Split-Path -Leaf $sidecar))}}
    $dbPreview=Invoke-Shim @('restore','sqlite-a','--only','database','--target','app.sqlite','--json') 'restore-database-preview.json';if($dbPreview.exitCode -ne 0){throw 'database restore preview failed'}
    $dbApply=Invoke-Shim @('restore','sqlite-a','--only','database','--target','app.sqlite','--yes') 'restore-database-apply.log';if($dbApply.exitCode -ne 0){throw 'SQLite database restore failed'}
    $verify=Run-Tool $python @('-E','-s',$dbHelper,'verify-only',$database) $project 'database-verify.json'
    # Verify-only mode is supported by the helper below; a nonzero result means
    # the exact restored rows, schema, BLOB and integrity check did not match.
    if($verify.exitCode -ne 0){throw 'restored SQLite data or integrity check failed'}
    $dbOperationId=[regex]::Match($dbApply.stdout,'Operation: ([a-f0-9]{32})').Groups[1].Value;if($dbOperationId.Length -ne 32){throw 'database restore output did not provide an operation ID'}
    $dbRollback=Invoke-Shim @('recover',$dbOperationId,'--rollback','--yes') 'restore-database-rollback.log';if($dbRollback.exitCode -ne 0 -or (Test-Path -LiteralPath $database)){throw 'database rollback did not restore the previously missing target'}
    $foreign=[Text.Encoding]::ASCII.GetBytes('synthetic external database');[IO.File]::WriteAllBytes($database,$foreign)
    $refusal=Invoke-Shim @('restore','sqlite-a','--only','database','--target','app.sqlite','--yes') 'restore-existing-database-refusal.log'
    if($refusal.exitCode -eq 0 -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($database)) -cne [Convert]::ToBase64String($foreign)){throw 'existing synthetic database was not preserved by refusal'}
    $summary.cases+=@([ordered]@{case='installed-entry-open-wal-private-seed-missing-target-restore-and-rollback';status='PASS';walJournalMode=$walResult.journalMode;walPresentWhileWriterOpen=$walResult.walPresentBeforeSnapshot;seedSnapshotExit=$walResult.snapshotExit;previewExit=$dbPreview.exitCode;restoreExit=$dbApply.exitCode;rollbackExit=$dbRollback.exitCode;existingTargetRefusalExit=$refusal.exitCode;restoredRowsSchemaBlobAndIntegrity=$true;originalDatabasePreservedOutsideProject=$true})

    $summary.result='PASS';$summary.endedAt=(Get-Date).ToUniversalTime().ToString('o');$summary.cases=@($summary.cases)
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));$summary|ConvertTo-Json -Depth 10
}catch{
    $summary.error=$_.Exception.Message;$summary.endedAt=(Get-Date).ToUniversalTime().ToString('o');[IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));throw
}finally{
    foreach($name in $variables){if($envPresent[$name]){[Environment]::SetEnvironmentVariable($name,[string]$envBefore[$name],'Process')}else{Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}}
}
