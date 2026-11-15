param([string]$RunId='installer-refusal-boundaries-a01')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$installerDir=$PSScriptRoot
$workspace=(Resolve-Path (Join-Path $installerDir '..\..')).Path
$sandbox=Join-Path (Split-Path -Parent $workspace) ('.installer-refusal-'+$RunId)
$evidence=Join-Path $workspace ('evidence\'+$RunId)
if((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)){throw 'Refusing to reuse refusal-boundary test paths'}
[IO.Directory]::CreateDirectory($sandbox)|Out-Null
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$python=(Get-Command python.exe -ErrorAction Stop).Source
$installer=Join-Path $installerDir 'install-core-prototype.ps1'
$transactionModule=Join-Path $installerDir 'installer-transaction.psm1'
Import-Module -Name $transactionModule -Force
$uv=Join-Path $workspace 'artifacts\tools\uv-0.13.7-windows-x64.exe'
$sourceWheel=Join-Path $workspace 'artifacts\product\project_state_python_candidate-0.1.0a36-py3-none-any.whl'
$wheel=Join-Path $sandbox (Split-Path -Leaf $sourceWheel)
Copy-Item -LiteralPath $sourceWheel -Destination $wheel
$wheelHash=(Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant()
$uvHash=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash.ToLowerInvariant()
$uvVersion=(& $uv --version 2>&1|Out-String).Trim() -replace '^uv ([^ ]+).*$','$1'
$manifest=Join-Path $sandbox 'manifest.json'
$manifestObject=[ordered]@{schemaVersion=1;kind='local-sandbox-candidate';version='0.1.0a36';wheel=[ordered]@{file=(Split-Path -Leaf $wheel);sha256=$wheelHash;bytes=[long](Get-Item -LiteralPath $wheel).Length};uv=[ordered]@{version=$uvVersion;sha256=$uvHash}}
[IO.File]::WriteAllText($manifest,($manifestObject|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$results=[System.Collections.Generic.List[object]]::new()
function Invoke-Installer([string[]]$Arguments,[string]$LogName){
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.WorkingDirectory=$workspace;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',$installer)+$Arguments){[void]$psi.ArgumentList.Add([string]$arg)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;if(-not $process.Start()){throw 'Could not start installer process'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(180000)){try{$process.Kill($true)}catch{};throw 'Installer process timed out'}
    $process.WaitForExit();$record=[ordered]@{pid=$process.Id;exitCode=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult()}
    [IO.File]::WriteAllText((Join-Path $evidence $LogName),($record.stdout+$record.stderr),[Text.UTF8Encoding]::new($false))
    return [pscustomobject]$record
}
function Invoke-Install([string]$Root,[string]$Action='Install'){
    return Invoke-Installer @('-Action',$Action,'-InstallRoot',$Root,'-ManifestPath',$manifest,'-UvPath',$uv,'-PythonPath',$python) ($Action.ToLowerInvariant()+'-'+[IO.Path]::GetFileName($Root)+'.log')
}
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
try{
    # An unowned pre-existing root and its data must not be adopted or removed.
    $stranger=Join-Path $sandbox 'stranger-root';[IO.Directory]::CreateDirectory($stranger)|Out-Null
    $strangerSentinel=Join-Path $stranger 'user-owned.marker';$strangerBytes=[Text.Encoding]::UTF8.GetBytes('external synthetic data')
    [IO.File]::WriteAllBytes($strangerSentinel,$strangerBytes)
    $strangerAttempt=Invoke-Installer @('-Action','Uninstall','-InstallRoot',$stranger) 'unowned-root-uninstall.log'
    Assert ($strangerAttempt.exitCode -eq 2 -and $strangerAttempt.stderr -match 'EINSTALL_RECEIPT') 'unowned root was not refused with a receipt error'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($strangerSentinel)) -ceq [Convert]::ToBase64String($strangerBytes)) 'unowned root sentinel changed'
    Assert (-not(Test-Path -LiteralPath (Join-Path $stranger 'state\install-receipt.json'))) 'unowned root was adopted by creating an install receipt'
    $results.Add([ordered]@{case='unowned-root-uninstall-refusal-preserves-external-sentinel';status='PASS';exitCode=$strangerAttempt.exitCode;sentinelPreserved=$true;receiptNotCreated=$true})

    # A changed managed command must be preserved and block uninstall.
    $tamperedRoot=Join-Path $sandbox 'tampered-shim-root';$installed=Invoke-Install $tamperedRoot
    Assert ($installed.exitCode -eq 0) 'fixture install for shim-integrity refusal failed'
    $shim=Join-Path $tamperedRoot 'bin\project-state.cmd';$receipt=Join-Path $tamperedRoot 'state\install-receipt.json';$pointer=Join-Path $tamperedRoot 'state\active-version.txt'
    $shimBytes=[IO.File]::ReadAllBytes($shim);$receiptBytes=[IO.File]::ReadAllBytes($receipt);$pointerBytes=[IO.File]::ReadAllBytes($pointer)
    $tamperedBytes=[byte[]]($shimBytes+([Text.Encoding]::ASCII.GetBytes("`r`necho synthetic-external-change`r`n")))
    [IO.File]::WriteAllBytes($shim,$tamperedBytes)
    $attempt=Invoke-Installer @('-Action','Uninstall','-InstallRoot',$tamperedRoot) 'tampered-shim-uninstall.log'
    Assert ($attempt.exitCode -eq 2 -and $attempt.stderr -match 'EINSTALL_CONFLICT: command shim changed or is linked') 'modified managed shim did not block uninstall with the expected ownership diagnostic'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($shim)) -ceq [Convert]::ToBase64String($tamperedBytes)) 'modified shim was overwritten or removed'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($receipt)) -ceq [Convert]::ToBase64String($receiptBytes)) 'receipt changed after modified-shim refusal'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($pointer)) -ceq [Convert]::ToBase64String($pointerBytes)) 'active pointer changed after modified-shim refusal'
    Assert (Test-Path -LiteralPath (Join-Path $tamperedRoot 'versions\0.1.0a36') -PathType Container) 'owned version was removed after modified-shim refusal'
    $results.Add([ordered]@{case='modified-managed-shim-refusal-preserves-install-state';status='PASS';exitCode=$attempt.exitCode;shimPreserved=$true;receiptPreserved=$true;pointerPreserved=$true;versionPreserved=$true})

    # Replacing the install-root directory at the same path must not reuse the
    # moved root's receipt to authorize removal from a different directory.
    $replacementRoot=Join-Path $sandbox 'root';$replacementInstall=Invoke-Install $replacementRoot
    Assert ($replacementInstall.exitCode -eq 0) 'fixture install for root-identity replacement failed'
    $movedOriginal=Join-Path $sandbox 'moved-root';$oldOwner=Join-Path $replacementRoot '.project-state-installer-root.json';$oldReceipt=Join-Path $replacementRoot 'state\install-receipt.json'
    $ownerBytes=[IO.File]::ReadAllBytes($oldOwner);$receiptIdentityBytes=[IO.File]::ReadAllBytes($oldReceipt)
    [IO.Directory]::Move($replacementRoot,$movedOriginal)
    [IO.Directory]::CreateDirectory((Join-Path $replacementRoot 'state'))|Out-Null
    [IO.File]::WriteAllBytes((Join-Path $replacementRoot '.project-state-installer-root.json'),$ownerBytes)
    [IO.File]::WriteAllBytes((Join-Path $replacementRoot 'state\install-receipt.json'),$receiptIdentityBytes)
    $identityRefusal=Invoke-Installer @('-Action','Uninstall','-InstallRoot',$replacementRoot) 'replacement-root-uninstall.log'
    Assert ($identityRefusal.exitCode -eq 2 -and $identityRefusal.stderr -match 'EINSTALL_ROOT_IDENTITY') 'replacement install root was not rejected by directory identity'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $replacementRoot '.project-state-installer-root.json'))) -ceq [Convert]::ToBase64String($ownerBytes)) 'replacement root owner marker changed after refusal'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $replacementRoot 'state\install-receipt.json'))) -ceq [Convert]::ToBase64String($receiptIdentityBytes)) 'replacement root receipt changed after refusal'
    Assert (Test-Path -LiteralPath (Join-Path $movedOriginal 'versions\0.1.0a36') -PathType Container) 'original install root contents were not preserved after replacement refusal'
    $results.Add([ordered]@{case='replacement-install-root-identity-refusal-preserves-original';status='PASS';exitCode=$identityRefusal.exitCode;ownerAndReceiptPreserved=$true;movedOriginalVersionPreserved=$true})

    # A second uninstall after a completed uninstall must not invent ownership.
    $repeatRoot=Join-Path $sandbox 'repeat';$repeatInstall=Invoke-Install $repeatRoot
    Assert ($repeatInstall.exitCode -eq 0) 'fixture install for repeated-uninstall check failed'
    $external=Join-Path $sandbox 'external-user-data.marker';$externalBytes=[Text.Encoding]::UTF8.GetBytes('must survive uninstall')
    [IO.File]::WriteAllBytes($external,$externalBytes)
    $first=Invoke-Installer @('-Action','Uninstall','-InstallRoot',$repeatRoot) 'first-uninstall.log'
    Assert ($first.exitCode -eq 0 -and $first.stdout -match '"phase":"completed"') 'first uninstall did not commit and complete'
    $txnPaths=Get-InstallerTxnStore $repeatRoot
    $before=@(Get-ChildItem -LiteralPath $txnPaths.Transactions -Directory -Force).Count
    $second=Invoke-Installer @('-Action','Uninstall','-InstallRoot',$repeatRoot) 'repeated-uninstall.log'
    $after=@(Get-ChildItem -LiteralPath $txnPaths.Transactions -Directory -Force).Count
    Assert ($second.exitCode -eq 2 -and $second.stderr -match 'EINSTALL_RECEIPT') 'repeat uninstall did not fail closed without an owned receipt'
    Assert ($after -eq $before) 'repeat uninstall created a new transaction or changed completed transaction count'
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($external)) -ceq [Convert]::ToBase64String($externalBytes)) 'uninstall changed external user data'
    Assert (Test-Path -LiteralPath $repeatRoot -PathType Container) 'uninstall removed the user-selected install root'
    $results.Add([ordered]@{case='repeated-uninstall-refusal-is-nonmutating';status='PASS';firstExit=$first.exitCode;secondExit=$second.exitCode;transactionCountBefore=$before;transactionCountAfter=$after;externalSentinelPreserved=$true;installRootPreserved=$true})

    $summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=(Get-Date).ToUniversalTime().ToString('o');powershell=$PSVersionTable.PSVersion.ToString();python=((& $python --version 2>&1)|Out-String).Trim();uv=((& $uv --version 2>&1)|Out-String).Trim();wheelSha256=$wheelHash;cases=@($results.ToArray());totals=@{pass=$results.Count;fail=0;skip=0;cancelled=0;todo=0};result='PASS';endedAt=(Get-Date).ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $summary|ConvertTo-Json -Depth 10
}catch{
    $summary=[ordered]@{schemaVersion=1;runId=$RunId;startedAt=(Get-Date).ToUniversalTime().ToString('o');cases=@($results.ToArray());totals=@{pass=$results.Count;fail=1;skip=0;cancelled=0;todo=0};failure=$_.Exception.Message;result='FAIL';endedAt=(Get-Date).ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    throw
}
