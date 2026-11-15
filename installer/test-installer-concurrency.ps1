param([string]$RunId = ('installer-concurrency-' + [guid]::NewGuid().ToString('N')))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$shortSandboxBase = Join-Path (Split-Path -Parent $workspace) '.i'
$sandbox = Join-Path $shortSandboxBase ('ic-' + ($RunId -replace '[^a-zA-Z0-9-]', ''))
$evidence = Join-Path $workspace ('evidence\' + $RunId)
if ((Test-Path -LiteralPath $sandbox) -or (Test-Path -LiteralPath $evidence)) { throw 'Refusing to reuse installer concurrency paths' }
[IO.Directory]::CreateDirectory($sandbox) | Out-Null
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$root = [IO.Path]::GetFullPath((Join-Path $sandbox ('install-' + [guid]::NewGuid().ToString('N'))))
$installer = Join-Path $PSScriptRoot 'install-core-prototype.ps1'
$worker = Join-Path $PSScriptRoot 'transaction-worker.ps1'
$module = Join-Path $PSScriptRoot 'installer-transaction.psm1'
$log = Join-Path $evidence 'results.json'
$started = (Get-Date).ToString('o')
$held = $null
try {
    Import-Module -Name $module -Force
    $held = Enter-InstallerFileLock $root
    $powershell = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $ready = Join-Path $evidence 'contender-entered.ready'
    $childOut = Join-Path $evidence 'contender.stdout.log'
    $childErr = Join-Path $evidence 'contender.stderr.log'
    $child = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-File',('"'+$worker+'"'),'-ModulePath',('"'+$module+'"'),'-InstallRoot',('"'+$root+'"'),'-ReadyFile',('"'+$ready+'"'),'-CompeteOnly') -PassThru -WindowStyle Hidden -RedirectStandardOutput $childOut -RedirectStandardError $childErr
    $child.WaitForExit(15000) | Out-Null
    $code = if ($child.HasExited) { $child.ExitCode } else { -1 }
    $text = if (Test-Path -LiteralPath $childErr) { Get-Content -LiteralPath $childErr -Raw } else { '' }
    [IO.File]::WriteAllText((Join-Path $evidence 'contention-attempt.json'),(@{powershell=$powershell;exitCode=$code;output=$text;rootCreated=(Test-Path -LiteralPath $root)} | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    if ($code -ne 2 -or $text -match 'LOCKED' -or $text -notmatch 'EINSTALL_BUSY' -or (Test-Path -LiteralPath $ready)) {
        throw 'contending installer did not fail closed before creating its root'
    }
    $result = [ordered]@{
        schemaVersion = 1
        evidenceKind = 'synthetic cross-process FileShare.None transaction lock contention'
        started = $started
        ended = (Get-Date).ToString('o')
        cwd = (Get-Location).Path
        powershell = $PSVersionTable.PSVersion.ToString()
        contenderExitCode = $code
        output = $text
        rootCreated = (Test-Path -LiteralPath $root)
        result = 'PASS'
    }
    [IO.File]::WriteAllText($log,($result | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
} finally {
    if ($null -ne $held) { Exit-InstallerFileLock $held }
}
