[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Prepare','Inspect','InspectStage','PublishStage')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [string]$StageRoot,
    [string]$UvPath,
    [string]$PythonCacheRoot,
    [switch]$Offline,
    [Parameter(DontShow=$true)][switch]$EnableTestHooks,
    [Parameter(DontShow=$true)][string]$TestGateRoot,
    [Parameter(DontShow=$true)][string]$TestGatePhase
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'ERUNTIME_POWERSHELL: PowerShell 7 or newer is required' }

# This lock is deliberately fixed for the first Windows engineering candidate.
# The uv binary is independently pinned; uv verifies the archive against its
# embedded python-build-standalone download metadata before extraction.
$script:PythonVersion = '3.12.13'
$script:Distribution = 'cpython-3.12.13-windows-x86_64-none'
$script:DownloadUrl = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
$script:UvVersion = '0.13.7'
$script:UvSha256 = '1791d7a9ed5b6df13ccf80f102e025c333010d96326b4ff0262aa3b578835c5a'
$script:SqliteMinimum = [version]'3.51.3'
$script:ExpectedRuntimeFileCount = 3342
$script:ExpectedRuntimeTotalBytes = [long]63276957
$script:ExpectedRuntimeTreeSha256 = '7366e8ae47742cdde8a437f8f5c1548a1a23ce4698d916069e40f8a250ef2805'

if (-not ('ProjectStateRuntime.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace ProjectStateRuntime {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks;
      public uint FileIndexHigh; public uint FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path, IntPtr security);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static string ExtendedPath(string path) {
      string full=System.IO.Path.GetFullPath(path);
      if(full.StartsWith(@"\\?\",StringComparison.Ordinal)) return full;
      if(full.StartsWith(@"\\",StringComparison.Ordinal)) return @"\\?\UNC\"+full.Substring(2);
      return @"\\?\"+full;
    }
    public static bool CreateDirectoryExclusive(string path) { return CreateDirectoryW(path,IntPtr.Zero); }
    public static int LastError() { return Marshal.GetLastWin32Error(); }
    public static SafeFileHandle OpenExclusiveRegularFile(string path,bool createNew) {
      const uint GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000, CREATE_NEW=1, OPEN_ALWAYS=4, OPEN_REPARSE_POINT=0x00200000;
      IntPtr h=CreateFileW(ExtendedPath(path),GENERIC_READ|GENERIC_WRITE,0,IntPtr.Zero,createNew?CREATE_NEW:OPEN_ALWAYS,OPEN_REPARSE_POINT,IntPtr.Zero);
      return ValidateExclusiveHandle(h);
    }
    public static SafeFileHandle OpenExistingExclusiveRegularFile(string path) {
      const uint GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000, OPEN_EXISTING=3, OPEN_REPARSE_POINT=0x00200000;
      IntPtr h=CreateFileW(ExtendedPath(path),GENERIC_READ|GENERIC_WRITE,0,IntPtr.Zero,OPEN_EXISTING,OPEN_REPARSE_POINT,IntPtr.Zero);
      return ValidateExclusiveHandle(h);
    }
    static SafeFileHandle ValidateExclusiveHandle(IntPtr h) {
      if(h==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      BY_HANDLE_FILE_INFORMATION i;
      if(!GetFileInformationByHandle(h,out i)) { int e=Marshal.GetLastWin32Error(); CloseHandle(h); throw new System.ComponentModel.Win32Exception(e); }
      const uint REPARSE=0x400, DIRECTORY=0x10;
      if((i.FileAttributes&REPARSE)!=0 || (i.FileAttributes&DIRECTORY)!=0 || i.NumberOfLinks!=1) { CloseHandle(h); throw new System.IO.InvalidDataException("runtime stage lease is linked or not a single-link file"); }
      return new SafeFileHandle(h,true);
    }
    public static string Identity(string path,bool directory) {
      const uint READ_ATTRIBUTES=0x80, SHARE=0x7, OPEN_EXISTING=3, BACKUP_SEMANTICS=0x02000000, OPEN_REPARSE_POINT=0x00200000;
      IntPtr h=CreateFileW(ExtendedPath(path),READ_ATTRIBUTES,SHARE,IntPtr.Zero,OPEN_EXISTING,(directory?BACKUP_SEMANTICS:0)|OPEN_REPARSE_POINT,IntPtr.Zero);
      if(h==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try { BY_HANDLE_FILE_INFORMATION i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return i.VolumeSerialNumber.ToString("x8")+":"+i.FileIndexHigh.ToString("x8")+i.FileIndexLow.ToString("x8")+":"+i.NumberOfLinks.ToString(); }
      finally { CloseHandle(h); }
    }
    public static string IdentityFromHandle(SafeFileHandle safeHandle) {
      BY_HANDLE_FILE_INFORMATION i;
      if(!GetFileInformationByHandle(safeHandle.DangerousGetHandle(),out i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return i.VolumeSerialNumber.ToString("x8")+":"+i.FileIndexHigh.ToString("x8")+i.FileIndexLow.ToString("x8")+":"+i.NumberOfLinks.ToString();
    }
  }
}
'@
}

function Get-Canonical([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar) }
function Get-Identity([string]$Path,[bool]$Directory,[string]$Context) {
    try { return [ProjectStateRuntime.Native]::Identity($Path,$Directory) }
    catch { throw ('ERUNTIME_IDENTITY: ' + $Context + ' could not be verified; preserve the staged runtime and inspect locally') }
}
function Get-StreamIdentity([IO.FileStream]$Stream,[string]$Context) {
    try { return [ProjectStateRuntime.Native]::IdentityFromHandle($Stream.SafeFileHandle) }
    catch { throw ('ERUNTIME_IDENTITY: ' + $Context + ' handle identity could not be verified; preserve the staged runtime') }
}
function Test-Reparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Assert-PlainAncestors([string]$Path) {
    $cursor = Get-Canonical $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (Test-Reparse $cursor) { throw 'ERUNTIME_PATH: a runtime path component is a reparse point; preserve it' }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -ceq $cursor) { break }
        $cursor = $parent
    }
}
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-JsonExclusive([string]$Path,$Value) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 8 -Compress)+"`n")
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Read-StageOwner([string]$Stage) {
    $path=Join-Path $Stage '.project-state-runtime-stage.json'
    if(-not(Test-Path -LiteralPath $path -PathType Leaf) -or (Test-Reparse $path)){throw 'ERUNTIME_STAGE_OWNER: stage ownership receipt is missing or linked; preserve the stage'}
    $identity=Get-Identity $path $false 'stage ownership receipt'
    if($identity -notmatch ':1$'){throw 'ERUNTIME_STAGE_OWNER: stage ownership receipt has multiple links; preserve the stage'}
    $bytes=[IO.File]::ReadAllBytes($path)
    if($bytes.Length -gt 65536){throw 'ERUNTIME_STAGE_OWNER: stage ownership receipt is oversized; preserve the stage'}
    try{$owner=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json}catch{throw 'ERUNTIME_STAGE_OWNER: stage ownership receipt is invalid; preserve the stage'}
    if((Get-Identity $path $false 'stage ownership receipt after read') -cne $identity){throw 'ERUNTIME_STAGE_OWNER: stage ownership receipt changed during validation; preserve the stage'}
    return $owner
}
function Assert-StageBinding([string]$Stage,[string]$ExpectedRuntimeRoot,[IO.FileStream]$LeaseStream=$null) {
    $stageFull=Get-Canonical $Stage;$expected=Get-Canonical $ExpectedRuntimeRoot
    $parentPath=Split-Path -Parent $expected;$parentIdentity=Get-Identity $parentPath $true 'runtime parent'
    if(-not(Test-Path -LiteralPath $stageFull -PathType Container) -or (Test-Reparse $stageFull)){throw 'ERUNTIME_STAGE_OWNER: stage is missing or linked; preserve it'}
    $owner=Read-StageOwner $stageFull
    $operationId=[string]$owner.operationId
    $expectedLeaf='.'+(Split-Path -Leaf $expected)+'.stage-'+$operationId
    $expectedStage=Join-Path $parentPath $expectedLeaf
    $expectedLease=Get-StageLeasePath $expectedStage $expected $operationId
    $leaseIdentity=if($LeaseStream){Get-StreamIdentity $LeaseStream 'runtime stage lease'}else{Get-Identity $expectedLease $false 'runtime stage lease'}
    $rootIsStage=[string]::Equals($stageFull,$expectedStage,[StringComparison]::OrdinalIgnoreCase)
    $rootIsFinal=[string]::Equals($stageFull,$expected,[StringComparison]::OrdinalIgnoreCase)
    if($owner.schemaVersion -ne 1 -or $operationId -notmatch '^[0-9a-f]{32}$' -or
        -not ($rootIsStage -or $rootIsFinal) -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$owner.stageRoot),$expectedStage,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$owner.finalRuntimeRoot),$expected,[StringComparison]::OrdinalIgnoreCase) -or
        [string]$owner.stageIdentity -cne (Get-Identity $stageFull $true 'runtime stage') -or
        [string]$owner.parentIdentity -cne $parentIdentity -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$owner.stageLeasePath),[IO.Path]::GetFullPath($expectedLease),[StringComparison]::OrdinalIgnoreCase) -or
        [string]$owner.stageLeaseIdentity -notmatch ':1$' -or
        [string]$owner.stageLeaseIdentity -cne $leaseIdentity -or
        [string]$owner.pythonVersion -cne $script:PythonVersion -or [string]$owner.distribution -cne $script:Distribution -or
        [string]$owner.downloadUrl -cne $script:DownloadUrl -or [string]$owner.uvVersion -cne $script:UvVersion -or
        [string]$owner.uvSha256 -cne $script:UvSha256 -or [string]$owner.expectedTreeSha256 -cne $script:ExpectedRuntimeTreeSha256 -or
        [string]$owner.operationToken -notmatch '^[0-9a-f]{64}$') {
        throw 'ERUNTIME_STAGE_OWNER: stage ownership receipt does not bind this operation, directory and pinned source; preserve it'
    }
    return $owner
}
function Get-StageLeasePath([string]$Stage,[string]$ExpectedRuntimeRoot,[string]$OperationId) {
    $parentPath=Split-Path -Parent (Get-Canonical $ExpectedRuntimeRoot)
    $stageLeaf='.'+(Split-Path -Leaf (Get-Canonical $ExpectedRuntimeRoot))+'.stage-'+$OperationId
    return Join-Path $parentPath ($stageLeaf+'.lock')
}
function New-StageLease([string]$Path,[string]$OperationToken) {
    try{$handle=[ProjectStateRuntime.Native]::OpenExclusiveRegularFile($Path,$true)}catch{throw 'ERUNTIME_STAGE_BUSY: exclusive stage lease creation failed; preserve stage and lease evidence'}
    $stream=[IO.FileStream]::new($handle,[IO.FileAccess]::ReadWrite)
    try{
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes($OperationToken)
        $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Position=0
        $identity=Get-StreamIdentity $stream 'new runtime stage lease'
        if((Test-Reparse $Path) -or $identity -notmatch ':1$'){throw 'ERUNTIME_STAGE_OWNER: new stage lease identity is unsafe; preserve stage and lease evidence'}
        return [pscustomobject]@{stream=$stream;identity=$identity}
    }catch{$stream.Dispose();throw}
}
function Open-StageLease([string]$Stage,$Owner,[IO.FileStream]$HeldStream=$null) {
    $path=[string]$Owner.stageLeasePath
    $expected=Get-StageLeasePath $Stage ([string]$Owner.finalRuntimeRoot) ([string]$Owner.operationId)
    if(-not [string]::Equals([IO.Path]::GetFullPath($path),[IO.Path]::GetFullPath($expected),[StringComparison]::OrdinalIgnoreCase) -or
        [string]$Owner.stageLeaseIdentity -notmatch ':1$') {
        throw 'ERUNTIME_STAGE_OWNER: stage lease path or identity does not match the operation receipt; preserve both'
    }
    if($HeldStream){$stream=$HeldStream;$owns=$false}
    else {
        try{$handle=[ProjectStateRuntime.Native]::OpenExistingExclusiveRegularFile($path)}catch{throw 'ERUNTIME_STAGE_BUSY: stage lease is active or unsafe; preserve the stage'}
        $stream=[IO.FileStream]::new($handle,[IO.FileAccess]::Read);$owns=$true
    }
    try{
        if((Get-StreamIdentity $stream 'runtime stage lease') -cne [string]$Owner.stageLeaseIdentity){throw 'ERUNTIME_STAGE_OWNER: opened stage lease identity differs from the operation receipt; preserve both'}
        if($stream.Length -gt 256){throw 'ERUNTIME_STAGE_OWNER: stage lease content is invalid; preserve the stage'}
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,1024,$true)
        try{$token=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $stream.Position=0
        if($token -cne [string]$Owner.operationToken -or (Get-StreamIdentity $stream 'runtime stage lease after read') -cne [string]$Owner.stageLeaseIdentity) {
            throw 'ERUNTIME_STAGE_OWNER: stage lease token or identity differs from the operation receipt; preserve both'
        }
        return [pscustomobject]@{stream=$stream;owns=$owns;identity=[string]$Owner.stageLeaseIdentity;token=$token}
    }catch{if($owns){$stream.Dispose()};throw}
}
function Invoke-Argv([string]$File, [string[]]$Arguments) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $File
    $psi.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32'))
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    foreach ($arg in $Arguments) { [void]$psi.ArgumentList.Add([string]$arg) }
    foreach ($name in @('PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','PYTHONSTARTUP','PYTHONEXECUTABLE','PYTHONINSPECT','UV_CONFIG_FILE','UV_PYTHON_CACHE_DIR','UV_CACHE_DIR','UV_OFFLINE','UV_NO_CACHE')) { [void]$psi.Environment.Remove($name) }
    $psi.Environment['UV_NO_CONFIG'] = '1'
    if ($script:ResolvedPythonCacheRoot) { $psi.Environment['UV_PYTHON_CACHE_DIR'] = $script:ResolvedPythonCacheRoot }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'ERUNTIME_TOOL: pinned tool did not start' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(1800000)) { try { $process.Kill($true) } catch {}; $process.WaitForExit(); throw 'ERUNTIME_TIMEOUT: pinned tool exceeded its time limit; preserve its stage' }
        $process.WaitForExit()
        $outText = $stdout.GetAwaiter().GetResult(); $errText = $stderr.GetAwaiter().GetResult()
        if ($outText.Length -gt 1048576 -or $errText.Length -gt 1048576) { throw 'ERUNTIME_OUTPUT: pinned tool output exceeded the capture limit; preserve its stage' }
        return [pscustomobject]@{ exitCode=[int]$process.ExitCode; stdout=$outText; stderr=$errText; pid=$process.Id }
    } finally { $process.Dispose() }
}
function Get-RuntimeTree([string]$Root, [string[]]$Exclude=@()) {
    $rootFull = Get-Canonical $Root
    $excluded = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Exclude) { if ($entry) { [void]$excluded.Add([IO.Path]::GetFullPath($entry)) } }
    foreach ($name in @('.project-state-runtime-owner.json','.project-state-runtime-stage.json','.project-state-runtime-stage.lock')) { [void]$excluded.Add([IO.Path]::GetFullPath((Join-Path $rootFull $name))) }
    $files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force | Where-Object { -not $excluded.Contains([IO.Path]::GetFullPath($_.FullName)) })
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        if (Test-Reparse $file.FullName) { throw 'ERUNTIME_TREE: runtime contains a reparse point; preserve it' }
        $identityBefore = Get-Identity $file.FullName $false 'runtime file before hashing'
        if ($identityBefore -notmatch ':1$') { throw 'ERUNTIME_TREE: runtime file has multiple links; preserve it' }
        $size = [long](Get-Item -LiteralPath $file.FullName).Length
        $hash = Get-Sha256 $file.FullName
        $identityAfter = Get-Identity $file.FullName $false 'runtime file after hashing'
        if ($identityBefore -cne $identityAfter -or $size -ne [long](Get-Item -LiteralPath $file.FullName).Length) { throw 'ERUNTIME_TREE: runtime file changed during identity capture; preserve it' }
        $relative = [IO.Path]::GetRelativePath($rootFull,$file.FullName).Replace('\','/')
        $records.Add([pscustomobject]@{path=$relative;size=$size;sha256=$hash})
    }
    $ordered = @($records | Sort-Object -Property path)
    $stream = [IO.MemoryStream]::new(); $writer = [IO.BinaryWriter]::new($stream,[Text.Encoding]::UTF8,$true)
    try {
        foreach ($record in $ordered) {
            $pathBytes = [Text.Encoding]::UTF8.GetBytes($record.path)
            $writer.Write([uint32]$pathBytes.Length); $writer.Write($pathBytes); $writer.Write([uint64]$record.size)
            $writer.Write([Convert]::FromHexString($record.sha256))
        }
        $writer.Flush(); $treeHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream.ToArray())).ToLowerInvariant()
    } finally { $writer.Dispose(); $stream.Dispose() }
    return [pscustomobject]@{fileCount=$ordered.Count;totalBytes=[long](($ordered | Measure-Object -Property size -Sum).Sum);sha256=$treeHash;files=$ordered}
}
function Read-AndVerifyRuntime([string]$Root,[string]$ExpectedRuntimeRoot=$Root,[IO.FileStream]$LeaseStream=$null) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container) -or (Test-Reparse $Root)) { throw 'ERUNTIME_OWNER: runtime directory is missing or linked' }
    $rootFull = Get-Canonical $Root
    $ownerPath = Join-Path $rootFull '.project-state-runtime-owner.json'
    if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf) -or (Test-Reparse $ownerPath)) { throw 'ERUNTIME_OWNER: runtime ownership receipt is missing or linked' }
    $ownerBytes = [IO.File]::ReadAllBytes($ownerPath)
    if ($ownerBytes.Length -gt 65536) { throw 'ERUNTIME_OWNER: runtime ownership receipt is oversized' }
    try { $owner = [Text.UTF8Encoding]::new($false,$true).GetString($ownerBytes) | ConvertFrom-Json } catch { throw 'ERUNTIME_OWNER: runtime ownership receipt is invalid' }
    $aliasModeProperty = $owner.PSObject.Properties['aliasMode']
    $aliasMode = if ($null -eq $aliasModeProperty) { 'legacy-unrecorded' } else { [string]$aliasModeProperty.Value }
    $aliasPath = Join-Path $rootFull 'cpython-3.12-windows-x86_64-none'
    if ($owner.schemaVersion -notin @(1,2) -or $owner.pythonVersion -cne $script:PythonVersion -or $owner.distribution -cne $script:Distribution -or
        $owner.uvVersion -cne $script:UvVersion -or $owner.uvSha256 -cne $script:UvSha256 -or $owner.downloadUrl -cne $script:DownloadUrl -or
        $aliasMode -notin @('uv-alias-created','versioned-runtime-no-alias','legacy-unrecorded') -or
        $owner.stageIdentity -cne (Get-Identity $rootFull $true 'runtime root')) { throw 'ERUNTIME_OWNER: runtime receipt does not bind this directory and pinned source' }
    if ($owner.schemaVersion -eq 2) {
        $expectedFull = Get-Canonical $ExpectedRuntimeRoot
        $expectedParent = Split-Path -Parent $expectedFull
        $expectedStageLeaf = '.' + (Split-Path -Leaf $expectedFull) + '.stage-' + [string]$owner.operationId
        $expectedStage = Join-Path $expectedParent $expectedStageLeaf
        $rootIsFinal = [string]::Equals($rootFull,$expectedFull,[StringComparison]::OrdinalIgnoreCase)
        $rootIsStage = [string]::Equals($rootFull,$expectedStage,[StringComparison]::OrdinalIgnoreCase)
        if (-not $owner.operationId -or [string]$owner.operationId -notmatch '^[0-9a-f]{32}$' -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$owner.finalRuntimeRoot),$expectedFull,[StringComparison]::OrdinalIgnoreCase) -or
            [string]$owner.stageLeaf -cne $expectedStageLeaf -or -not ($rootIsFinal -or $rootIsStage) -or
            [string]$owner.parentIdentity -cne (Get-Identity $expectedParent $true 'runtime parent') -or
            [string]$owner.expectedTreeSha256 -cne $script:ExpectedRuntimeTreeSha256) {
            throw 'ERUNTIME_OWNER: staged runtime receipt does not bind the exact final path and operation'
        }
        $stageOwner=Assert-StageBinding $rootFull $expectedFull $LeaseStream
        if([string]$stageOwner.operationId -cne [string]$owner.operationId -or [string]$stageOwner.operationToken -cne [string]$owner.operationToken -or
            [string]$stageOwner.stageIdentity -cne [string]$owner.stageIdentity -or [string]$stageOwner.expectedTreeSha256 -cne [string]$owner.expectedTreeSha256) {
            throw 'ERUNTIME_OWNER: stage receipt and runtime receipt do not agree; preserve the runtime'
        }
        $leaseCheck=Open-StageLease $rootFull $stageOwner $LeaseStream
        if($leaseCheck.owns){$leaseCheck.stream.Dispose()}
    }
    if ($aliasMode -ceq 'versioned-runtime-no-alias' -and (Test-Path -LiteralPath $aliasPath)) { throw 'ERUNTIME_ALIAS: a no-alias runtime unexpectedly contains the optional alias path' }
    if ($aliasMode -ceq 'uv-alias-created' -and (Test-Path -LiteralPath $aliasPath) -and -not (Test-Reparse $aliasPath)) { throw 'ERUNTIME_ALIAS: the uv alias path changed type; preserve the runtime' }
    $python = Join-Path $rootFull ($script:Distribution + '\python.exe')
    if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or (Get-Sha256 $python) -cne [string]$owner.pythonExeSha256) { throw 'ERUNTIME_OWNER: runtime executable identity changed' }
    $probe = Invoke-Argv $python @('-I','-B','-c',"import json,sqlite3,sys;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'sqlite':sqlite3.sqlite_version}))")
    if ($probe.exitCode -ne 0) { throw 'ERUNTIME_VERIFY: installed runtime could not be queried' }
    $info = $probe.stdout.Trim() | ConvertFrom-Json
    if ($info.version -cne $script:PythonVersion -or ([version]$info.sqlite) -lt $script:SqliteMinimum -or $info.sqlite -cne [string]$owner.sqliteVersion) { throw 'ERUNTIME_VERIFY: runtime version or SQLite engine differs from its receipt' }
    $tree = Get-RuntimeTree $rootFull @($ownerPath)
    if ($tree.sha256 -cne [string]$owner.treeSha256 -or $tree.fileCount -ne [int]$owner.fileCount -or $tree.totalBytes -ne [long]$owner.totalBytes) { throw 'ERUNTIME_VERIFY: managed runtime files changed; preserve the runtime' }
    if ($owner.schemaVersion -eq 2 -and ($tree.sha256 -cne $script:ExpectedRuntimeTreeSha256 -or $tree.fileCount -ne $script:ExpectedRuntimeFileCount -or $tree.totalBytes -ne $script:ExpectedRuntimeTotalBytes)) { throw 'ERUNTIME_VERIFY: runtime differs from the independently pinned runtime tree; preserve it' }
    return [pscustomobject]@{root=$rootFull;python=$python;pythonVersion=$info.version;sqliteVersion=$info.sqlite;aliasMode=$aliasMode;fileCount=$tree.fileCount;totalBytes=$tree.totalBytes;treeSha256=$tree.sha256;rootIdentity=$owner.stageIdentity;uvSha256=$owner.uvSha256;downloadUrl=$owner.downloadUrl}
}

function Wait-RuntimeTestGate([string]$Phase,[string]$ObservedPath) {
    if (-not $EnableTestHooks -or -not $TestGateRoot -or $TestGatePhase -cne $Phase) { return }
    $gate = [IO.Path]::GetFullPath($TestGateRoot)
    if (-not (Test-Path -LiteralPath $gate -PathType Container) -or (Test-Reparse $gate)) { throw 'ERUNTIME_TEST_GATE: test gate root must be an existing plain directory' }
    $ready = Join-Path $gate ($script:StageOperationId + '.' + $Phase + '.ready')
    $release = Join-Path $gate ($script:StageOperationId + '.' + $Phase + '.release')
    [IO.File]::WriteAllText($ready,$ObservedPath,[Text.UTF8Encoding]::new($false))
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not (Test-Path -LiteralPath $release)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'ERUNTIME_TEST_GATE_TIMEOUT: deterministic runtime-stage barrier expired' }
        Start-Sleep -Milliseconds 20
    }
}

$finalRoot = Get-Canonical $RuntimeRoot
$parent = Split-Path -Parent $finalRoot
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'ERUNTIME_PATH: runtime parent must exist; it is not created automatically' }
Assert-PlainAncestors $parent
if ($finalRoot.Length -ge 180) { throw 'ERUNTIME_PATH_LIMIT: choose a shorter runtime directory; no files were moved' }

$script:ResolvedPythonCacheRoot = $null
$cacheIdentityBefore = $null
if ($Action -ceq 'Prepare' -and $PythonCacheRoot) {
    $script:ResolvedPythonCacheRoot = Get-Canonical $PythonCacheRoot
    Assert-PlainAncestors $script:ResolvedPythonCacheRoot
    if (-not (Test-Path -LiteralPath $script:ResolvedPythonCacheRoot -PathType Container) -or (Test-Reparse $script:ResolvedPythonCacheRoot)) {
        throw 'ERUNTIME_CACHE_PATH: selected Python cache must be an existing plain directory'
    }
    $cacheRoot = Get-Canonical $script:ResolvedPythonCacheRoot
    if ([string]::Equals($cacheRoot,$finalRoot,[StringComparison]::OrdinalIgnoreCase) -or
        $cacheRoot.StartsWith($finalRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
        $finalRoot.StartsWith($cacheRoot + '\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'ERUNTIME_CACHE_PATH: Python cache must be separate from the managed runtime directory'
    }
    if ($cacheRoot.Length -ge 180) { throw 'ERUNTIME_CACHE_PATH_LIMIT: choose a shorter Python cache directory; no files were changed' }
    $cacheIdentityBefore = Get-Identity $cacheRoot $true 'selected Python cache before installation'
} elseif ($Action -ceq 'Prepare' -and $Offline) {
    throw 'ERUNTIME_OFFLINE_CACHE_REQUIRED: offline runtime preparation requires an explicit isolated Python cache directory'
}

if ($Action -ceq 'Inspect') {
    $result = Read-AndVerifyRuntime $finalRoot
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if ($Action -in @('InspectStage','PublishStage')) {
    if (-not $StageRoot) { throw 'ERUNTIME_STAGE_ARGUMENT: stage path is required' }
    $stageFull = Get-Canonical $StageRoot
    $stageParent = Split-Path -Parent $stageFull
    $stageLeaf = Split-Path -Leaf $stageFull
    $expectedPattern = '^\.' + [regex]::Escape((Split-Path -Leaf $finalRoot)) + '\.stage-[0-9a-f]{32}$'
    if (-not [string]::Equals($stageParent,$parent,[StringComparison]::OrdinalIgnoreCase) -or $stageLeaf -notmatch $expectedPattern) {
        throw 'ERUNTIME_STAGE_PATH: stage must be the exact runtime sibling naming pattern; no files were changed'
    }
    if (-not (Test-Path -LiteralPath $stageFull -PathType Container) -or (Test-Reparse $stageFull)) { throw 'ERUNTIME_STAGE_OWNER: staged runtime is missing or linked; preserve it' }
    if ([string]::Equals($stageFull,$finalRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $finalRoot)) {
        throw 'ERUNTIME_CONFLICT: final runtime already exists; stage was not changed'
    }
    # A preparing receipt proves only that this operation created the stage
    # directory. It does not prove that a partial extraction is complete or
    # safe to publish. Inspect may report this state without reading or
    # changing extracted content; publication remains forbidden.
    $preparingOwner = Assert-StageBinding $stageFull $finalRoot
    $leaseCheck=Open-StageLease $stageFull $preparingOwner
    $published=$null
    try {
    $runtimeOwnerPath = Join-Path $stageFull '.project-state-runtime-owner.json'
    $runtimeOwnerItem = Get-Item -LiteralPath $runtimeOwnerPath -Force -ErrorAction SilentlyContinue
    if ($runtimeOwnerItem -and (($runtimeOwnerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $runtimeOwnerItem.PSIsContainer)) {
        throw 'ERUNTIME_STAGE_OWNER: completed runtime receipt path is linked or not a regular file; preserve the stage'
    }
    if (-not $runtimeOwnerItem) {
        if ($preparingOwner.phase -cne 'preparing') {
            throw 'ERUNTIME_STAGE_OWNER: stage has no completed runtime receipt and its preparation phase is not recognized; preserve it'
        }
        if ($Action -ceq 'PublishStage') {
            throw 'ERUNTIME_STAGE_INCOMPLETE: owned stage is incomplete and is not publishable; preserve it and retry in a fresh stage'
        }
        [pscustomobject]@{
            root=$stageFull
            rootIdentity=[string]$preparingOwner.stageIdentity
            operationId=[string]$preparingOwner.operationId
            finalRuntimeRoot=$finalRoot
            stageStatus='owned-incomplete-not-publishable'
            publishable=$false
            extractedContents='NOT_VERIFIED'
            lease='inactive-and-owner-bound'
            recovery='preserved; retry with a fresh stage after reviewing disk space'
        } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    $stageInfo = Read-AndVerifyRuntime $stageFull $finalRoot $leaseCheck.stream
    $stageOwner = [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes((Join-Path $stageFull '.project-state-runtime-owner.json'))) | ConvertFrom-Json
    if ($stageOwner.schemaVersion -ne 2 -or -not [string]::Equals([string]$stageOwner.finalRuntimeRoot,$finalRoot,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'ERUNTIME_STAGE_OWNER: stage lacks a complete identity-bound publication receipt; preserve it'
    }
    $stageInfo | Add-Member -NotePropertyName stageStatus -NotePropertyValue 'verified-ready-to-publish'
    if ($Action -ceq 'InspectStage') { $stageInfo | ConvertTo-Json -Depth 5 -Compress; exit 0 }
    if ((Get-Identity $stageFull $true 'stage before publish') -cne [string]$stageInfo.rootIdentity -or (Test-Path -LiteralPath $finalRoot)) {
        throw 'ERUNTIME_CONFLICT: stage identity or final path changed; both objects are preserved'
    }
    [IO.Directory]::Move($stageFull,$finalRoot)
    if ((Get-Identity $finalRoot $true 'recovered runtime after publish') -cne [string]$stageInfo.rootIdentity) {
        throw 'ERUNTIME_PUBLISH: recovered runtime identity changed; preserve the published object'
    }
    } finally {
        if($leaseCheck.owns){$leaseCheck.stream.Dispose()}
    }
    $published = Read-AndVerifyRuntime $finalRoot
    $published | Add-Member -NotePropertyName stageStatus -NotePropertyValue 'published-and-verified'
    $published | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if (Test-Path -LiteralPath $finalRoot) {
    $existing = Read-AndVerifyRuntime $finalRoot
    $existing | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
if (-not $UvPath) { throw 'ERUNTIME_ARGUMENT: Prepare requires a pinned uv executable' }
$uv = [IO.Path]::GetFullPath($UvPath)
if (-not (Test-Path -LiteralPath $uv -PathType Leaf) -or (Test-Reparse $uv) -or (Get-Sha256 $uv) -cne $script:UvSha256) { throw 'ERUNTIME_UV: uv executable identity differs from the pinned copy' }
$uvProbe = Invoke-Argv $uv @('--version')
if ($uvProbe.exitCode -ne 0 -or ($uvProbe.stdout.Trim()) -cne ('uv ' + $script:UvVersion + ' (316c827e0 2026-11-03 x86_64-pc-windows-msvc)')) { throw 'ERUNTIME_UV: pinned uv version could not be verified' }
$listingArguments = @()
if ($Offline) { $listingArguments += '--offline' }
$listingArguments += @('python','list',$script:PythonVersion,'--only-downloads','--show-urls','--output-format','json')
$listing = Invoke-Argv $uv $listingArguments
if ($listing.exitCode -ne 0) { throw 'ERUNTIME_SOURCE: uv could not resolve the pinned runtime metadata' }
try { $downloads = @($listing.stdout | ConvertFrom-Json) } catch { throw 'ERUNTIME_SOURCE: pinned runtime metadata was invalid' }
if ($downloads.Count -ne 1 -or $downloads[0].key -cne $script:Distribution -or $downloads[0].url -cne $script:DownloadUrl) { throw 'ERUNTIME_SOURCE: runtime download URL differs from the reviewed pin; no installation was attempted' }

$operationId = [guid]::NewGuid().ToString('N')
$script:StageOperationId = $operationId
$leaf = Split-Path -Leaf $finalRoot
$stage = Join-Path $parent ('.' + $leaf + '.stage-' + $operationId)
if (-not [ProjectStateRuntime.Native]::CreateDirectoryExclusive($stage)) {
    throw ('ERUNTIME_STAGE: exclusive stage creation failed (Win32 ' + [ProjectStateRuntime.Native]::LastError() + '); preserve existing objects')
}
$stageIdentity = Get-Identity $stage $true 'owned runtime stage after creation'
$stageLease = $null
$operationLocation = $stage
try {
    $parentIdentity = Get-Identity $parent $true 'runtime parent before stage preparation'
    $operationToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $stageLeasePath=Get-StageLeasePath $stage $finalRoot $operationId
    $leaseCreated=New-StageLease $stageLeasePath $operationToken
    $stageLease=$leaseCreated.stream
    $stageOwnerPath = Join-Path $stage '.project-state-runtime-stage.json'
    $stageOwner = [ordered]@{schemaVersion=1;phase='preparing';operationId=$operationId;createdAt=[DateTimeOffset]::UtcNow.ToString('o');host=$env:COMPUTERNAME;pid=$PID;pythonVersion=$script:PythonVersion;distribution=$script:Distribution;downloadUrl=$script:DownloadUrl;uvVersion=$script:UvVersion;uvSha256=$script:UvSha256;stageIdentity=$stageIdentity;parentIdentity=$parentIdentity;stageRoot=$stage;stageLeaf=(Split-Path -Leaf $stage);finalRuntimeRoot=$finalRoot;operationToken=$operationToken;stageLeasePath=$stageLeasePath;stageLeaseIdentity=$leaseCreated.identity;expectedTreeSha256=$script:ExpectedRuntimeTreeSha256}
    Write-JsonExclusive $stageOwnerPath $stageOwner
    Wait-RuntimeTestGate 'runtime-stage-owner-flushed-before-extract' $stage
    $installArguments = @()
    if ($Offline) { $installArguments += '--offline' }
    $installArguments += @('python','install',$script:PythonVersion,'--install-dir',$stage,'--no-bin','--no-registry','--no-progress')
    if (-not $script:ResolvedPythonCacheRoot) { $installArguments += '--no-cache' }
    $install = Invoke-Argv $uv $installArguments
    $script:AliasMode = 'uv-alias-created'
    if ($install.exitCode -ne 0) {
        if ($Offline -and $install.stderr -match '(?is)offline Python installation was requested, but .+ is missing in ') {
            throw 'ERUNTIME_OFFLINE_CACHE_UNAVAILABLE: the pinned runtime archive is not available in the selected cache; retry online with this same cache after reviewing the source pin'
        }
        # uv may finish extracting the pinned, hash-verified runtime and then fail
        # only while creating its optional minor-version alias. The application
        # invokes the exact-version executable inside the distribution directory,
        # so that alias is unnecessary. Accept this narrowly identified case only
        # after probing and fully measuring the exclusively-created stage below.
        if ($install.stderr -match '(?i)Failed to create Python minor version link directory') {
            $script:AliasMode = 'versioned-runtime-no-alias'
        } elseif ($Offline) {
            throw 'ERUNTIME_OFFLINE_INSTALL_FAILED: offline runtime preparation failed for a reason other than a confirmed cache miss; no network retry was attempted and the owned stage is preserved for inspection'
        } else {
            throw 'ERUNTIME_INSTALL: pinned runtime installation failed; owned stage is preserved for inspection'
        }
    }
    if ($script:ResolvedPythonCacheRoot -and (Get-Identity $script:ResolvedPythonCacheRoot $true 'selected Python cache after installation') -cne $cacheIdentityBefore) {
        throw 'ERUNTIME_CACHE_CHANGED: selected Python cache directory identity changed during preparation; preserve the runtime stage'
    }
    $python = Join-Path $stage ($script:Distribution + '\python.exe')
    if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or (Test-Reparse $python)) { throw 'ERUNTIME_VERIFY: expected interpreter was not produced; stage is preserved' }
    $aliasPath = Join-Path $stage 'cpython-3.12-windows-x86_64-none'
    if ($script:AliasMode -ceq 'versioned-runtime-no-alias' -and (Test-Path -LiteralPath $aliasPath)) { throw 'ERUNTIME_ALIAS: uv reported alias creation failure but the alias path exists; preserve the stage for inspection' }
    if ($script:AliasMode -ceq 'uv-alias-created' -and (Test-Path -LiteralPath $aliasPath) -and -not (Test-Reparse $aliasPath)) { throw 'ERUNTIME_ALIAS: uv alias path is not the expected reparse point; preserve the stage' }
    $probe = Invoke-Argv $python @('-I','-B','-c',"import json,sqlite3,sys;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'sqlite':sqlite3.sqlite_version}))")
    if ($probe.exitCode -ne 0) { throw 'ERUNTIME_VERIFY: staged interpreter could not be queried; stage is preserved' }
    $info = $probe.stdout.Trim() | ConvertFrom-Json
    if ($info.version -cne $script:PythonVersion -or ([version]$info.sqlite) -lt $script:SqliteMinimum) { throw 'ERUNTIME_VERIFY: staged Python/SQLite version is outside the product requirement; stage is preserved' }
    $tree = Get-RuntimeTree $stage @((Join-Path $stage '.project-state-runtime-owner.json'))
    if ($tree.sha256 -cne $script:ExpectedRuntimeTreeSha256 -or $tree.fileCount -ne $script:ExpectedRuntimeFileCount -or $tree.totalBytes -ne $script:ExpectedRuntimeTotalBytes) {
        throw 'ERUNTIME_VERIFY: runtime differs from the independently pinned runtime tree; stage is preserved'
    }
    $ownerPath = Join-Path $stage '.project-state-runtime-owner.json'
    $owner = [ordered]@{schemaVersion=2;operationId=$operationId;createdAt=[DateTimeOffset]::UtcNow.ToString('o');pythonVersion=$info.version;sqliteVersion=$info.sqlite;distribution=$script:Distribution;downloadUrl=$script:DownloadUrl;uvVersion=$script:UvVersion;uvSha256=$script:UvSha256;aliasMode=$script:AliasMode;stageIdentity=$stageIdentity;parentIdentity=$parentIdentity;stageLeaf=(Split-Path -Leaf $stage);finalRuntimeRoot=$finalRoot;expectedTreeSha256=$script:ExpectedRuntimeTreeSha256;operationToken=$operationToken;stageLeasePath=$stageLeasePath;stageLeaseIdentity=$leaseCreated.identity;pythonExeSha256=(Get-Sha256 $python);fileCount=$tree.fileCount;totalBytes=$tree.totalBytes;treeSha256=$tree.sha256}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($owner | ConvertTo-Json -Depth 5 -Compress) + "`n")
    $stream = [IO.File]::Open($ownerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Wait-RuntimeTestGate 'runtime-owner-flushed-before-publish' $stage
    [void](Read-AndVerifyRuntime $stage $finalRoot $stageLease)
    if ((Get-Identity $stage $true 'owned runtime stage before publish') -cne $stageIdentity) { throw 'ERUNTIME_STAGE: stage directory identity changed; preserve it' }
    if (Test-Path -LiteralPath $finalRoot) { throw 'ERUNTIME_CONFLICT: another runtime appeared at the final path; both objects are preserved' }
    [IO.Directory]::Move($stage,$finalRoot)
    $operationLocation = $finalRoot
    if ((Get-Identity $finalRoot $true 'published runtime root') -cne $stageIdentity) { throw 'ERUNTIME_PUBLISH: published runtime directory identity differs; preserve it' }
    $stageLease.Dispose(); $stageLease = $null
    $result = Read-AndVerifyRuntime $finalRoot
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.WriteLine(('ERUNTIME_OPERATION: ' + $operationId + '; owned runtime state is preserved at ' + $operationLocation))
    exit 2
} finally {
    if ($stageLease) { $stageLease.Dispose() }
}
