param([ValidateSet('install','uninstall','status')][string]$Action='status', [string]$OwnerSid='')
$ErrorActionPreference='Stop'
$serviceName='PiWebDesktop'
$installDir=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'pi-web-ui-desktop'
$target=Join-Path $installDir 'PiDesktopService.exe'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$owner=$identity.User.Value
if ($OwnerSid) {
    if ($OwnerSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'Invalid desktop owner SID' }
    $owner=([Security.Principal.SecurityIdentifier]::new($OwnerSid)).Value
}
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
    if(Test-Path -LiteralPath $installDir) { [IO.File]::WriteAllText((Join-Path $installDir 'auto-disabled'),'1') }
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
foreach($name in @('pi-desktop-codec.dll','pi-desktop-codec.new.dll','pi-desktop-codec.previous.dll','codec.sha256','codec.sha256.new','codec.sha256.previous','video-flow-v1','video-flow-v1.new')) {
    $path=Join-Path $installDir $name
    if((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked codec installation file' }
}
foreach($name in @('PiDesktopService.exe','PiDesktopService.new.exe','PiDesktopService.previous.exe','owner.sid','owner.new.sid','ffmpeg.exe','ffmpeg.new.exe','ffmpeg.previous.exe','encoder.sha256','encoder.sha256.new','encoder.sha256.previous','video-v1','video-v1.new','ffmpeg-nvenc-compat.exe','ffmpeg-nvenc-compat.new.exe','ffmpeg-nvenc-compat.previous.exe','encoder-nvenc-compat.sha256','encoder-nvenc-compat.sha256.new','encoder-nvenc-compat.sha256.previous','source.sha256','source.sha256.new','auto-disabled','enabled','enabled.new','profile-v2','profile-v2.new','raw-v1','raw-v1.new')) {
    $path=Join-Path $installDir $name
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked installation file' }
}
$staged=Join-Path $installDir 'PiDesktopService.new.exe'
# Removing only these exact protected staging files also avoids following old hard links.
if(Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
$wgcReferences=@(
    (Join-Path $env:SystemRoot 'System32\WinMetadata\Windows.Graphics.winmd'),
    (Join-Path $env:SystemRoot 'System32\WinMetadata\Windows.Foundation.winmd'),
    (Join-Path (Split-Path $compiler) 'System.Runtime.WindowsRuntime.dll'),
    (Join-Path $env:SystemRoot 'Microsoft.NET\assembly\GAC_MSIL\System.Runtime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.dll')
)
$wgcOptions=@()
if([Environment]::OSVersion.Version.Build -ge 18362 -and @($wgcReferences | Where-Object { !(Test-Path -LiteralPath $_) }).Count -eq 0) {
    $wgcOptions=@('/define:PI_DESKTOP_WGC')+@($wgcReferences | ForEach-Object { '/r:'+$_ })
}
& $compiler /nologo /target:exe /optimize+ /platform:anycpu "/out:$staged" /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.ServiceProcess.dll @wgcOptions (Join-Path $PSScriptRoot 'NativeDesktop.cs') (Join-Path $PSScriptRoot 'Native.cs') (Join-Path $PSScriptRoot 'DesktopVideo.cs') (Join-Path $PSScriptRoot 'DesktopEncoder.cs') (Join-Path $PSScriptRoot 'DesktopHardware.cs') (Join-Path $PSScriptRoot 'DesktopWgc.cs') (Join-Path $PSScriptRoot 'DesktopUserVideo.cs') (Join-Path $PSScriptRoot 'Service.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop service compilation failed; existing service not replaced.' }
$encoderSource=Join-Path $PSScriptRoot '..\ffmpeg\win32-x64\ffmpeg.exe'
$encoderStaged=Join-Path $installDir 'ffmpeg.new.exe'
$encoderTarget=Join-Path $installDir 'ffmpeg.exe'
$encoderPrevious=Join-Path $installDir 'ffmpeg.previous.exe'
$encoderHashPath=Join-Path $installDir 'encoder.sha256'
$encoderHashPrevious=Join-Path $installDir 'encoder.sha256.previous'
$hasEncoder=Test-Path -LiteralPath $encoderSource
if($hasEncoder) {
    $manifest=Get-Content -LiteralPath (Join-Path (Split-Path $encoderSource) 'build.json') -Raw | ConvertFrom-Json
    if($manifest.binarySha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid bundled desktop encoder manifest' }
    if(Test-Path -LiteralPath $encoderStaged) { Remove-Item -LiteralPath $encoderStaged -Force }
    Copy-Item -LiteralPath $encoderSource -Destination $encoderStaged
    $encoderHash=(Get-FileHash -LiteralPath $encoderStaged -Algorithm SHA256).Hash
    if($encoderHash -ne $manifest.binarySha256) { throw 'Bundled desktop encoder checksum mismatch; existing service not replaced.' }
}
$compatSource=Join-Path $PSScriptRoot '..\ffmpeg\win32-x64\nvenc-compat\ffmpeg.exe'
$compatTarget=Join-Path $installDir 'ffmpeg-nvenc-compat.exe'
$compatStaged=Join-Path $installDir 'ffmpeg-nvenc-compat.new.exe'
$compatPrevious=Join-Path $installDir 'ffmpeg-nvenc-compat.previous.exe'
$compatHashPath=Join-Path $installDir 'encoder-nvenc-compat.sha256'
$compatHashPrevious=Join-Path $installDir 'encoder-nvenc-compat.sha256.previous'
$hasCompat=Test-Path -LiteralPath $compatSource
if ($hasEncoder -and !$hasCompat) { throw 'Bundled compatibility encoder is missing; existing service not replaced.' }
if($hasCompat) {
    $compatManifest=Get-Content -LiteralPath (Join-Path (Split-Path $compatSource) 'build.json') -Raw | ConvertFrom-Json
    if($compatManifest.binarySha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid compatibility encoder manifest' }
    if(Test-Path -LiteralPath $compatStaged) { Remove-Item -LiteralPath $compatStaged -Force }
    Copy-Item -LiteralPath $compatSource -Destination $compatStaged
    $compatHash=(Get-FileHash -LiteralPath $compatStaged -Algorithm SHA256).Hash
    if($compatHash -ne $compatManifest.binarySha256) { throw 'Compatibility encoder checksum mismatch; existing service not replaced.' }
}
$codecSource=Join-Path $PSScriptRoot '..\desktop-codec\win32-x64\pi-desktop-codec.dll'
$codecTarget=Join-Path $installDir 'pi-desktop-codec.dll'
$codecStaged=Join-Path $installDir 'pi-desktop-codec.new.dll'
$codecPrevious=Join-Path $installDir 'pi-desktop-codec.previous.dll'
$codecHashPath=Join-Path $installDir 'codec.sha256'
$codecHashPrevious=Join-Path $installDir 'codec.sha256.previous'
if(!(Test-Path -LiteralPath $codecSource)) { throw 'Bundled native codec is missing; existing service not replaced.' }
$codecManifest=Get-Content -LiteralPath (Join-Path (Split-Path $codecSource) 'build.json') -Raw | ConvertFrom-Json
if($codecManifest.binarySha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid native codec manifest' }
if(Test-Path -LiteralPath $codecStaged) { Remove-Item -LiteralPath $codecStaged -Force }
Copy-Item -LiteralPath $codecSource -Destination $codecStaged
$codecHash=(Get-FileHash -LiteralPath $codecStaged -Algorithm SHA256).Hash
if($codecHash -ne $codecManifest.binarySha256) { throw 'Native codec checksum mismatch; existing service not replaced.' }
$inputs=@('desktop-service/install.ps1','desktop-service/NativeDesktop.cs','desktop-service/Native.cs','desktop-service/DesktopVideo.cs','desktop-service/DesktopEncoder.cs','desktop-service/DesktopHardware.cs','desktop-service/DesktopWgc.cs','desktop-service/DesktopUserVideo.cs','desktop-service/Service.cs','ffmpeg/win32-x64/build.json','ffmpeg/win32-x64/nvenc-compat/build.json','desktop-codec/win32-x64/build.json')
$hashes=@($inputs | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path (Split-Path $PSScriptRoot) $_) -Algorithm SHA256).Hash.ToLowerInvariant() })
$sha=[Security.Cryptography.SHA256]::Create()
try { $fingerprint=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($hashes -join "`n"))))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$service=Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) { Stop-Service -Name $serviceName -Force }
$previous=Join-Path $installDir 'PiDesktopService.previous.exe'
if(Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Force }
if(Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $previous -Force }
try {
foreach($path in @($codecPrevious,$codecHashPrevious)) { if(Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
if(Test-Path -LiteralPath $codecTarget) { Move-Item -LiteralPath $codecTarget -Destination $codecPrevious -Force }
if(Test-Path -LiteralPath $codecHashPath) { Move-Item -LiteralPath $codecHashPath -Destination $codecHashPrevious -Force }
Move-Item -LiteralPath $codecStaged -Destination $codecTarget -Force
$codecHashStaged=Join-Path $installDir 'codec.sha256.new'
if(Test-Path -LiteralPath $codecHashStaged) { Remove-Item -LiteralPath $codecHashStaged -Force }
[IO.File]::WriteAllText($codecHashStaged,$codecHash,[Text.Encoding]::ASCII)
Move-Item -LiteralPath $codecHashStaged -Destination $codecHashPath -Force
if($hasCompat) {
    foreach($path in @($compatPrevious,$compatHashPrevious)) { if(Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
    if(Test-Path -LiteralPath $compatTarget) { Move-Item -LiteralPath $compatTarget -Destination $compatPrevious -Force }
    if(Test-Path -LiteralPath $compatHashPath) { Move-Item -LiteralPath $compatHashPath -Destination $compatHashPrevious -Force }
    Move-Item -LiteralPath $compatStaged -Destination $compatTarget -Force
    $compatHashStaged=Join-Path $installDir 'encoder-nvenc-compat.sha256.new'
    if(Test-Path -LiteralPath $compatHashStaged) { Remove-Item -LiteralPath $compatHashStaged -Force }
    [IO.File]::WriteAllText($compatHashStaged,$compatHash,[Text.Encoding]::ASCII)
    Move-Item -LiteralPath $compatHashStaged -Destination $compatHashPath -Force
}
if($hasEncoder) {
    foreach($path in @($encoderPrevious,$encoderHashPrevious)) { if(Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
    if(Test-Path -LiteralPath $encoderTarget) { Move-Item -LiteralPath $encoderTarget -Destination $encoderPrevious -Force }
    if(Test-Path -LiteralPath $encoderHashPath) { Move-Item -LiteralPath $encoderHashPath -Destination $encoderHashPrevious -Force }
    Move-Item -LiteralPath $encoderStaged -Destination $encoderTarget -Force
    $hashStaged=Join-Path $installDir 'encoder.sha256.new'
    if(Test-Path -LiteralPath $hashStaged) { Remove-Item -LiteralPath $hashStaged -Force }
    [IO.File]::WriteAllText($hashStaged,$encoderHash,[Text.Encoding]::ASCII)
    Move-Item -LiteralPath $hashStaged -Destination $encoderHashPath -Force
}
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
# Capability is valid only for this binary, including after a rollback or downgrade.
$profileStaged=Join-Path $installDir 'profile-v2.new'
if(Test-Path -LiteralPath $profileStaged) { Remove-Item -LiteralPath $profileStaged -Force }
[IO.File]::WriteAllText($profileStaged,(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash,[Text.Encoding]::ASCII)
Move-Item -LiteralPath $profileStaged -Destination (Join-Path $installDir 'profile-v2') -Force
$rawStaged=Join-Path $installDir 'raw-v1.new'
if(Test-Path -LiteralPath $rawStaged) { Remove-Item -LiteralPath $rawStaged -Force }
[IO.File]::WriteAllText($rawStaged,(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash,[Text.Encoding]::ASCII)
Move-Item -LiteralPath $rawStaged -Destination (Join-Path $installDir 'raw-v1') -Force
if($hasEncoder) {
    $videoStaged=Join-Path $installDir 'video-v1.new'
    if(Test-Path -LiteralPath $videoStaged) { Remove-Item -LiteralPath $videoStaged -Force }
    [IO.File]::WriteAllText($videoStaged,(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash,[Text.Encoding]::ASCII)
    Move-Item -LiteralPath $videoStaged -Destination (Join-Path $installDir 'video-v1') -Force
}
$sourceStaged=Join-Path $installDir 'source.sha256.new'
$flowStaged=Join-Path $installDir 'video-flow-v1.new'
if(Test-Path -LiteralPath $flowStaged) { Remove-Item -LiteralPath $flowStaged -Force }
[IO.File]::WriteAllText($flowStaged,(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash,[Text.Encoding]::ASCII)
Move-Item -LiteralPath $flowStaged -Destination (Join-Path $installDir 'video-flow-v1') -Force
if(Test-Path -LiteralPath $sourceStaged) { Remove-Item -LiteralPath $sourceStaged -Force }
[IO.File]::WriteAllText($sourceStaged,$fingerprint,[Text.Encoding]::ASCII)
Move-Item -LiteralPath $sourceStaged -Destination (Join-Path $installDir 'source.sha256') -Force
$disabled=Join-Path $installDir 'auto-disabled'
if(Test-Path -LiteralPath $disabled) { Remove-Item -LiteralPath $disabled -Force }
[ordered]@{installed=$true; running=$true; ownerSid=$owner; path=$target} | ConvertTo-Json -Compress
} catch {
    $failure=$_
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    if(Test-Path -LiteralPath $codecPrevious) { Move-Item -LiteralPath $codecPrevious -Destination $codecTarget -Force }
    if(Test-Path -LiteralPath $codecHashPrevious) { Move-Item -LiteralPath $codecHashPrevious -Destination $codecHashPath -Force }
    if($hasCompat) {
        if(Test-Path -LiteralPath $compatPrevious) { Move-Item -LiteralPath $compatPrevious -Destination $compatTarget -Force }
        if(Test-Path -LiteralPath $compatHashPrevious) { Move-Item -LiteralPath $compatHashPrevious -Destination $compatHashPath -Force }
    }
    if($hasEncoder) {
        if(Test-Path -LiteralPath $encoderPrevious) { Move-Item -LiteralPath $encoderPrevious -Destination $encoderTarget -Force }
        if(Test-Path -LiteralPath $encoderHashPrevious) { Move-Item -LiteralPath $encoderHashPrevious -Destination $encoderHashPath -Force }
    }
    if(Test-Path -LiteralPath $previous) {
        Move-Item -LiteralPath $previous -Destination $target -Force
        Start-Service -Name $serviceName -ErrorAction SilentlyContinue
    }
    throw $failure
}
