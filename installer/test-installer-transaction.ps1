param([string]$RunId='installer-tx-a01')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$installerDir=$PSScriptRoot
$module=Join-Path $installerDir 'installer-transaction.psm1'
$worker=Join-Path $installerDir 'transaction-worker.ps1'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$run=Join-Path $workspace ('sandbox\'+$RunId)
$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path -LiteralPath $run) -or (Test-Path -LiteralPath $evidence)){throw 'Refusing to reuse transaction test paths'}
[IO.Directory]::CreateDirectory($run)|Out-Null
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$results=[System.Collections.Generic.List[object]]::new()
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Start-Worker([string[]]$Extra){
    $args=@('-NoProfile','-File',('"'+$worker+'"'),'-ModulePath',('"'+$module+'"'))+$Extra
    return Start-Process -FilePath $pwsh -ArgumentList $args -PassThru -WindowStyle Hidden
}
function New-Root {
    $parent=Join-Path $run ('parent-'+[guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($parent)|Out-Null
    return Join-Path $parent 'managed-install'
}
Import-Module -Name $module -Force

# Stable byte-empty FileShare.None lock blocks another process and is never aged out.
$root=New-Root
$lock=Enter-InstallerFileLock $root
$ready=Join-Path $run ('busy-'+[guid]::NewGuid().ToString('N')+'.ready')
$child=Start-Worker @('-InstallRoot',('"'+$root+'"'),'-ReadyFile',('"'+$ready+'"'),'-CompeteOnly')
$child.WaitForExit(15000)|Out-Null
$busyText=if(Test-Path -LiteralPath $ready){Get-Content -Raw $ready}else{''}
Assert ($child.ExitCode -eq 2) 'competing process did not fail closed'
Assert ($busyText -notmatch 'LOCKED') 'competing process entered lock section'
Exit-InstallerFileLock $lock
$results.Add([ordered]@{case='cross-process-lock';status='PASS';childExit=$child.ExitCode;lockSentinelRetained=(Test-Path -LiteralPath (Get-InstallerTxnStore $root).Lock)})

# Create a transaction, kill a real child after its durable phase record, and read it in a third process.
$root=New-Root
$lock=Enter-InstallerFileLock $root
$tx=New-InstallerTransaction $root Install ([guid]::NewGuid().ToString('N')) ([guid]::NewGuid().ToString('N')) ([ordered]@{version='0.1.0a36';artifactSha256=('a'*64);rootExisted=$true}) ''
Exit-InstallerFileLock $lock
$ready=Join-Path $run ('ready-'+[guid]::NewGuid().ToString('N')+'.txt')
$release=Join-Path $run ('release-'+[guid]::NewGuid().ToString('N')+'.txt')
$child=Start-Worker @('-InstallRoot',('"'+$root+'"'),'-TransactionId',('"'+$tx.Id+'"'),'-Phase','root-create-intent','-ReadyFile',('"'+$ready+'"'),'-ReleaseFile',('"'+$release+'"'))
$deadline=[DateTime]::UtcNow.AddSeconds(15)
while(-not(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 25}
Assert (Test-Path -LiteralPath $ready) 'child did not publish deterministic post-journal barrier'
Assert ($child -and -not $child.HasExited) 'child did not remain alive at barrier'
Stop-Process -Id $child.Id -Force
$child.WaitForExit()
$newLock=Enter-InstallerFileLock $root
$read=Read-InstallerTransaction $root $tx.Id
Assert ($read.Latest.phase -ceq 'root-create-intent') 'third process did not observe the last committed phase'
$tx2=Resume-InstallerTransaction $root $tx.Id
$tx2=Set-InstallerTransactionPhase $tx2 'root-created' ([ordered]@{root='not-created-in-this-protocol-test'}) ''
$check=Read-InstallerTransaction $root $tx.Id
Assert ($check.Latest.phase -ceq 'root-created') 'third-process continuation failed'
Exit-InstallerFileLock $newLock
$results.Add([ordered]@{case='terminated-child-after-durable-intent';status='PASS';killedPid=$child.Id;observedPhase=$read.Latest.phase;continuedPhase=$check.Latest.phase})

# Corrupt chain is rejected and the evidence remains in place.
$badId=[guid]::NewGuid().ToString('N')
$lock=Enter-InstallerFileLock $root
$bad=New-InstallerTransaction $root Install ([guid]::NewGuid().ToString('N')) ([guid]::NewGuid().ToString('N')) ([ordered]@{version='0.1.0';artifactSha256=('b'*64)}) ''
Exit-InstallerFileLock $lock
$record=Join-Path $bad.Directory '00000001.json'
$raw=[IO.File]::ReadAllText($record)
[IO.File]::WriteAllText($record,$raw.Replace('"version":"0.1.0"','"version":"0.1.1"'),[Text.UTF8Encoding]::new($false))
$rejected=$false
try{[void](Read-InstallerTransaction $root $bad.Id)}catch{$rejected=$_.Exception.Message -match 'EINSTALL_JOURNAL_INVALID'}
Assert $rejected 'self-inconsistent journal was not rejected'
Assert (Test-Path -LiteralPath $record) 'rejected journal evidence was removed'
$results.Add([ordered]@{case='tampered-transaction-plan';status='PASS';evidencePreserved=$true})

# Incomplete append temp is rejected and retained; only a complete chain-linked
# append can be promoted by Resume-InstallerTransaction.
$incompleteRoot=New-Root
$lock=Enter-InstallerFileLock $incompleteRoot
$incomplete=New-InstallerTransaction $incompleteRoot Activate ([guid]::NewGuid().ToString('N')) ([guid]::NewGuid().ToString('N')) ([ordered]@{version='0.1.0a36';previousPointerSha256=$null}) ''
$temp=Join-Path $incomplete.Directory ('.00000002-'+[guid]::NewGuid().ToString('N')+'.tmp')
[IO.File]::WriteAllText($temp,'{"schemaVersion":1', [Text.UTF8Encoding]::new($false))
$reject=$false
try{[void](Resume-InstallerTransaction $incompleteRoot $incomplete.Id)}catch{$reject=$_.Exception.Message -match 'EINSTALL_JOURNAL_INVALID'}
Assert $reject 'incomplete append temp was not refused'
Assert (Test-Path -LiteralPath $temp) 'incomplete append evidence was removed'
Exit-InstallerFileLock $lock
$results.Add([ordered]@{case='incomplete-temporary-journal-rejected-and-preserved';status='PASS';evidencePreserved=$true})

# Unknown transaction entries are not adopted or removed as cleanup.
$unknownRoot=New-Root
$lock=Enter-InstallerFileLock $unknownRoot
$known=New-InstallerTransaction $unknownRoot Install ([guid]::NewGuid().ToString('N')) ([guid]::NewGuid().ToString('N')) ([ordered]@{version='0.1.0a36';artifactSha256=('c'*64);rootExisted=$true}) ''
Exit-InstallerFileLock $lock
$unknownPath=Join-Path (Get-InstallerTxnStore $unknownRoot).Transactions 'unrecognized-evidence'
[IO.Directory]::CreateDirectory($unknownPath)|Out-Null
$unknownRejected=$false
try{[void](Get-InstallerTransactions $unknownRoot)}catch{$unknownRejected=$_.Exception.Message -match 'EINSTALL_JOURNAL_INVALID'}
Assert $unknownRejected 'unknown transaction entry was not rejected'
Assert (Test-Path -LiteralPath $unknownPath -PathType Container) 'unknown transaction evidence was removed'
$results.Add([ordered]@{case='unknown-transaction-entry-rejected-and-preserved';status='PASS';evidencePreserved=$true})

$summary=[ordered]@{schemaVersion=1;runId=[guid]::NewGuid().ToString('N');startedAt=(Get-Date).ToUniversalTime().ToString('o');shell=$PSVersionTable.PSVersion.ToString();cases=@($results);totals=@{pass=$results.Count;fail=0;skip=0};result='PASS'}
$summary.endedAt=(Get-Date).ToUniversalTime().ToString('o')
$dest=Join-Path $evidence 'results.json'
[IO.File]::WriteAllText($dest,(ConvertTo-Json -InputObject $summary -Depth 12),[Text.UTF8Encoding]::new($false))
$summary|ConvertTo-Json -Depth 12
