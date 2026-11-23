# 桌面应用内更新（状态机 / IPC / 发布说明）

> 事实源：`desktop/updater.ts`★（状态机与能力判定）· `desktop/main.ts`（接线与落盘）· `desktop/preload.cts`（桥）· `web/src/desktop-updater.ts`★（渲染层快照）· `web/src/update-verdict.ts`★（通道 → 单一结论）· `web/src/components/UpdateModal.tsx`（更新中心弹窗）。
> 守卫：`tests/unit/desktop-update-state.test.ts` · `tests/unit/desktop-updater.test.ts` · `tests/unit/desktop-updater-bridge.test.ts` · `tests/unit/update-verdict.test.ts` · `tests/unit/update-row-layout.test.ts`。

参考模型来自 [yetone/magpie](https://github.com/yetone/magpie) 的自更新实现（`internal/update/`）：**先判断这份拷贝能不能换掉自己，再谈下载**；失败要分得出「网络不行 / 还没发布 / 没有写权限 / 系统不收这个包」，而不是一句英文错误；发布说明是更新体验的一部分。桌面壳跑的是 Electron，替换动作仍交给 `electron-updater`（NSIS / dmg+zip / AppImage），这里补齐的是它不管的那一层。

## 一、为什么状态住主进程

旧实现是「事件驱动 + 增量广播」：应用启动就 `checkForUpdates()`，发现新版往渲染层推一个 `{state:"available"}`。问题是网页要等本地服务起来（几秒）才挂上监听，事件早就丢了——更新面板会一直停在「检查更新」，用户只能重启后再撞一次运气。

现在只有一份 `UpdaterState`，住在主进程：

- 渲染层挂载时先 `getState()` 拉一次快照（窗口重载、面板重开都能拿回「已发现 / 已下载」）；
- 之后每次变化广播**完整快照**，渲染层直接替换，不做增量合并；
- 前端发起的检查 / 下载也走同一条链路，`reduceUpdater()` 是唯一的状态迁移入口。

因此「谁先订阅」不再是正确性前提。同一个原则在核心协议里也是同一条（见 [`architecture-core.md`](architecture-core.md)）。

## 二、状态机

```text
idle ──checking──▶ checking ──┬─▶ available ──download──▶ downloading ──▶ downloaded
                              ├─▶ up-to-date                      │
                              └─▶ error  ◀── download/progress 失败 │
downloaded ──(quitAndInstall)──▶ 退出并安装                        │
downloading ──cancel──▶ available（不落 error）
```

`UpdaterState` 的关键字段：

| 字段                       | 含义                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `mode` / `modeReason`      | `auto` 能自更新；`manual` 加原因（`dev`/`portable`/`no-feed`/`forced`） |
| `phase`                    | 上面那条状态机的当前节点                                                |
| `currentVersion`           | `app.getVersion()`，渲染层显示「当前版本」                              |
| `targetVersion`            | 已发现的更新目标；`up-to-date` 时清空，避免显示陈旧版本号               |
| `releasesBehind` / `notes` | 中间隔了几个 release、每个 release 的说明（新→旧）                      |
| `percent` / `transferred`… | 下载进度；`percent` 缺失时按字节算，不沿用上一阶段的值                  |
| `skippedVersion`           | 用户「忽略此版本」，落盘在 `userData/desktop-updater.json`              |
| `errorCode` / `error`      | 分类后的失败码 + 原始信息（只作为细节展示）                             |
| `releasesUrl`              | 目标版本发布页，手动安装的兜底入口                                      |

约定：

- `up-to-date` 必须清掉 `targetVersion` / `notes`，否则「已是最新」下面还挂着上一轮的更新说明；
- `cancelled` 回到 `available` 且**不写 error**；用户主动取消不是失败；
- `manual` 模式下 `check/download/quitAndInstall` 全部是空操作，只把原因交给界面。

## 三、能力判定：这份拷贝能不能换掉自己

`resolveUpdaterMode()` 在启动时算一次，顺序是：

1. `PI_DESKTOP_UPDATE_MODE=manual|auto`（支持 / 现场调试，`manual` 时 modeReason 记 `forced`）；
2. 未打包（`app.isPackaged === false`）→ `manual` / `dev`；
3. 便携布局（`setupPortableMode()` 命中）→ `manual` / `portable`：便携版的语义是「换解压目录」，不是原地覆盖；
4. `process.resourcesPath/app-update.yml` 不存在 → `manual` / `no-feed`：`win-unpacked`、手工拷贝的目录都在这条路上（electron-builder 只给 NSIS / dmg+zip / AppImage 写这个文件）。

这条判断把 magpie 的 `Stuck()`（在磁盘映像里打开、被 App Translocation 搬走、只读卷）翻译成了 Electron 这边等价的信号。判定为 `manual` 时**不加载 `electron-updater`**，界面直接给「去下载页手动安装」，而不是让用户对着一条 `Cannot find app-update.yml` 发呆。

## 四、失败分类 → 用户下一步

`classifyUpdaterError()` 把 `electron-updater` 的错误串归成六类，前端据此决定给「重试」还是「换包」：

| `errorCode`  | 典型来源                                                | 面板给的动作                |
| ------------ | ------------------------------------------------------- | --------------------------- |
| `network`    | `ENOTFOUND` / `ETIMEDOUT` / `ERR_INTERNET_DISCONNECTED` | 重试 + 手动下载             |
| `feed`       | `latest.yml` 404、feed 解析失败、发布未完成             | 重试 + 手动下载             |
| `permission` | `EACCES` / `EPERM`：安装目录不可写                      | 手动下载（换安装位置）      |
| `disk`       | `ENOSPC`                                                | 重试（腾空间后）            |
| `signature`  | 代码签名 / 完整性校验被系统拒绝（未签名的包首启）       | 手动下载（右键打开 / 放行） |
| `unknown`    | 其它                                                    | 重试 + 手动下载             |

## 五、发布说明（What's new）

`attach()` 里设 `autoUpdater.fullChangelog = true`：`electron-updater` 的 GitHub provider 会把 `current..latest` 之间每个 release 的说明都塞进 `update-available` 的 `releaseNotes`，`normalizeReleaseNotes()` 统一成 `{version, markdown}[]` 并按上限裁剪：

- 最多 `MAX_NOTE_RELEASES = 20` 段、单段 `MAX_NOTE_CHARS = 3000`、总量 `MAX_NOTES_CHARS = 40000`；
- 超限置 `notesCut`，面板提示「只显示最近的部分」并链到发布页；
- 渲染复用 `web/src/components/Markdown.tsx`（默认不渲染原始 HTML），字号按面板缩小。

所以「更新内容」不是另找接口：它跟着 feed 一起下来，离线时也不会去请求第三方服务。

## 六、IPC 契约

| 通道                              | 方向 | 说明                                                |
| --------------------------------- | ---- | --------------------------------------------------- |
| `pi-desktop-updater:state`        | 调用 | 返回 `UpdaterState` 快照（面板挂载 / 重开时用）     |
| `pi-desktop-updater:check`        | 调用 | `{manual?: boolean}`；`manual` 清退避计数并立即检查 |
| `pi-desktop-updater:download`     | 调用 | 单飞：下载中重复调用直接忽略                        |
| `pi-desktop-updater:cancel`       | 调用 | 取消下载（token 由 `CancellationToken` 提供）       |
| `pi-desktop-updater:skip`         | 调用 | `string                                             | null`，落盘并影响顶部小红点 |
| `pi-desktop-updater:quit-install` | 调用 | 只在 `downloaded` 阶段有效                          |
| `pi-desktop-updater:event`        | 广播 | 每次状态变化推**完整快照**                          |

三个面必须一起改，`tests/unit/desktop-updater-bridge.test.ts` 会拦：

1. `desktop/main.ts` 的 `ipcMain.handle`（全部先过 `assertTrustedDesktopRequest`）；
2. `desktop/preload.cts` 暴露的 `piDesktop.updater.*`；
3. `web/src/desktop-updater.ts` 的 `DesktopUpdaterBridge`。

**旧壳兼容**：新前端遇到旧壳（只广播 `{state:"available", version}` 这种增量事件、没有 `getState`）时，`legacyUpdaterPatch()` 把它折成状态片段，面板仍能用；`getDesktopUpdaterBridge()` 只要求 `check`/`download` 存在，`cancel`/`skip` 缺失时相应按钮不出现。

## 七、自检节奏

- 启动后 `initialCheckDelayMs = 15s` 做第一次检查（避开启动高峰）；
- 之后 `checkIntervalMs = 6h`；失败按 `2^failures` 退避，上限 `maxCheckIntervalMs = 24h`；
- 手动检查清空 `failures`，等于「现在就查，并且重新开始计时」；
- 下载中 / 已下载阶段不自动检查；定时器 `unref()`，不拦退出；
- 只检查元数据（`autoDownload = false`），用户点「下载更新」才动网络。

## 八、两条更新通道的边界

桌面壳里有两条互不相干的路：

| 通道       | 覆盖对象                                       | 入口                                 |
| ---------- | ---------------------------------------------- | ------------------------------------ |
| npm        | 引擎、插件、全局包、Git 扩展（网页 / CLI 下还有 pi-web-ui 本体） | `check_update` / `check_updates_all` |
| 桌面自更新 | 应用本体 + **运行时**（含服务端与前端）        | `pi-desktop-updater:*`               |

**怎么不混**：只由 `web/src/update-verdict.ts` 的 `resolveUpdateCenter()` 判定一次，顶栏 chip、badge、小黄点与弹窗标题/主按钮全读这份结果。

- 桌面壳：轴 = 「应用（壳）」+「运行时」，**运行时就是 pi-web-ui 本体**，所以 `updatesAll` 里那条 `kind: "webui"` 只作为版本兜底输入，不进入组件列表（组件的口径是插件 / 全局包 / Git 扩展）。
- 网页 / CLI：没有壳也没有运行时通道，第一条轴换成「Web 界面（npm 全局包）」，同样不会在组件里再出现一次。
- 引擎（`@earendil-works/pi-coding-agent`）单独成轴：清单里有新版才给按钮；「机器上装了更新的全局 pi」只提示不按钮（`npm i -g pi@latest` 修不了服务正在跑的那份）。

旧实现按 `inDesktopShell` 在两套 DOM 之间二选一，结果顶栏统计了 webui 行、面板又说「已是最新」，同屏自相矛盾（`updatesCount` 与面板结论不同源）。现在只留一个入口：顶栏 chip 打开 `UpdateModal`，其余位置不再各画一份。

## 九、对着本地 feed 实机测更新

发真包验证更新会污染 Release，所以留了一个测试开关（参考 magpie 的 `MAGPIE_UPDATE_FEED`）：

```bash
# 1) 把某个目录当 feed：自动算 sha512、写 latest*.yml、起 HTTP 服务（长跑用后台任务）
node scripts/desktop-update-feed.mjs --dir release --version 0.121.1 --port 8799
#    产物选择：win 取 *-setup.exe、mac 取 *.zip、linux 取 *.AppImage；也可 --file 指定

# 2) 用「能自更新」的拷贝启动，并强行打开能力判定（解压包 / 无 app-update.yml 时需要）
PI_DESKTOP_UPDATE_MODE=auto PI_DESKTOP_UPDATE_FEED=http://127.0.0.1:8799 <桌面可执行文件>
```

测试模式下主进程会自动下载（不自动安装），并把每次状态迁移打到日志：`[updater] phase=… target=… percent=…`。

能验到哪一步：**检查 → 发现新版 → 下载 → 校验哈希 → downloaded**。
验不到：**替换安装**——需要真实安装包（本机用 `npm run desktop:nsis` 产出，与 CI 的 desktop-release 同一条命令），以及安装器能被执行。macOS 另需签名/公证，见下一节。

> 下一层演进（壳/运行时分离、自有密钥签名、三平台矩阵）见 [`architecture-desktop-runtime.md`](architecture-desktop-runtime.md)。

## 十、还没做的

- **签名校验**：包体完整性目前只依赖 `electron-updater` 自带的 `sha512`（`latest*.yml`）。macOS 未签名产物要靠用户右键打开，`signature` 分类只负责把这类失败讲清楚。
- **镜像 / 代理回退**：magpie 会在 github.com 抽风时改走 API 路由或用户镜像；这里还没有，`feed`/`network` 失败只引导手动下载。
- **增量下载与恢复**：`electron-updater` 的差分包（`.blockmap`）已经随产物发布，但下载中断后仍从头开始。
- **安装后自检回滚**：magpie 会在新版本起不来时把旧版本放回去；Electron 这边替换动作在安装器里完成，暂时只能靠「从下载页重装」。

排期时按「用户实际撞到的失败」排序，别为了对齐参考实现而先做回滚。

## 十一、MSI 本地安装（FilesInUse 绕行）

MSI（WiX）安装器不会主动关闭正在运行的旧版应用，用户手动装 MSI 会被 FilesInUse 卡住。修法是「退出并安装本地 MSI」：应用内选包 → 起一个 detached 看门狗等本进程退出 → 跑 `msiexec /passive` → 应用自己退出。事实源：`desktop/msi-quit-install.ts`（纯函数：`validateMsiPath` / `buildMsiQuitInstallScript` / `escapePsSingleQuoted`，不 import electron）· `desktop/main.ts`（`pi-desktop:update-install-local-msi` 接线）。守卫：`tests/unit/msi-quit-install.test.ts`。

- 看门狗 ps1：循环 `Get-Process -Id <pid>`（500ms 一次，最多 120 秒）→ 进程消失后 `Start-Process msiexec.exe -ArgumentList '/i', <msi>, '/passive'` → 结尾自删 ps1（`try/catch` 包住，删不掉不报错）。PowerShell 单引号转义为双写（`'` → `''`）。
- 主进程：先过 `assertTrustedDesktopRequest`；`dialog.showOpenDialog`（filters 限 `msi`，取消返回 `{ok:false, cancelled:true}`）；`validateMsiPath` 拒绝空 / 超长（>4096）/ 控制字符 / 非 `.msi` 后缀 / 不存在的文件；ps1 原子写（`os.tmpdir()` 下 tmp+rename）；`spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {detached:true, stdio:"ignore", windowsHide:true})` 后 `unref()`，成功才 `app.quit()`；任何一步失败只返回 `{ok:false, error}` 且不退出；非 win32 直接返回 `{ok:false, error:"unsupported-platform"}`。
- 三面对齐（与 §六 同一守卫思路）：`desktop/main.ts` 的通道名 `pi-desktop:update-install-local-msi` ＝ `desktop/preload.cts` 的 `updater.installLocalMsi` ＝ `web/src/desktop-updater.ts` 的桥方法（旧壳缺失时为 `undefined`，面板不显示按钮）。面板在 `web/src/components/UpdateModal.tsx` 的壳轴「更多选项」里（仅 win32 + 桌面壳）：`window.confirm` 二次确认 → 调用 → ok 即显示「正在退出并安装…」（应用随即退出，无需处理返回后的状态）。

## 十二、NSIS 覆盖安装（FilesInUse 绕行：关不掉的 helper/CLI 孤儿）

NSIS 安装器自带的 `CHECK_APP_RUNNING` 在 cmd 分支（PowerShell 不可用 / 被执行策略禁掉时）只认“镜像名 = 主 exe”，漏掉三类自家人：① node-pty 解压在 `app.asar.unpacked` 下的 console helper（`winpty-agent.exe` / `OpenConsole.exe`，异镜像，主进程被强杀后 `will-quit` 来不及跑，它们成孤儿继续抱着 unpacked 原生模块）；② `resolveKernelPkgRoot()` 指回安装目录时跑起来的 `bin` CLI（服务安装/状态查询等短命进程，命令行带安装目录）；③ bundled 内核的 `ELECTRON_RUN_AS_NODE` 侧车（同镜像，PS 分支能杀、cmd 分支只能看到主 exe）。PS 分支按镜像路径前缀匹配，能看见①③，看不见“镜像在外、命令行指向安装目录”的②。结果都是覆盖写文件时 `Error opening file for writing`，安装卡在进度条。事实源：`desktop/installer.nsh`（`customInit` / `customUnInstall` 共用的清场宏）· `desktop/electron-builder.yml`（`nsis.include` 接线）。守卫：`tests/unit/nsis-installer.test.ts`。

- 清场宏只动两类进程，绝不裸杀 `node.exe`（会误伤用户本机开发服务）：① 可执行路径落在 `$INSTDIR` 下的（node-pty helper 等自家文件）；② 镜像名是 `node.exe` **且**命令行包含 `$INSTDIR` 的（安装目录 `bin` CLI / 引用了安装目录的侧车；安装器自身跑在 `%TEMP%`，不可能命中，无需 pid 自排除）。
- 先礼后兵：`Stop-Process` 优雅关 → `Sleep 800` → `-Force` → `Sleep 500`。PowerShell 被执行策略禁掉时退回 `wmic … delete`（同样两条规则）；都没有就静默跳过，股票逻辑仍兜住主 exe。
- 注入点：`customInit`（`.onInit` 里 `initMultiUser` 之后，`$INSTDIR` 已定，目录页出来前清场；oneClick/assisted 都走）；`customUnInstall`（股票 `un.checkAppRunning` 之后，否则卸载也删不干净被锁的 asar）。
- 用户侧即时解法（没新包时）：彻底退出旧版（确认任务管理器里没有 `pi-web-ui-desktop.exe`），再跑 `setup.exe`；`setup.exe`（assisted，per-user）与 `*-oneclick.exe` / `*.msi` 落盘位置不同，混装等于装三份，升级前先只留一种并卸载其余。

### 十二补：安装器必须提权（「不能打开要写入的文件」的真实原因）

2026-11-21 实机定位：NSIS 安装到一半弹「不能打开要写入的文件：`<安装目录>\Uninstall pi-web-ui-desktop.exe`」，
换任何目录（`%LOCALAPPDATA%\Programs`、`C:\app\pwu`、`D:\t4`）都一样，**改动前的旧包同样复现** —— 与路径无关。

在三处埋点后拿到决定性证据（`desktop/installer.nsh` 的 `customFiles_<arch>` 钩子写探针）：

| 启动方式                 | `$TEMP`       | 写 `$INSTDIR` 探针 | 结果                           |
| ------------------------ | ------------- | ------------------ | ------------------------------ |
| 普通双击（非提权）       | `…\Temp\Low\` | `OPEN-FAILED`      | 装到一半报上面那句             |
| 右键「以管理员身份运行」 | `…\Temp\`     | `ok`               | 19 个文件 + 注册表卸载项写成功 |

`…\Temp\Low` 是 Windows 给**低完整性令牌**进程的临时目录 —— 也就是说非提权启动时安装器落在 Low IL，
对中完整性的安装目录**没有写权限**，NSIS 把「拒绝访问」一律显示成「不能打开要写入的文件」。
所以在 `nsis` 里加 `perMachine: true`（NSIS 侧的提权开关，安装器起手就 UAC），
**不要用 `win.requestedExecutionLevel`** —— 那个作用于「应用 exe」，会让装好之后每次启动都要管理员。

同处还修掉一个隐式依赖：electron-builder 把卸载器的落盘位置记成解包宏留下的 `$R0` 寄存器
（`7z l` 产物能看到 `$R0\Uninstall …exe`），这里显式 `SetOutPath "$INSTDIR"` 钉死。
