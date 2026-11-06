
param(
  [string]$Op = "",
  [int]$X = 0, [int]$Y = 0,
  [int]$ToX = 0, [int]$ToY = 0,
  [ValidateRange(100, 2000)][int]$Duration = 500,
  [int]$Delta = 360, [int]$Horizontal = 0,
  [string]$Button = "left",
  [int]$Double = 0,
  [string]$Keys = "",
  [string]$Text = "",
  [string]$Title = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Inp {
  // 注：键盘不用 SendInput——INPUT 结构体在 x64 下必须是 32 字节，
  // .NET 默认 Pack 会封成 40 字节导致发送失败且无报错；keybd_event 无结构体，稳妥。
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public const int MOUSEEVENTF_MOVE = 0x0001;
  public const int MOUSEEVENTF_LEFTDOWN = 0x02, MOUSEEVENTF_LEFTUP = 0x04;
  public const int MOUSEEVENTF_RIGHTDOWN = 0x08, MOUSEEVENTF_RIGHTUP = 0x10;
  public const int MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40;
  public const int MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const int MOUSEEVENTF_VIRTUALDESK = 0x4000;
  public const int KEYEVENTF_KEYUP = 0x02;
}
"@

try { [void][Inp]::SetProcessDpiAwareness(2) } catch { try { [void][Inp]::SetProcessDPIAware() } catch {} }

function Move-Cursor($x, $y) {
  [void][Inp]::SetCursorPos($x, $y)
  $vL = [Inp]::GetSystemMetrics(76); $vT = [Inp]::GetSystemMetrics(77)
  $vW = [Inp]::GetSystemMetrics(78); $vH = [Inp]::GetSystemMetrics(79)
  if ($vW -gt 0 -and $vH -gt 0) {
    $normX = [int]((($x - $vL) * 65535.0 / ($vW - 1)) + 0.5)
    $normY = [int]((($y - $vT) * 65535.0 / ($vH - 1)) + 0.5)
    [Inp]::mouse_event([Inp]::MOUSEEVENTF_MOVE -bor [Inp]::MOUSEEVENTF_ABSOLUTE -bor [Inp]::MOUSEEVENTF_VIRTUALDESK, $normX, $normY, 0, [UIntPtr]::Zero)
  }
}

function Out-Ok($extra) {
  $o = [ordered]@{ ok = $true; op = $Op }
  if ($extra) { foreach ($e in $extra.GetEnumerator()) { $o[$e.Key] = $e.Value } }
  $o | ConvertTo-Json -Compress | Write-Output
}
function Out-Err($msg) {
  [ordered]@{ ok = $false; op = $Op; error = [string]$msg } | ConvertTo-Json -Compress | Write-Output
}

$VK = @{
  enter = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20
  backspace = 0x08; delete = 0x2E; up = 0x26; down = 0x28; left = 0x25; right = 0x27
  home = 0x24; end = 0x23; pgup = 0x21; pgdn = 0x22; insert = 0x2D
}
for ($i = 1; $i -le 24; $i++) { $VK["f$i"] = 0x6F + $i }
foreach ($c in "abcdefghijklmnopqrstuvwxyz".ToCharArray()) { $VK[[string]$c] = [int][char]([string]$c).ToUpper() }
foreach ($c in "0123456789".ToCharArray()) { $VK[[string]$c] = [int][char][string]$c }
$MODMAP = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; win = 0x5B }

function Send-Vk($vk, $up) {
  $flags = 0
  if ($up) { $flags = [Inp]::KEYEVENTF_KEYUP }
  $scan = [byte][Inp]::MapVirtualKey([uint32]$vk, 0)
  [Inp]::keybd_event([byte]$vk, $scan, $flags, [UIntPtr]::Zero)
}

try {
  switch ($Op) {
    "move" {
      Move-Cursor $X $Y
      Out-Ok @{ x = $X; y = $Y }
    }
    "scroll" {
      Move-Cursor $X $Y
      Start-Sleep -Milliseconds 60
      $flag = $(if ($Horizontal -eq 1) { 0x1000 } else { 0x0800 })
      [Inp]::mouse_event($flag, 0, 0, $Delta, [UIntPtr]::Zero)
      Out-Ok @{ delta = $Delta; horizontal = $Horizontal }
    }
    "drag" {
      Move-Cursor $X $Y
      Start-Sleep -Milliseconds 60
      try {
        [Inp]::mouse_event([Inp]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        $steps = 20
        for ($step = 1; $step -le $steps; $step++) {
          Move-Cursor ([int]($X + ($ToX - $X) * $step / $steps)) ([int]($Y + ($ToY - $Y) * $step / $steps))
          Start-Sleep -Milliseconds ([int]($Duration / $steps))
        }
      } finally {
        [Inp]::mouse_event([Inp]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      }
      Out-Ok @{ x = $ToX; y = $ToY }
    }
    "click" {
      Move-Cursor $X $Y
      Start-Sleep -Milliseconds 60
      $n = $(if ($Double -eq 1) { 2 } else { 1 })
      for ($k = 0; $k -lt $n; $k++) {
        if ($k -gt 0) { Start-Sleep -Milliseconds 120 }
        switch ($Button) {
          "right" {
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
          }
          "middle" {
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_MIDDLEUP, 0, 0, 0, [UIntPtr]::Zero)
          }
          default {
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
          }
        }
      }
      Out-Ok @{ x = $X; y = $Y; button = $Button; double = $Double }
    }
    "key" {
      $parts = $Keys -split '\+' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne "" }
      if ($parts.Count -eq 0) { Out-Err "empty keys"; break }
      $modList = @(); $main = $null
      foreach ($p in $parts) {
        if ($MODMAP.ContainsKey($p)) { $modList += $MODMAP[$p] } else { $main = $p }
      }
      if ($null -eq $main -and $modList.Count -gt 0) {
        foreach ($m in $modList) { Send-Vk $m $false }
        Start-Sleep -Milliseconds 40
        foreach ($m in ($modList | Sort-Object -Descending)) { Send-Vk $m $true }
        Out-Ok @{ keys = $Keys }; break
      }
      if (-not $VK.ContainsKey($main)) { Out-Err "unknown key: $main"; break }
      foreach ($m in $modList) { Send-Vk $m $false }
      Start-Sleep -Milliseconds 40
      Send-Vk $VK[$main] $false; Start-Sleep -Milliseconds 30; Send-Vk $VK[$main] $true
      foreach ($m in ($modList | Sort-Object -Descending)) { Send-Vk $m $true }
      Out-Ok @{ keys = $Keys }
    }
    "paste" {
      $prevText = $null
      try {
        try { $prevText = Get-Clipboard -Raw } catch { $prevText = $null }
        Set-Clipboard -Value $Text
        Start-Sleep -Milliseconds 80
        Send-Vk 0x11 $false
        Start-Sleep -Milliseconds 20
        Send-Vk 0x56 $false
        Start-Sleep -Milliseconds 40
        Send-Vk 0x56 $true
        Start-Sleep -Milliseconds 20
        Send-Vk 0x11 $true
        Start-Sleep -Milliseconds 250
        Out-Ok @{ chars = $Text.Length }
      } finally {
        Send-Vk 0x56 $true
        Send-Vk 0x11 $true
        if ($null -ne $prevText) {
          try { Set-Clipboard -Value $prevText } catch {
          }
        }
      }
    }
    "focus" {
      $found = $null
      foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$Title*" -or $_.ProcessName -like "*$Title*") })) {
        $found = $p; break
      }
      if ($null -eq $found) { Out-Err "no window matches title: $Title"; break }
      [Inp]::keybd_event(0, 0, 0, [UIntPtr]::Zero)
      [void][Inp]::ShowWindow($found.MainWindowHandle, 9)
      [void][Inp]::SetForegroundWindow($found.MainWindowHandle)
      Out-Ok @{ title = $found.MainWindowTitle }
    }
    default { Out-Err "unknown op: $Op (move|click|scroll|drag|key|paste|focus)" }
  }
} catch {
  Out-Err $_.Exception.Message
}
