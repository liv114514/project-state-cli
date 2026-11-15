Set-StrictMode -Version Latest

if(-not('ProjectStateInstaller.TxnStoreNative' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ProjectStateInstaller {
  public static class TxnStoreNative {
    [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path,IntPtr security);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    public static bool CreateDirectoryExclusive(string path) { return CreateDirectoryW(path,IntPtr.Zero); }
    public static int LastError() { return Marshal.GetLastWin32Error(); }
    public static string DirectoryIdentity(string path) {
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

$script:Transitions = @{
    Install = @{
        prepared='root-create-intent'; 'root-create-intent'='root-stage-owned'; 'root-stage-owned'='root-receipt-published';
        'root-receipt-published'='root-published'; 'root-published'='root-created'; 'root-created'='stage-create-intent';
        'stage-create-intent'='stage-created'; 'stage-created'='venv-create-intent'; 'venv-create-intent'='venv-created';
        'venv-created'='wheel-install-intent'; 'wheel-install-intent'='wheel-installed'; 'wheel-installed'='verify-intent';
        'verify-intent'='candidate-verified'; 'candidate-verified'='publish-intent'; 'publish-intent'='version-published';
        'version-published'='receipt-intent'; 'receipt-intent'='receipt-published'; 'receipt-published'='shim-intent';
        'shim-intent'='shim-published'; 'shim-published'='activate-intent'; 'activate-intent'='active';
        active='committed'; committed='completed'
    }
    Activate = @{ prepared='activate-intent'; 'activate-intent'='active'; active='committed'; committed='completed' }
    Rollback = @{ prepared='activate-intent'; 'activate-intent'='active'; active='committed'; committed='completed' }
    Uninstall = @{
        prepared='shim-retire-intent'; 'shim-retire-intent'='shim-retired'; 'shim-retired'='versions-retire-intent';
        'versions-retire-intent'='versions-retired'; 'versions-retired'='pointer-retire-intent';
        'pointer-retire-intent'='pointer-retired'; 'pointer-retired'='committed'; committed='cleanup-pending';
        'cleanup-pending'='completed'
    }
}

function Get-InstallerRootBinding([string]$InstallRoot) {
    $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $bytes = [Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    [pscustomobject]@{ Root=$root; RootHash=$hash; Parent=[IO.Path]::GetDirectoryName($root) }
}

function Test-PlainEntry([string]$Path, [switch]$Directory) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'EINSTALL_UNSAFE: transaction path is a reparse point; preserve it' }
    if ($Directory -and -not $item.PSIsContainer) { throw 'EINSTALL_UNSAFE: transaction directory path is not a directory; preserve it' }
    if (-not $Directory -and $item.PSIsContainer) { throw 'EINSTALL_UNSAFE: transaction file path is not a file; preserve it' }
    return $true
}

function Wait-InstallerStoreGate([string]$GateRoot,[string]$GatePhase,[string]$Phase) {
    if(-not $GateRoot -or $GatePhase -cne $Phase){return}
    $ready=Join-Path $GateRoot ('store.'+$Phase+'.ready');$release=Join-Path $GateRoot ('store.'+$Phase+'.release')
    [IO.File]::WriteAllText($ready,$Phase,[Text.UTF8Encoding]::new($false));$deadline=[DateTime]::UtcNow.AddSeconds(45)
    while(-not(Test-Path -LiteralPath $release)){if([DateTime]::UtcNow -gt $deadline){throw 'EINSTALL_TEST_GATE_TIMEOUT: transaction-store barrier expired'};Start-Sleep -Milliseconds 20}
}
function New-ExclusiveInstallerDirectory([string]$Path) {
    if([ProjectStateInstaller.TxnStoreNative]::CreateDirectoryExclusive($Path)){return $true}
    $code=[ProjectStateInstaller.TxnStoreNative]::LastError()
    if($code -eq 183){return $false}
    throw ('EINSTALL_STORE_CREATE: exclusive transaction directory creation failed (Win32 error '+$code+'); preserve existing objects')
}
function Assert-InstallerStoreOwner($Binding,[string]$Store) {
    if(-not(Test-PlainEntry $Store -Directory)){throw 'EINSTALL_STORE_UNCERTAIN: transaction store directory is unavailable; preserve it'}
    $marker=Join-Path $Store 'store-owner.json'
    if(-not(Test-PlainEntry $marker)){throw 'EINSTALL_STORE_UNCERTAIN: installer transaction store has no valid ownership marker; preserve it'}
    $bytes=[IO.File]::ReadAllBytes($marker);Assert-UniqueJsonProperties $bytes
    try{$owner=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json}catch{throw 'EINSTALL_STORE_UNCERTAIN: installer store marker is malformed; preserve it'}
    if($owner.protocol -cne 'project-state-installer' -or $owner.rootHash -cne $Binding.RootHash -or -not [string]::Equals([string]$owner.root,$Binding.Root,[StringComparison]::OrdinalIgnoreCase)){throw 'EINSTALL_STORE_UNCERTAIN: installer transaction store belongs to a different installation root; preserve it'}
    if($owner.schemaVersion -eq 2){
        $actualId=[ProjectStateInstaller.TxnStoreNative]::DirectoryIdentity($Store)
        if(-not $owner.bootstrapTokenHash -or $owner.storeDirectoryId -cne $actualId){throw 'EINSTALL_STORE_UNCERTAIN: installer store owner binding or directory identity differs; preserve it'}
    }elseif($owner.schemaVersion -ne 1){throw 'EINSTALL_STORE_UNCERTAIN: installer store schema is unknown; preserve it'}
    return $owner
}
function Get-InstallerTxnStore([string]$InstallRoot, [switch]$Create,[string]$TestGateRoot,[string]$TestGatePhase) {
    $binding = Get-InstallerRootBinding $InstallRoot
    if (-not (Test-Path -LiteralPath $binding.Parent -PathType Container)) { throw 'EINSTALL_PATH: installation parent must exist before transaction setup' }
    $parentItem = Get-Item -LiteralPath $binding.Parent -Force
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'EINSTALL_UNSAFE: installation parent is a reparse point' }
    $store = Join-Path $binding.Parent ('.project-state-installer-' + $binding.RootHash)
    if(-not(Test-Path -LiteralPath $store)){
        if(-not $Create){return $null}
        # The canonical root-hash name is intentionally long; the private
        # initializer uses a compact sibling name so normal project roots do
        # not cross MAX_PATH merely because the transaction store is new.
        $staging=Join-Path $binding.Parent ('.project-state-store-init-'+$binding.RootHash.Substring(0,16)+'-'+[guid]::NewGuid().ToString('N'))
        if(-not(New-ExclusiveInstallerDirectory $staging)){throw 'EINSTALL_STORE_CREATE: unique transaction initialization path already exists; preserve it'}
        $stagingId=[ProjectStateInstaller.TxnStoreNative]::DirectoryIdentity($staging)
        Wait-InstallerStoreGate $TestGateRoot $TestGatePhase 'store-directory-created'
        $token=[guid]::NewGuid().ToString('N')
        $owner=[ordered]@{schemaVersion=2;protocol='project-state-installer';rootHash=$binding.RootHash;root=$binding.Root;bootstrapTokenHash=(Get-ByteSha256 ([Text.Encoding]::UTF8.GetBytes($token)));storeDirectoryId=$stagingId}
        $ownerBytes=Get-CanonicalJsonBytes $owner;$marker=Join-Path $staging 'store-owner.json'
        try{$stream=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($ownerBytes,0,$ownerBytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}}catch{throw 'EINSTALL_STORE_CREATE: staged owner proof could not be durably written; preserve initialization directory'}
        Wait-InstallerStoreGate $TestGateRoot $TestGatePhase 'store-owner-published'
        if(-not(New-ExclusiveInstallerDirectory (Join-Path $staging 'transactions'))){throw 'EINSTALL_STORE_CREATE: staged transaction directory unexpectedly exists; preserve initialization directory'}
        [void](Assert-InstallerStoreOwner $binding $staging)
        Wait-InstallerStoreGate $TestGateRoot $TestGatePhase 'store-ready-before-publish'
        try{[IO.Directory]::Move($staging,$store)}catch{
            if(-not(Test-Path -LiteralPath $store)){throw 'EINSTALL_STORE_CREATE: ready transaction store could not be atomically published; preserve initialization directory'}
            # Another first-use process won the no-replace publication. Its
            # canonical store is validated below; our unique stage is retained.
        }
    }
    if(-not(Test-Path -LiteralPath $store)){return $null}
    [void](Assert-InstallerStoreOwner $binding $store)
    $transactions = Join-Path $store 'transactions'
    if(Test-PlainEntry $transactions -Directory){}
    elseif($Create){[void](New-ExclusiveInstallerDirectory $transactions);[void](Test-PlainEntry $transactions -Directory)}
    else{return $null}
    return [pscustomobject]@{ Binding=$binding; Store=$store; Transactions=$transactions; Lock=(Join-Path $store 'lock') }
}

function Enter-InstallerFileLock([string]$InstallRoot,[string]$TestGateRoot,[string]$TestGatePhase) {
    $paths = Get-InstallerTxnStore $InstallRoot -Create -TestGateRoot $TestGateRoot -TestGatePhase $TestGatePhase
    if (Test-PlainEntry $paths.Lock) {
        $lockItem = Get-Item -LiteralPath $paths.Lock -Force
        if ($lockItem.Length -ne 0) { throw 'EINSTALL_LOCK_UNCERTAIN: persistent lock sentinel is not empty; preserve installer state' }
    }
    try {
        $stream = [IO.File]::Open($paths.Lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    } catch [IO.IOException] {
        throw 'EINSTALL_BUSY: another process holds the installation transaction lock'
    }
    try {
        $item = Get-Item -LiteralPath $paths.Lock -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne 0) { throw 'EINSTALL_LOCK_UNCERTAIN: lock sentinel changed; preserve installer state' }
        return [pscustomobject]@{ Paths=$paths; Stream=$stream; FullName=$paths.Lock; Identity=('{0}:{1}:{2}' -f $item.Length,$item.CreationTimeUtc.Ticks,$item.LastWriteTimeUtc.Ticks) }
    } catch { $stream.Dispose(); throw }
}

function Exit-InstallerFileLock($Lock) {
    if ($null -eq $Lock) { return }
    try {
        $item = Get-Item -LiteralPath $Lock.FullName -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne 0) { throw 'EINSTALL_LOCK_UNCERTAIN: lock sentinel changed while held; preserve it' }
    } finally { $Lock.Stream.Dispose() }
}

function Get-CanonicalJsonBytes($Value) {
    $ordered = ConvertTo-CanonicalValue $Value
    $json = ConvertTo-Json -InputObject $ordered -Depth 40 -Compress
    return [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
}

function ConvertTo-CanonicalValue($Value) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [bool] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered=[ordered]@{}
        foreach($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) { $ordered[$key]=ConvertTo-CanonicalValue $Value[$key] }
        return $ordered
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items=[System.Collections.Generic.List[object]]::new()
        foreach($item in $Value) { $items.Add((ConvertTo-CanonicalValue $item)) }
        return ,@($items)
    }
    if ($Value -is [pscustomobject]) {
        $ordered=[ordered]@{}
        foreach($property in @($Value.PSObject.Properties | Sort-Object Name -CaseSensitive)) { $ordered[$property.Name]=ConvertTo-CanonicalValue $property.Value }
        return $ordered
    }
    throw 'EINSTALL_JOURNAL_INVALID: unsupported value in transaction record'
}

function Get-ByteSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Test-AllowedInstallerTransition([string]$Operation,[string]$Current,[string]$Next,$Plan) {
    if($Operation -ceq 'Install' -and $Current -in @('root-create-intent','root-stage-owned','root-receipt-published','stage-create-intent','stage-created','venv-create-intent') -and $Next -ceq 'abandoned-preserved'){return $true}
    if($Operation -ceq 'Install' -and $Current -ceq 'root-create-intent'){
        $expected=if([bool]$Plan.rootExisted){'root-created'}else{'root-stage-owned'}
        return $Next -ceq $expected
    }
    if($Operation -ceq 'Uninstall'){
        $items=@($Plan.retireItems)
        if($items.Count -lt 1){return $false}
        if($Current -notin @('committed','cleanup-pending','completed','rolled-back') -and $Next -ceq 'rollback-started'){return $true}
        if($Current -ceq 'rollback-started' -and $Next -ceq 'rolled-back'){return $true}
        if($Current -in @('rollback-started','rolled-back')){return $false}
        if($Current -ceq 'prepared'){$expected='retire-intent-0000'}
        elseif($Current -match '^retired-([0-9]{4})$'){
            $index=[int]$Matches[1]+1
            $expected=if($index -lt $items.Count){'retire-intent-{0:D4}' -f $index}else{'committed'}
        }elseif($Current -match '^retire-intent-([0-9]{4})$'){$expected='retired-{0:D4}' -f [int]$Matches[1]}
        elseif($Current -ceq 'committed'){$expected='cleanup-pending'}
        elseif($Current -ceq 'cleanup-pending'){$expected=if($items.Count -gt 0){'cleanup-intent-0000'}else{'completed'}}
        elseif($Current -match '^cleanup-done-([0-9]{4})$'){
            $index=[int]$Matches[1]+1
            $expected=if($index -lt $items.Count){'cleanup-intent-{0:D4}' -f $index}else{'completed'}
        }
        elseif($Current -match '^cleanup-intent-([0-9]{4})$'){$expected='cleanup-done-{0:D4}' -f [int]$Matches[1]}
        else{return $false}
        return $Next -ceq $expected
    }
    if($Current -notin @('committed','cleanup-pending','completed','rolled-back') -and $Next -ceq 'rollback-started'){return $true}
    if($Current -ceq 'rollback-started' -and $Next -ceq 'rolled-back'){return $true}
    if($Current -in @('rollback-started','rolled-back')){return $false}
    $allowed=$script:Transitions[$Operation]
    return ($allowed.ContainsKey($Current) -and $allowed[$Current] -ceq $Next)
}

function Assert-UniqueJsonProperties([byte[]]$Bytes) {
    try { $document=[System.Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($Bytes)) }
    catch { throw 'EINSTALL_JOURNAL_INVALID: transaction record is not valid JSON; preserve it' }
    try {
        $walk = $null
        $walk = {
            param($Element)
            if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                $seen=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                foreach($property in $Element.EnumerateObject()) {
                    if (-not $seen.Add($property.Name)) { throw 'EINSTALL_JOURNAL_INVALID: duplicate transaction field; preserve it' }
                    & $walk $property.Value
                }
            } elseif ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                foreach($item in $Element.EnumerateArray()) { & $walk $item }
            }
        }
        & $walk $document.RootElement
    } finally { $document.Dispose() }
}

function Write-InstallerRecord([string]$Directory, $Record, [string]$FaultAt) {
    $bytes = Get-CanonicalJsonBytes $Record
    $sequence = [int]$Record.sequence
    $final = Join-Path $Directory ('{0:D8}.json' -f $sequence)
    $temp = Join-Path $Directory ('.{0:D8}-{1}.tmp' -f $sequence,[guid]::NewGuid().ToString('N'))
    $fs = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $fs.Write($bytes,0,$bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
    if ($FaultAt -eq 'journal-temp-flushed') { throw 'EINSTALL_TEST_STOP: journal-temp-flushed' }
    if (Test-Path -LiteralPath $final) { throw 'EINSTALL_JOURNAL_CONFLICT: sequence already exists; preserve transaction' }
    [IO.File]::Move($temp,$final)
    if ((Get-ByteSha256 ([IO.File]::ReadAllBytes($final))) -cne (Get-ByteSha256 $bytes)) { throw 'EINSTALL_JOURNAL_UNCERTAIN: published transaction record failed verification' }
    if ($FaultAt -eq 'journal-published') { throw 'EINSTALL_TEST_STOP: journal-published' }
    return Get-ByteSha256 $bytes
}

function Read-InstallerTransaction([string]$InstallRoot,[string]$TransactionId,[switch]$AllowCompleteTemporary) {
    if ($TransactionId -notmatch '^[a-f0-9]{32}$') { throw 'EINSTALL_ARGUMENT: transaction ID is invalid' }
    $paths = Get-InstallerTxnStore $InstallRoot
    if ($null -eq $paths) { throw 'EINSTALL_NOT_FOUND: transaction store does not exist' }
    $directory = Join-Path $paths.Transactions $TransactionId
    if (-not (Test-PlainEntry $directory -Directory)) { throw 'EINSTALL_NOT_FOUND: transaction does not exist' }
    $allFiles = @(Get-ChildItem -LiteralPath $directory -Force | Sort-Object Name)
    $temporary=@($allFiles|Where-Object{$_.Name -match '^\.[0-9]{8}-[a-f0-9]{32}\.tmp$'})
    $files=@($allFiles|Where-Object{$_.Name -notmatch '^\.[0-9]{8}-[a-f0-9]{32}\.tmp$'})
    if($temporary.Count -gt 0 -and (-not $AllowCompleteTemporary -or $temporary.Count -ne 1)){throw 'EINSTALL_JOURNAL_INVALID: temporary journal record is ambiguous; preserve all evidence'}
    if ($files.Count -eq 0) { throw 'EINSTALL_JOURNAL_INVALID: transaction has no committed record' }
    $records = [System.Collections.Generic.List[object]]::new()
    $previous = $null
    $sequence = 1
    foreach ($file in $files) {
        if ($file.Name -notmatch '^([0-9]{8})\.json$' -or [int]$Matches[1] -ne $sequence) { throw 'EINSTALL_JOURNAL_INVALID: unrecognized, temporary, or missing transaction record; preserve all evidence' }
        if (-not (Test-PlainEntry $file.FullName)) { throw 'EINSTALL_JOURNAL_INVALID: transaction record is not a plain file' }
        $raw = [IO.File]::ReadAllBytes($file.FullName)
        Assert-UniqueJsonProperties $raw
        try { $record = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json } catch { throw 'EINSTALL_JOURNAL_INVALID: transaction record is malformed; preserve it' }
        $required = if($sequence -eq 1){@('schemaVersion','transactionId','rootHash','installId','ownerTokenHash','operation','sequence','phase','plan','planDigest','previousDigest','recordDigest')}else{@('schemaVersion','transactionId','rootHash','installId','ownerTokenHash','operation','sequence','phase','plan','planDigest','observed','previousDigest','recordDigest')}
        $actual = @($record.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        $expected = @($required | Sort-Object -CaseSensitive)
        if (@(Compare-Object $expected $actual).Count -ne 0) { throw 'EINSTALL_JOURNAL_INVALID: transaction record fields do not match the schema' }
        if ($record.schemaVersion -ne 1 -or $record.transactionId -cne $TransactionId -or $record.rootHash -cne $paths.Binding.RootHash -or $record.sequence -ne $sequence -or $record.previousDigest -cne $previous) { throw 'EINSTALL_JOURNAL_INVALID: transaction identity or chain is inconsistent' }
        if (-not $script:Transitions.ContainsKey([string]$record.operation)) { throw 'EINSTALL_JOURNAL_INVALID: transaction operation is unsupported' }
        if ($sequence -eq 1 -and (Get-ByteSha256 (Get-CanonicalJsonBytes $record.plan)) -cne $record.planDigest) { throw 'EINSTALL_JOURNAL_INVALID: immutable transaction plan digest mismatch' }
        $copy = [ordered]@{}; foreach($property in $record.PSObject.Properties){if($property.Name -ne 'recordDigest'){$copy[$property.Name]=$property.Value}}
        if ((Get-ByteSha256 (Get-CanonicalJsonBytes $copy)) -cne $record.recordDigest) { throw 'EINSTALL_JOURNAL_INVALID: transaction record digest mismatch' }
        if ($sequence -gt 1) {
            $previousPhase=[string]$records[$records.Count-1].phase
            if (-not (Test-AllowedInstallerTransition ([string]$record.operation) $previousPhase ([string]$record.phase) $record.plan)) { throw 'EINSTALL_JOURNAL_INVALID: illegal phase transition' }
            if ($record.planDigest -cne $records[0].planDigest -or $record.ownerTokenHash -cne $records[0].ownerTokenHash -or $record.installId -cne $records[0].installId -or $record.operation -cne $records[0].operation) { throw 'EINSTALL_JOURNAL_INVALID: immutable transaction binding changed' }
        }
        $previous = $record.recordDigest; $records.Add($record); $sequence++
    }
    $pendingTemporary=$null
    if($temporary.Count -eq 1){
        $file=$temporary[0]
        if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'EINSTALL_JOURNAL_INVALID: temporary transaction record is linked'}
        $raw=[IO.File]::ReadAllBytes($file.FullName);Assert-UniqueJsonProperties $raw
        try{$record=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json}catch{throw 'EINSTALL_JOURNAL_INVALID: temporary transaction record is incomplete; preserve it'}
        $copy=[ordered]@{};foreach($property in $record.PSObject.Properties){if($property.Name -ne 'recordDigest'){$copy[$property.Name]=$property.Value}}
        $required=@('schemaVersion','transactionId','rootHash','installId','ownerTokenHash','operation','sequence','phase','plan','planDigest','observed','previousDigest','recordDigest')|Sort-Object -CaseSensitive
        $actual=@($record.PSObject.Properties.Name|Sort-Object -CaseSensitive)
        $expectedFinal=Join-Path $directory ('{0:D8}.json' -f ([int]$records[$records.Count-1].sequence+1))
        $previousRecord=$records[$records.Count-1]
        if(@(Compare-Object $required $actual).Count -ne 0 -or $record.schemaVersion -ne 1 -or $record.transactionId -cne $TransactionId -or $record.rootHash -cne $paths.Binding.RootHash -or $record.sequence -ne ([int]$previousRecord.sequence+1) -or $record.previousDigest -cne $previous -or $record.planDigest -cne $records[0].planDigest -or (Get-ByteSha256 (Get-CanonicalJsonBytes $record.plan)) -cne $record.planDigest -or $record.ownerTokenHash -cne $records[0].ownerTokenHash -or $record.installId -cne $records[0].installId -or $record.operation -cne $records[0].operation -or (Get-ByteSha256 (Get-CanonicalJsonBytes $copy)) -cne $record.recordDigest -or -not (Test-AllowedInstallerTransition ([string]$record.operation) ([string]$previousRecord.phase) ([string]$record.phase) $record.plan) -or (Test-Path -LiteralPath $expectedFinal)) {throw 'EINSTALL_JOURNAL_INVALID: completed temporary record does not extend the authenticated transaction chain; preserve it'}
        $pendingTemporary=$file.FullName
    }
    return [pscustomobject]@{ Paths=$paths; Directory=$directory; Records=@($records); Latest=$records[$records.Count-1]; Digest=$previous; PendingTemporary=$pendingTemporary }
}

function Resume-InstallerTransaction([string]$InstallRoot,[string]$TransactionId) {
    $read=Read-InstallerTransaction $InstallRoot $TransactionId -AllowCompleteTemporary
    if($read.PendingTemporary){
        $sequence=[int]$read.Latest.sequence+1;$destination=Join-Path $read.Directory ('{0:D8}.json' -f $sequence)
        if(Test-Path -LiteralPath $destination){throw 'EINSTALL_JOURNAL_CONFLICT: temporary append destination is occupied; preserve both records'}
        [IO.File]::Move([string]$read.PendingTemporary,$destination)
        $read=Read-InstallerTransaction $InstallRoot $TransactionId
    }
    return [pscustomobject]@{ Id=$TransactionId; Directory=$read.Directory; Latest=$read.Latest; Digest=$read.Digest; Paths=$read.Paths }
}

function New-InstallerTransaction([string]$InstallRoot,[string]$Operation,[string]$InstallId,[string]$OwnerToken,[hashtable]$Plan,[string]$FaultAt) {
    if (-not $script:Transitions.ContainsKey($Operation)) { throw 'EINSTALL_ARGUMENT: unsupported transaction operation' }
    $paths = Get-InstallerTxnStore $InstallRoot -Create
    $id = [guid]::NewGuid().ToString('N')
    # Bind stage markers to the immutable journal identity before its digest is
    # computed. A path in a plan alone is never ownership proof.
    $Plan.transactionId=$id
    $dir = Join-Path $paths.Transactions $id
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $planBytes = Get-CanonicalJsonBytes $Plan
    $base = [ordered]@{ schemaVersion=1; transactionId=$id; rootHash=$paths.Binding.RootHash; installId=$InstallId; ownerTokenHash=(Get-ByteSha256 ([Text.Encoding]::UTF8.GetBytes($OwnerToken))); operation=$Operation; sequence=1; phase='prepared'; plan=$Plan; planDigest=(Get-ByteSha256 $planBytes); previousDigest=$null }
    $base.recordDigest = Get-ByteSha256 (Get-CanonicalJsonBytes $base)
    [void](Write-InstallerRecord $dir $base $FaultAt)
    return [pscustomobject]@{ Id=$id; Directory=$dir; Latest=$base; Digest=$base.recordDigest; Paths=$paths }
}

function Set-InstallerTransactionPhase($Transaction,[string]$Phase,[hashtable]$Observed,[string]$FaultAt) {
    $current = [string]$Transaction.Latest.phase
    $operation = [string]$Transaction.Latest.operation
    if (-not (Test-AllowedInstallerTransition $operation $current $Phase $Transaction.Latest.plan)) { throw 'EINSTALL_JOURNAL_INVALID: requested phase is not the next allowed transition' }
    $record = [ordered]@{ schemaVersion=1; transactionId=$Transaction.Id; rootHash=$Transaction.Latest.rootHash; installId=$Transaction.Latest.installId; ownerTokenHash=$Transaction.Latest.ownerTokenHash; operation=$operation; sequence=([int]$Transaction.Latest.sequence + 1); phase=$Phase; plan=$Transaction.Latest.plan; planDigest=$Transaction.Latest.planDigest; observed=$Observed; previousDigest=$Transaction.Digest }
    $record.recordDigest=Get-ByteSha256 (Get-CanonicalJsonBytes $record)
    [void](Write-InstallerRecord $Transaction.Directory $record $FaultAt)
    $Transaction.Latest=$record; $Transaction.Digest=$record.recordDigest
    return $Transaction
}

function Get-InstallerTransactions([string]$InstallRoot) {
    $paths=Get-InstallerTxnStore $InstallRoot
    if($null -eq $paths){return @()}
    $result=[System.Collections.Generic.List[object]]::new()
    foreach($dir in Get-ChildItem -LiteralPath $paths.Transactions -Directory -Force){
        if($dir.Name -notmatch '^[a-f0-9]{32}$'){throw 'EINSTALL_JOURNAL_INVALID: transaction store contains an unknown directory; preserve it'}
        try{$result.Add((Read-InstallerTransaction $InstallRoot $dir.Name))}
        catch{$result.Add([pscustomobject]@{Paths=$paths;Directory=$dir.FullName;Records=@();Latest=[pscustomobject]@{transactionId=$dir.Name;operation='unknown';phase='blocked-invalid-or-incomplete';rootHash=$paths.Binding.RootHash;plan=$null};Digest=$null;Invalid=$true})}
    }
    return @($result)
}

Export-ModuleMember -Function Get-InstallerRootBinding,Get-InstallerTxnStore,Enter-InstallerFileLock,Exit-InstallerFileLock,New-InstallerTransaction,Set-InstallerTransactionPhase,Read-InstallerTransaction,Resume-InstallerTransaction,Get-InstallerTransactions,Assert-UniqueJsonProperties
