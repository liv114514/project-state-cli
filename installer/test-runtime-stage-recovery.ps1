[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$WorkRoot,
    [Parameter(Mandatory=$true)][string]$EvidenceRoot,
    [Parameter(Mandatory=$true)][string]$PythonCacheRoot,
    [Parameter(Mandatory=$true)][string]$UvPath,
    [string]$RunId = ('runtime-stage-' + [guid]::NewGuid().ToString('N'))
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'ETEST_POWERSHELL: PowerShell 7 or newer is required' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work = [IO.Path]::GetFullPath($WorkRoot)
$evidence = Join-Path ([IO.Path]::GetFullPath($EvidenceRoot)) $RunId
$sandbox = Join-Path $work $RunId
if ((Test-Path -LiteralPath $evidence) -or (Test-Path -LiteralPath $sandbox)) { throw 'ETEST_PATH: run paths already exist; evidence will not be overwritten' }
if (-not (Test-Path -LiteralPath $PythonCacheRoot -PathType Container) -or -not (Test-Path -LiteralPath $UvPath -PathType Leaf)) { throw 'ETEST_PREREQUISITE: isolated cache and pinned uv are required' }
[IO.Directory]::CreateDirectory($work) | Out-Null
[IO.Directory]::CreateDirectory($sandbox) | Out-Null
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$runtime = Join-Path $sandbox 'runtime'
$gate = Join-Path $sandbox 'gate'
[IO.Directory]::CreateDirectory($gate) | Out-Null
$preparer = Join-Path $PSScriptRoot 'prepare-python-runtime.ps1'
$wrapper = Join-Path $PSScriptRoot 'install-managed.ps1'
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$started = [DateTimeOffset]::Now
$commands = [System.Collections.Generic.List[object]]::new()
$cases = [System.Collections.Generic.List[object]]::new()
$failure = $null
$blockedCount = 0
$incompleteChild = $null
$child = $null

function Invoke-Captured([string]$Label,[string]$File,[string[]]$Arguments,[string]$Cwd=$repo,[int]$TimeoutSeconds=240) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $File; $psi.WorkingDirectory = $Cwd; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($arg in $Arguments) { [void]$psi.ArgumentList.Add([string]$arg) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'ETEST_SPAWN: child did not start' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { try { $process.Kill($true) } catch {}; $process.WaitForExit(); throw 'ETEST_TIMEOUT: child exceeded bound; preserve stage and logs' }
        $process.WaitForExit(); $outText = $stdout.GetAwaiter().GetResult(); $errText = $stderr.GetAwaiter().GetResult()
        $safe = $Label -replace '[^A-Za-z0-9-]','-'
        [IO.File]::WriteAllText((Join-Path $evidence ($safe + '.stdout.log')),$outText,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $evidence ($safe + '.stderr.log')),$errText,[Text.UTF8Encoding]::new($false))
        $row = [ordered]@{label=$Label;file=$File;argv=$Arguments;cwd=$Cwd;pid=$process.Id;exitCode=[int]$process.ExitCode;stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($outText);stderrBytes=[Text.Encoding]::UTF8.GetByteCount($errText);stdoutLog=$safe+'.stdout.log';stderrLog=$safe+'.stderr.log'}
        $commands.Add($row)
        return [pscustomobject]@{exitCode=[int]$process.ExitCode;stdout=$outText;stderr=$errText;pid=$process.Id}
    } finally { $process.Dispose() }
}

try {
    # First interrupt before extraction starts. The durable receipt and lease
    # prove stage ownership, but no content may be trusted or published.
    $incompleteRuntime = Join-Path $sandbox 'runtime-incomplete'
    $incompleteGate = Join-Path $sandbox 'incomplete-gate'
    [IO.Directory]::CreateDirectory($incompleteGate) | Out-Null
    $incompleteArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','Prepare','-RuntimeRoot',$incompleteRuntime,'-UvPath',[IO.Path]::GetFullPath($UvPath),'-PythonCacheRoot',[IO.Path]::GetFullPath($PythonCacheRoot),'-Offline','-EnableTestHooks','-TestGateRoot',$incompleteGate,'-TestGatePhase','runtime-stage-owner-flushed-before-extract')
    $incompletePsi = [Diagnostics.ProcessStartInfo]::new(); $incompletePsi.FileName = $pwsh; $incompletePsi.WorkingDirectory = $repo; $incompletePsi.UseShellExecute = $false; $incompletePsi.CreateNoWindow = $true
    $incompletePsi.RedirectStandardOutput = $true; $incompletePsi.RedirectStandardError = $true
    $incompletePsi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $incompletePsi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($arg in $incompleteArgs) { [void]$incompletePsi.ArgumentList.Add([string]$arg) }
    $incompleteChild = [Diagnostics.Process]::new(); $incompleteChild.StartInfo = $incompletePsi
    if (-not $incompleteChild.Start()) { throw 'ETEST_SPAWN: pre-extraction child did not start' }
    $incompleteOut = $incompleteChild.StandardOutput.ReadToEndAsync(); $incompleteErr = $incompleteChild.StandardError.ReadToEndAsync()
    $incompleteDeadline = [DateTime]::UtcNow.AddMinutes(2)
    $incompleteReady = Get-ChildItem -LiteralPath $incompleteGate -Filter '*.runtime-stage-owner-flushed-before-extract.ready' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    while (-not $incompleteReady -and -not $incompleteChild.HasExited -and [DateTime]::UtcNow -lt $incompleteDeadline) { Start-Sleep -Milliseconds 25; $incompleteReady = Get-ChildItem -LiteralPath $incompleteGate -Filter '*.runtime-stage-owner-flushed-before-extract.ready' -File -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $incompleteReady) { if (-not $incompleteChild.HasExited) { try { $incompleteChild.Kill($true) } catch {}; $incompleteChild.WaitForExit() }; throw 'ETEST_GATE: pre-extraction ownership barrier was not reached' }
    $incompleteStage = [IO.File]::ReadAllText($incompleteReady.FullName,[Text.Encoding]::UTF8)
    $incompleteOwnerPath = Join-Path $incompleteStage '.project-state-runtime-stage.json'
    if (-not (Test-Path -LiteralPath $incompleteOwnerPath -PathType Leaf) -or (Test-Path -LiteralPath $incompleteRuntime)) { throw 'ETEST_GATE_STATE: pre-extraction ownership receipt missing or final runtime unexpectedly exists' }
    $incompleteOwnerBytes = [IO.File]::ReadAllBytes($incompleteOwnerPath)
    $incompleteOwnerValue = [Text.UTF8Encoding]::new($false,$true).GetString($incompleteOwnerBytes) | ConvertFrom-Json
    if ($incompleteOwnerValue.phase -cne 'preparing' -or $incompleteOwnerValue.schemaVersion -ne 1) { throw 'ETEST_GATE_STATE: expected preparing owner receipt was not persisted' }
    $incompleteLeasePath = [string]$incompleteOwnerValue.stageLeasePath
    if (-not $incompleteLeasePath -or -not (Test-Path -LiteralPath $incompleteLeasePath -PathType Leaf)) { throw 'ETEST_GATE_STATE: bound external lease is missing' }
    $wrapperInstallRoot = Join-Path $sandbox 'managed-install'
    $activeInspect = Invoke-Captured 'active-stage-inspection-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
    if ($activeInspect.exitCode -eq 0 -or (Test-Path -LiteralPath $incompleteRuntime) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($incompleteOwnerPath)) -cne [Convert]::ToBase64String($incompleteOwnerBytes)) { throw 'ETEST_ACTIVE_LEASE: concurrent inspect did not refuse the active stage without mutation' }
    $cases.Add([ordered]@{case='active-preparation-lease-blocks-inspection-without-mutation';result='PASS';exitCode=$activeInspect.exitCode})
    $incompletePid = $incompleteChild.Id
    $incompleteChild.Kill($true); $incompleteChild.WaitForExit()
    $incompleteExit = [int]$incompleteChild.ExitCode
    $incompleteStdout = $incompleteOut.GetAwaiter().GetResult(); $incompleteStderr = $incompleteErr.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $evidence 'interrupted-before-extract.stdout.log'),$incompleteStdout,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $evidence 'interrupted-before-extract.stderr.log'),$incompleteStderr,[Text.UTF8Encoding]::new($false))
    $commands.Add([ordered]@{label='interrupted-before-extract';file=$pwsh;argv=$incompleteArgs;cwd=$repo;pid=$incompletePid;processTerminated=$true;exitCode=$incompleteExit;stdoutLog='interrupted-before-extract.stdout.log';stderrLog='interrupted-before-extract.stderr.log'})
    $incompleteLeaseBytes = [IO.File]::ReadAllBytes($incompleteLeasePath)
    $incompleteFilesBefore = @(Get-ChildItem -LiteralPath $incompleteStage -Force -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } | Sort-Object)
    $incompleteChild.Dispose()
    $incompleteChild = $null
    if ($incompleteExit -ne -1 -or -not (Test-Path -LiteralPath $incompleteStage -PathType Container) -or (Test-Path -LiteralPath $incompleteRuntime)) { throw 'ETEST_INTERRUPT: pre-extraction worker was not actually terminated with stage preserved' }
    $cases.Add([ordered]@{case='process-terminated-after-preparation-receipt-before-extraction';result='PASS';pid=$incompletePid;terminated=$true;stagePresent=$true;finalAbsent=$true;ownerPhase='preparing'})

    $inspectIncomplete = Invoke-Captured 'inspect-owned-incomplete-stage' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
    if ($inspectIncomplete.exitCode -ne 0) { throw 'ETEST_INCOMPLETE_INSPECT: an owned inactive stage was not inspectable' }
    $incompleteInfo = $inspectIncomplete.stdout.Trim() | ConvertFrom-Json
    $incompleteFilesAfterInspect = @(Get-ChildItem -LiteralPath $incompleteStage -Force -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } | Sort-Object)
    if ($incompleteInfo.stageStatus -cne 'owned-incomplete-not-publishable' -or $incompleteInfo.publishable -ne $false -or $incompleteInfo.extractedContents -cne 'NOT_VERIFIED' -or
        (Compare-Object $incompleteFilesBefore $incompleteFilesAfterInspect) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($incompleteOwnerPath)) -cne [Convert]::ToBase64String($incompleteOwnerBytes) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($incompleteLeasePath)) -cne [Convert]::ToBase64String($incompleteLeaseBytes)) { throw 'ETEST_INCOMPLETE_INSPECT: inspect changed evidence or misclassified the stage' }
    $cases.Add([ordered]@{case='inspect-classifies-owned-incomplete-stage-without-reading-or-mutating-contents';result='PASS';stageStatus=$incompleteInfo.stageStatus;publishable=$incompleteInfo.publishable;contents=$incompleteInfo.extractedContents})

    # The owner receipt and external lease are authorization evidence. Missing,
    # altered, or multiply-linked evidence must block inspection and must not be
    # repaired or discarded by the installer. Each mutation is restored byte
    # for byte before the next independent check.
    $leaseBackup = $incompleteLeasePath + '.test-backup'
    [IO.File]::Move($incompleteLeasePath,$leaseBackup)
    try {
        $missingLease = Invoke-Captured 'missing-stage-lease-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
        if ($missingLease.exitCode -eq 0 -or (Test-Path -LiteralPath $incompleteStage -PathType Container) -eq $false -or -not(Test-Path -LiteralPath $leaseBackup -PathType Leaf)) { throw 'ETEST_MISSING_LEASE: missing lease was not refused with stage evidence preserved' }
        $cases.Add([ordered]@{case='missing-stage-lease-refused-and-owner-preserved';result='PASS';exitCode=$missingLease.exitCode;stagePreserved=$true;leaseEvidencePreserved=$true})
    } finally { if ((Test-Path -LiteralPath $leaseBackup -PathType Leaf) -and -not(Test-Path -LiteralPath $incompleteLeasePath)) { [IO.File]::Move($leaseBackup,$incompleteLeasePath) } }

    $originalLeaseBytes = [IO.File]::ReadAllBytes($incompleteLeasePath)
    try {
        [IO.File]::WriteAllBytes($incompleteLeasePath,([byte[]](0,1,2,3,4,5,6,7)))
        $tamperedLease = Invoke-Captured 'tampered-stage-lease-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
        if ($tamperedLease.exitCode -eq 0 -or -not(Test-Path -LiteralPath $incompleteStage -PathType Container)) { throw 'ETEST_TAMPERED_LEASE: altered lease was not refused with stage preserved' }
        $cases.Add([ordered]@{case='tampered-stage-lease-refused-and-stage-preserved';result='PASS';exitCode=$tamperedLease.exitCode;stagePreserved=$true})
    } finally { [IO.File]::WriteAllBytes($incompleteLeasePath,$originalLeaseBytes) }

    $originalOwnerBytes = [IO.File]::ReadAllBytes($incompleteOwnerPath)
    try {
        $alteredOwner = [Text.UTF8Encoding]::new($false,$true).GetString($originalOwnerBytes) | ConvertFrom-Json
        $alteredOwner.operationToken = ('f' * 64)
        [IO.File]::WriteAllText($incompleteOwnerPath,($alteredOwner | ConvertTo-Json -Depth 8 -Compress) + "`n",[Text.UTF8Encoding]::new($false))
        $ownerMismatch = Invoke-Captured 'altered-stage-owner-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
        if ($ownerMismatch.exitCode -eq 0 -or -not(Test-Path -LiteralPath $incompleteStage -PathType Container)) { throw 'ETEST_OWNER_MISMATCH: altered owner receipt was not refused with stage preserved' }
        $cases.Add([ordered]@{case='altered-stage-owner-token-refused-and-stage-preserved';result='PASS';exitCode=$ownerMismatch.exitCode;stagePreserved=$true})
    } finally { [IO.File]::WriteAllBytes($incompleteOwnerPath,$originalOwnerBytes) }

    if (-not ('ProjectStateStageTest.HardLink' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ProjectStateStageTest {
    public static class HardLink {
        [DllImport("Kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateHardLinkW")]
        public static extern bool Create(string newName, string existingName, IntPtr securityAttributes);
    }
}
'@
    }
    $leaseAlias = $incompleteLeasePath + '.test-link'
    if (Test-Path -LiteralPath $leaseAlias) { throw 'ETEST_HARDLINK: refusing to overwrite a pre-existing synthetic path' }
    if (-not [ProjectStateStageTest.HardLink]::Create($leaseAlias,$incompleteLeasePath,[IntPtr]::Zero)) {
        $linkError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($linkError -in @(1,5,50,1314)) {
            $blockedCount++
            $cases.Add([ordered]@{case='hardlinked-stage-lease-refused-and-both-links-preserved';result='BLOCKED_PRECONDITION';reason='WINDOWS_HARDLINK_CREATION_UNAVAILABLE';win32Error=$linkError;productProcessStarted=$false})
        } else { throw ('ETEST_HARDLINK: synthetic same-volume link setup failed unexpectedly; win32=' + $linkError) }
    } else {
        try {
            $linkedLease = Invoke-Captured 'hardlinked-stage-lease-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
            if ($linkedLease.exitCode -eq 0 -or -not(Test-Path -LiteralPath $leaseAlias -PathType Leaf) -or -not(Test-Path -LiteralPath $incompleteStage -PathType Container)) { throw 'ETEST_HARDLINK: multiply-linked lease was not refused with both paths preserved' }
            $cases.Add([ordered]@{case='hardlinked-stage-lease-refused-and-both-links-preserved';result='PASS';exitCode=$linkedLease.exitCode;aliasPreserved=$true;stagePreserved=$true})
        } finally { Remove-Item -LiteralPath $leaseAlias -Force }
    }

    $publishIncomplete = Invoke-Captured 'publish-owned-incomplete-stage-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','PublishRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$incompleteRuntime,'-StageRoot',$incompleteStage)
    if ($publishIncomplete.exitCode -eq 0 -or (Test-Path -LiteralPath $incompleteRuntime) -or -not(Test-Path -LiteralPath $incompleteStage) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($incompleteOwnerPath)) -cne [Convert]::ToBase64String($incompleteOwnerBytes) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($incompleteLeasePath)) -cne [Convert]::ToBase64String($incompleteLeaseBytes)) { throw 'ETEST_INCOMPLETE_PUBLISH: incomplete stage was not refused without mutation' }
    $cases.Add([ordered]@{case='incomplete-stage-publish-refused-and-all-evidence-preserved';result='PASS';exitCode=$publishIncomplete.exitCode})

    $retryRuntime = Join-Path $sandbox 'runtime-fresh-retry'
    $retry = Invoke-Captured 'fresh-retry-with-orphan-preserved' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','Prepare','-RuntimeRoot',$retryRuntime,'-UvPath',[IO.Path]::GetFullPath($UvPath),'-PythonCacheRoot',[IO.Path]::GetFullPath($PythonCacheRoot),'-Offline')
    if ($retry.exitCode -ne 0 -or -not(Test-Path -LiteralPath $retryRuntime) -or -not(Test-Path -LiteralPath $incompleteStage) -or (Test-Path -LiteralPath $incompleteRuntime)) { throw 'ETEST_FRESH_RETRY: fresh retry did not succeed while preserving the incomplete stage' }
    $retryInfo = Invoke-Captured 'inspect-fresh-retry-runtime' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','Inspect','-RuntimeRoot',$retryRuntime)
    if ($retryInfo.exitCode -ne 0) { throw 'ETEST_FRESH_RETRY: fresh runtime failed independent inspection' }
    $cases.Add([ordered]@{case='fresh-retry-publishes-verified-runtime-and-preserves-incomplete-stage';result='PASS';prepareExit=$retry.exitCode;inspectExit=$retryInfo.exitCode;orphanPreserved=$true})

    $gateArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','Prepare','-RuntimeRoot',$runtime,'-UvPath',[IO.Path]::GetFullPath($UvPath),'-PythonCacheRoot',[IO.Path]::GetFullPath($PythonCacheRoot),'-Offline','-EnableTestHooks','-TestGateRoot',$gate,'-TestGatePhase','runtime-owner-flushed-before-publish')
    $psi = [Diagnostics.ProcessStartInfo]::new(); $psi.FileName = $pwsh; $psi.WorkingDirectory = $repo; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($arg in $gateArgs) { [void]$psi.ArgumentList.Add([string]$arg) }
    $child = [Diagnostics.Process]::new(); $child.StartInfo = $psi
    if (-not $child.Start()) { throw 'ETEST_SPAWN: runtime prepare child did not start' }
    $stdoutTask = $child.StandardOutput.ReadToEndAsync(); $stderrTask = $child.StandardError.ReadToEndAsync()
    $deadline = [DateTime]::UtcNow.AddMinutes(5); $ready = Get-ChildItem -LiteralPath $gate -Filter '*.runtime-owner-flushed-before-publish.ready' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    while (-not $ready -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50; $ready = Get-ChildItem -LiteralPath $gate -Filter '*.runtime-owner-flushed-before-publish.ready' -File -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $ready) { if (-not $child.HasExited) { try { $child.Kill($true) } catch {}; $child.WaitForExit() }; throw 'ETEST_GATE: owner-flushed publication barrier was not reached' }
    $stage = [IO.File]::ReadAllText($ready.FullName,[Text.Encoding]::UTF8)
    $ownerPath = Join-Path $stage '.project-state-runtime-owner.json'
    if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf) -or (Test-Path -LiteralPath $runtime)) { throw 'ETEST_GATE_STATE: stage owner missing or final runtime already exists at barrier' }
    $ownerBytesBefore = [IO.File]::ReadAllBytes($ownerPath)
    $stageIdentityBefore = $null
    $childPid = $child.Id
    $child.Kill($true); $child.WaitForExit()
    $childExit = [int]$child.ExitCode
    $childStdout = $stdoutTask.GetAwaiter().GetResult(); $childStderr = $stderrTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $evidence 'interrupted-prepare.stdout.log'),$childStdout,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $evidence 'interrupted-prepare.stderr.log'),$childStderr,[Text.UTF8Encoding]::new($false))
    $commands.Add([ordered]@{label='interrupted-prepare';file=$pwsh;argv=$gateArgs;cwd=$repo;pid=$childPid;processTerminated=$true;exitCode=$childExit;stdoutLog='interrupted-prepare.stdout.log';stderrLog='interrupted-prepare.stderr.log'})
    $child.Dispose()
    $cases.Add([ordered]@{case='process-terminated-after-complete-owner-before-directory-publish';result='PASS';pid=$childPid;terminated=$true;stagePresent=(Test-Path -LiteralPath $stage);finalAbsent=(-not(Test-Path -LiteralPath $runtime));ownerSchema=2})

    $wrongRuntime = Join-Path $sandbox 'wrong-runtime'
    $wrong = Invoke-Captured 'inspect-wrong-final-path' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','InspectStage','-RuntimeRoot',$wrongRuntime,'-StageRoot',$stage)
    if ($wrong.exitCode -eq 0 -or -not (Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $wrongRuntime)) { throw 'ETEST_WRONG_TARGET: wrong final path was not refused without mutation' }
    $cases.Add([ordered]@{case='wrong-final-path-refused-and-stage-preserved';result='PASS';exitCode=$wrong.exitCode})

    $inspect = Invoke-Captured 'inspect-complete-stage' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$runtime,'-StageRoot',$stage)
    if ($inspect.exitCode -ne 0) { throw 'ETEST_INSPECT_STAGE: complete stage inspection failed' }
    $inspectValue = $inspect.stdout.Trim() | ConvertFrom-Json
    if ($inspectValue.stageStatus -cne 'verified-ready-to-publish' -or $inspectValue.treeSha256 -cne '7366e8ae47742cdde8a437f8f5c1548a1a23ce4698d916069e40f8a250ef2805' -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($ownerPath)) -cne [Convert]::ToBase64String($ownerBytesBefore)) { throw 'ETEST_INSPECT_STAGE: inspection changed stage metadata or failed to verify the pinned tree' }
    $cases.Add([ordered]@{case='inspect-verifies-stage-and-does-not-modify-owner';result='PASS';stageStatus=$inspectValue.stageStatus;treeSha256=$inspectValue.treeSha256})

    $publish = Invoke-Captured 'publish-stage' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','PublishRuntimeStage','-InstallRoot',$wrapperInstallRoot,'-RuntimeRoot',$runtime,'-StageRoot',$stage)
    if ($publish.exitCode -ne 0 -or (Test-Path -LiteralPath $stage) -or -not(Test-Path -LiteralPath $runtime)) { throw 'ETEST_PUBLISH_STAGE: verified stage did not publish to the final path' }
    $published = $publish.stdout.Trim() | ConvertFrom-Json
    if ($published.stageStatus -cne 'published-and-verified' -or $published.treeSha256 -cne $inspectValue.treeSha256 -or $published.rootIdentity -cne $inspectValue.rootIdentity) { throw 'ETEST_PUBLISH_STAGE: published runtime differs from the verified staged identity' }
    $cases.Add([ordered]@{case='publish-preserves-identity-and-revalidates-final';result='PASS';stageStatus=$published.stageStatus;rootIdentity=$published.rootIdentity;treeSha256=$published.treeSha256})

    $repeat = Invoke-Captured 'repeat-publish-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','PublishStage','-RuntimeRoot',$runtime,'-StageRoot',$stage)
    $finalInspect = Invoke-Captured 'inspect-final-runtime' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','Inspect','-RuntimeRoot',$runtime)
    if ($repeat.exitCode -eq 0 -or $finalInspect.exitCode -ne 0 -or (($finalInspect.stdout.Trim() | ConvertFrom-Json).treeSha256 -cne $published.treeSha256)) { throw 'ETEST_REPEAT: repeat publish was not refused or published runtime changed' }
    $cases.Add([ordered]@{case='repeat-publication-refused-with-runtime-usable';result='PASS';repeatExit=$repeat.exitCode;inspectExit=$finalInspect.exitCode})

    $foreignFinal = Join-Path $sandbox 'foreign-runtime'
    $foreignId = [guid]::NewGuid().ToString('N')
    $foreignStage = Join-Path $sandbox ('.foreign-runtime.stage-' + $foreignId)
    [IO.Directory]::CreateDirectory($foreignStage) | Out-Null
    $sentinel = Join-Path $foreignStage 'external-sentinel.bin'; $sentinelBytes = [byte[]](17,0,255,13,10,23); [IO.File]::WriteAllBytes($sentinel,$sentinelBytes)
    $overlap = Invoke-Captured 'wrapper-overlap-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Action','InspectRuntimeStage','-InstallRoot',$foreignStage,'-RuntimeRoot',$foreignFinal,'-StageRoot',$foreignStage)
    if ($overlap.exitCode -eq 0 -or $overlap.stderr -notmatch 'EINSTALL_OWNERSHIP' -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($sentinel)) -cne [Convert]::ToBase64String($sentinelBytes)) { throw 'ETEST_WRAPPER_OVERLAP: wrapper did not reject overlap before preserving stage data' }
    $cases.Add([ordered]@{case='wrapper-refuses-install-root-overlap-with-stage';result='PASS';exitCode=$overlap.exitCode;sentinelBytesPreserved=$true})
    $foreign = Invoke-Captured 'publish-unowned-stage-refused' $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$preparer,'-Action','PublishStage','-RuntimeRoot',$foreignFinal,'-StageRoot',$foreignStage)
    if ($foreign.exitCode -eq 0 -or -not(Test-Path -LiteralPath $sentinel) -or (Test-Path -LiteralPath $foreignFinal) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($sentinel)) -cne [Convert]::ToBase64String($sentinelBytes)) { throw 'ETEST_UNOWNED_STAGE: unowned stage was not preserved and refused' }
    $cases.Add([ordered]@{case='unowned-stage-refused-and-sentinel-preserved';result='PASS';exitCode=$foreign.exitCode;sentinelBytes=$sentinelBytes.Length})
} catch {
    $failure = $_.Exception.Message
} finally {
    foreach ($ownedProcess in @($incompleteChild,$child)) {
        if ($null -ne $ownedProcess) {
            try { if (-not $ownedProcess.HasExited) { $ownedProcess.Kill($true); $ownedProcess.WaitForExit() } } catch {}
            try { $ownedProcess.Dispose() } catch {}
        }
    }
    $passed = @($cases | Where-Object result -eq 'PASS').Count
    $failed = if ($failure) { 1 } else { 0 }
    $resultState = if ($failure -or $cases.Count -ne 16) { 'FAIL' } elseif ($blockedCount -gt 0) { 'BLOCKED' } else { 'PASS' }
    $result = [ordered]@{schemaVersion=1;runId=$RunId;startedAt=$started.ToString('o');finishedAt=[DateTimeOffset]::Now.ToString('o');cwd=$repo;workRoot=$work;cachePath=[IO.Path]::GetFullPath($PythonCacheRoot);uvPath=[IO.Path]::GetFullPath($UvPath);uvSha256=(Get-FileHash -LiteralPath $UvPath -Algorithm SHA256).Hash.ToLowerInvariant();powerShell=$PSVersionTable.PSVersion.ToString();commands=@($commands.ToArray());cases=@($cases.ToArray());pass=$passed;fail=$failed;skip=0;blocked=$blockedCount;result=$resultState;failure=$failure}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($result|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
}
$result | ConvertTo-Json -Depth 10
if ($result.result -eq 'FAIL') { exit 1 }
if ($result.result -eq 'BLOCKED') { exit 2 }
