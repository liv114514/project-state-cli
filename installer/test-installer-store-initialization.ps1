param([string]$RunId='store-init-s01')
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$here=$PSScriptRoot;$workspace=(Resolve-Path (Join-Path $here '..\..')).Path;$sandbox=Join-Path $workspace ('sandbox\'+$RunId);$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path $sandbox) -or (Test-Path $evidence)){throw 'Refusing to reuse store initialization evidence'}
[IO.Directory]::CreateDirectory($sandbox)|Out-Null;[IO.Directory]::CreateDirectory($evidence)|Out-Null
$module=Join-Path $here 'installer-transaction.psm1';Import-Module $module -Force
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source;$cases=[System.Collections.Generic.List[object]]::new()
function Assert([bool]$Ok,[string]$Message){if(-not $Ok){throw $Message}}
function SnapshotTree([string]$Root){if(-not(Test-Path $Root)){return @()};return @(Get-ChildItem $Root -Force -Recurse|ForEach-Object{[pscustomobject]@{relative=$_.FullName.Substring($Root.Length).TrimStart('\');directory=$_.PSIsContainer;length=if($_.PSIsContainer){0L}else{[long]$_.Length};sha256=if($_.PSIsContainer){$null}else{(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}}|Sort-Object relative)}
foreach($kind in @('empty','sentinel','missing-marker','partial-marker','wrong-root')){
    $root=Join-Path $sandbox ('unknown-'+$kind);[IO.Directory]::CreateDirectory($root)|Out-Null;$binding=Get-InstallerRootBinding $root;$store=Join-Path $binding.Parent ('.project-state-installer-'+$binding.RootHash);[IO.Directory]::CreateDirectory($store)|Out-Null
    if($kind -eq 'sentinel'){[IO.File]::WriteAllText((Join-Path $store 'sentinel.txt'),'synthetic sentinel',[Text.UTF8Encoding]::new($false))}
    if($kind -eq 'partial-marker'){[IO.File]::WriteAllText((Join-Path $store 'store-owner.json'),'{"schemaVersion":2',[Text.UTF8Encoding]::new($false))}
    if($kind -eq 'wrong-root'){$other=Get-InstallerRootBinding (Join-Path $sandbox 'different-root');$owner=[ordered]@{schemaVersion=1;protocol='project-state-installer';rootHash=$other.RootHash;root=$other.Root};[IO.File]::WriteAllText((Join-Path $store 'store-owner.json'),($owner|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
    $before=ConvertTo-Json -InputObject (SnapshotTree $store) -Depth 6 -Compress;$refused=$false
    try{[void](Get-InstallerTxnStore $root -Create)}catch{$refused=$true}
    $after=ConvertTo-Json -InputObject (SnapshotTree $store) -Depth 6 -Compress
    Assert ($refused -and $before -ceq $after) "unknown $kind store was mutated or adopted"
    $cases.Add([ordered]@{case='preexisting-markerless-or-invalid-store-'+$kind;status='PASS';treeUnchanged=$true;refused=$refused})
}
# Deterministic process termination while a unique initializer owns a private
# staging directory. The next process must create a different stage and publish
# a complete canonical store; the abandoned init evidence remains untouched.
foreach($phase in @('store-directory-created','store-owner-published')){
    $root=Join-Path $sandbox ('interrupted-'+$phase);$gate=Join-Path $evidence ('gate-'+$phase);[IO.Directory]::CreateDirectory($gate)|Out-Null
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',(Join-Path $here 'install-core-prototype.ps1'),'-Action','Status','-InstallRoot',$root,'-EnableTestHooks','-TestGateRoot',$gate,'-TestGatePhase',$phase)){[void]$psi.ArgumentList.Add($arg)}
    $proc=[Diagnostics.Process]::new();$proc.StartInfo=$psi;if(-not $proc.Start()){throw 'Could not start store initialization interruption process'};$out=$proc.StandardOutput.ReadToEndAsync();$err=$proc.StandardError.ReadToEndAsync()
    $deadline=[DateTime]::UtcNow.AddSeconds(30);$ready=$null;do{$ready=Get-ChildItem $gate -Filter ('store.'+$phase+'.ready') -File -ErrorAction SilentlyContinue|Select-Object -First 1;if($ready){break};if($proc.HasExited){break};Start-Sleep -Milliseconds 20}while([DateTime]::UtcNow -lt $deadline)
    Assert ($ready -and -not $proc.HasExited) "store process did not reach $phase barrier"
    $proc.Kill($true);$proc.WaitForExit();$pidValue=$proc.Id;$proc.Dispose()
    $binding=Get-InstallerRootBinding $root;$canonical=Join-Path $binding.Parent ('.project-state-installer-'+$binding.RootHash)
    Assert (-not(Test-Path $canonical)) "canonical store unexpectedly published at $phase"
    $orphans=@(Get-ChildItem -LiteralPath $binding.Parent -Directory -Filter ('.project-state-store-init-'+$binding.RootHash.Substring(0,16)+'-*'))
    Assert ($orphans.Count -eq 1) "expected exactly one preserved private initializer after $phase"
    $orphan=$orphans[0].FullName;$before=ConvertTo-Json -InputObject (SnapshotTree $orphan) -Depth 6 -Compress
    $created=Get-InstallerTxnStore $root -Create
    Assert ($created -and (Test-Path (Join-Path $created.Store 'store-owner.json')) -and (Test-Path (Join-Path $created.Transactions '.')) ) "third process did not publish complete store after $phase"
    Assert ((ConvertTo-Json -InputObject (SnapshotTree $orphan) -Depth 6 -Compress) -ceq $before) "retry modified the abandoned initializer from $phase"
    $cases.Add([ordered]@{case='initializer-process-kill-'+$phase;status='PASS';terminatedPid=$pidValue;orphanPreserved=$true;thirdProcessPublishedOwner=$true})
}
# Two simultaneous first users must converge on one valid canonical store.
$root=Join-Path $sandbox 'concurrent-first-use';$workers=@();$results=@()
for($i=0;$i -lt 2;$i++){$resultPath=Join-Path $evidence ('concurrent-'+$i+'.txt');$psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;foreach($arg in @('-NoProfile','-File',(Join-Path $here 'test-installer-store-init-worker.ps1'),$module,$root,$resultPath)){[void]$psi.ArgumentList.Add($arg)};$p=[Diagnostics.Process]::new();$p.StartInfo=$psi;if(-not $p.Start()){throw 'Could not start concurrent initializer'};$workers+=,$p;$results+=,$resultPath}
foreach($p in $workers){if(-not $p.WaitForExit(20000)){try{$p.Kill($true)}catch{};throw 'Concurrent initializer timed out'};$p.WaitForExit();Assert ($p.ExitCode -eq 0) 'a concurrent first-use initializer failed';$p.Dispose()}
foreach($f in $results){Assert ((Get-Content $f -Raw).StartsWith('PASS|')) 'concurrent initializer did not validate the winner'}
$binding=Get-InstallerRootBinding $root;$store=Join-Path $binding.Parent ('.project-state-installer-'+$binding.RootHash);$validated=Get-InstallerTxnStore $root;Assert ($validated -and (Test-Path (Join-Path $store 'store-owner.json')) -and (Test-Path (Join-Path $store 'transactions'))) 'canonical store failed final owner validation'
$cases.Add([ordered]@{case='concurrent-first-use-single-valid-canonical-store';status='PASS';twoProcesses=$true;canonicalOwnerValidated=$true})
$summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=[DateTimeOffset]::UtcNow.ToString('o');powershell=$PSVersionTable.PSVersion.ToString();cases=@($cases.ToArray());pass=$cases.Count;fail=0;skip=0;result='PASS'}
$summary.endedAt=[DateTimeOffset]::UtcNow.ToString('o');[IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));$summary|ConvertTo-Json -Depth 10
