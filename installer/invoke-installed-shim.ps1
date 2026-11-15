param([Parameter(Mandatory=$true)][string]$Shim,[Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArguments)
$ErrorActionPreference='Continue'
& $Shim @CliArguments
exit $LASTEXITCODE
