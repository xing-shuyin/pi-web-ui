@echo off
setlocal enableextensions
title Pi Web UI Portable

rem ---------------------------------------------------------------------------
rem  Pi Portable Launcher
rem  All paths are relative to this script (%~dp0), so the whole PiPortable
rem  folder can be copied to any PC or USB drive without drive letter issues.
rem
rem  NOTE: this file is intentionally pure ASCII to prevent cmd.exe from
rem  mis-parsing multi-byte characters under different console code pages.
rem  Localized details live in checks\*.utf8.txt and checks\*.gbk.txt.
rem ---------------------------------------------------------------------------

set "PI_ROOT=%~dp0"
if "%PI_ROOT:~-1%"=="\" set "PI_ROOT=%PI_ROOT:~0,-1%"

rem ----- console code page -> select language file -----
set "PI_CP=0"
for /f "tokens=2 delims=:" %%C in ('chcp') do set "PI_CP=%%C"
set "PI_CP=%PI_CP: =%"
set "PI_LANG="
if "%PI_CP%"=="936"   set "PI_LANG=.gbk"
if "%PI_CP%"=="65001" set "PI_LANG=.utf8"

rem ----- fatal checks: main app executable -----
if not exist "%PI_ROOT%\app\pi-web-ui-desktop.exe" (
    echo.
    echo [Pi] ERROR: app\pi-web-ui-desktop.exe not found.
    echo      The portable folder is incomplete.
    call :print_detail fatal-app
    goto :fail
)

rem ----- optional runtime check: PortableGit -----
if exist "%PI_ROOT%\runtime\git\cmd\git.exe" (
    echo [Pi] PortableGit detected in runtime\git. Mounting environment...
    set "PORTABLE_GIT=%PI_ROOT%\runtime\git"
    set "PATH=%PI_ROOT%\runtime\git\cmd;%PI_ROOT%\runtime\git\usr\bin;%PI_ROOT%\runtime\git\mingw64\bin;%PATH%"
    set "GIT_EXEC_PATH=%PI_ROOT%\runtime\git\mingw64\libexec\git-core"
    if exist "%PI_ROOT%\runtime\git\bin\bash.exe" (
        set "SHELL=%PI_ROOT%\runtime\git\bin\bash.exe"
        set "PI_WEB_SHELL=%PI_ROOT%\runtime\git\bin\bash.exe"
    ) else if exist "%PI_ROOT%\runtime\git\usr\bin\bash.exe" (
        set "SHELL=%PI_ROOT%\runtime\git\usr\bin\bash.exe"
        set "PI_WEB_SHELL=%PI_ROOT%\runtime\git\usr\bin\bash.exe"
    )
) else (
    echo [Pi] NOTE: Built-in PortableGit not found. Falling back to system Git.
    call :print_detail warn-git
)

rem ----- ensure portable data directories exist -----
if not exist "%PI_ROOT%\data\agent"     mkdir "%PI_ROOT%\data\agent"
if not exist "%PI_ROOT%\data\web"       mkdir "%PI_ROOT%\data\web"
if not exist "%PI_ROOT%\data\git"       mkdir "%PI_ROOT%\data\git"
if not exist "%PI_ROOT%\data\home"      mkdir "%PI_ROOT%\data\home"
if not exist "%PI_ROOT%\data\workspace" mkdir "%PI_ROOT%\data\workspace"
if not exist "%PI_ROOT%\data\electron"  mkdir "%PI_ROOT%\data\electron"

rem ----- configure environment variables for total isolation -----
set "PI_PORTABLE=1"
set "PI_PORTABLE_ROOT=%PI_ROOT%"
set "PI_CODING_AGENT_DIR=%PI_ROOT%\data\agent"
set "PI_WEB_DATA_DIR=%PI_ROOT%\data\web"
set "PI_WEB_CWD=%PI_ROOT%\data\workspace"
set "GIT_CONFIG_GLOBAL=%PI_ROOT%\data\git\.gitconfig"
set "HOME=%PI_ROOT%\data\home"
set "USERPROFILE=%PI_ROOT%\data\home"

call :print_detail run-info

echo [Pi] Launching Pi Web UI Desktop...
start "" "%PI_ROOT%\app\pi-web-ui-desktop.exe" --user-data-dir="%PI_ROOT%\data\electron" %*
exit /b 0

:print_detail
if not "%PI_LANG%"=="" (
    if exist "%PI_ROOT%\checks\%~1%PI_LANG%.txt" (
        echo.
        type "%PI_ROOT%\checks\%~1%PI_LANG%.txt"
        echo.
    )
)
exit /b 0

:fail
echo.
echo [Pi] Startup failed. Press any key to exit.
pause >nul
exit /b 1
