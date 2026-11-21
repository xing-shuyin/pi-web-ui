; pi-web-ui NSIS 自定义安装逻辑（electron-builder `nsis.include` 单源引入）。
;
; 背景（见 docs/architecture-desktop-update.md §十二）：
; 覆盖安装卡住，锁文件的从来不是主 exe 本身（股票逻辑按镜像名能关掉它），而是三类“自家人”：
; ① node-pty 解压在 app.asar.unpacked 下的 console helper（winpty-agent.exe / OpenConsole.exe，
;    异镜像）：主进程被强杀（will-quit 来不及跑）后成孤儿，继续抱着 unpacked 原生模块；
; ② resolveKernelPkgRoot() 指回安装目录时跑起来的 bin CLI（服务安装/状态查询等，命令行带安装目录）；
; ③ bundled 内核的 ELECTRON_RUN_AS_NODE 侧车（同镜像，PS 分支能杀，cmd 分支只能看到主 exe）。
; electron-builder 自带的 CHECK_APP_RUNNING 在 cmd 分支（PowerShell 不可用/被策略禁掉时）只按
; “镜像名 = 主 exe”匹配，①②③一个都看不见；PS 分支按镜像路径前缀匹配，能看见①③但看不见
; “镜像在外、命令行指向安装目录”的② → 覆盖写文件时报“Error opening file for writing”，安装卡在进度条。
; MSI 当年是同一起因，走的是应用内“退出并安装本地 MSI”看门狗（desktop/msi-quit-install.ts）；
; NSIS 这边在安装器侧补齐。
;
; 策略（先礼后兵，只动自家目录，绝不按裸镜像名杀 node.exe——那会误伤用户的开发服务）：
; 1. 可执行路径落在 $INSTDIR 下的进程：全是自家文件，直接关（主 exe 股票逻辑也会关一遍，重复无害）。
; 2. 镜像名为 node.exe，但命令行包含 $INSTDIR 的进程：就是自家 server 侧车，关。
; 两轮：先优雅（Stop-Process 无 -Force ≈ CloseMainWindow）→ 睡 800ms → 强制 → 睡 500ms。
; PowerShell 被组策略禁掉时退回 WMIC（按同样两条规则）；WMIC 也不存在就静默跳过，
; 股票的 CHECK_APP_RUNNING 仍会兜住主 exe。
;
; 两个注入点共用同一宏：
; - customInit：安装器 .onInit（initMultiUser 之后，$INSTDIR 已定），目录页出来之前就清场。
; - customUnInstall：卸载段（股票 un.checkAppRunning 之后），否则卸载也会被侧车锁住删不干净。
; 安装器自身解压运行在 %TEMP%，命令行/镜像都不可能命中上面两条规则，无需 pid 自排除。

!macro PI_SWEEP_SIDECARS
  Push $R0
  Push $R1
  Push $R2

  ; PowerShell 可用吗（能跑 + 执行策略没禁掉）？沿用股票逻辑的探测方式。
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }"`
  Pop $R0
  Pop $R1
  ${If} $R0 == "0"
    ; 第一轮：优雅关闭（自家目录进程 + 命令行指向自家目录的 node 侧车）。
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "& { $$dir='$INSTDIR'; $$isOurs = { param($$p) (($$p.ExecutablePath -ne $$null) -and ($$p.ExecutablePath.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase))) -or (($$p.Name -eq 'node.exe') -and ($$p.CommandLine -ne $$null) -and ($$p.CommandLine.Contains($$dir))) }; Get-CimInstance Win32_Process | Where-Object { & $$isOurs $$_ } | ForEach-Object { try { Stop-Process -Id $$_.ProcessId } catch { } } }"`
    Pop $R0
    Pop $R1
    Sleep 800
    ; 第二轮：还没退出的强制结束。
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "& { $$dir='$INSTDIR'; $$isOurs = { param($$p) (($$p.ExecutablePath -ne $$null) -and ($$p.ExecutablePath.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase))) -or (($$p.Name -eq 'node.exe') -and ($$p.CommandLine -ne $$null) -and ($$p.CommandLine.Contains($$dir))) }; Get-CimInstance Win32_Process | Where-Object { & $$isOurs $$_ } | ForEach-Object { try { Stop-Process -Id $$_.ProcessId -Force } catch { } } }"`
    Pop $R0
    Pop $R1
    Sleep 500
  ${Else}
    ; 无 PowerShell 兜底：WMIC 按同样两条规则强制结束（WMIC 只有终止语义，没有优雅可言；
    ; wmic.exe 不存在时 nsExec 直接返回错误码，无副作用）。
    nsExec::ExecToStack `"$SYSDIR\wbem\wmic.exe" process where "(ExecutablePath like '$INSTDIR%' or (name='node.exe' and CommandLine like '%$INSTDIR%'))" delete`
    Pop $R0
    Pop $R1
    Sleep 500
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customInit
  !insertmacro PI_SWEEP_SIDECARS
!macroend

!macro customUnInstall
  !insertmacro PI_SWEEP_SIDECARS
!macroend
