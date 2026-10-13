@echo off
setlocal enableextensions
title Create Pi Portable Shortcut

set "PI_ROOT=%~dp0"
if "%PI_ROOT:~-1%"=="\" set "PI_ROOT=%PI_ROOT:~0,-1%"

if not exist "%PI_ROOT%\app\pi-web-ui-desktop.exe" (
    echo [ERROR] app\pi-web-ui-desktop.exe not found.
    pause
    exit /b 1
)

echo Creating desktop shortcut...

powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $lnkPath = Join-Path $desktop 'Pi Web UI.lnk'; $s = $ws.CreateShortcut($lnkPath); $s.TargetPath = (Join-Path $env:PI_ROOT '启动Pi.bat'); $s.WorkingDirectory = $env:PI_ROOT; $s.IconLocation = ((Join-Path $env:PI_ROOT 'app\pi-web-ui-desktop.exe') + ',0'); $s.WindowStyle = 7; $s.Description = 'Pi Web UI Portable'; $s.Save(); Write-Host '[SUCCESS] Desktop shortcut created: ' -NoNewline; Write-Host $lnkPath -ForegroundColor Green }"

if %errorlevel% neq 0 (
    echo [ERROR] Failed to create shortcut.
    pause
    exit /b 1
)

echo.
echo Shortcut created on your Desktop with app icon!
"%SystemRoot%\System32\timeout.exe" /t 2 >nul 2>&1 || ping -n 3 127.0.0.1 >nul 2>&1
exit /b 0
