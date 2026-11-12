param([ValidateSet('install','uninstall','status')][string]$Action='status')
$ErrorActionPreference='Stop'
$serviceName='PiWebDesktop'
$installDir=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'pi-web-ui-desktop'
$target=Join-Path $installDir 'PiDesktopService.exe'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$owner=$identity.User.Value
if ($Action -eq 'status') {
    $service=Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    [ordered]@{installed=($null -ne $service); running=($null -ne $service -and $service.Status -eq 'Running'); path=$target} | ConvertTo-Json -Compress
    exit 0
}
if (![Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this command in an administrator terminal for the Windows account running pi-web-ui.' }
if ($Action -eq 'uninstall') {
    $service=Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service) { Stop-Service -Name $serviceName -Force; & "$env:SystemRoot\System32\sc.exe" delete $serviceName; if ($LASTEXITCODE -ne 0) { throw 'Cannot remove desktop service' } }
    $marker=Join-Path $installDir 'enabled'
    if(Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    Write-Output 'Desktop service removed. User-session capture restored; protected installation files retained.'
    exit 0
}
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { $compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable.' }
$existing=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
if($existing -and $existing.PathName -ne ('"'+$target+'" --service')) { throw 'Refusing to replace an unrelated Windows service' }
if($existing -and $existing.StartName -ne 'LocalSystem') { throw 'Desktop service must use the LocalSystem account' }
$ownerPath=Join-Path $installDir 'owner.sid'
if((Test-Path -LiteralPath $ownerPath) -and [IO.File]::ReadAllText($ownerPath).Trim() -ne $owner) { throw 'Desktop service belongs to another account. Uninstall it before assigning another owner.' }
# Never execute an elevated service from a user-writable npm directory.
if (Test-Path -LiteralPath $installDir) {
    if ((Get-Item -LiteralPath $installDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked installation directory' }
} else { New-Item -ItemType Directory -Path $installDir | Out-Null }
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($admins)
foreach($sid in @($admins,$system)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($owner),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $installDir -AclObject $acl
foreach($name in @('PiDesktopService.exe','PiDesktopService.new.exe','owner.sid')) {
    $path=Join-Path $installDir $name
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked installation file' }
}
$staged=Join-Path $installDir 'PiDesktopService.new.exe'
# Removing only these exact protected staging files also avoids following old hard links.
if(Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
& $compiler /nologo /target:exe /optimize+ /platform:anycpu "/out:$staged" /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.ServiceProcess.dll (Join-Path $PSScriptRoot 'NativeDesktop.cs') (Join-Path $PSScriptRoot 'Native.cs') (Join-Path $PSScriptRoot 'Service.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop service compilation failed; existing service not replaced.' }
$service=Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) { Stop-Service -Name $serviceName -Force }
$previous=Join-Path $installDir 'PiDesktopService.previous.exe'
if(Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Force }
if(Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $previous -Force }
try {
Move-Item -LiteralPath $staged -Destination $target -Force
$ownerStaged=Join-Path $installDir 'owner.new.sid'
if(Test-Path -LiteralPath $ownerStaged) { Remove-Item -LiteralPath $ownerStaged -Force }
[IO.File]::WriteAllText($ownerStaged,$owner,[Text.Encoding]::ASCII)
Move-Item -LiteralPath $ownerStaged -Destination $ownerPath -Force
foreach($path in @($target,(Join-Path $installDir 'owner.sid'))) {
    $fileAcl=New-Object Security.AccessControl.FileSecurity
    $fileAcl.SetAccessRuleProtection($false,$false)
    $fileAcl.SetOwner($admins)
    Set-Acl -LiteralPath $path -AclObject $fileAcl
}
$binary='"'+$target+'" --service'
if (!$service) { New-Service -Name $serviceName -BinaryPathName $binary -StartupType Automatic -DisplayName 'pi-web-ui Windows desktop capture' | Out-Null }
else { Set-Service -Name $serviceName -StartupType Automatic }
& "$env:SystemRoot\System32\sc.exe" failure $serviceName reset= 86400 actions= restart/3000/restart/10000
if($LASTEXITCODE -ne 0) { throw 'Cannot configure service recovery' }
Start-Service -Name $serviceName
$service=Get-Service -Name $serviceName
$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
$markerStaged=Join-Path $installDir 'enabled.new'
if(Test-Path -LiteralPath $markerStaged) { Remove-Item -LiteralPath $markerStaged -Force }
[IO.File]::WriteAllText($markerStaged,'1',[Text.Encoding]::ASCII)
Move-Item -LiteralPath $markerStaged -Destination (Join-Path $installDir 'enabled') -Force
[ordered]@{installed=$true; running=$true; ownerSid=$owner; path=$target} | ConvertTo-Json -Compress
} catch {
    $failure=$_
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    if(Test-Path -LiteralPath $previous) {
        Move-Item -LiteralPath $previous -Destination $target -Force
        Start-Service -Name $serviceName -ErrorAction SilentlyContinue
    }
    throw $failure
}
