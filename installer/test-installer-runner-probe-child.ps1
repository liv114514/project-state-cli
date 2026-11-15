param([ValidateSet('timeout','spawn-fail','nonzero')][string]$ProbeMode,[string]$RunId)
$ErrorActionPreference='Stop'
if($ProbeMode -eq 'nonzero'){[Console]::Out.WriteLine('probe-stdout-before-failure');[Console]::Error.WriteLine('probe-stderr-before-failure');exit 7}
if($ProbeMode -eq 'spawn-fail'){exit 0}
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwsh;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
foreach($arg in @('-NoProfile','-Command','Start-Sleep -Seconds 120')){[void]$psi.ArgumentList.Add($arg)}
$child=[Diagnostics.Process]::new();$child.StartInfo=$psi
if(-not $child.Start()){throw 'probe descendant failed to start'}
[IO.File]::WriteAllText($env:RUNNER_PROBE_PID_FILE,[string]$child.Id,[Text.UTF8Encoding]::new($false))
while($true){[Console]::Out.WriteLine('probe stdout continues');[Console]::Error.WriteLine('probe stderr continues');[Console]::Out.Flush();[Console]::Error.Flush();Start-Sleep -Milliseconds 10}
