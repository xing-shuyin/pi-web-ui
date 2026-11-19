# 桌面应用内更新（状态机 / IPC / 发布说明）

> 事实源：`desktop/updater.ts`★（状态机与能力判定）· `desktop/main.ts`（接线与落盘）· `desktop/preload.cts`（桥）· `web/src/desktop-updater.ts`★（渲染层快照）· `web/src/components/DesktopUpdatePanel.tsx`（面板）。
> 守卫：`tests/unit/desktop-update-state.test.ts` · `tests/unit/desktop-updater.test.ts` · `tests/unit/desktop-updater-bridge.test.ts`。

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

| 通道       | 覆盖对象                              | 入口                                 |
| ---------- | ------------------------------------- | ------------------------------------ |
| npm        | 全局 `pi-web-ui`、pi core、插件等组件 | `check_update` / `check_updates_all` |
| 桌面自更新 | 应用本体（含包内的 `dist/server`）    | `pi-desktop-updater:*`               |

面板在桌面壳里只显示自更新这一段（版本号、进度、说明），并把 npm 那段留给挂件更新列表；网页 / CLI 里反过来。混着显示会出现「npm 说有新版、安装包其实已经是最新」的错位，所以 `TopBar` 用 `inDesktopShell` 二选一。

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
验不到：**替换安装**——需要真实安装包（本机按 [`release.md`](release.md) 的口径产不出 NSIS），以及安装器能被执行。macOS 另需签名/公证，见下一节。

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
- 三面对齐（与 §六 同一守卫思路）：`desktop/main.ts` 的通道名 `pi-desktop:update-install-local-msi` ＝ `desktop/preload.cts` 的 `updater.installLocalMsi` ＝ `web/src/desktop-updater.ts` 的桥方法（旧壳缺失时为 `undefined`，面板不显示按钮）。面板在 `web/src/components/DesktopUpdatePanel.tsx`（仅 win32 + 桌面壳）：`window.confirm` 二次确认 → 调用 → ok 即显示「正在退出并安装…」（应用随即退出，无需处理返回后的状态）。
