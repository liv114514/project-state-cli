param([string]$ModulePath,[string]$InstallRoot,[string]$ResultPath)
$ErrorActionPreference='Stop'
Import-Module -Name $ModulePath -Force
try{$store=Get-InstallerTxnStore $InstallRoot -Create;[IO.File]::WriteAllText($ResultPath,('PASS|'+$store.Store),[Text.UTF8Encoding]::new($false));exit 0}
catch{[IO.File]::WriteAllText($ResultPath,('FAIL|'+$_.Exception.Message),[Text.UTF8Encoding]::new($false));exit 2}
