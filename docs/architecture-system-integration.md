# 桌面版 Windows 系统集成：默认浏览器 / 文件关联 / 双击打开

> 事实源：`desktop/system-integration.ts`（注册表规划与执行）· `desktop/main.ts`（IPC、单实例 argv、打开链路）· `desktop/preload.cts`（`piDesktop.systemIntegration` / `onOpenFiles`）· `web/src/components/DesktopAppSettings.tsx`（设置面板）· `web/src/App.tsx`（`getDesktopOpenFilesBridge`）· `plugins/office/index.mjs`（工作区外路径与远程文档）。

## 1. 能力边界（先读这段，别指望做不到的事）

Windows 10/11 的默认程序由 `HKCU\...\UserChoice` + 哈希保护决定，**任何程序都无法静默改写**。所以「设为默认浏览器」只能拆成两步：

1. pi 把 ProgId 与 `Capabilities` 写进 HKCU（用户级，不需要管理员权限），让自己出现在「默认应用 / 打开方式」列表里；
2. 用户在系统设置里选中 pi 并确认。设置页的按钮只负责把人送到 `ms-settings:defaultapps`。

同理，文件关联只登记 `.ext\OpenWithProgids` 与 `Capabilities\FileAssociations`，**不写 `.ext` 的默认值**：写不进（系统会无视）还会破坏用户现有默认。用户右键「打开方式 → 始终使用 pi」或在「默认应用」里选一次，才算真正绑定。

其它硬约束：

- 只有 `win32` 注册；macOS/Linux 直接返回 `supported: false`（`readIntegrationState`）。
- 开发模式（`app.isPackaged === false`）禁止写入：`process.execPath` 那时是 `electron.exe`，写进去等于把 Electron 插件成默认浏览器。
- 便携版的 `process.execPath` 在临时解包目录，注册时必须用 `PORTABLE_EXECUTABLE_FILE`（用户双击的那个 exe）。换目录后命令会指到旧路径，启动时 `refreshSystemIntegrationOnStartup()` 检查 `stale` 并重写。

## 2. 注册表布局（HKCU）

```
Software\Classes\PiWebUI.Desktop.Html            (默认)="Pi Web UI"
  \DefaultIcon                                   "C:\...\pi-web-ui-desktop.exe",0
  \shell\open\command                            "C:\...\pi-web-ui-desktop.exe" "%1"
Software\Classes\PiWebUI.Desktop.pdf             每个扩展名一个 ProgId
  \shell\open\command                            同上
Software\Classes\.pdf\OpenWithProgids            PiWebUI.Desktop.pdf=""
Software\PiWebUI\Capabilities                    ApplicationName / Description / Icon
  \UrlAssociations                               http / https = PiWebUI.Desktop.Html
  \FileAssociations                              .pdf = PiWebUI.Desktop.pdf
Software\RegisteredApplications                  Pi Web UI = Software\PiWebUI\Capabilities
```

- `desktop/system-integration.ts` 只做两件事：**纯函数**（`browserRegistrationActions` / `fileRegistrationActions` / `planIntegrationActions` / `removalActions` / `registryArgs` / `reg query` 输出解析 / `collectOpenTargets`）与**异步执行**（`createRegistryRunner` → `spawn("reg.exe")`）。
- 红线：主进程不许同步子进程（`spawnSync` 等），所以执行器一律 `spawn` + Promise；删不存在的键不算失败（`applyRegistryActions` 只把 `set` 失败算错）。
- 勾选状态存 `<userData>/system-integration.json`；`planIntegrationActions(current, next)` 算出「新增写、去掉删」的幂等动作集，全部取消时连 `RegisteredApplications` 登记与 `Software\PiWebUI` 一起收掉。

## 3. 双击文件 / 点链接怎么进到界面

```
系统双击 .docx / 点 http 链接
  → 新进程 argv（已有实例则 second-instance 事件转交）
  → collectOpenTargets(argv) 过滤开关与不存在路径（dev 模式跳过启动 argv）
  → queueOpenTargets → flushOpenTargets（窗口就绪后）
       ├ 链接 → browser.createTab(url)，模式切 browser/split
       ├ .pdf → browser.createTab("", { localFile })：webPreferences.plugins=true 才有 Chromium PDF 阅读器
       └ 其它 → pi-desktop:open-file 事件 → 渲染层 openFile(path, name)
                 ├ 有插件 fileHandlers（office）→ 插件渲染并可直接保存
                 └ 无插件 → FilePreview（read_file 支持绝对路径）
```

- Agent 页未就绪（`agentReady === false`）时文件留在队列，`DesktopBrowserHost` 的 `onAgentReady`（`did-finish-load`）回调再 flush 一次；链接与 PDF 不等它。
- `browser/runtime/manager.ts` 的 `createTab(url, { localFile })` 是**唯一**放行 `file://` 的入口，由主进程调用；`normalizeBrowserUrl` 仍然只收 http(s)，网页传入 `file://` 一律拒绝。持久化的 `file://` 标签在恢复时走 `safeFilePath`。
- 渲染层订阅点在 `web/src/App.tsx`（`getDesktopOpenFilesBridge`），与文件树双击共用同一个 `openFile`。

## 4. office 插件：工作区外与远程文档

「双击下载目录里的 Word」要求插件能读工作区外路径，做法复用现有权限模型，不新开旁路：

- `server/plugins.ts` 的 `host.resolveInWorkspace()` 现在接受 **工作区 ∪ 已授权目录**（`PluginGrantsStore.has`，含子路径）。授权仍由用户在权限弹窗里点同意，写进 `plugin-grants.json`。
- `plugins/office/index.mjs` 的 `ensureOfficePath()`：命中 403 时 `host.fs.requestAccess(dirname(absPath), reason)` 请求一次授权，成功后重试原校验；拒绝就维持原错误。`/save`、`/inspect`、`/edit`、`/read-sheet` 与 `office_doc` 工具都走它（`/open` 本来只读，走 `resolveOfficePath`）。
- 远程文档（`http(s)://…`）由 `downloadRemoteDoc()` 用 `host.fetch` 下到插件自己的临时缓存（≤64 MiB，仅 `.xlsx/.docx/.pptx/.csv/.tsv`）再走同一条转换链；`/save`、`/edit` 对远程路径直接拒绝（`400`，提示只读、请另存为），客户端 `entry.mjs` 据此把「保存」置灰、只留「另存为」（仍写回工作区）。

## 5. 调试与验证

```sh
# 纯函数与状态解析（不需要 Windows 也能跑）
npx vitest run tests/unit/system-integration.test.ts

# 类型（桌面主进程 + 渲染层 + 服务端）
npm run typecheck
```

实机验证顺序：

1. `npm run build && npx electron dist/desktop/main.js`（dev 下设置页会提示「未打包不写注册表」）；
2. 打包安装后：设置 → 桌面应用 → 系统集成，勾选浏览器与 `.pdf/.docx`，保存；
3. `reg query HKCU\Software\PiWebUI\Capabilities /s` 应看到 `UrlAssociations` 与 `FileAssociations`；
4. 「打开系统默认应用设置」→ 把 pi 选成默认浏览器；双击 `D:\Downloads\a.docx`（工作区外）应打开 pi 并在插件里渲染，首次保存会弹目录授权；
5. 便携版换目录后再启动：控制台无 `刷新系统集成注册失败`，`reg query` 的 command 指向新 exe。

## 6. 已知限制

- 系统默认的选择权在用户：没有「一键设为默认」的合法实现，注册后仍要用户点一次。
- 文件关联不会自动抢占已有默认（`UserChoice` 哈希），只能作为「打开方式」候选出现。
- 远程文档只读；插件缓存随实例销毁（`cacheDir` 在停用时删除），不落盘留存。
- `file://` 标签与其他标签一样会被持久化，但文件被删除后恢复只会得到空白页（Chromium 的加载失败）。
- 双击图片/音视频仍走渲染层预览（`FilePreview`），没有专门的文件关联候选；要加只需在 `fileRegistrationActions` 的候选集里补扩展名并调整 `flushOpenTargets` 的分流表。
