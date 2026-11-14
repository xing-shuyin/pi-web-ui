param([ValidateSet('install','uninstall')][string]$Action='install')
$ErrorActionPreference='Stop'
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { exit 42 }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$owner=$identity.User.Value
$script=Join-Path $PSScriptRoot 'install.ps1'
if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    & $script -Action $Action -OwnerSid $owner
    exit $LASTEXITCODE
}
# Bind the service to the initiating user, also for over-the-shoulder administrator credentials.
$command="& '"+$script.Replace("'","''")+"' -Action '"+$Action+"' -OwnerSid '"+$owner+"'; if (-not `$?) { exit 1 }"
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
try {
    $process=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(120000)) { throw 'Desktop component installation timed out' }
    exit $process.ExitCode
} catch { Write-Error $_; exit 1 }
