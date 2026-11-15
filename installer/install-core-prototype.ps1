<#
Local installer-core prototype. It consumes an explicitly supplied, hash-bound
wheel manifest and uv binary; it does not download/bootstrap either one.
This is intentionally not a public bootstrap or a supported end-user installer.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Install','Upgrade','Activate','Status','Rollback','Uninstall','Inspect','Resume')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$ManifestPath,
    [string]$UvPath,
    [string]$PythonPath,
    [string]$Version,
    [string]$TransactionId,
    [Parameter(DontShow=$true)][switch]$EnableTestHooks,
    [Parameter(DontShow=$true)][string]$TestGateRoot,
    [Parameter(DontShow=$true)][string]$TestGatePhase
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -lt 7) { [Console]::Error.WriteLine('EINSTALL_POWERSHELL: this transactional prototype requires PowerShell 7 or newer'); exit 2 }
Import-Module -Name (Join-Path $PSScriptRoot 'installer-transaction.psm1') -Force
if(-not('ProjectStateInstaller.FileIdentity' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ProjectStateInstaller {
  public static class FileIdentity {
    [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks;
      public uint FileIndexHigh; public uint FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    public static string Get(string path,bool directory) {
      const uint READ_ATTRIBUTES=0x80, SHARE=0x7, OPEN_EXISTING=3, BACKUP_SEMANTICS=0x02000000, OPEN_REPARSE_POINT=0x00200000;
      IntPtr h=CreateFileW(path,READ_ATTRIBUTES,SHARE,IntPtr.Zero,OPEN_EXISTING,BACKUP_SEMANTICS|OPEN_REPARSE_POINT,IntPtr.Zero);
      if(h==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try { BY_HANDLE_FILE_INFORMATION i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return i.VolumeSerialNumber.ToString("x8")+":"+i.FileIndexHigh.ToString("x8")+i.FileIndexLow.ToString("x8")+":"+i.NumberOfLinks.ToString(); }
      finally { CloseHandle(h); }
    }
  }
}
'@
}
$script:Transaction = $null
$script:PendingInstallId = $null
$script:InstallerVersion = '0.3.4'

function Wait-InstallerTestGate([string]$Phase,[string]$ObservedPath='') {
    if(-not $EnableTestHooks -or -not $TestGateRoot -or $TestGatePhase -cne $Phase){return}
    $fullGate=[IO.Path]::GetFullPath($TestGateRoot)
    [IO.Directory]::CreateDirectory($fullGate)|Out-Null
    $id=if($script:Transaction){[string]$script:Transaction.Id}else{'no-transaction'}
    $ready=Join-Path $fullGate ($id+'.'+$Phase+'.ready')
    $release=Join-Path $fullGate ($id+'.'+$Phase+'.release')
    [IO.File]::WriteAllText($ready,$ObservedPath,[Text.UTF8Encoding]::new($false))
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    while(-not(Test-Path -LiteralPath $release)){
        if([DateTime]::UtcNow -gt $deadline){throw 'EINSTALL_TEST_GATE_TIMEOUT: deterministic installer test barrier expired'}
        Start-Sleep -Milliseconds 20
    }
}

function New-InstallerStageDirectory([string]$Path) {
    if([ProjectStateInstaller.TxnStoreNative]::CreateDirectoryExclusive($Path)){return}
    $code=[ProjectStateInstaller.TxnStoreNative]::LastError()
    if($code -eq 183){throw 'EINSTALL_STAGE: unique staging path is occupied; preserve it'}
    throw 'EINSTALL_STAGE: exclusive stage creation failed; preserve all state'
}

function Write-ActionPhase([string]$Phase,[hashtable]$Observed=@{}) {
    if($null -eq $script:Transaction){throw 'EINSTALL_JOURNAL_INVALID: no active transaction object'}
    $script:Transaction = Set-InstallerTransactionPhase $script:Transaction $Phase $Observed ''
    Wait-InstallerTestGate $Phase
    return
}
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-ByteSha256([byte[]]$Bytes) { $sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()} }
function Get-StreamSha256([IO.Stream]$Stream) { $sha=[Security.Cryptography.SHA256]::Create();try{$Stream.Position=0;return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()} }
function Get-InstallerOwnerTokenHash([string]$Token) { $sha=[Security.Cryptography.SHA256]::Create(); try{return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()} }
function Get-EntryIdentity([string]$Path,[bool]$Directory=$false) { try{return [ProjectStateInstaller.FileIdentity]::Get($Path,$Directory)}catch{throw 'EINSTALL_IDENTITY: could not verify Windows file identity; preserve the object'} }
function Get-DirectoryIdentity([string]$Path) { $id=Get-EntryIdentity $Path $true; return (($id -split ':')[0..1] -join ':') }
function Test-PlanField($Plan,[string]$Name) { if($Plan -is [System.Collections.IDictionary]){return $Plan.Contains($Name)};return ($Plan.PSObject.Properties.Name -contains $Name) }
function Get-Canonical([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { return $full.TrimEnd([IO.Path]::DirectorySeparatorChar) }
    return $full
}
function Assert-InstallPathBudget([string]$Version) {
    if ($env:OS -cne 'Windows_NT') { return }
    $stage = Join-Path $script:Root ('versions\.stage-' + ('0' * 32))
    $final = Join-Path $script:Root ('versions\' + $Version)
    $paths = @(
        (Join-Path $stage 'Scripts\python.exe'),
        (Join-Path $stage 'Lib\site-packages\project_state\__init__.py'),
        (Join-Path $stage ("Lib\site-packages\project_state_python_candidate-$Version.dist-info\licenses\LICENSE")),
        (Join-Path $final 'Scripts\python.exe'),
        (Join-Path $script:Root 'bin\project-state.cmd'),
        (Join-Path $script:Root 'state\install-receipt.json'),
        (Join-Path $script:Root 'state\active-version.txt')
    )
    foreach ($path in $paths) {
        $full = [IO.Path]::GetFullPath($path)
        # .NET string Length counts UTF-16 code units, matching Win32's path units.
        if ($full.Length -ge 260) {
            throw 'EINSTALL_PATH_LIMIT: selected installation location exceeds the tested Win32 path budget; choose a shorter user installation path. No installation state was changed.'
        }
    }
}
function Invoke-Native([string]$File,[string[]]$Arguments) {
    $safeCwd=[IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32'))
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$File;$psi.WorkingDirectory=$safeCwd;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in $Arguments){[void]$psi.ArgumentList.Add([string]$arg)}
    foreach($name in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','PYTHONSTARTUP','PYTHONEXECUTABLE','PYTHONINSPECT')){[void]$psi.Environment.Remove($name)}
    $psi.Environment['UV_NO_CONFIG']='1'
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi
    try{
        if(-not $process.Start()){throw 'EINSTALL_TOOL: pinned local tool did not start'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(1800000)){try{$process.Kill($true)}catch{};$process.WaitForExit();throw 'EINSTALL_TOOL_TIMEOUT: pinned local tool exceeded its time limit'}
        $process.WaitForExit();[void]$stdout.GetAwaiter().GetResult();[void]$stderr.GetAwaiter().GetResult();return [int]$process.ExitCode
    }finally{$process.Dispose()}
}
function Invoke-IsolatedPython([string]$PythonExe,[string[]]$Arguments) {
    if(-not(Test-Path -LiteralPath $PythonExe -PathType Leaf)){throw 'EINSTALL_PYTHON: isolated interpreter is unavailable'}
    $safeCwd=[IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32'))
    if(-not(Test-Path -LiteralPath $safeCwd -PathType Container) -or (Test-Reparse $safeCwd)){throw 'EINSTALL_PYTHON: safe interpreter working directory is unavailable'}
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$PythonExe;$psi.WorkingDirectory=$safeCwd;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    foreach($arg in $Arguments){[void]$psi.ArgumentList.Add([string]$arg)}
    foreach($name in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','PYTHONSTARTUP','PYTHONEXECUTABLE','PYTHONINSPECT')){[void]$psi.Environment.Remove($name)}
    $psi.Environment['PYTHONNOUSERSITE']='1';$psi.Environment['PYTHONDONTWRITEBYTECODE']='1'
    $process=[Diagnostics.Process]::new();$process.StartInfo=$psi
    try{
        if(-not $process.Start()){throw 'EINSTALL_PYTHON: isolated interpreter did not start'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(30000)){try{$process.Kill($true)}catch{};$process.WaitForExit();throw 'EINSTALL_PYTHON_TIMEOUT: isolated interpreter exceeded its verification limit'}
        $process.WaitForExit()
        return [pscustomobject]@{exitCode=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult();pid=$process.Id;cwd=$safeCwd}
    }catch{if($_.Exception.Message -match '^EINSTALL_PYTHON'){throw};throw 'EINSTALL_PYTHON: isolated interpreter execution failed'}finally{$process.Dispose()}
}
function Test-ModuleOriginWithinEnvironment([string]$Origin,[string]$EnvironmentRoot){
    if(-not $Origin -or -not(Test-Path -LiteralPath $Origin -PathType Leaf) -or (Test-Reparse $Origin)){return $false}
    try{Assert-PlainAncestors $Origin;Assert-PlainAncestors $EnvironmentRoot}catch{return $false}
    # The origin itself must be a single-link file. Reparse points are rejected
    # along both paths before canonical lexical comparison, so a path alias
    # cannot turn a component-prefix match into an out-of-environment import.
    if((Get-EntryIdentity $Origin $false) -notmatch ':1$'){return $false}
    $rootFinal=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $EnvironmentRoot).Path).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
    $originFinal=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Origin).Path)
    $prefix=$rootFinal+[IO.Path]::DirectorySeparatorChar
    if(-not $originFinal.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){return $false}
    $relative=[IO.Path]::GetRelativePath($rootFinal,$originFinal)
    return (-not [IO.Path]::IsPathRooted($relative) -and $relative -notin @('..') -and $relative -notmatch '^(\.\.[\\/])')
}
function Get-PythonModuleIdentity([string]$PythonExe) {
    # Encode the filesystem path as ASCII-safe Base64 so redirected Windows
    # stdout decoding cannot corrupt non-ASCII installation-root names.
    $code="import base64,project_state; print(project_state.__version__+'|'+base64.b64encode(project_state.__file__.encode('utf-8')).decode('ascii'))"
    $probe=Invoke-IsolatedPython $PythonExe @('-I','-B','-c',$code)
    $exitCode=$probe.exitCode
    $identityLine=@($probe.stdout -split "`r?`n"|Where-Object{$_ -match '^([^|]+)\|([A-Za-z0-9+/]*={0,2})$'}|Select-Object -Last 1)
    if($identityLine.Count -ne 1){return [pscustomobject]@{exitCode=$exitCode;version=$null;origin=$null;outputComplete=$false;cwd=$probe.cwd}}
    $parts=$identityLine[0].Split('|',2)
    try{$origin=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($parts[1]))}catch{return [pscustomobject]@{exitCode=$exitCode;version=$null;origin=$null;outputComplete=$false}}
    return [pscustomobject]@{exitCode=$exitCode;version=$parts[0];origin=$origin;outputComplete=$true;cwd=$probe.cwd}
}
function Install-PinnedWheel([string]$Uv,[string]$PythonExe,[string]$WheelPath,[string]$ExpectedSha,[long]$ExpectedBytes,[string]$ExpectedFileId) {
    Assert-PlainAncestors $WheelPath
    if(-not(Test-Path -LiteralPath $WheelPath -PathType Leaf) -or (Test-Reparse $WheelPath)){throw 'EINSTALL_ARTIFACT: pinned wheel path is missing or linked'}
    $id=Get-EntryIdentity $WheelPath $false
    if($id -cne $ExpectedFileId -or $id -notmatch ':1$'){throw 'EINSTALL_ARTIFACT: pinned wheel file identity changed or is hard-linked'}
    $stream=[IO.File]::Open($WheelPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length -ne $ExpectedBytes -or (Get-StreamSha256 $stream) -cne $ExpectedSha){throw 'EINSTALL_ARTIFACT: pinned wheel bytes changed before installation'}
        $idWhileOpen=Get-EntryIdentity $WheelPath $false
        if($idWhileOpen -cne $ExpectedFileId){throw 'EINSTALL_ARTIFACT: wheel path identity changed while opened'}
        $code=Invoke-Native $Uv @('pip','install','--offline','--no-index','--no-deps','--reinstall','--python',$PythonExe,$WheelPath)
        if($code -ne 0){return $code}
        if((Get-EntryIdentity $WheelPath $false) -cne $ExpectedFileId -or (Get-StreamSha256 $stream) -cne $ExpectedSha){throw 'EINSTALL_ARTIFACT: wheel identity changed during installation'}
        return 0
    }finally{$stream.Dispose()}
}
function Test-Reparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Assert-PlainTree([string]$Path) {
    if (Test-Reparse $Path) { throw 'EINSTALL_PATH: install path contains a reparse point' }
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force -Recurse) {
        if (Test-Reparse $item.FullName) { throw 'EINSTALL_PATH: owned environment contains a reparse point' }
    }
}
function Assert-PlainAncestors([string]$Path) {
    $cursor = Get-Canonical $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (Test-Reparse $cursor) { throw 'EINSTALL_PATH: install path traverses a reparse point' }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -ceq $cursor) { break }
        $cursor = $parent
    }
}
function Get-EnvironmentManifestHash([string]$Path) {
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $Path -File -Force -Recurse | Sort-Object FullName) {
        if (Test-Reparse $file.FullName) { throw 'EINSTALL_PATH: environment file is a reparse point' }
        $relative = $file.FullName.Substring($Path.Length).TrimStart('\') -replace '\\','/'
        $rows.Add([ordered]@{ path=$relative; bytes=[long]$file.Length; sha256=(Get-Sha256 $file.FullName) })
    }
    $json = ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)) } finally { $sha.Dispose() }
    return [BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()
}
function Get-EnvironmentIdentity([string]$Path) {
    $marker = Join-Path $Path '.project-state-installer-owner.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Test-Reparse $marker)) { throw 'EINSTALL_OWNERSHIP: version environment ownership marker is missing or linked' }
    $bytes=[IO.File]::ReadAllBytes($marker);Assert-UniqueJsonProperties $bytes;$value=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
    if ($value.installId -cne $script:Receipt.installId -or $value.version -notmatch '^\d+\.\d+\.\d+[a-zA-Z0-9.-]*$') { throw 'EINSTALL_OWNERSHIP: version environment marker does not match receipt' }
    if($value.schemaVersion -eq 2){
        $records=@($script:Receipt.versions|Where-Object{$_.version -ceq [string]$value.version})
        if($records.Count -ne 1 -or $records[0].transactionId -cne [string]$value.transactionId -or $value.directoryId -cne ((Get-EntryIdentity $Path $true)-replace ':[0-9]+$','') -or $value.ownerTokenHash -cne (Get-InstallerOwnerTokenHash ([string]$records[0].environmentToken))){throw 'EINSTALL_OWNERSHIP: version environment owner binding differs from receipt'}
        return [string]$records[0].environmentToken
    }
    if($value.schemaVersion -ne 1 -or -not $value.token){throw 'EINSTALL_OWNERSHIP: unsupported version environment owner schema'}
    return [string]$value.token
}
function Get-AtomicWriteAuthorization([string]$Path) {
    if($null -eq $script:Transaction -or -not $script:Transaction.Latest -or $script:Transaction.Latest.phase -in @('completed','rolled-back','abandoned-preserved')){throw 'EINSTALL_ATOMIC_WRITE: metadata write has no active durable transaction; preserve installer state'}
    $phase=[string]$script:Transaction.Latest.phase;$plan=$script:Transaction.Latest.plan;$canonical=[IO.Path]::GetFullPath($Path)
    $allowed=[System.Collections.Generic.List[string]]::new()
    $allowed.Add((Join-Path $script:Root 'state\install-receipt.json'))
    $allowed.Add((Join-Path $script:Root 'state\active-version.txt'))
    $allowed.Add((Join-Path $script:Root 'bin\project-state.cmd'))
    if((Test-PlanField $plan 'rootStagePath') -and $plan.rootStagePath){$allowed.Add((Join-Path ([string]$plan.rootStagePath) 'state\install-receipt.json'))}
    $matched=$false;foreach($candidate in $allowed){if([string]::Equals([IO.Path]::GetFullPath($candidate),$canonical,[StringComparison]::OrdinalIgnoreCase)){$matched=$true;break}}
    if(-not $matched){throw 'EINSTALL_ATOMIC_WRITE: target is outside the transaction metadata allowlist; preserve it'}
    $name=[IO.Path]::GetFileName($canonical);$operation=[string]$script:Transaction.Latest.operation;$phaseAllowed=$false
    if($name -ceq 'install-receipt.json' -and $operation -ceq 'Install' -and $phase -in @('root-create-intent','root-stage-owned','receipt-intent','shim-intent')){$phaseAllowed=$true}
    if($name -ceq 'project-state.cmd' -and $operation -ceq 'Install' -and $phase -ceq 'shim-intent'){$phaseAllowed=$true}
    if($name -ceq 'active-version.txt' -and $operation -in @('Install','Activate','Rollback') -and $phase -ceq 'activate-intent'){$phaseAllowed=$true}
    if(-not $phaseAllowed){throw 'EINSTALL_ATOMIC_WRITE: journal phase does not authorize this metadata target; preserve it'}
    return [pscustomobject]@{transactionId=[string]$script:Transaction.Id;target=$canonical;targetHash=(Get-ByteSha256 ([Text.Encoding]::UTF8.GetBytes($canonical.ToUpperInvariant())))}
}
function Write-AtomicText([string]$Path,[string]$Value) {
    $authorization=Get-AtomicWriteAuthorization $Path;$canonical=$authorization.target;$parent=Split-Path -Parent $canonical
    Assert-PlainAncestors $parent
    if(-not(Test-Path -LiteralPath $parent -PathType Container) -or (Test-Reparse $parent)){throw 'EINSTALL_ATOMIC_WRITE: metadata parent is missing or linked; preserve installer state'}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Value);$payloadHash=Get-ByteSha256 $bytes
    # Keep the deterministic basename short enough for the tested Win32 path
    # budget; full target and payload digests are rechecked from bytes below.
    $tmp=Join-Path $parent ('.write-{0}-{1}-{2}.tmp' -f $authorization.transactionId,$authorization.targetHash.Substring(0,16),$payloadHash.Substring(0,16))
    if(Test-Path -LiteralPath $canonical){
        if((Test-Reparse $canonical) -or -not(Test-Path -LiteralPath $canonical -PathType Leaf)){throw 'EINSTALL_ATOMIC_WRITE: metadata target is not a plain file; preserve it'}
        $current=Get-Item -LiteralPath $canonical -Force;$currentId=Get-EntryIdentity $canonical $false
        if($currentId -notmatch ':1$'){throw 'EINSTALL_ATOMIC_WRITE: metadata target has multiple links; preserve it'}
        if($current.Length -eq [long]$bytes.Length -and (Get-Sha256 $canonical) -ceq $payloadHash -and (Get-EntryIdentity $canonical $false) -ceq $currentId){return}
    }
    $createdNow=$false
    if(Test-Path -LiteralPath $tmp){
        if((Test-Reparse $tmp) -or -not(Test-Path -LiteralPath $tmp -PathType Leaf)){throw 'EINSTALL_ATOMIC_TEMP_UNCERTAIN: transaction temporary is not a plain file; preserve it'}
        $tempId=Get-EntryIdentity $tmp $false;$tempItem=Get-Item -LiteralPath $tmp -Force
        if($tempId -notmatch ':1$' -or $tempItem.Length -ne [long]$bytes.Length -or (Get-Sha256 $tmp) -cne $payloadHash -or (Get-EntryIdentity $tmp $false) -cne $tempId){throw 'EINSTALL_ATOMIC_TEMP_UNCERTAIN: transaction temporary does not match its journal-authorized bytes; preserve it'}
    }else{
        $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$fs.Write($bytes,0,$bytes.Length);$fs.Flush($true)}finally{$fs.Dispose()}
        $tempId=Get-EntryIdentity $tmp $false;$createdNow=$true
        if($tempId -notmatch ':1$' -or (Get-Item -LiteralPath $tmp -Force).Length -ne [long]$bytes.Length -or (Get-Sha256 $tmp) -cne $payloadHash -or (Get-EntryIdentity $tmp $false) -cne $tempId){throw 'EINSTALL_ATOMIC_TEMP_UNCERTAIN: flushed transaction temporary failed identity or content verification; preserve it'}
    }
    try{
        if($EnableTestHooks -and $TestGatePhase -ceq 'atomic-temp-flushed'){
            $fullGate=[IO.Path]::GetFullPath($TestGateRoot);[IO.Directory]::CreateDirectory($fullGate)|Out-Null
            $ready=Join-Path $fullGate ($authorization.transactionId+'.atomic-temp-flushed.ready');$release=Join-Path $fullGate ($authorization.transactionId+'.atomic-temp-flushed.release')
            [IO.File]::WriteAllText($ready,$tmp,[Text.UTF8Encoding]::new($false));$deadline=[DateTime]::UtcNow.AddSeconds(45)
            while(-not(Test-Path -LiteralPath $release)){if([DateTime]::UtcNow -gt $deadline){throw 'EINSTALL_TEST_GATE_TIMEOUT: deterministic atomic-write barrier expired'};Start-Sleep -Milliseconds 20}
        }
        if((Get-EntryIdentity $tmp $false) -cne $tempId -or (Get-Item -LiteralPath $tmp -Force).Length -ne [long]$bytes.Length -or (Get-Sha256 $tmp) -cne $payloadHash){throw 'EINSTALL_ATOMIC_TEMP_UNCERTAIN: transaction temporary changed before publication; preserve it'}
        if(Test-Path -LiteralPath $canonical){
            if((Test-Reparse $canonical) -or (Get-EntryIdentity $canonical $false) -notmatch ':1$'){throw 'EINSTALL_ATOMIC_WRITE: metadata target became linked or multi-linked; preserve it'}
            [IO.File]::Move($tmp,$canonical,$true)
        }else{[IO.File]::Move($tmp,$canonical)}
        if((Test-Reparse $canonical) -or (Get-Item -LiteralPath $canonical -Force).Length -ne [long]$bytes.Length -or (Get-Sha256 $canonical) -cne $payloadHash){throw 'EINSTALL_ATOMIC_PUBLISH_UNCERTAIN: published metadata does not match the journal-authorized payload; preserve it'}
    }catch{
        # On an ordinary exception, remove only a temp created by this invocation
        # whose single-link identity and exact bytes still match. A temp inherited
        # after process death is retained for deterministic journal-authorized retry.
        if($createdNow -and (Test-Path -LiteralPath $tmp -PathType Leaf)){
            try{if(-not(Test-Reparse $tmp) -and (Get-EntryIdentity $tmp $false) -ceq $tempId -and (Get-EntryIdentity $tmp $false) -match ':1$' -and (Get-Item -LiteralPath $tmp -Force).Length -eq [long]$bytes.Length -and (Get-Sha256 $tmp) -ceq $payloadHash){[IO.File]::Delete($tmp)}}catch{}
        }
        throw
    }
}
function Get-Receipt {
    $file = Join-Path $script:Root 'state\install-receipt.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    if (Test-Reparse $file) { throw 'EINSTALL_RECEIPT: receipt is a link' }
    $r = [IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($r.schemaVersion -ne 1 -or -not [string]::Equals([string]$r.installRoot,$script:Root,[StringComparison]::OrdinalIgnoreCase) -or [string]::IsNullOrWhiteSpace($r.installId)) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:Root))).Replace('-','').ToLowerInvariant(); $recorded = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$r.installRoot))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        throw "EINSTALL_RECEIPT: root binding mismatch (requested=$actual, receipt=$recorded)"
    }
    if(-not $r.rootDirectoryId -or (Get-DirectoryIdentity $script:Root) -cne [string]$r.rootDirectoryId){throw 'EINSTALL_ROOT_IDENTITY: installation directory identity differs from its receipt; preserve the installation'}
    $rootOwner=Join-Path $script:Root '.project-state-installer-root.json'
    if(-not(Test-Path -LiteralPath $rootOwner -PathType Leaf) -or (Test-Reparse $rootOwner)){throw 'EINSTALL_ROOT_IDENTITY: installation root owner marker is missing or linked; preserve the installation'}
    try{$owner=[IO.File]::ReadAllBytes($rootOwner);Assert-UniqueJsonProperties $owner;$ownerValue=[Text.Encoding]::UTF8.GetString($owner)|ConvertFrom-Json}catch{throw 'EINSTALL_ROOT_IDENTITY: installation root owner marker is malformed; preserve the installation'}
    if($ownerValue.schemaVersion -ne 1 -or $ownerValue.installId -cne $r.installId -or $ownerValue.rootHash -cne (Get-InstallerRootBinding $script:Root).RootHash -or $ownerValue.rootDirectoryId -cne [string]$r.rootDirectoryId -or $ownerValue.ownerTokenHash -cne [string]$r.rootOwnerTokenHash){throw 'EINSTALL_ROOT_IDENTITY: installation root owner marker does not match its receipt; preserve the installation'}
    return $r
}
function Save-Receipt($Receipt) {
    $file = Join-Path $script:Root 'state\install-receipt.json'
    Write-AtomicText $file (($Receipt | ConvertTo-Json -Depth 12) + "`n")
}
function Get-ActiveVersion {
    $file = Join-Path $script:Root 'state\active-version.txt'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    if (Test-Reparse $file) { throw 'EINSTALL_POINTER: active version pointer is a link' }
    $value = (Get-Content -LiteralPath $file -Raw).Trim()
    if ($value -notmatch '^\d+\.\d+\.\d+(?:[a-zA-Z0-9.-]+)?$') { throw 'EINSTALL_POINTER: active version is malformed' }
    return $value
}
function Set-ActiveVersion([string]$Version) {
    $record = @($script:Receipt.versions | Where-Object { $_.version -ceq $Version })
    if ($record.Count -ne 1) { throw 'EINSTALL_VERSION: requested version is not owned by this installation' }
    $python = Join-Path $script:Root ('versions\' + $Version + '\Scripts\python.exe')
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'EINSTALL_VERSION: owned version interpreter is missing' }
    $folder = Join-Path $script:Root ('versions\' + $Version)
    Assert-PlainTree $folder
    if ((Get-EnvironmentIdentity $folder) -cne $record[0].environmentToken -or (Get-EnvironmentManifestHash $folder) -cne $record[0].environmentManifestSha256) { throw 'EINSTALL_VERSION: installed environment identity changed; active pointer was preserved' }
    $verify=Invoke-IsolatedPython $python @('-I','-B','-m','project_state.cli','--version')
    if ($verify.exitCode -ne 0 -or $verify.stdout.Trim() -cne $Version) { throw 'EINSTALL_VERIFY: version entry failed verification; active version was not switched' }
    $pointer=Join-Path $script:Root 'state\active-version.txt'
    $newText=$Version+"`n";$newHash=Get-ByteSha256 ([Text.Encoding]::UTF8.GetBytes($newText))
    if(Test-Path -LiteralPath $pointer -PathType Leaf){if((Get-Sha256 $pointer) -ceq $newHash){return}}
    if($script:Transaction -and (Test-PlanField $script:Transaction.Latest.plan 'previousPointerSha256')){
        $expected=$script:Transaction.Latest.plan.previousPointerSha256
        $actual=if(Test-Path -LiteralPath $pointer -PathType Leaf){Get-Sha256 $pointer}else{$null}
        if($actual -cne $expected){throw 'EINSTALL_POINTER_CONFLICT: active pointer changed after transaction planning; preserve it'}
    }
    Write-AtomicText $pointer $newText
}
function Get-CommandConflict {
    $expected = Join-Path $script:Root 'bin\project-state.cmd'
    $extensions = @($env:PATHEXT -split ';' | Where-Object { $_ })
    $userPath = [Environment]::GetEnvironmentVariable('Path','User')
    foreach ($entry in @((@($env:PATH -split ';') + @(([string]$userPath) -split ';')) | Where-Object { $_ })) {
        foreach ($extension in $extensions) {
            $candidate = Join-Path $entry ('project-state' + $extension)
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            try { $resolved = Get-Canonical $candidate } catch { continue }
            if ($resolved -ine (Get-Canonical $expected)) { return $resolved }
        }
    }
    return $null
}
function Ensure-Root {
    Assert-PlainAncestors $script:Root
    if (-not (Test-Path -LiteralPath $script:Root)) {
        if($null -eq $script:Transaction -or -not $script:Transaction.Latest.plan.rootStagePath){throw 'EINSTALL_ROOT_RECOVERY: first-root creation requires a durable transaction plan'}
        $stageRoot=[string]$script:Transaction.Latest.plan.rootStagePath
        $plan=$script:Transaction.Latest.plan
        $ownerPath=Join-Path $stageRoot '.project-state-installer-root.json'
        if(-not(Test-Path -LiteralPath $stageRoot)){
            New-InstallerStageDirectory $stageRoot
            Wait-InstallerTestGate 'root-stage-directory-created' $stageRoot
            Assert-PlainAncestors $stageRoot
            $stageId=Get-DirectoryIdentity $stageRoot
            $owner=[ordered]@{schemaVersion=1;transactionId=[string]$script:Transaction.Id;rootHash=(Get-InstallerRootBinding $script:Root).RootHash;installId=[string]$script:PendingInstallId;rootDirectoryId=$stageId;ownerTokenHash=[string]$plan.rootOwnerTokenHash}
            $ownerBytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner|ConvertTo-Json -Compress)+"`n")
            try{$ownerStream=[IO.File]::Open($ownerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$ownerStream.Write($ownerBytes,0,$ownerBytes.Length);$ownerStream.Flush($true)}finally{$ownerStream.Dispose()}}catch{throw 'EINSTALL_ROOT_UNCERTAIN: root-stage ownership marker could not be published; preserve the stage'}
            Wait-InstallerTestGate 'root-stage-marker-flushed' $stageRoot
            Write-ActionPhase 'root-stage-owned' @{stagePath=$stageRoot;rootDirectoryId=$stageId;ownerMarkerSha256=(Get-ByteSha256 $ownerBytes)}
        }
        if(-not(Test-Path -LiteralPath $stageRoot -PathType Container) -or (Test-Reparse $stageRoot) -or -not(Test-Path -LiteralPath $ownerPath -PathType Leaf) -or (Test-Reparse $ownerPath)){throw 'EINSTALL_ROOT_UNCERTAIN: root stage or its owner marker is missing or unsafe; preserve it'}
        $actualStageId=Get-DirectoryIdentity $stageRoot
        $ownerBytes=[IO.File]::ReadAllBytes($ownerPath);Assert-UniqueJsonProperties $ownerBytes
        try{$ownerValue=[Text.Encoding]::UTF8.GetString($ownerBytes)|ConvertFrom-Json}catch{throw 'EINSTALL_ROOT_UNCERTAIN: root-stage owner marker is malformed; preserve it'}
        $stageRecord=Get-TransactionRecord $script:Transaction 'root-stage-owned'
        if($ownerValue.schemaVersion -ne 1 -or $ownerValue.transactionId -cne [string]$script:Transaction.Id -or $ownerValue.rootHash -cne (Get-InstallerRootBinding $script:Root).RootHash -or $ownerValue.installId -cne [string]$plan.installId -or $ownerValue.rootDirectoryId -cne $actualStageId -or $ownerValue.ownerTokenHash -cne [string]$plan.rootOwnerTokenHash -or ($stageRecord -and $stageRecord.observed.rootDirectoryId -cne $actualStageId)){throw 'EINSTALL_ROOT_UNCERTAIN: root-stage owner binding or directory identity differs; preserve it'}
        if($script:Transaction.Latest.phase -ceq 'root-create-intent') { Write-ActionPhase 'root-stage-owned' @{stagePath=$stageRoot;rootDirectoryId=$actualStageId;ownerMarkerSha256=(Get-ByteSha256 $ownerBytes)} }
        $allowed=@('.project-state-installer-root.json','versions','bin','state')
        foreach($child in Get-ChildItem -LiteralPath $stageRoot -Force){if($child.Name -notin $allowed -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'EINSTALL_ROOT_UNCERTAIN: root stage contains an unexpected or linked entry; preserve it'}}
        foreach($dir in @('versions','bin','state')){$path=Join-Path $stageRoot $dir;if(Test-Path -LiteralPath $path){if(-not(Test-Path -LiteralPath $path -PathType Container) -or (Test-Reparse $path)){throw 'EINSTALL_ROOT_UNCERTAIN: staged root directory type changed; preserve it'}}else{[IO.Directory]::CreateDirectory($path)|Out-Null}}
        $stageRecord=Get-TransactionRecord $script:Transaction 'root-stage-owned'
        if($script:Transaction.Latest.phase -ceq 'root-stage-owned'){
            $receiptPath=Join-Path $stageRoot 'state\install-receipt.json'
            if(-not(Test-Path -LiteralPath $receiptPath -PathType Leaf)){
                $oldRoot=$script:Root
                try{$script:Root=$stageRoot;$script:Receipt=[ordered]@{schemaVersion=1;installerVersion=$script:InstallerVersion;installId=$script:PendingInstallId;installRoot=$oldRoot;rootDirectoryId=$actualStageId;rootOwnerTokenHash=[string]$plan.rootOwnerTokenHash;createdByTransactionId=[string]$script:Transaction.Id;createdAt=([DateTimeOffset]::FromUnixTimeMilliseconds([long]$plan.rootCreatedAtUnixMs).UtcDateTime.ToString('o'));versions=@();userPathRegistered=$false;shimSha256=$null};Save-Receipt $script:Receipt}finally{$script:Root=$oldRoot}
            }else{
                if(Test-Reparse $receiptPath){throw 'EINSTALL_ROOT_UNCERTAIN: staged receipt is linked; preserve it'}
                $staged=[IO.File]::ReadAllBytes($receiptPath);Assert-UniqueJsonProperties $staged;$stagedReceipt=[Text.Encoding]::UTF8.GetString($staged)|ConvertFrom-Json
                if($stagedReceipt.installId -cne [string]$plan.installId -or $stagedReceipt.rootDirectoryId -cne $actualStageId -or $stagedReceipt.rootOwnerTokenHash -cne [string]$plan.rootOwnerTokenHash){throw 'EINSTALL_ROOT_UNCERTAIN: staged receipt does not match transaction; preserve it'}
            }
            Write-ActionPhase 'root-receipt-published' @{receiptSha256=(Get-Sha256 $receiptPath);rootDirectoryId=$actualStageId}
        }
        if($script:Transaction.Latest.phase -ceq 'root-receipt-published'){
            if(Test-Path -LiteralPath $script:Root){throw 'EINSTALL_ROOT_UNCERTAIN: live install root appeared before publication; preserve both paths'}
            $receiptPath=Join-Path $stageRoot 'state\install-receipt.json';if(-not(Test-Path -LiteralPath $receiptPath -PathType Leaf) -or (Get-Sha256 $receiptPath) -cne [string]$script:Transaction.Latest.observed.receiptSha256){throw 'EINSTALL_ROOT_UNCERTAIN: staged receipt differs from the journal; preserve it'}
            [IO.Directory]::Move($stageRoot,$script:Root)
            if((Get-DirectoryIdentity $script:Root) -cne $actualStageId){throw 'EINSTALL_ROOT_UNCERTAIN: published root directory identity changed; preserve it'}
            Write-ActionPhase 'root-published' @{rootDirectoryId=$actualStageId;receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}
        }
        if($script:Transaction.Latest.phase -ceq 'root-published'){$script:Receipt=Get-Receipt}
        elseif($script:Transaction.Latest.phase -notin @('root-created','stage-create-intent','stage-created','venv-create-intent','venv-created','wheel-install-intent','wheel-installed','verify-intent','candidate-verified','publish-intent','version-published','receipt-intent','receipt-published','shim-intent','shim-published','activate-intent','active','committed','completed')){throw 'EINSTALL_ROOT_RECOVERY: unexpected phase while publishing first root'}
    } else {
        $script:Receipt = Get-Receipt
        if (-not $script:Receipt) { throw 'EINSTALL_CONFLICT: install root exists without an ownership receipt; nothing was changed' }
        if($script:Transaction -and $script:Transaction.Latest.operation -ceq 'Install' -and -not [bool]$script:Transaction.Latest.plan.rootExisted){
            $phase=[string]$script:Transaction.Latest.phase
            if($phase -in @('root-create-intent','root-stage-owned')){throw 'EINSTALL_ROOT_UNCERTAIN: live install root appeared before its journaled publication; preserve it'}
            if($script:Receipt.installId -cne [string]$script:Transaction.Latest.plan.installId){throw 'EINSTALL_ROOT_UNCERTAIN: live install root belongs to a different transaction; preserve it'}
            $rootId=Get-DirectoryIdentity $script:Root
            if($phase -ceq 'root-receipt-published'){
                if($rootId -cne [string]$script:Transaction.Latest.observed.rootDirectoryId -or (Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json')) -cne [string]$script:Transaction.Latest.observed.receiptSha256){throw 'EINSTALL_ROOT_UNCERTAIN: moved root differs from the durable receipt intent; preserve it'}
                Write-ActionPhase 'root-published' @{rootDirectoryId=$rootId;receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}
            }elseif($phase -in @('root-published','root-created','stage-create-intent','stage-created','venv-create-intent','venv-created','wheel-install-intent','wheel-installed','verify-intent','candidate-verified','publish-intent','version-published','receipt-intent','receipt-published','shim-intent','shim-published','activate-intent','active','committed','completed')){
                $bound=Read-InstallerTransaction $script:Root $script:Transaction.Id
                $proof=@($bound.Records|Where-Object{$_.PSObject.Properties['observed'] -and $_.observed -and $_.observed.PSObject.Properties['rootDirectoryId'] -and $_.observed.rootDirectoryId}|Select-Object -Last 1)
                if($proof.Count -ne 1 -or [string]$proof[0].observed.rootDirectoryId -cne $rootId){throw 'EINSTALL_ROOT_IDENTITY: published install root differs from its transaction proof; preserve it'}
                if($phase -ceq 'root-published'){Write-ActionPhase 'root-created' @{installId=$script:Receipt.installId;rootDirectoryId=$rootId;receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}}
            }
        }
        foreach ($dir in @('versions','bin','state')) {
            $path = Join-Path $script:Root $dir
            if (-not (Test-Path -LiteralPath $path -PathType Container) -or (Test-Reparse $path)) { throw 'EINSTALL_PATH: owned install directory is missing or linked' }
        }
    }
}
function Get-Manifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Test-Reparse $Path)) { throw 'EINSTALL_MANIFEST: local manifest is missing or linked' }
    Assert-PlainAncestors $Path
    $manifestId=Get-EntryIdentity $Path $false
    if($manifestId -notmatch ':1$'){throw 'EINSTALL_MANIFEST: manifest has multiple hard links'}
    $manifestStream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{if($manifestStream.Length -gt 1048576){throw 'EINSTALL_MANIFEST: local manifest exceeds the size limit'};$manifestBytes=[byte[]]::new([int]$manifestStream.Length);$offset=0;while($offset -lt $manifestBytes.Length){$read=$manifestStream.Read($manifestBytes,$offset,$manifestBytes.Length-$offset);if($read -le 0){throw 'EINSTALL_MANIFEST: manifest read was incomplete'};$offset+=$read};$manifestHash=Get-ByteSha256 $manifestBytes;if((Get-EntryIdentity $Path $false) -cne $manifestId){throw 'EINSTALL_MANIFEST: manifest file identity changed while read'}}finally{$manifestStream.Dispose()}
    Assert-UniqueJsonProperties $manifestBytes
    $m = [Text.UTF8Encoding]::new($false,$true).GetString($manifestBytes) | ConvertFrom-Json
    if(@($m.PSObject.Properties.Name|Sort-Object -CaseSensitive) -join ',' -cne 'kind,schemaVersion,uv,version,wheel' -or @($m.wheel.PSObject.Properties.Name|Sort-Object -CaseSensitive) -join ',' -cne 'bytes,file,sha256' -or @($m.uv.PSObject.Properties.Name|Sort-Object -CaseSensitive) -join ',' -cne 'sha256,version'){throw 'EINSTALL_MANIFEST: manifest fields are missing or unknown'}
    if ($m.schemaVersion -ne 1 -or $m.kind -ne 'local-sandbox-candidate' -or $m.version -notmatch '^\d+\.\d+\.\d+[a-zA-Z0-9.-]*$') { throw 'EINSTALL_MANIFEST: unsupported local manifest' }
    if ($m.wheel.file -notmatch '^[A-Za-z0-9_.+-]+\.whl$' -or $m.wheel.sha256 -notmatch '^[a-f0-9]{64}$' -or $m.wheel.bytes -isnot [long] -and $m.wheel.bytes -isnot [int]) { throw 'EINSTALL_MANIFEST: wheel identity is invalid' }
    $wheel = Join-Path (Split-Path -Parent (Get-Canonical $Path)) $m.wheel.file
    if (-not (Test-Path -LiteralPath $wheel -PathType Leaf) -or (Test-Reparse $wheel)) { throw 'EINSTALL_ARTIFACT: wheel is missing or linked' }
    Assert-PlainAncestors $wheel
    $wheelId=Get-EntryIdentity $wheel $false;if($wheelId -notmatch ':1$'){throw 'EINSTALL_ARTIFACT: wheel has multiple hard links'}
    $wheelStream=[IO.File]::Open($wheel,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{if($wheelStream.Length -ne [long]$m.wheel.bytes -or (Get-StreamSha256 $wheelStream) -cne [string]$m.wheel.sha256){throw 'EINSTALL_ARTIFACT: wheel size or SHA-256 mismatch'};if((Get-EntryIdentity $wheel $false) -cne $wheelId){throw 'EINSTALL_ARTIFACT: wheel identity changed while read'}}finally{$wheelStream.Dispose()}
    return @{ value=$m; wheel=$wheel; manifestSha256=$manifestHash; manifestFileId=$manifestId; wheelFileId=$wheelId }
}
function Write-Shim {
    $shim = Join-Path $script:Root 'bin\project-state.cmd'
    $content = @('@echo off','setlocal DisableDelayedExpansion','set "PYTHONPATH="','set "PYTHONHOME="','set "PYTHONUSERBASE="','set "PYTHONSTARTUP="','set "PYTHONEXECUTABLE="','set "PYTHONINSPECT="','set "PYTHONNOUSERSITE=1"','set "PYTHONUTF8=1"','set "PYTHONDONTWRITEBYTECODE=1"','set "PS_VERSION="','for /f "usebackq delims=" %%V in ("%~dp0..\state\active-version.txt") do set "PS_VERSION=%%V"','if not defined PS_VERSION exit /b 2','"%~dp0..\versions\%PS_VERSION%\Scripts\python.exe" -I -B -m project_state.cli %*','exit /b %ERRORLEVEL%','') -join "`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($content)
    $sha=[Security.Cryptography.SHA256]::Create();try{$expectedSha=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if (Test-Path -LiteralPath $shim) {
        $currentSha=Get-Sha256 $shim
        if($currentSha -cne $expectedSha -and (-not $script:Receipt.shimSha256 -or $currentSha -cne $script:Receipt.shimSha256)){throw 'EINSTALL_CONFLICT: command shim exists and is not verified as owned; nothing was overwritten'}
        if($currentSha -ceq $expectedSha){$script:Receipt.shimSha256=$expectedSha;Save-Receipt $script:Receipt;return}
    }
    Write-AtomicText $shim $content
    $script:Receipt.shimSha256 = Get-Sha256 $shim
    Save-Receipt $script:Receipt
}
function Install-Version {
    if (-not $ManifestPath -or -not $UvPath -or -not $PythonPath) { throw 'EINSTALL_ARGUMENT: Install requires ManifestPath, UvPath, and PythonPath in this local prototype' }
    $loaded = Get-Manifest $ManifestPath
    $m = $loaded.value
    if ($Version -and $Version -cne $m.version) { throw 'EINSTALL_VERSION: requested version does not match the manifest' }
    Assert-InstallPathBudget $m.version
    $uv = Get-Canonical $UvPath
    if (-not (Test-Path -LiteralPath $uv -PathType Leaf) -or (Test-Reparse $uv) -or (Get-Sha256 $uv) -cne $m.uv.sha256) { throw 'EINSTALL_UV: uv executable identity mismatch' }
    $prior = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $uvVersion = & $uv --version 2>&1; $uvCode = $LASTEXITCODE } finally { $ErrorActionPreference = $prior }
    if ($uvCode -ne 0 -or (($uvVersion -join '').Trim() -notmatch ('^uv ' + [regex]::Escape([string]$m.uv.version) + '(?:\s|$)'))) { throw 'EINSTALL_UV: uv version does not match the pinned local manifest' }
    $pythonBase = Get-Canonical $PythonPath
    if (-not (Test-Path -LiteralPath $pythonBase -PathType Leaf)) { throw 'EINSTALL_PYTHON: Python executable is unavailable' }
    $pythonVersionResult=Invoke-IsolatedPython $pythonBase @('-I','--version')
    $pvText=($pythonVersionResult.stdout+$pythonVersionResult.stderr).Trim()
    if ($pythonVersionResult.exitCode -ne 0 -or $pvText -notmatch 'Python 3\.(1[2-9]|[2-9]\d)(?:\.|$)') { throw 'EINSTALL_PYTHON: Python 3.12 or newer is required' }
    $conflict = Get-CommandConflict
    if ($conflict) { throw 'EINSTALL_CONFLICT: another project-state command is already on PATH; existing command was preserved' }
    $rootExisted = Test-Path -LiteralPath $script:Root -PathType Container
    $priorReceipt = if($rootExisted){Get-Receipt}else{$null}
    if($rootExisted -and -not $priorReceipt){throw 'EINSTALL_CONFLICT: install root exists without a valid ownership receipt; nothing was changed'}
    $script:Receipt = $priorReceipt
    $script:PendingInstallId = if($priorReceipt){[string]$priorReceipt.installId}else{[guid]::NewGuid().ToString('N')}
    $priorActive = if($priorReceipt){Get-ActiveVersion}else{$null}
    $prePointer = Join-Path $script:Root 'state\active-version.txt'
    $preShim = Join-Path $script:Root 'bin\project-state.cmd'
    $ownedBefore = if($priorReceipt){@($priorReceipt.versions | Where-Object { $_.version -ceq $m.version })}else{@()}
    $operation = if(@($ownedBefore).Count -eq 1){'Activate'}else{'Install'}
    $stage = Join-Path (Join-Path $script:Root 'state\staging') ([guid]::NewGuid().ToString('N'))
    $rootStage = Join-Path (Split-Path -Parent $script:Root) ('.' + (Split-Path -Leaf $script:Root) + '.stage-' + [guid]::NewGuid().ToString('N'))
    $token = [guid]::NewGuid().ToString('N')
    $rootOwnerToken = [guid]::NewGuid().ToString('N')
    $plan = @{
        version=[string]$m.version; installRootDirectoryId=if($rootExisted){Get-DirectoryIdentity $script:Root}else{$null}; manifestPath=(Get-Canonical $ManifestPath); manifestSha256=[string]$loaded.manifestSha256; manifestFileId=[string]$loaded.manifestFileId
        wheelPath=$loaded.wheel; wheelSha256=[string]$m.wheel.sha256; wheelBytes=[long]$m.wheel.bytes; wheelFileId=[string]$loaded.wheelFileId
        uvPath=$uv; uvSha256=[string]$m.uv.sha256; pythonPath=$pythonBase; pythonVersion=$pvText
        stagePath=$stage; rootStagePath=$rootStage; finalPath=(Join-Path (Join-Path $script:Root 'versions') $m.version)
        rootExisted=[bool]$rootExisted; installId=$script:PendingInstallId; previousActiveVersion=$priorActive
        previousReceiptSha256=if($priorReceipt){Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json')}else{$null}
        previousPointerSha256=if(Test-Path -LiteralPath $prePointer -PathType Leaf){Get-Sha256 $prePointer}else{$null}
        previousShimSha256=if(Test-Path -LiteralPath $preShim -PathType Leaf){Get-Sha256 $preShim}else{$null}
        environmentToken=$token;stageOwnerProtocol=2;rootOwnerTokenHash=(Get-InstallerOwnerTokenHash $rootOwnerToken);rootCreatedAtUnixMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();installedAtUnixMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $script:Transaction = New-InstallerTransaction $script:Root $operation $script:PendingInstallId ([guid]::NewGuid().ToString('N')) $plan ''
    if($operation -eq 'Install'){
        Write-ActionPhase 'root-create-intent' @{rootExisted=$rootExisted}
        Ensure-Root
        Write-ActionPhase 'root-created' @{installId=[string]$script:Receipt.installId;receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}
    }else{
        Ensure-Root
        Write-ActionPhase 'activate-intent' @{from=$priorActive;to=[string]$m.version}
    }
    $final = Join-Path $script:Root ('versions\' + $m.version)
    $owned = @($script:Receipt.versions | Where-Object { $_.version -ceq $m.version })
    if ($owned.Count -gt 1) { throw 'EINSTALL_RECEIPT: duplicate version ownership records' }
    if ($owned.Count -eq 1) {
        if ($owned[0].wheelSha256 -cne $m.wheel.sha256 -or -not (Test-Path -LiteralPath $final -PathType Container)) { throw 'EINSTALL_VERSION: installed version identity differs from manifest' }
    } else {
        if (Test-Path -LiteralPath $final) { throw 'EINSTALL_CONFLICT: version directory exists without an ownership record' }
        if (Test-Path -LiteralPath $stage) { throw 'EINSTALL_STAGE: unique staging path is already occupied; preserve it' }
        try {
            $env:UV_CACHE_DIR = Join-Path $script:Root 'state\uv-cache'
            $env:UV_LINK_MODE = 'copy'
            $env:PYTHONUTF8 = '1'
            [IO.Directory]::CreateDirectory($env:UV_CACHE_DIR) | Out-Null
            [IO.Directory]::CreateDirectory((Split-Path -Parent $stage)) | Out-Null
            Write-ActionPhase 'stage-create-intent' @{stagePath=$stage;version=[string]$m.version}
            New-InstallerStageDirectory $stage
            Wait-InstallerTestGate 'version-stage-directory-created' $stage
            $stageDirectoryId=Get-DirectoryIdentity $stage
            $owner = [ordered]@{ schemaVersion=2; transactionId=[string]$script:Transaction.Id; installId=[string]$script:Receipt.installId; version=[string]$m.version; directoryId=$stageDirectoryId; ownerTokenHash=(Get-InstallerOwnerTokenHash $token) }
            $ownerBytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner | ConvertTo-Json -Compress) + "`n")
            $ownerStream=[IO.File]::Open((Join-Path $stage '.project-state-installer-owner.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$ownerStream.Write($ownerBytes,0,$ownerBytes.Length);$ownerStream.Flush($true)}finally{$ownerStream.Dispose()}
            Wait-InstallerTestGate 'version-stage-marker-flushed' $stage
            Write-ActionPhase 'stage-created' @{stagePath=$stage;stageDirectoryId=$stageDirectoryId;ownerMarkerSha256=(Get-ByteSha256 $ownerBytes);ownerTokenHash=(Get-InstallerOwnerTokenHash $token)}
            Write-ActionPhase 'venv-create-intent' @{pythonPath=$pythonBase;uvSha256=$m.uv.sha256}
            if ((Invoke-Native $uv @('venv','--offline','--allow-existing','--python',$pythonBase,$stage)) -ne 0) { throw 'EINSTALL_VENV: uv could not create the isolated environment' }
            Write-ActionPhase 'venv-created' @{pythonRelativePath='Scripts/python.exe'}
            $versionPython = Join-Path $stage 'Scripts\python.exe'
            Write-ActionPhase 'wheel-install-intent' @{wheelSha256=$m.wheel.sha256;wheelBytes=[long]$m.wheel.bytes}
            if ((Install-PinnedWheel $uv $versionPython $loaded.wheel ([string]$m.wheel.sha256) ([long]$m.wheel.bytes) ([string]$loaded.wheelFileId)) -ne 0) { throw 'EINSTALL_PACKAGE: candidate wheel installation failed' }
            Write-ActionPhase 'wheel-installed' @{wheelSha256=$m.wheel.sha256}
            $env:PYTHONDONTWRITEBYTECODE = '1'
            $prior = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            Write-ActionPhase 'verify-intent' @{expectedVersion=$m.version;expectedWheelSha256=$m.wheel.sha256}
            $identity=Get-PythonModuleIdentity $versionPython
            if($identity.exitCode -ne 0){throw 'EINSTALL_VERIFY: installed module could not be imported'}
            if(-not $identity.outputComplete -or $identity.version -cne $m.version -or -not (Test-ModuleOriginWithinEnvironment $identity.origin $stage)){throw 'EINSTALL_VERIFY: module version or origin did not match the isolated environment'}
            Assert-PlainTree $stage
            $treeHash = Get-EnvironmentManifestHash $stage
            Write-ActionPhase 'candidate-verified' @{environmentToken=$token;environmentManifestSha256=$treeHash;moduleOrigin=$identity.origin}
            Write-ActionPhase 'publish-intent' @{stagePath=$stage;finalPath=$final;environmentManifestSha256=$treeHash}
            [IO.Directory]::Move($stage,$final)
            Wait-InstallerTestGate 'version-published-before-journal' $final
            Assert-PlainTree $final
            if ((Get-EnvironmentManifestHash $final) -cne $treeHash) { throw 'EINSTALL_VERIFY: published version directory differs from its verified staging environment' }
            Write-ActionPhase 'version-published' @{finalPath=$final;environmentManifestSha256=$treeHash;environmentToken=$token}
            Write-ActionPhase 'receipt-intent' @{receiptPath=(Join-Path $script:Root 'state\install-receipt.json')}
            $script:Receipt.versions += [ordered]@{ version=$m.version; transactionId=[string]$script:Transaction.Id; wheelSha256=$m.wheel.sha256; wheelBytes=$m.wheel.bytes; installedAt=([DateTimeOffset]::FromUnixTimeMilliseconds([long]$plan.installedAtUnixMs).UtcDateTime.ToString('o')); python=$pvText; uvSha256=$m.uv.sha256; environmentToken=$token; environmentManifestSha256=$treeHash }
            Save-Receipt $script:Receipt
            Write-ActionPhase 'receipt-published' @{receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}
        } catch {
            # Preserve a failed/partial environment. The active pointer has
            # not moved, and recursive deletion cannot prove per-object
            # ownership across an external replacement race.
            throw
        }
    }
    if($operation -eq 'Install'){
        Write-ActionPhase 'shim-intent' @{shimPath=(Join-Path $script:Root 'bin\project-state.cmd')}
        Write-Shim
        Write-ActionPhase 'shim-published' @{shimSha256=$script:Receipt.shimSha256}
        Write-ActionPhase 'activate-intent' @{to=[string]$m.version}
    }else{
        $shim=Join-Path $script:Root 'bin\project-state.cmd'
        if(-not(Test-Path -LiteralPath $shim -PathType Leaf) -or -not $script:Receipt.shimSha256 -or (Get-Sha256 $shim) -cne $script:Receipt.shimSha256){throw 'EINSTALL_CONFLICT: activation requires the previously owned command shim; preserve it'}
    }
    Set-ActiveVersion $m.version
    Write-ActionPhase 'active' @{activeVersion=[string]$m.version;pointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'))}
    Write-ActionPhase 'committed' @{activeVersion=[string]$m.version}
    Write-ActionPhase 'completed' @{verified=$true}
    return [pscustomobject]@{ action='installed'; version=$m.version; command=(Join-Path $script:Root 'bin\project-state.cmd'); pathRegistered=$false; note='prototype prints an absolute command path; user PATH integration is not implemented' }
}
function Get-TransactionRecord($Transaction,[string]$Phase) {
    $id=if($Transaction.PSObject.Properties['Id'] -and $Transaction.Id){[string]$Transaction.Id}else{[string]$Transaction.Latest.transactionId}
    $fresh=Read-InstallerTransaction $script:Root $id
    $matches=@($fresh.Records | Where-Object { $_.phase -ceq $Phase })
    if($matches.Count -eq 0){return $null};return $matches[$matches.Count-1]
}
function Test-StageOwner($Plan,[string]$Path) {
    if(-not(Test-Path -LiteralPath $Path -PathType Container)){return $false}
    Assert-PlainTree $Path
    $marker=Join-Path $Path '.project-state-installer-owner.json'
    if(-not(Test-Path -LiteralPath $marker -PathType Leaf) -or (Test-Reparse $marker)){return $false}
    try{$bytes=[IO.File]::ReadAllBytes($marker);Assert-UniqueJsonProperties $bytes;$owner=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json}catch{return $false}
    $actualDirectoryId=Get-DirectoryIdentity $Path
    if(Test-PlanField $Plan 'stageOwnerProtocol' -and [int]$Plan.stageOwnerProtocol -eq 2){
        return ($owner.schemaVersion -eq 2 -and $owner.transactionId -ceq [string]$Plan.transactionId -and $owner.installId -ceq [string]$Plan.installId -and $owner.version -ceq [string]$Plan.version -and $owner.directoryId -ceq $actualDirectoryId -and $owner.ownerTokenHash -ceq (Get-InstallerOwnerTokenHash ([string]$Plan.environmentToken)))
    }
    return ($owner.schemaVersion -eq 1 -and $owner.installId -ceq $Plan.installId -and $owner.version -ceq $Plan.version -and (Get-InstallerOwnerTokenHash ([string]$owner.token)) -ceq (Get-InstallerOwnerTokenHash ([string]$Plan.environmentToken)))
}
function Test-RootStageOwner($Plan,[string]$Path) {
    if(-not(Test-Path -LiteralPath $Path -PathType Container) -or (Test-Reparse $Path)){return $false}
    $marker=Join-Path $Path '.project-state-installer-root.json'
    if(-not(Test-Path -LiteralPath $marker -PathType Leaf) -or (Test-Reparse $marker)){return $false}
    try{$bytes=[IO.File]::ReadAllBytes($marker);Assert-UniqueJsonProperties $bytes;$owner=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json}catch{return $false}
    $rootHash=(Get-InstallerRootBinding $script:Root).RootHash
    return ($owner.schemaVersion -eq 1 -and $owner.transactionId -ceq [string]$Plan.transactionId -and $owner.rootHash -ceq $rootHash -and $owner.installId -ceq [string]$Plan.installId -and $owner.rootDirectoryId -ceq (Get-DirectoryIdentity $Path) -and $owner.ownerTokenHash -ceq [string]$Plan.rootOwnerTokenHash)
}
function Get-PublicationAssessment($Transaction) {
    if([string]$Transaction.Latest.operation -cne 'Install') { return $null }
    $phase=[string]$Transaction.Latest.phase
    if($phase -ceq 'rolled-back') { return $null }
    if($phase -ceq 'abandoned-preserved') { return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_ABANDONED';permittedActions=@()} }
    if($phase -ceq 'rollback-started') { return [pscustomobject]@{outcome='RECOVERABLE_FAILURE';reasonCode='EINSTALL_ROLLBACK_PENDING';permittedActions=@('Rollback')} }
    $publishPhases=@('candidate-verified','publish-intent','version-published','receipt-intent','receipt-published','shim-intent','shim-published','activate-intent','active','committed','completed')
    if($phase -notin $publishPhases) { return $null }
    $plan=$Transaction.Latest.plan
    $candidate=Get-TransactionRecord $Transaction 'candidate-verified'
    if(-not $candidate -or -not $candidate.observed.environmentManifestSha256 -or -not $plan.stagePath -or -not $plan.finalPath) {
        return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_PROOF_MISSING';permittedActions=@()}
    }
    $stage=[string]$plan.stagePath;$final=[string]$plan.finalPath
    $stageExists=Test-Path -LiteralPath $stage;$finalExists=Test-Path -LiteralPath $final
    if($stageExists -eq $finalExists) { return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_PATH_CONFLICT';permittedActions=@()} }
    $path=if($stageExists){$stage}else{$final}
    try {
        if(-not(Test-Path -LiteralPath $path -PathType Container) -or (Test-Reparse $path) -or -not(Test-StageOwner $plan $path) -or (Get-EnvironmentManifestHash $path) -cne [string]$candidate.observed.environmentManifestSha256) {
            return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_IDENTITY_MISMATCH';permittedActions=@()}
        }
    } catch { return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_IDENTITY_UNVERIFIED';permittedActions=@()} }
    if($stageExists) {
        if($phase -in @('candidate-verified','publish-intent')) {
            $actions=if([bool]$plan.rootExisted){@('Resume','Rollback')}else{@('Resume')}
            return [pscustomobject]@{outcome='RECOVERABLE_FAILURE';reasonCode='EINSTALL_PUBLISH_PENDING';permittedActions=$actions}
        }
        return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_STAGE_REAPPEARED';permittedActions=@()}
    }
    if($phase -in @('publish-intent','version-published','receipt-intent','receipt-published','shim-intent','shim-published','activate-intent','active','committed','completed')) {
        $actions=if($phase -in @('committed','completed')){@()}else{@('Resume')}
        return [pscustomobject]@{outcome='PUBLISHED';reasonCode='EINSTALL_PUBLISH_VERIFIED';permittedActions=$actions}
    }
    return [pscustomobject]@{outcome='UNCERTAIN_STATE';reasonCode='EINSTALL_PUBLISH_UNEXPECTED_FINAL';permittedActions=@()}
}
function Invoke-InspectTransaction([string]$Id) {
    if($Id -notmatch '^[a-f0-9]{32}$'){throw 'EINSTALL_ARGUMENT: transaction ID is invalid'}
    try{$tx=Read-InstallerTransaction $script:Root $Id}catch{
        if($_.Exception.Message -match 'EINSTALL_NOT_FOUND'){throw}
        return [pscustomobject]@{schemaVersion=1;transactionId=$Id;phase='blocked-invalid-or-incomplete';journalValid=$false;permittedActions='none';reasonCode='EINSTALL_JOURNAL_INVALID';evidencePreserved=$true;values='withheld'}
    }
    $plan=$tx.Latest.plan
    $publication=Get-PublicationAssessment $tx
    $final=if((Test-PlanField $plan 'finalPath') -and $plan.finalPath){[string]$plan.finalPath}else{$null}
    $stage=if((Test-PlanField $plan 'stagePath') -and $plan.stagePath){[string]$plan.stagePath}else{$null}
    $receiptPath=Join-Path $script:Root 'state\install-receipt.json'
    $pointer=Join-Path $script:Root 'state\active-version.txt'
    $hasDurableCommit=@($tx.Records | Where-Object { $_.phase -ceq 'committed' }).Count -gt 0
    return [pscustomobject]@{
        schemaVersion=1;transactionId=$Id;operation=$tx.Latest.operation;phase=$tx.Latest.phase;rootHash=$tx.Latest.rootHash
        installId=$tx.Latest.installId;planDigest=$tx.Latest.planDigest;lastRecordDigest=$tx.Digest
        rootPresent=(Test-Path -LiteralPath $script:Root -PathType Container)
        receiptPresent=(Test-Path -LiteralPath $receiptPath -PathType Leaf)
        receiptSha256=if(Test-Path -LiteralPath $receiptPath -PathType Leaf){Get-Sha256 $receiptPath}else{$null}
        activeVersion=$(try{Get-ActiveVersion}catch{$null})
        pointerSha256=$(if(Test-Path -LiteralPath $pointer -PathType Leaf){Get-Sha256 $pointer}else{$null})
        stagePresent=$(if($stage){Test-Path -LiteralPath $stage -PathType Container}else{$false})
        stageOwnerVerified=$(if($stage -and (Test-Path -LiteralPath $stage -PathType Container)){Test-StageOwner $plan $stage}else{$false})
        finalPresent=$(if($final){Test-Path -LiteralPath $final -PathType Container}else{$false})
        finalOwnerVerified=$(if($final -and (Test-Path -LiteralPath $final -PathType Container)){Test-StageOwner $plan $final}else{$false})
        abandonedStagePath=$(if($tx.Latest.phase -ceq 'abandoned-preserved' -and $tx.Latest.observed.stagePath){[string]$tx.Latest.observed.stagePath}else{$null})
        abandonedStagePresent=$(if($tx.Latest.phase -ceq 'abandoned-preserved' -and $tx.Latest.observed.stagePath){Test-Path -LiteralPath ([string]$tx.Latest.observed.stagePath)}else{$false})
        abandonmentReasonCode=$(if($tx.Latest.phase -ceq 'abandoned-preserved'){[string]$tx.Latest.observed.reasonCode}else{$null})
        evidencePreserved=$(if($tx.Latest.phase -ceq 'abandoned-preserved'){[bool]$tx.Latest.observed.evidencePreserved}else{$false})
        publicationOutcome=$(if($publication){[string]$publication.outcome}else{$null})
        publicationReasonCode=$(if($publication){[string]$publication.reasonCode}else{$null})
        permittedActions=$(if($publication){if(@($publication.permittedActions).Count){@($publication.permittedActions)}else{'none'}}elseif($tx.Latest.phase -in @('completed','rolled-back','abandoned-preserved','committed','cleanup-pending')){'none'}elseif($hasDurableCommit){@('Resume')}else{@('Resume','Rollback')})
        values='withheld'
    }
}
function Invoke-ResumeTransaction([string]$Id) {
    $read=Read-InstallerTransaction $script:Root $Id
    $script:Transaction=Resume-InstallerTransaction $script:Root $Id
    $plan=$script:Transaction.Latest.plan
    $op=[string]$script:Transaction.Latest.operation
    $expectedRootId=if(Test-PlanField $plan 'installRootDirectoryId'){[string]$plan.installRootDirectoryId}else{''}
    if(-not $expectedRootId){$boundRecords=Read-InstallerTransaction $script:Root $Id;$rootProof=@($boundRecords.Records|Where-Object{$_.PSObject.Properties['observed'] -and $_.observed -and $_.observed.PSObject.Properties['rootDirectoryId'] -and $_.observed.rootDirectoryId}|Select-Object -Last 1);if($rootProof.Count){$expectedRootId=[string]$rootProof[0].observed.rootDirectoryId}}
    if($expectedRootId){
        $prePublicationFirstRoot=$op -ceq 'Install' -and -not [bool]$plan.rootExisted -and $script:Transaction.Latest.phase -in @('root-create-intent','root-stage-owned','root-receipt-published')
        if(-not $prePublicationFirstRoot -and (-not(Test-Path -LiteralPath $script:Root -PathType Container) -or (Get-DirectoryIdentity $script:Root) -cne $expectedRootId)){throw 'EINSTALL_ROOT_IDENTITY: transaction root directory identity differs from its durable binding; preserve all state'}
    }
    if($script:Transaction.Latest.phase -in @('completed','rolled-back','abandoned-preserved')){return Invoke-InspectTransaction $Id}
    if($op -ceq 'Uninstall'){
        if($script:Transaction.Latest.phase -ceq 'rollback-started'){return Invoke-RollbackTransaction $Id}
        return Invoke-UninstallProgress $script:Transaction
    }
    if($op -ceq 'Install' -and $script:Transaction.Latest.phase -ceq 'rollback-started'){return Invoke-RollbackTransaction $Id}
    if($op -in @('Activate','Rollback')){
        if($script:Transaction.Latest.phase -ceq 'activate-intent'){
            $script:Receipt=Get-Receipt
            $target=[string]$plan.version
            $pointer=Join-Path $script:Root 'state\active-version.txt';$actual=if(Test-Path -LiteralPath $pointer -PathType Leaf){Get-Sha256 $pointer}else{$null};$targetHash=Get-ByteSha256 ([Text.Encoding]::UTF8.GetBytes($target+"`n"))
            if($actual -cne $targetHash -and $actual -cne $plan.previousPointerSha256){throw 'EINSTALL_RECOVERY_UNCERTAIN: active pointer no longer matches either journaled state; preserve it'}
            if($actual -cne $targetHash){Set-ActiveVersion $target}
            Write-ActionPhase 'active' @{activeVersion=$target;pointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'))}
        }
        if($script:Transaction.Latest.phase -ceq 'active'){$pointer=Join-Path $script:Root 'state\active-version.txt';if(-not(Test-Path -LiteralPath $pointer -PathType Leaf) -or (Get-Sha256 $pointer) -cne [string]$script:Transaction.Latest.observed.pointerSha256){throw 'EINSTALL_RECOVERY_UNCERTAIN: active pointer differs from the durable active record; preserve it'};Write-ActionPhase 'committed' @{activeVersion=$plan.version}}
        if($script:Transaction.Latest.phase -ceq 'committed'){Write-ActionPhase 'completed' @{verified=$true}}
        return Invoke-InspectTransaction $Id
    }
    if($op -ne 'Install'){throw 'EINSTALL_RECOVERY_UNSUPPORTED: this transaction requires manual review; no files were changed'}
    if(-not [bool]$plan.rootExisted -and $script:Transaction.Latest.phase -in @('root-create-intent','root-stage-owned','root-receipt-published')){
        $rootStage=[string]$plan.rootStagePath
        $rootStageOwned=$false;try{$rootStageOwned=Test-RootStageOwner $plan $rootStage}catch{$rootStageOwned=$false}
        if((Test-Path -LiteralPath $rootStage) -and -not $rootStageOwned){
            $observedId=$null;try{if(Test-Path -LiteralPath $rootStage -PathType Container){$observedId=Get-DirectoryIdentity $rootStage}}catch{}
            Write-ActionPhase 'abandoned-preserved' @{stagePath=$rootStage;observedDirectoryId=$observedId;reasonCode='EINSTALL_ROOT_STAGE_UNOWNED';evidencePreserved=$true}
            return Invoke-InspectTransaction $Id
        }
    }
    $manifest=Get-Manifest ([string]$plan.manifestPath)
    if($manifest.manifestSha256 -cne [string]$plan.manifestSha256 -or $manifest.manifestFileId -cne [string]$plan.manifestFileId -or $manifest.wheelFileId -cne [string]$plan.wheelFileId -or $manifest.value.version -cne [string]$plan.version -or $manifest.value.wheel.sha256 -cne [string]$plan.wheelSha256){throw 'EINSTALL_RECOVERY_INPUT: pinned manifest or wheel identity changed; preserve transaction and artifacts'}
    $uv=[string]$plan.uvPath;$python=[string]$plan.pythonPath
    if((Get-Sha256 $uv) -cne [string]$plan.uvSha256 -or (Get-Sha256 $manifest.wheel) -cne [string]$plan.wheelSha256 -or -not(Test-Path -LiteralPath $python -PathType Leaf)){throw 'EINSTALL_RECOVERY_INPUT: pinned tool or wheel is unavailable or changed; preserve transaction'}
    $env:UV_CACHE_DIR=Join-Path $script:Root 'state\uv-cache';$env:UV_LINK_MODE='copy';$env:PYTHONUTF8='1';$env:PYTHONDONTWRITEBYTECODE='1'
    if($script:Transaction.Latest.phase -in @('root-create-intent','root-stage-owned','root-receipt-published','root-published')){
        $script:PendingInstallId=[string]$plan.installId
        Ensure-Root
        if($script:Transaction.Latest.phase -ceq 'root-published'){Write-ActionPhase 'root-created' @{installId=[string]$script:Receipt.installId;rootDirectoryId=(Get-DirectoryIdentity $script:Root);receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}}
    }
    if($script:Transaction.Latest.phase -ceq 'root-created'){Write-ActionPhase 'stage-create-intent' @{stagePath=[string]$plan.stagePath;version=[string]$plan.version}}
    if($script:Transaction.Latest.phase -ceq 'stage-create-intent'){
        $stage=[string]$plan.stagePath;[IO.Directory]::CreateDirectory((Split-Path -Parent $stage))|Out-Null
        if(-not(Test-Path -LiteralPath $stage)){
            New-InstallerStageDirectory $stage
            Wait-InstallerTestGate 'version-stage-directory-created' $stage
            $stageDirectoryId=Get-DirectoryIdentity $stage
            $owner=[ordered]@{schemaVersion=2;transactionId=[string]$plan.transactionId;installId=[string]$plan.installId;version=[string]$plan.version;directoryId=$stageDirectoryId;ownerTokenHash=(Get-InstallerOwnerTokenHash ([string]$plan.environmentToken))}
            $ownerBytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner|ConvertTo-Json -Compress)+"`n")
            $stream=[IO.File]::Open((Join-Path $stage '.project-state-installer-owner.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$stream.Write($ownerBytes,0,$ownerBytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
            Wait-InstallerTestGate 'version-stage-marker-flushed' $stage
        }else{
            $stageOwned=$false;try{$stageOwned=Test-StageOwner $plan $stage}catch{$stageOwned=$false}
            if(-not $stageOwned){
            Write-ActionPhase 'abandoned-preserved' @{stagePath=$stage;observedDirectoryId=$(try{Get-DirectoryIdentity $stage}catch{$null});reasonCode='EINSTALL_VERSION_STAGE_UNOWNED';evidencePreserved=$true}
            return Invoke-InspectTransaction $Id
            }
        }
        $stageDirectoryId=Get-DirectoryIdentity $stage
        Write-ActionPhase 'stage-created' @{stagePath=$stage;stageDirectoryId=$stageDirectoryId;ownerTokenHash=(Get-InstallerOwnerTokenHash ([string]$plan.environmentToken))}
    }
    if($script:Transaction.Latest.phase -ceq 'stage-created'){Write-ActionPhase 'venv-create-intent' @{pythonPath=$python;uvSha256=$plan.uvSha256}}
    if($script:Transaction.Latest.phase -ceq 'venv-create-intent'){
        $stage=[string]$plan.stagePath;$stageOwned=$false;try{$stageOwned=Test-StageOwner $plan $stage}catch{$stageOwned=$false};if(-not $stageOwned){
            Write-ActionPhase 'abandoned-preserved' @{stagePath=$stage;observedDirectoryId=$(try{Get-DirectoryIdentity $stage}catch{$null});reasonCode='EINSTALL_VERSION_STAGE_UNOWNED';evidencePreserved=$true}
            return Invoke-InspectTransaction $Id
        }
        [IO.Directory]::CreateDirectory($env:UV_CACHE_DIR)|Out-Null
        if((Invoke-Native $uv @('venv','--offline','--allow-existing','--python',$python,$stage)) -ne 0){throw 'EINSTALL_VENV: recovery could not create or resume the isolated environment'}
        if(-not(Test-Path -LiteralPath (Join-Path $stage 'Scripts\python.exe') -PathType Leaf)){throw 'EINSTALL_VENV: resumed environment has no Python executable'}
        Write-ActionPhase 'venv-created' @{pythonRelativePath='Scripts/python.exe'}
    }
    if($script:Transaction.Latest.phase -ceq 'venv-created'){Write-ActionPhase 'wheel-install-intent' @{wheelSha256=$plan.wheelSha256;wheelBytes=$plan.wheelBytes}}
    if($script:Transaction.Latest.phase -ceq 'wheel-install-intent'){
        $versionPython=Join-Path ([string]$plan.stagePath) 'Scripts\python.exe'
        if((Install-PinnedWheel $uv $versionPython $manifest.wheel ([string]$plan.wheelSha256) ([long]$plan.wheelBytes) ([string]$plan.wheelFileId)) -ne 0){throw 'EINSTALL_PACKAGE: recovery could not install the pinned wheel'}
        Write-ActionPhase 'wheel-installed' @{wheelSha256=$plan.wheelSha256}
    }
    if($script:Transaction.Latest.phase -ceq 'wheel-installed'){Write-ActionPhase 'verify-intent' @{expectedVersion=$plan.version;expectedWheelSha256=$plan.wheelSha256}}
    if($script:Transaction.Latest.phase -ceq 'verify-intent'){
        $stage=[string]$plan.stagePath;$versionPython=Join-Path $stage 'Scripts\python.exe'
        if(-not(Test-StageOwner $plan $stage)){throw 'EINSTALL_RECOVERY_UNCERTAIN: environment stage ownership changed'}
        $identity=Get-PythonModuleIdentity $versionPython
        if($identity.exitCode -ne 0 -or -not $identity.outputComplete -or $identity.version -cne [string]$plan.version -or -not (Test-ModuleOriginWithinEnvironment $identity.origin $stage)){throw 'EINSTALL_VERIFY: recovered module version or origin failed verification'}
        Assert-PlainTree $stage;$treeHash=Get-EnvironmentManifestHash $stage
        Write-ActionPhase 'candidate-verified' @{environmentToken=[string]$plan.environmentToken;environmentManifestSha256=$treeHash;moduleOrigin=$identity.origin}
    }
    if($script:Transaction.Latest.phase -ceq 'candidate-verified'){Write-ActionPhase 'publish-intent' @{stagePath=[string]$plan.stagePath;finalPath=[string]$plan.finalPath;environmentManifestSha256=[string]$script:Transaction.Latest.observed.environmentManifestSha256}}
    if($script:Transaction.Latest.phase -ceq 'publish-intent'){
        $stage=[string]$plan.stagePath;$final=[string]$plan.finalPath
        $verifyRecord=Get-TransactionRecord $script:Transaction 'candidate-verified'
        $expectedTree=if($verifyRecord){[string]$verifyRecord.observed.environmentManifestSha256}else{[string]$script:Transaction.Latest.observed.environmentManifestSha256}
        if((Test-Path -LiteralPath $stage) -and -not(Test-Path -LiteralPath $final)){
            if(-not(Test-StageOwner $plan $stage) -or (Get-EnvironmentManifestHash $stage) -cne $expectedTree){throw 'EINSTALL_RECOVERY_UNCERTAIN: stage no longer matches the verified candidate; preserve it'}
            [IO.Directory]::Move($stage,$final)
        }elseif(-not(Test-Path -LiteralPath $final) -or (Test-Path -LiteralPath $stage)){throw 'EINSTALL_RECOVERY_UNCERTAIN: stage/final publication state is ambiguous'}
        Wait-InstallerTestGate 'version-published-before-journal' $final
        if(-not(Test-StageOwner $plan $final) -or (Get-EnvironmentManifestHash $final) -cne $expectedTree){throw 'EINSTALL_RECOVERY_UNCERTAIN: published version differs from the verified candidate'}
        Write-ActionPhase 'version-published' @{finalPath=$final;environmentManifestSha256=$expectedTree;environmentToken=[string]$plan.environmentToken}
    }
    if($script:Transaction.Latest.phase -ceq 'version-published'){Write-ActionPhase 'receipt-intent' @{receiptPath=(Join-Path $script:Root 'state\install-receipt.json')}}
    if($script:Transaction.Latest.phase -ceq 'receipt-intent'){
        $script:Receipt=Get-Receipt;$existing=@($script:Receipt.versions|Where-Object{$_.version -ceq [string]$plan.version})
        if($existing.Count -gt 1){throw 'EINSTALL_RECEIPT: duplicate version record prevents recovery'}
        if($existing.Count -eq 0){
            $currentReceipt=Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json')
            if($plan.previousReceiptSha256 -and $currentReceipt -cne [string]$plan.previousReceiptSha256){throw 'EINSTALL_RECOVERY_UNCERTAIN: receipt changed outside this transaction'}
            $proof=Get-TransactionRecord $script:Transaction 'version-published';if(-not $proof){$proof=Get-TransactionRecord $script:Transaction 'candidate-verified'}
            if(-not $proof -or -not $proof.observed.environmentManifestSha256){throw 'EINSTALL_RECOVERY_UNCERTAIN: no durable verified environment digest is available; preserve the transaction'}
            $treeHash=[string]$proof.observed.environmentManifestSha256
            $script:Receipt.versions += [ordered]@{version=[string]$plan.version;transactionId=[string]$script:Transaction.Id;wheelSha256=[string]$plan.wheelSha256;wheelBytes=[long]$plan.wheelBytes;installedAt=([DateTimeOffset]::FromUnixTimeMilliseconds([long]$plan.installedAtUnixMs).UtcDateTime.ToString('o'));python=[string]$plan.pythonVersion;uvSha256=[string]$plan.uvSha256;environmentToken=[string]$plan.environmentToken;environmentManifestSha256=$treeHash}
            Save-Receipt $script:Receipt
        }
        Write-ActionPhase 'receipt-published' @{receiptSha256=(Get-Sha256 (Join-Path $script:Root 'state\install-receipt.json'))}
    }
    if($script:Transaction.Latest.phase -ceq 'receipt-published'){Write-ActionPhase 'shim-intent' @{shimPath=(Join-Path $script:Root 'bin\project-state.cmd')}}
    if($script:Transaction.Latest.phase -ceq 'shim-intent'){$script:Receipt=Get-Receipt;Write-Shim;Write-ActionPhase 'shim-published' @{shimSha256=$script:Receipt.shimSha256}}
    if($script:Transaction.Latest.phase -ceq 'shim-published'){Write-ActionPhase 'activate-intent' @{to=[string]$plan.version}}
    if($script:Transaction.Latest.phase -ceq 'activate-intent'){$script:Receipt=Get-Receipt;if((Get-ActiveVersion) -cne [string]$plan.version){Set-ActiveVersion ([string]$plan.version)};Write-ActionPhase 'active' @{activeVersion=[string]$plan.version;pointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'))}}
    if($script:Transaction.Latest.phase -ceq 'active'){Write-ActionPhase 'committed' @{activeVersion=[string]$plan.version}}
    if($script:Transaction.Latest.phase -ceq 'committed'){Write-ActionPhase 'completed' @{verified=$true}}
    return Invoke-InspectTransaction $Id
}
function Invoke-RollbackTransaction([string]$Id) {
    $read=Read-InstallerTransaction $script:Root $Id;$phase=[string]$read.Latest.phase;$plan=$read.Latest.plan
    if($phase -in @('completed','rolled-back','abandoned-preserved')){return Invoke-InspectTransaction $Id}
    if($phase -in @('committed','cleanup-pending') -or @($read.Records|Where-Object{$_.phase -ceq 'committed'}).Count -gt 0){throw 'EINSTALL_ROLLBACK_REFUSED: committed installer operations can only continue cleanup; use a new program version rollback if needed'}
    if($read.Latest.operation -ceq 'Uninstall'){
        $script:Transaction=Resume-InstallerTransaction $script:Root $Id
        if($phase -cne 'rollback-started'){Write-ActionPhase 'rollback-started' @{direction='restore-quarantined-objects'}}
        $plan=$script:Transaction.Latest.plan
        Ensure-RetirementContainer $plan $Id ([string]$read.Latest.planDigest)
        $items=@($plan.retireItems)
        for($i=$items.Count-1;$i -ge 0;$i--){
            $item=$items[$i];$state=Get-RetiredItemState $item
            if($state -ceq 'absent'){throw 'EINSTALL_ROLLBACK_UNCERTAIN: uninstall object is absent from both live and quarantine paths; preserve transaction'}
            if($state -ceq 'quarantine'){
                [IO.Directory]::CreateDirectory((Split-Path -Parent ([string]$item.source)))|Out-Null
                if($item.kind -ceq 'file'){[IO.File]::Move([string]$item.quarantine,[string]$item.source)}else{[IO.Directory]::Move([string]$item.quarantine,[string]$item.source)}
            }
            if((Get-RetiredItemState $item) -cne 'source'){throw 'EINSTALL_ROLLBACK_INCOMPLETE: restored object did not verify at its original path'}
        }
        $script:Transaction=Resume-InstallerTransaction $script:Root $Id
        Write-ActionPhase 'rolled-back' @{restoredItems=$items.Count;rootPreserved=$true}
        return Invoke-InspectTransaction $Id
    }
    if($read.Latest.operation -ceq 'Install'){
        if(-not [bool]$plan.rootExisted -or $phase -notin @('stage-created','venv-create-intent','venv-created','wheel-install-intent','wheel-installed','verify-intent','candidate-verified','publish-intent','rollback-started')){
            throw 'EINSTALL_ROLLBACK_REFUSED: only an owned, uncommitted upgrade stage with the prior installation unchanged can be quarantined; preserve transaction'
        }
        $script:Transaction=Resume-InstallerTransaction $script:Root $Id
        $expectedRootId=[string]$plan.installRootDirectoryId
        if(-not $expectedRootId -or (Get-DirectoryIdentity $script:Root) -cne $expectedRootId){throw 'EINSTALL_ROLLBACK_UNCERTAIN: managed root identity differs; preserve transaction and all files'}
        $receiptPath=Join-Path $script:Root 'state\install-receipt.json';$pointer=Join-Path $script:Root 'state\active-version.txt';$shim=Join-Path $script:Root 'bin\project-state.cmd'
        if(-not(Test-Path -LiteralPath $receiptPath -PathType Leaf) -or (Get-Sha256 $receiptPath) -cne [string]$plan.previousReceiptSha256 -or
           -not(Test-Path -LiteralPath $pointer -PathType Leaf) -or (Get-Sha256 $pointer) -cne [string]$plan.previousPointerSha256 -or
           -not(Test-Path -LiteralPath $shim -PathType Leaf) -or (Get-Sha256 $shim) -cne [string]$plan.previousShimSha256 -or
           (Get-ActiveVersion) -cne [string]$plan.previousActiveVersion){throw 'EINSTALL_ROLLBACK_UNCERTAIN: receipt, command, active pointer, or prior version changed; preserve transaction'}
        [void](Get-Receipt)
        $stage=[string]$plan.stagePath;$quarantine=Join-Path $script:Root ('state\failed-install\'+$Id)
        $intent=Get-TransactionRecord $script:Transaction 'rollback-started'
        if(-not $intent){
            if(-not(Test-Path -LiteralPath $stage -PathType Container) -or (Test-Path -LiteralPath $quarantine)){throw 'EINSTALL_ROLLBACK_UNCERTAIN: expected failed stage is missing or quarantine is occupied; preserve both paths'}
            if(-not(Test-StageOwner $plan $stage)){throw 'EINSTALL_ROLLBACK_UNCERTAIN: failed stage owner marker does not bind to this transaction; preserve it'}
            Assert-PlainTree $stage
            $stageId=Get-EntryIdentity $stage $true;$stageHash=Get-EnvironmentManifestHash $stage
            Write-ActionPhase 'rollback-started' @{stagePath=$stage;stageIdentity=$stageId;stageManifestSha256=$stageHash;quarantinePath=$quarantine;priorActiveVersion=[string]$plan.previousActiveVersion;priorPointerSha256=[string]$plan.previousPointerSha256;priorReceiptSha256=[string]$plan.previousReceiptSha256;priorShimSha256=[string]$plan.previousShimSha256}
            $script:Transaction=Resume-InstallerTransaction $script:Root $Id;$intent=Get-TransactionRecord $script:Transaction 'rollback-started'
        }
        $proof=$intent.observed
        if([string]$proof.stagePath -cne $stage -or [string]$proof.quarantinePath -cne $quarantine){throw 'EINSTALL_ROLLBACK_UNCERTAIN: rollback intent path binding differs; preserve transaction'}
        $sourceExists=Test-Path -LiteralPath $stage -PathType Container;$quarantineExists=Test-Path -LiteralPath $quarantine -PathType Container
        if($sourceExists -eq $quarantineExists){throw 'EINSTALL_ROLLBACK_UNCERTAIN: failed stage is present in both or neither location; preserve transaction'}
        if($sourceExists){
            if(-not(Test-StageOwner $plan $stage) -or (Get-EntryIdentity $stage $true) -cne [string]$proof.stageIdentity -or (Get-EnvironmentManifestHash $stage) -cne [string]$proof.stageManifestSha256){throw 'EINSTALL_ROLLBACK_UNCERTAIN: failed stage changed after rollback intent; preserve it'}
            Assert-PlainAncestors $stage
            [IO.Directory]::CreateDirectory((Split-Path -Parent $quarantine))|Out-Null
            if(Test-Path -LiteralPath $quarantine){throw 'EINSTALL_ROLLBACK_UNCERTAIN: quarantine path became occupied; preserve both'}
            [IO.Directory]::Move($stage,$quarantine)
            Wait-InstallerTestGate 'rollback-stage-quarantined-before-journal' $quarantine
        }
        if(-not(Test-StageOwner $plan $quarantine) -or (Get-EntryIdentity $quarantine $true) -cne [string]$proof.stageIdentity -or (Get-EnvironmentManifestHash $quarantine) -cne [string]$proof.stageManifestSha256){throw 'EINSTALL_ROLLBACK_INCOMPLETE: quarantined upgrade stage did not verify; preserve transaction'}
        Write-ActionPhase 'rolled-back' @{quarantinePath=$quarantine;quarantinedIdentity=[string]$proof.stageIdentity;quarantinedManifestSha256=[string]$proof.stageManifestSha256;priorActiveVersion=[string]$plan.previousActiveVersion;priorPointerSha256=[string]$plan.previousPointerSha256;priorReceiptSha256=[string]$plan.previousReceiptSha256;priorShimSha256=[string]$plan.previousShimSha256}
        return Invoke-InspectTransaction $Id
    }
    throw 'EINSTALL_ROLLBACK_REFUSED: unfinished install or activation records are continued with Resume; file destruction is not an installer rollback action'
}

function Invoke-TransactionList {
    $items=@(Get-InstallerTransactions $script:Root)
    return [pscustomobject]@{schemaVersion=1;rootHash=(Get-InstallerRootBinding $script:Root).RootHash;transactions=@($items|ForEach-Object{[pscustomobject]@{transactionId=$_.Latest.transactionId;operation=$_.Latest.operation;phase=$_.Latest.phase;digest=$_.Digest;journalValid=(-not $_.Invalid);permittedActions=if($_.Invalid -or $_.Latest.phase -in @('completed','rolled-back','abandoned-preserved')){'none'}else{@('Resume','Rollback')}}});values='withheld'}
}

function Assert-TransactionNoPending([string]$ExceptId) {
    $pending=@(Get-InstallerTransactions $script:Root|Where-Object{$_.Latest.phase -notin @('completed','rolled-back','abandoned-preserved') -and $_.Latest.transactionId -cne $ExceptId})
    if($pending.Count -gt 0){throw 'EINSTALL_RECOVERY_REQUIRED: an earlier installer transaction is unresolved; inspect and resume or roll it back first'}
}
function Invoke-Activate([string]$TargetVersion) {
    $script:Receipt=Get-Receipt;if(-not $script:Receipt){throw 'EINSTALL_RECEIPT: no owned installation was found'}
    $current=Get-ActiveVersion;$version=[string]$TargetVersion
    $record=@($script:Receipt.versions|Where-Object{$_.version -ceq $version});if($record.Count -ne 1){throw 'EINSTALL_VERSION: requested version is not uniquely owned'}
    $plan=@{version=$version;installRootDirectoryId=(Get-DirectoryIdentity $script:Root);previousActiveVersion=$current;previousPointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'));wheelSha256=[string]$record[0].wheelSha256}
    $script:Transaction=New-InstallerTransaction $script:Root Activate $script:Receipt.installId ([guid]::NewGuid().ToString('N')) $plan ''
    Write-ActionPhase 'activate-intent' @{from=$current;to=$version}
    Set-ActiveVersion $version
    Write-ActionPhase 'active' @{activeVersion=$version;pointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'))}
    Write-ActionPhase 'committed' @{activeVersion=$version};Write-ActionPhase 'completed' @{verified=$true}
    return [pscustomobject]@{action='activate';from=$current;to=$version;command=(Join-Path $script:Root 'bin\project-state.cmd')}
}

function Invoke-Rollback {
    $script:Receipt = Get-Receipt
    if (-not $script:Receipt) { throw 'EINSTALL_RECEIPT: no owned installation was found' }
    Assert-PlainAncestors $script:Root
    $current = Get-ActiveVersion
    $prior = @($script:Receipt.versions | Where-Object { $_.version -cne $current } | Sort-Object installedAt -Descending | Select-Object -First 1)
    if ($prior.Count -ne 1) { throw 'EINSTALL_ROLLBACK: no previously installed version is available' }
    $plan=@{version=[string]$prior[0].version;installRootDirectoryId=(Get-DirectoryIdentity $script:Root);previousActiveVersion=[string]$current;previousPointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'));wheelSha256=[string]$prior[0].wheelSha256}
    $script:Transaction=New-InstallerTransaction $script:Root Rollback $script:Receipt.installId ([guid]::NewGuid().ToString('N')) $plan ''
    Write-ActionPhase 'activate-intent' @{from=$current;to=[string]$prior[0].version}
    Set-ActiveVersion $prior[0].version
    Write-ActionPhase 'active' @{activeVersion=[string]$prior[0].version;pointerSha256=(Get-Sha256 (Join-Path $script:Root 'state\active-version.txt'))}
    Write-ActionPhase 'committed' @{activeVersion=[string]$prior[0].version};Write-ActionPhase 'completed' @{verified=$true}
    return [pscustomobject]@{ action='rollback'; from=$current; to=$prior[0].version; command=(Join-Path $script:Root 'bin\project-state.cmd') }
}
function Invoke-Status {
    $script:Receipt = Get-Receipt
    if (-not $script:Receipt) { throw 'EINSTALL_RECEIPT: no owned installation was found' }
    Assert-PlainAncestors $script:Root
    return [pscustomobject]@{ action='status'; activeVersion=(Get-ActiveVersion); versions=@($script:Receipt.versions | ForEach-Object { $_.version }); command=(Join-Path $script:Root 'bin\project-state.cmd') }
}
function Get-RetiredItemState($Item) {
    $sourceExists=Test-Path -LiteralPath ([string]$Item.source)
    $retiredExists=Test-Path -LiteralPath ([string]$Item.quarantine)
    if($sourceExists -and $retiredExists){throw 'EINSTALL_RECOVERY_UNCERTAIN: source and quarantine both exist; preserve both'}
    if(-not $sourceExists -and -not $retiredExists){return 'absent'}
    $path=if($sourceExists){[string]$Item.source}else{[string]$Item.quarantine}
    if($Item.kind -ceq 'file'){
        if(-not(Test-Path -LiteralPath $path -PathType Leaf) -or (Test-Reparse $path)){throw 'EINSTALL_RECOVERY_UNCERTAIN: retired file is not a plain file'}
        $fi=Get-Item -LiteralPath $path -Force
        $currentId=Get-EntryIdentity $path $false
        if($fi.Length -ne [long]$Item.bytes -or (Get-Sha256 $path) -cne [string]$Item.sha256 -or $currentId -cne [string]$Item.fileId -or $currentId -notmatch ':1$'){throw 'EINSTALL_RECOVERY_UNCERTAIN: retired file identity differs or is hard-linked; preserve it'}
    }elseif($Item.kind -ceq 'directory'){
        if(-not(Test-Path -LiteralPath $path -PathType Container)){throw 'EINSTALL_RECOVERY_UNCERTAIN: retired directory type changed'}
        Assert-PlainTree $path
        if((Get-EnvironmentManifestHash $path) -cne [string]$Item.environmentManifestSha256 -or (Get-EntryIdentity $path $true) -cne [string]$Item.fileId){throw 'EINSTALL_RECOVERY_UNCERTAIN: retired directory identity or contents differ; preserve it'}
        $marker=Join-Path $path '.project-state-installer-owner.json'
        if(-not(Test-Path -LiteralPath $marker -PathType Leaf) -or (Test-Reparse $marker)){throw 'EINSTALL_RECOVERY_UNCERTAIN: retired directory owner marker is missing or linked'}
        $ownerBytes=[IO.File]::ReadAllBytes($marker);Assert-UniqueJsonProperties $ownerBytes;$owner=[Text.Encoding]::UTF8.GetString($ownerBytes)|ConvertFrom-Json
        $tokenHash=Get-InstallerOwnerTokenHash ([string]$Item.environmentToken)
        if($owner.schemaVersion -eq 2){
            $directoryId=(Get-EntryIdentity $path $true) -replace ':[0-9]+$',''
            if($owner.installId -cne [string]$Item.installId -or $owner.version -cne [string]$Item.version -or $owner.transactionId -cne [string]$Item.transactionId -or $owner.directoryId -cne $directoryId -or $owner.ownerTokenHash -cne $tokenHash){throw 'EINSTALL_RECOVERY_UNCERTAIN: retired directory owner does not match immutable plan'}
        }elseif($owner.schemaVersion -eq 1){
            if($owner.installId -cne [string]$Item.installId -or $owner.version -cne [string]$Item.version -or (Get-InstallerOwnerTokenHash ([string]$owner.token)) -cne $tokenHash){throw 'EINSTALL_RECOVERY_UNCERTAIN: legacy retired directory owner does not match immutable plan'}
        }else{throw 'EINSTALL_RECOVERY_UNCERTAIN: retired directory owner schema is unsupported'}
    }else{throw 'EINSTALL_JOURNAL_INVALID: unsupported retire item kind'}
    return $(if($sourceExists){'source'}else{'quarantine'})
}

function Ensure-RetirementContainer($Plan,[string]$TransactionId,[string]$PlanDigest) {
    $root=[string]$Plan.quarantineRoot
    Assert-PlainAncestors $root
    if(Test-Path -LiteralPath $root -PathType Container){
        if(Test-Reparse $root){throw 'EINSTALL_RECOVERY_UNCERTAIN: quarantine root is linked'}
        $marker=Join-Path $root 'retirement-owner.json'
        if(-not(Test-Path -LiteralPath $marker -PathType Leaf) -or (Test-Reparse $marker)){throw 'EINSTALL_RECOVERY_UNCERTAIN: quarantine root has no plain owner marker'}
        $owner=[IO.File]::ReadAllText($marker,[Text.Encoding]::UTF8)|ConvertFrom-Json
        if($owner.transactionId -cne $TransactionId -or $owner.planDigest -cne $PlanDigest){throw 'EINSTALL_RECOVERY_UNCERTAIN: quarantine root belongs to another transaction'}
    }elseif(Test-Path -LiteralPath $root){throw 'EINSTALL_RECOVERY_UNCERTAIN: quarantine path is not a directory'}else{
        [IO.Directory]::CreateDirectory($root)|Out-Null
        $marker=Join-Path $root 'retirement-owner.json'
        $owner=[ordered]@{schemaVersion=1;transactionId=$TransactionId;planDigest=$PlanDigest}
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($owner|ConvertTo-Json -Compress)+"`n")
        $fs=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$fs.Write($bytes,0,$bytes.Length);$fs.Flush($true)}finally{$fs.Dispose()}
    }
}

function Invoke-UninstallProgress($Transaction) {
    $script:Transaction=$Transaction
    $plan=$script:Transaction.Latest.plan
    Ensure-RetirementContainer $plan $script:Transaction.Id ([string]$script:Transaction.Latest.planDigest)
    $items=@($plan.retireItems)
    if($script:Transaction.Latest.phase -ceq 'prepared'){Write-ActionPhase 'retire-intent-0000' @{index=0;kind=[string]$items[0].kind;source=[string]$items[0].source;quarantine=[string]$items[0].quarantine;identity=[string]$items[0].identity}}
    if($script:Transaction.Latest.phase -ceq 'committed'){Write-ActionPhase 'cleanup-pending' @{quarantineRoot=$plan.quarantineRoot;retainedItems=$items.Count}}
    $phase=[string]$script:Transaction.Latest.phase
    if($phase -match '^retire-intent-([0-9]{4})$'){
        $i=[int]$Matches[1];$item=$items[$i];$state=Get-RetiredItemState $item
        if($state -ceq 'source'){
            $parent=Split-Path -Parent ([string]$item.quarantine);[IO.Directory]::CreateDirectory($parent)|Out-Null
            if($item.kind -ceq 'file'){[IO.File]::Move([string]$item.source,[string]$item.quarantine)}else{[IO.Directory]::Move([string]$item.source,[string]$item.quarantine)}
            $state=Get-RetiredItemState $item
        }
        if($state -cne 'quarantine'){throw 'EINSTALL_RECOVERY_UNCERTAIN: retirement move did not produce its exact quarantined object'}
        Write-ActionPhase ('retired-{0:D4}' -f $i) @{index=$i;kind=[string]$item.kind;source=[string]$item.source;quarantine=[string]$item.quarantine;identity=[string]$item.identity}
        $phase=[string]$script:Transaction.Latest.phase
    }
    while($phase -match '^retired-([0-9]{4})$'){
        $next=[int]$Matches[1]+1
        if($next -lt $items.Count){
            Write-ActionPhase ('retire-intent-{0:D4}' -f $next) @{index=$next;kind=[string]$items[$next].kind;source=[string]$items[$next].source;quarantine=[string]$items[$next].quarantine;identity=[string]$items[$next].identity}
            $phase=[string]$script:Transaction.Latest.phase
            $i=$next;$item=$items[$i];$state=Get-RetiredItemState $item
            if($state -ceq 'source'){
                [IO.Directory]::CreateDirectory((Split-Path -Parent ([string]$item.quarantine)))|Out-Null
                if($item.kind -ceq 'file'){[IO.File]::Move([string]$item.source,[string]$item.quarantine)}else{[IO.Directory]::Move([string]$item.source,[string]$item.quarantine)}
                $state=Get-RetiredItemState $item
            }
            if($state -cne 'quarantine'){throw 'EINSTALL_RECOVERY_UNCERTAIN: retirement move did not produce its exact quarantined object'}
            Write-ActionPhase ('retired-{0:D4}' -f $i) @{index=$i;kind=[string]$item.kind;source=[string]$item.source;quarantine=[string]$item.quarantine;identity=[string]$item.identity}
            $phase=[string]$script:Transaction.Latest.phase
        }else{break}
    }
    if($phase -match '^retired-([0-9]{4})$' -and [int]$Matches[1] -eq ($items.Count-1)){
        foreach($item in $items){if((Get-RetiredItemState $item) -cne 'quarantine'){throw 'EINSTALL_RECOVERY_UNCERTAIN: pre-commit retirement set is incomplete'}}
        Write-ActionPhase 'committed' @{activeVersion=$null;retiredItems=$items.Count;quarantineRoot=[string]$plan.quarantineRoot}
        $phase='committed'
    }
    if($phase -ceq 'committed'){Write-ActionPhase 'cleanup-pending' @{quarantineRoot=$plan.quarantineRoot;retainedItems=$items.Count};$phase='cleanup-pending'}
    if($phase -ceq 'cleanup-pending' -or $phase -match '^cleanup-intent-[0-9]{4}$'){
        for($i=0;$i -lt $items.Count;$i++){
            $read=Read-InstallerTransaction $script:Root $script:Transaction.Id
            $done=@($read.Records|Where-Object{$_.phase -ceq ('cleanup-done-{0:D4}' -f $i)}).Count -gt 0
            if($done){continue}
            $intent=@($read.Records|Where-Object{$_.phase -ceq ('cleanup-intent-{0:D4}' -f $i)}).Count -gt 0
            if(-not $intent){Write-ActionPhase ('cleanup-intent-{0:D4}' -f $i) @{index=$i;quarantine=[string]$items[$i].quarantine;identity=[string]$items[$i].identity}}
            $state=Get-RetiredItemState $items[$i]
            if($state -ceq 'source'){throw 'EINSTALL_CLEANUP_PENDING: object reappeared at its live path after uninstall commit; preserve both locations'}
            if($state -ceq 'quarantine'){
                if($items[$i].kind -ceq 'file'){[IO.File]::Delete([string]$items[$i].quarantine)}else{Remove-Item -LiteralPath ([string]$items[$i].quarantine) -Recurse -Force}
            }
            if((Test-Path -LiteralPath ([string]$items[$i].quarantine)) -or (Test-Path -LiteralPath ([string]$items[$i].source))){throw 'EINSTALL_CLEANUP_PENDING: quarantined object remains or reappeared; inspect before retry'}
            Write-ActionPhase ('cleanup-done-{0:D4}' -f $i) @{index=$i;removed=$true}
        }
        $container=[string]$plan.quarantineRoot
        # Keep the empty, transaction-bound container as durable uninstall evidence.
        # It contains no application files after completion and is never recursively
        # removed by the installer.
        Write-ActionPhase 'completed' @{uninstalled=$true;rootPreserved=$true}
    }
    return [pscustomobject]@{action='uninstall';phase=$script:Transaction.Latest.phase;transactionId=$script:Transaction.Id;rootPreserved=$true;quarantineRoot=[string]$plan.quarantineRoot}
}

function Invoke-Uninstall {
    $script:Receipt=Get-Receipt
    if(-not $script:Receipt){throw 'EINSTALL_RECEIPT: no owned installation was found; nothing was changed'}
    Assert-PlainAncestors $script:Root
    $ownedNames=@($script:Receipt.versions|ForEach-Object{[string]$_.version})
    $versionRoot=Join-Path $script:Root 'versions'
    foreach($child in Get-ChildItem -LiteralPath $versionRoot -Force){if($child.Name -notin $ownedNames -or -not $child.PSIsContainer){throw 'EUNINSTALL_CONFLICT: versions contains an unowned entry; nothing was changed'}}
    $operationId=[guid]::NewGuid().ToString('N');$retirementRoot=Join-Path $script:Root ('state\retired\'+$operationId)
    $items=[System.Collections.Generic.List[object]]::new();$index=0
    $shim=Join-Path $script:Root 'bin\project-state.cmd'
    if(Test-Path -LiteralPath $shim){if((Test-Reparse $shim) -or -not $script:Receipt.shimSha256 -or (Get-Sha256 $shim) -cne $script:Receipt.shimSha256){throw 'EINSTALL_CONFLICT: command shim changed or is linked; it was preserved'};$fileId=Get-EntryIdentity $shim $false;if($fileId -notmatch ':1$'){throw 'EINSTALL_CONFLICT: command shim has multiple hard links; it was preserved'};$items.Add([ordered]@{kind='file';source=$shim;quarantine=(Join-Path $retirementRoot ('{0:D4}.shim' -f $index));bytes=[long](Get-Item $shim).Length;sha256=(Get-Sha256 $shim);fileId=$fileId;identity=(Get-Sha256 $shim)});$index++}
    foreach($record in @($script:Receipt.versions)){
        $folder=Join-Path $script:Root ('versions\'+[string]$record.version)
        if(-not(Test-Path -LiteralPath $folder -PathType Container) -or (Test-Reparse $folder)){throw 'EUNINSTALL_CONFLICT: an owned version is missing or linked; preserve receipt and files'}
        Assert-PlainTree $folder
        if((Get-EnvironmentIdentity $folder) -cne [string]$record.environmentToken -or (Get-EnvironmentManifestHash $folder) -cne [string]$record.environmentManifestSha256){throw 'EUNINSTALL_CONFLICT: installed environment identity changed; preserve it'}
        $items.Add([ordered]@{kind='directory';source=$folder;quarantine=(Join-Path $retirementRoot ('{0:D4}.version' -f $index));installId=[string]$script:Receipt.installId;transactionId=[string]$record.transactionId;version=[string]$record.version;environmentToken=[string]$record.environmentToken;environmentManifestSha256=[string]$record.environmentManifestSha256;fileId=(Get-EntryIdentity $folder $true);identity=[string]$record.environmentManifestSha256});$index++
    }
    $pointer=Join-Path $script:Root 'state\active-version.txt'
    if(Test-Path -LiteralPath $pointer){$activeVersion=Get-ActiveVersion;if((Test-Reparse $pointer) -or $activeVersion -notin $ownedNames){throw 'EINSTALL_CONFLICT: active pointer is linked or does not reference an owned version'};$fileId=Get-EntryIdentity $pointer $false;if($fileId -notmatch ':1$'){throw 'EINSTALL_CONFLICT: active pointer has multiple hard links; it was preserved'};$items.Add([ordered]@{kind='file';source=$pointer;quarantine=(Join-Path $retirementRoot ('{0:D4}.pointer' -f $index));bytes=[long](Get-Item $pointer).Length;sha256=(Get-Sha256 $pointer);fileId=$fileId;identity=(Get-Sha256 $pointer)});$index++}
    $receipt=Join-Path $script:Root 'state\install-receipt.json'
    $receiptHash=Get-Sha256 $receipt;$receiptId=Get-EntryIdentity $receipt $false;if($receiptId -notmatch ':1$'){throw 'EINSTALL_CONFLICT: install receipt has multiple hard links; it was preserved'};$items.Add([ordered]@{kind='file';source=$receipt;quarantine=(Join-Path $retirementRoot ('{0:D4}.receipt' -f $index));bytes=[long](Get-Item $receipt).Length;sha256=$receiptHash;fileId=$receiptId;identity=$receiptHash})
    if($items.Count -eq 0){throw 'EUNINSTALL_STATE: no owned installation objects are available'}
    $rootOwner=Join-Path $script:Root '.project-state-installer-root.json';$rootOwnerId=Get-EntryIdentity $rootOwner $false;if($rootOwnerId -notmatch ':1$'){throw 'EUNINSTALL_CONFLICT: installation owner marker has multiple hard links; it was preserved'};$rootOwnerHash=Get-Sha256 $rootOwner
    $items.Add([ordered]@{kind='file';source=$rootOwner;quarantine=(Join-Path $retirementRoot ('{0:D4}.root-owner' -f $index));bytes=[long](Get-Item $rootOwner).Length;sha256=$rootOwnerHash;fileId=$rootOwnerId;identity=$rootOwnerHash})
    $plan=@{installId=[string]$script:Receipt.installId;installRootDirectoryId=(Get-DirectoryIdentity $script:Root);quarantineRoot=$retirementRoot;quarantineId=$operationId;retireItems=@($items.ToArray());previousReceiptSha256=$receiptHash;previousActiveVersion=(Get-ActiveVersion)}
    $tx=New-InstallerTransaction $script:Root Uninstall $script:Receipt.installId ([guid]::NewGuid().ToString('N')) $plan ''
    $full=Read-InstallerTransaction $script:Root $tx.Id
    $script:Transaction=Resume-InstallerTransaction $script:Root $tx.Id
    return Invoke-UninstallProgress $script:Transaction
}

$script:Root = Get-Canonical $InstallRoot
$script:Receipt = $null
$installerLock = $null
$script:InstallerEnvironmentNames = @('UV_CACHE_DIR','UV_LINK_MODE','PYTHONUTF8','PYTHONDONTWRITEBYTECODE')
$script:InstallerEnvironmentBefore = @{}
$processEnvironment=[Environment]::GetEnvironmentVariables('Process')
foreach ($name in $script:InstallerEnvironmentNames) {
    $present=$processEnvironment.Contains($name)
    $script:InstallerEnvironmentBefore[$name] = [pscustomobject]@{present=$present;value=$(if($present){[Environment]::GetEnvironmentVariable($name,'Process')}else{$null})}
}
$script:InstallerExitCode = 0
try {
        Assert-PlainAncestors $script:Root
        if($Action -ceq 'Inspect'){
            if($TransactionId){$result=Invoke-InspectTransaction $TransactionId}else{$result=Invoke-TransactionList}
        }else{
            $installerLock=Enter-InstallerFileLock $script:Root $(if($EnableTestHooks){$TestGateRoot}else{''}) $(if($EnableTestHooks){$TestGatePhase}else{''})
            if($Action -ceq 'Resume'){
                $id=$TransactionId
                if(-not $id){$pending=@(Get-InstallerTransactions $script:Root|Where-Object{$_.Latest.phase -notin @('completed','rolled-back','abandoned-preserved')});if($pending.Count -ne 1){throw 'EINSTALL_ARGUMENT: Resume requires TransactionId unless exactly one pending transaction exists'};$id=[string]$pending[0].Latest.transactionId}
                $result=Invoke-ResumeTransaction $id
            }elseif($Action -ceq 'Rollback' -and $TransactionId){
                $result=Invoke-RollbackTransaction $TransactionId
            }else{
                Assert-TransactionNoPending ''
                switch ($Action) {
                    'Install' { $result = Install-Version }
                    'Upgrade' { $result = Install-Version }
                    'Activate' { if(-not $Version){throw 'EINSTALL_ARGUMENT: Activate requires Version'};$result=Invoke-Activate $Version }
                    'Status' { $result = Invoke-Status }
                    'Rollback' { $result = Invoke-Rollback }
                    'Uninstall' { $result = Invoke-Uninstall }
                    default { throw 'EINSTALL_ARGUMENT: unsupported installer action' }
                }
            }
        }
    $result | ConvertTo-Json -Depth 8 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if($script:Transaction -and $script:Transaction.Id){[Console]::Error.WriteLine(('EINSTALL_TRANSACTION_ID: '+[string]$script:Transaction.Id+'; inspect with -Action Inspect -TransactionId '+[string]$script:Transaction.Id+'; do not delete its journal or quarantine'))}
    $script:InstallerExitCode = 2
} finally {
    if($installerLock){try{Exit-InstallerFileLock $installerLock}catch{[Console]::Error.WriteLine($_.Exception.Message);$script:InstallerExitCode=2}}
    foreach ($name in $script:InstallerEnvironmentNames) {
        $previous=$script:InstallerEnvironmentBefore[$name]
        if($previous.present){[Environment]::SetEnvironmentVariable($name,[string]$previous.value,'Process')}
        else{Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}
    }
}
exit $script:InstallerExitCode
