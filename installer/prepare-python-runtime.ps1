[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Prepare','Inspect')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [string]$UvPath,
    [string]$PythonCacheRoot,
    [switch]$Offline
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

if (-not ('ProjectStateRuntime.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
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
    public static string Identity(string path,bool directory) {
      const uint READ_ATTRIBUTES=0x80, SHARE=0x7, OPEN_EXISTING=3, BACKUP_SEMANTICS=0x02000000, OPEN_REPARSE_POINT=0x00200000;
      IntPtr h=CreateFileW(ExtendedPath(path),READ_ATTRIBUTES,SHARE,IntPtr.Zero,OPEN_EXISTING,(directory?BACKUP_SEMANTICS:0)|OPEN_REPARSE_POINT,IntPtr.Zero);
      if(h==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try { BY_HANDLE_FILE_INFORMATION i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return i.VolumeSerialNumber.ToString("x8")+":"+i.FileIndexHigh.ToString("x8")+i.FileIndexLow.ToString("x8")+":"+i.NumberOfLinks.ToString(); }
      finally { CloseHandle(h); }
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
function Get-RuntimeTree([string]$Root, [string]$Exclude='') {
    $rootFull = Get-Canonical $Root
    $files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force | Where-Object { $_.FullName -cne $Exclude })
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
function Read-AndVerifyRuntime([string]$Root) {
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
    if ($owner.schemaVersion -ne 1 -or $owner.pythonVersion -cne $script:PythonVersion -or $owner.distribution -cne $script:Distribution -or
        $owner.uvVersion -cne $script:UvVersion -or $owner.uvSha256 -cne $script:UvSha256 -or $owner.downloadUrl -cne $script:DownloadUrl -or
        $aliasMode -notin @('uv-alias-created','versioned-runtime-no-alias','legacy-unrecorded') -or
        $owner.stageIdentity -cne (Get-Identity $rootFull $true 'runtime root')) { throw 'ERUNTIME_OWNER: runtime receipt does not bind this directory and pinned source' }
    if ($aliasMode -ceq 'versioned-runtime-no-alias' -and (Test-Path -LiteralPath $aliasPath)) { throw 'ERUNTIME_ALIAS: a no-alias runtime unexpectedly contains the optional alias path' }
    if ($aliasMode -ceq 'uv-alias-created' -and (Test-Path -LiteralPath $aliasPath) -and -not (Test-Reparse $aliasPath)) { throw 'ERUNTIME_ALIAS: the uv alias path changed type; preserve the runtime' }
    $python = Join-Path $rootFull ($script:Distribution + '\python.exe')
    if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or (Get-Sha256 $python) -cne [string]$owner.pythonExeSha256) { throw 'ERUNTIME_OWNER: runtime executable identity changed' }
    $probe = Invoke-Argv $python @('-I','-B','-c',"import json,sqlite3,sys;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'sqlite':sqlite3.sqlite_version}))")
    if ($probe.exitCode -ne 0) { throw 'ERUNTIME_VERIFY: installed runtime could not be queried' }
    $info = $probe.stdout.Trim() | ConvertFrom-Json
    if ($info.version -cne $script:PythonVersion -or ([version]$info.sqlite) -lt $script:SqliteMinimum -or $info.sqlite -cne [string]$owner.sqliteVersion) { throw 'ERUNTIME_VERIFY: runtime version or SQLite engine differs from its receipt' }
    $tree = Get-RuntimeTree $rootFull $ownerPath
    if ($tree.sha256 -cne [string]$owner.treeSha256 -or $tree.fileCount -ne [int]$owner.fileCount -or $tree.totalBytes -ne [long]$owner.totalBytes) { throw 'ERUNTIME_VERIFY: managed runtime files changed; preserve the runtime' }
    return [pscustomobject]@{root=$rootFull;python=$python;pythonVersion=$info.version;sqliteVersion=$info.sqlite;aliasMode=$aliasMode;fileCount=$tree.fileCount;totalBytes=$tree.totalBytes;treeSha256=$tree.sha256;rootIdentity=$owner.stageIdentity;uvSha256=$owner.uvSha256;downloadUrl=$owner.downloadUrl}
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
$leaf = Split-Path -Leaf $finalRoot
$stage = Join-Path $parent ('.' + $leaf + '.stage-' + $operationId)
if (-not [ProjectStateRuntime.Native]::CreateDirectoryExclusive($stage)) {
    throw ('ERUNTIME_STAGE: exclusive stage creation failed (Win32 ' + [ProjectStateRuntime.Native]::LastError() + '); preserve existing objects')
}
$stageIdentity = Get-Identity $stage $true 'owned runtime stage after creation'
try {
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
    $tree = Get-RuntimeTree $stage
    $ownerPath = Join-Path $stage '.project-state-runtime-owner.json'
    $owner = [ordered]@{schemaVersion=1;operationId=$operationId;createdAt=[DateTimeOffset]::UtcNow.ToString('o');pythonVersion=$info.version;sqliteVersion=$info.sqlite;distribution=$script:Distribution;downloadUrl=$script:DownloadUrl;uvVersion=$script:UvVersion;uvSha256=$script:UvSha256;aliasMode=$script:AliasMode;stageIdentity=$stageIdentity;pythonExeSha256=(Get-Sha256 $python);fileCount=$tree.fileCount;totalBytes=$tree.totalBytes;treeSha256=$tree.sha256}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($owner | ConvertTo-Json -Depth 5 -Compress) + "`n")
    $stream = [IO.File]::Open($ownerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ((Get-Identity $stage $true 'owned runtime stage before publish') -cne $stageIdentity) { throw 'ERUNTIME_STAGE: stage directory identity changed; preserve it' }
    if (Test-Path -LiteralPath $finalRoot) { throw 'ERUNTIME_CONFLICT: another runtime appeared at the final path; both objects are preserved' }
    [IO.Directory]::Move($stage,$finalRoot)
    if ((Get-Identity $finalRoot $true 'published runtime root') -cne $stageIdentity) { throw 'ERUNTIME_PUBLISH: published runtime directory identity differs; preserve it' }
    $result = Read-AndVerifyRuntime $finalRoot
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.WriteLine(('ERUNTIME_OPERATION: ' + $operationId + '; any created stage is preserved at ' + $stage))
    exit 2
}
