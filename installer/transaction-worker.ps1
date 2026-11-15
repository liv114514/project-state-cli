param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$TransactionId,
    [string]$Phase,
    [string]$ReadyFile,
    [string]$ReleaseFile,
    [switch]$CompeteOnly
)
$ErrorActionPreference='Stop'
Import-Module -Name $ModulePath -Force
$held=$null
try {
    $held=Enter-InstallerFileLock $InstallRoot
    if($CompeteOnly){'LOCKED'|Set-Content -LiteralPath $ReadyFile -Encoding ascii;exit 0}
    $tx=Resume-InstallerTransaction $InstallRoot $TransactionId
    $tx=Set-InstallerTransactionPhase $tx $Phase ([ordered]@{worker='child';phase=$Phase}) ''
    'READY'|Set-Content -LiteralPath $ReadyFile -Encoding ascii
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    while(-not(Test-Path -LiteralPath $ReleaseFile)){
        if([DateTime]::UtcNow -gt $deadline){throw 'worker test gate timed out'}
        Start-Sleep -Milliseconds 25
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
} finally {
    if($null -ne $held){Exit-InstallerFileLock $held}
}
