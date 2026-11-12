param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopSessionInfo {
    [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    public static string Text(int session, int info) {
        IntPtr p; int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, info, out p, out bytes)) throw new System.ComponentModel.Win32Exception();
        try { return Marshal.PtrToStringUni(p) ?? ""; } finally { WTSFreeMemory(p); }
    }
    public static int Number(int session, int info, bool shortValue) {
        IntPtr p; int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, info, out p, out bytes)) throw new System.ComponentModel.Win32Exception();
        try { return shortValue ? Marshal.ReadInt16(p) : Marshal.ReadInt32(p); } finally { WTSFreeMemory(p); }
    }
}
'@
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$user = [DesktopSessionInfo]::Text($session, 5)
$domain = [DesktopSessionInfo]::Text($session, 7)
$owner = [Security.Principal.NTAccount]::new($domain, $user).Translate([Security.Principal.SecurityIdentifier])
$state = [DesktopSessionInfo]::Number($session, 8, $false)
$protocol = [DesktopSessionInfo]::Number($session, 16, $true)
$console = [DesktopSessionInfo]::WTSGetActiveConsoleSessionId()
$otherConsoleUser = $false
if ($console -ne [uint32]::MaxValue -and $console -ne $session) {
    $otherConsoleUser = [DesktopSessionInfo]::Text([int]$console, 5).Length -gt 0
}
$eligible = $session -gt 0 -and $owner.Value -eq $identity.User.Value -and $state -eq 0 -and $protocol -eq 2 -and !$otherConsoleUser
if (!$Apply) {
    [ordered]@{ sessionId=$session; state=$state; protocol=$protocol; elevated=$admin; consoleSessionId=$console; otherConsoleUser=$otherConsoleUser; eligible=$eligible; applied=$false } | ConvertTo-Json -Compress
    exit 0
}
if (!$eligible) { throw 'Only your own active RDP session can be transferred; another logged-in console user is not allowed.' }
if (!$admin) { throw 'Run this command in an administrator terminal for the SAME Windows account. No session was changed.' }
# No user-supplied session ID, credentials, auto-login, or unlock operation.
& "$env:SystemRoot\System32\tscon.exe" "$session" '/dest:console'
if ($LASTEXITCODE -ne 0) { throw "tscon failed ($LASTEXITCODE)." }
[ordered]@{ sessionId=$session; applied=$true; consoleSessionId=[DesktopSessionInfo]::WTSGetActiveConsoleSessionId() } | ConvertTo-Json -Compress
