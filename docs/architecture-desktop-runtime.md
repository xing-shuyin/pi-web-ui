# 桌面更新适配方案：壳 + 运行时双层（Windows / macOS / Linux）

> **状态：P0（加载路径）+ P1（归档/清单/签名/解包）+ P2（下载 → 切换 → 健康检查 → 回滚 + 面板双段）已落地；P3 macOS 壳自更新仍是设计稿**。
> 已实现：`desktop/runtime-store.ts`、`desktop/runtime-manifest.ts`、`desktop/runtime-updater.ts`、
> `desktop/runtime-config.ts`（信任根/壳能力线）、`desktop/main.ts` 接线、`desktop/updater.ts` 的 runtime 通道、
> 面板第二段（`DesktopUpdatePanel.tsx`）、`scripts/build-desktop-runtime.mjs` / `scripts/verify-desktop-runtime.mjs`。
> 未实现：macOS 壳换包（P3）、差分下载/灰度（P4）、`natives` 载荷的下载与复用（P2 只处理 `core`）。
> **信任根已内置**：`desktop/runtime-config.ts` 的 `RUNTIME_PUBLIC_KEY_PEM`（指纹 `c144c1…`），私钥只存 CI secret
> `DESKTOP_RUNTIME_SIGNING_KEY`（步骤见 [`release.md`](release.md#桌面运行时签名壳--运行时双层模型)）；清空公钥即回到"拒绝一切更新"。
> "一体包 + electron-updater"的当前实际行为见 [`architecture-desktop-update.md`](architecture-desktop-update.md)；
> 本文其余部分描述"要变成什么样、分几步、每步验收什么"。
>
> 参考实现：magpie 的自更新（换包 + 失败放回旧包）、Tauri updater（自有密钥签名，官方明确"签名不可关闭"）、
> VS Code Remote（按版本下发预构建 server 归档）、Homebrew Cellar（版本目录 + `opt` 指针）、Chrome 组件更新器（壳与组件分离）。

## 一、目标与非目标

**目标**

1. 三平台同一套模型：**壳（Electron）**和**运行时（服务端 + 前端 + 原生件）**各自独立更新。
2. 常态更新只下几十 MB（JS 载荷），不再每次 700 MB。
3. macOS **不需要 Apple 证书**也能更新运行时；壳的自更新在未签名状态下也有可落地路径。
4. 任何一次切换失败都能**自动回到上一个能用的版本**，且永远保留"安装包内自带运行时"这条活路。
5. 安全边界不退化：所有产物用**自有 ed25519 密钥**签名，壳内只存公钥。

**非目标**

- 不换框架（不迁 Tauri：内置 Chromium 扩展、CDP 自动化、每标签独立 session 是产品能力，见下节"为什么不是 Tauri"）。
- 不做"壳热更新"（Electron 二进制/preload 变更仍走整包）。
- 不做多用户共享安装、不做企业策略分发。
- 不做增量差分（P4 可选）。

## 二、三平台现状与差距

|                    | Windows                                                                    | macOS                                                        | Linux                                               |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| 现在壳怎么更       | `electron-updater` + NSIS（`latest.yml`），CI 可选 SignPath 签名后刷新哈希 | `electron-updater` + Squirrel，**未签名 → 安装阶段必然失败** | `electron-updater` + AppImage（`latest-linux.yml`） |
| 现在"服务端"怎么更 | 跟壳一起（`resources/app/dist/server`）                                    | 同左                                                         | 同左                                                |
| 主要痛点           | 本机产不出 NSIS、安装器执行被系统拦；每次更新几百 MB                       | 无证书就装不上；白下 150 MB 后失败                           | AppImage 必须可写；同样每次全量                     |
| 本方案怎么变       | 壳保留 NSIS；运行时改由应用自更新                                          | 运行时自更新（不碰 `.app`）；壳支持 ad-hoc + 自管换包（P3）  | 运行时自更新；壳继续 AppImage                       |

**为什么不是 Tauri**（决策已定，记录理由）：Tauri 体积更小且更新器用自有密钥，但系统 WebView
无法加载 Chrome 扩展、没有 CDP、WKWebView 共享数据存储。本仓库 `desktop/browser-host.ts`（1925 行）+
`browser/runtime/{crx,dnr,extension-*,autofill}.ts` 全部依赖 Electron/Chromium。换壳等于重写招牌功能，
且仍要另带 Node sidecar，净收益只有一两百 MB。**Tauri 的签名思想照抄，壳不换。**

## 三、双层模型

```text
L1 壳（shell）        Electron + preload + browser host + 打包器
                     更新频率：低（改 preload / IPC / Electron / 浏览器模块时才需要）
                     产物：NSIS / dmg+zip / AppImage（现有 latest*.yml 不变）

L2 运行时（runtime）   dist/server + web/dist + bin/*（ffmpeg、desktop-codec、device-p2p）+ node_modules
                     更新频率：高（每个版本）
                     产物：按平台/架构的归档 + 签名清单
```

体积账（实测）：`win-unpacked` 792 MB = Electron ~180 MB + `node_modules` 158 MB + `bin/` 250 MB
（ffmpeg 167 / device-p2p 49 / desktop-codec 38）+ `dist` 9 MB + `web` 8 MB。散文件 17480 个（`node_modules` 占 16700）——这曾是 MSI 更新慢的主因，WiX 要逐个计价/拷贝/替换。开 asar 后（`electron-builder.yml`：`asar: true`）收敛为 `app.asar` + `app.asar.unpacked/bin/**` + `*.node`/`node-pty` 等原生件：MSI 只剩个位数文件要处理。`core` 归档仍从解包态目录打，不受影响。

因此运行时再拆两层，避免"为了改几行 JS 下 400 MB"：

| 载荷      | 内容                                                | 变更频率 | 典型体积           |
| --------- | --------------------------------------------------- | -------- | ------------------ |
| `core`    | `dist/server`、`web/dist`、`node_modules`           | 每个版本 | 压缩后 ~30–60 MB   |
| `natives` | `bin/ffmpeg`、`bin/desktop-codec`、`bin/device-p2p` | 很少     | 压缩后 ~100–150 MB |

清单里 `natives` 带自己的 `version` 与摘要：版本没变就**不重复下载**，直接复用已安装的那份。

## 四、磁盘布局与指针

```text
<userData>/runtime/
  current.json                # 指针 + 回滚信息（见下）
  <version>/                  # 一个完整可运行的运行时（core + natives 合并后的视图）
    dist/server/…
    web/dist/…
    bin/…
  natives/<nativesVersion>/   # 原生件按版本单独存，软链/复制进 <version>/bin
  downloads/                  # 临时下载与解包（成功后清空）
```

`current.json`（唯一事实源，写入必须原子：临时文件 + rename）：

```json
{
	"schemaVersion": 1,
	"version": "0.122.0",
	"nativesVersion": "1.4.0",
	"protocol": 59,
	"lastGoodVersion": "0.121.0",
	"consecutiveFailures": 0,
	"installedAt": "2026-11-17T08:00:00.000Z"
}
```

规则：

- 只保留 `current` 与 `lastGood` 两份（`lastGood` 在切换成功后由 `current` 顶替）。
- `consecutiveFailures ≥ 2` 时，启动**不再尝试** `current`，直接退回 `lastGood`，并把 `current` 标记为 quarantine（等下次更新覆盖）。
- 指针与目录不同步（目录被手动删）→ 当作没有运行时，回落安装包内自带那份。

## 五、清单与签名

发布时每个 平台/架构/通道 一个清单，壳内只存**公钥**（ed25519，base64 DER）：

```json
{
	"schemaVersion": 1,
	"version": "0.122.0",
	"channel": "stable",
	"platform": "darwin",
	"arch": "arm64",
	"protocol": 59,
	"minShell": 3,
	"releasedAt": "2026-11-17T08:00:00.000Z",
	"notes": [{ "version": "0.122.0", "markdown": "### Fixed\n- …" }],
	"core": { "url": "https://…/core-0.122.0.tar.zst", "size": 41234567, "sha256": "…" },
	"natives": {
		"version": "1.4.0",
		"url": "https://…/natives-1.4.0-darwin-arm64.tar.zst",
		"size": 134567890,
		"sha256": "…"
	},
	"shell": { "version": "0.121.0", "url": "https://…/pi-web-ui-desktop-0.121.0-arm64.dmg", "sha256": "…" }
}
```

- 签名文件：`<清单>.sig`，内容是 **base64(ed25519(清单原始字节))**。壳用 Node 内置 `crypto.verify(null, bytes, publicKey, sig)`
  校验，**不引入新依赖**。
- 清单地址固定为 `…/runtime/<channel>/<platform>/<arch>.json`（+ `.sig`），与 GitHub Release 资产一起发布；
  国内网络可用 `PI_DESKTOP_UPDATE_FEED` 指向镜像（已是现成开关）。
- 校验顺序：签名 → `platform/arch` 匹配 → `sha256` 与 `size` → 解包白名单 → 写入临时目录 → 原子 rename。
- `protocol` / `minShell` 是**版本闸门**（见下节），签名通过但闸门不过 → 拒绝切换，并提示升级壳。

## 六、版本闸门

三个数，任何一项不满足就不切换（**绝不进入"能启动但行为诡异"的状态**）：

| 字段       | 来源                                                        | 含义                      | 不满足时                                                   |
| ---------- | ----------------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `protocol` | `server/protocol-version.ts` 的 `PROTOCOL_VERSION`          | 运行时与前端/壳的协议版本 | 若 > 壳自带运行时协议 → 「请先更新桌面壳」，给壳的下载入口 |
| `minShell` | 壳内常量 `SHELL_CAPABILITY_VERSION`（改 preload/IPC 时 +1） | 运行时要求的最低壳能力    | 同上                                                       |
| `version`  | semver                                                      | 防降级                    | 低于当前已安装版本 → 拒绝（回滚不受此限）                  |

实现：壳启动时从**自带运行时**读 `dist/server/protocol-version.js` 得到自己理解的协议版本（动态 `import()`，
不做编译期耦合），再与清单比较。

## 七、启动与切换流程

```text
启动
 ├─ 读 current.json
 │   ├─ 缺失/损坏/目录不存在 → 用 <app>/dist/server（安装包内自带，永远可用）
 │   ├─ consecutiveFailures ≥ 2 → 用 lastGood 目录
 │   └─ 正常 → 用 current 目录
 ├─ spawn（现有逻辑：process.execPath + ELECTRON_RUN_AS_NODE）
 ├─ 健康检查 /api/health 通过 → 标记运行版本成功，consecutiveFailures = 0
 └─ 超时/退出/crash-loop → consecutiveFailures++ ；达到 2 次 → 切 lastGood 并重启服务
```

更新（复用 `desktop/updater.ts` 的状态机，新增 `runtime` 通道，状态与壳更新并列）：

```text
idle → checking → available → downloading(percent/bytes) → verified → staged
     → 切换指针（原子）→ 重启服务 → health 通过 → done（失败则自动回滚到上一版）
```

- 下载/解包都在 `downloads/`，只有全部校验通过才 `rename` 进 `runtime/<version>`；
- 切换只改 `current.json`，不动正在运行的进程（等下次重启生效；面板提供「立即重启服务」）；
- 回滚 = 把 `current.json` 写回 `lastGoodVersion`，无网络、无解包，毫秒级。

**P2 实现要点（实机踩出来才补上的，别再拆掉）**：

1. **服务端生命周期必须串行**：启动 / 重启 / 应用更新走同一个队列（`main.ts` 的 `enqueueServerStep`）。
   不串行时「本地 feed 自动更新」会和首次启动互相 kill——实机第一轮就是这个症状（两行 `server 就绪` + 误记一次失败）。
2. **健康检查要连版本一起验**：`/api/health` 的 `piVersion` 必须等于刚切的版本，否则算失败并回滚。
   只看 HTTP 200 会把"指针切了但跑的还是旧服务"当成成功。
3. **`stoppingServer` 期间不记失败**：主动停旧进程不算崩溃；反过来，新进程起不来时 `consecutiveFailures++`，
   连续两次后 P0 直接跳过 current（崩溃循环保护）。
4. **本次启动兜底**：运行时起不来 → 立刻 `bypassRuntimeForThisBoot` 跑包内自带那份，而不是只弹错误。
5. **IPC 仍是一条通道**：`check`/`download`/`cancel` 带 `channel`（`shell`/`runtime`），只新增
   `applyRuntime`（「立即重启服务」），状态仍只有一份快照——没有第二套 4 方法桥。

## 八、三平台适配矩阵

| 关注点        | Windows                                                                                                                                                                                                                                                                                                                                                                                                                        | macOS                                                                                                                       | Linux                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 壳更新        | NSIS + `electron-updater`（保留）；签名可选（SignPath），签名后 `latest.yml` 哈希要刷新（`scripts/refresh-win-release-metadata.mjs` 已有）；包内开 asar（`asar: true`），`bin/**`、`*.node`、`node-pty` 走 `asarUnpack`（spawn 进 asar 内失败），`dist/server` 禁止 unpack（Node 从 `app.asar/dist/server` 向上解析 `node_modules` 会断链），运行时经 `server/asar-paths.ts` 的 `toUnpackedPath` 改走 `app.asar.unpacked` 副本 | 未签名：`electron-updater`/Squirrel 不可用 → P3 改自管换包（下载 → 校验 → `rename` 换 `.app` → 失败放回），壳需 ad-hoc 签名 | AppImage + `electron-updater`（现有）          |
| 运行时更新    | ✅ 自更新                                                                                                                                                                                                                                                                                                                                                                                                                      | ✅ 自更新（不碰 `.app`，无签名问题）                                                                                        | ✅ 自更新                                      |
| userData 位置 | `%APPDATA%\<app>`（可写）                                                                                                                                                                                                                                                                                                                                                                                                      | `~/Library/Application Support/<app>`（可写）                                                                               | `~/.config/<app>`（可写）                      |
| 便携模式      | `PI_PORTABLE_ROOT/data`（可写；注意跨盘 rename → 同盘临时目录再 rename）                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                           | —                                              |
| 只读/受限位置 | 装在 `Program Files` 时运行时不落在安装目录，天然可写                                                                                                                                                                                                                                                                                                                                                                          | 从 dmg 直接运行（`/Volumes/…`）或 App Translocation → **拒绝自更新并说明**                                                  | AppImage 在只读挂载点 → 壳不可自更新，运行时可 |
| 原生件        | `natives-<ver>-win32-x64.tar.zst`                                                                                                                                                                                                                                                                                                                                                                                              | `…-darwin-arm64` / `…-darwin-x64`                                                                                           | `…-linux-x64`（AppImage 内同样路径）           |
| 杀软/文件占用 | 换目录前重试 rename（仓库已有 `readFileSyncRetry` 的退避套路）                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                           | —                                              |

## 九、macOS 专项（没有 Apple 证书的三条路）

| 路线                                             | 可行性                                                                                     | 代价                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| A. `electron-updater` + Developer ID 签名 + 公证 | 完全可用                                                                                   | 需要 Apple 开发者账号（$99/年）与公证流程                                                      |
| B. **运行时自更新（本方案 P0–P2）**              | 立即生效，**不需要任何证书**                                                               | 壳的修复（preload/Electron）仍要整包                                                           |
| C. 壳也自管换包（P3）                            | 可用：下载 zip → 校验 → 换 `.app`；ad-hoc 签名（`codesign -s -`）即可在 Apple Silicon 运行 | 失去 OS 级签名验证（靠自有密钥）；首次安装仍受 Gatekeeper；需清 quarantine、检测 translocation |

P3 细节：换包前把 `.app` 移到同卷临时名（`mv` 成功后写新包，失败 `mv` 回来，magpie `swapScript` 的等价实现）；
换完要 `xattr -dr com.apple.quarantine`；`/Applications` 不可写时提示用户手动安装（不弹 sudo）。

## 十、安全

1. **信任根**：ed25519 公钥硬编码在壳内；私钥只在 CI secret（`DESKTOP_RUNTIME_SIGNING_KEY`）。轮换公钥需要一次壳更新。
2. **防降级**：清单版本必须 > 已安装版本（回滚走本地 `lastGood`，不下载旧清单）。
3. **解包防护**：拒绝绝对路径、盘符、`..`、符号链接/硬链接/设备文件；只接受归档内白名单顶层目录（`dist/`、`web/`、`bin/`、`node_modules/`、`themes/`、`plugins/`、`plugin-sdk/`、`docs/`、`package.json`，单一来源 `RUNTIME_ALLOWED_TOP_LEVEL`，长住的守卫会拿 `electron-builder.yml` 的 `files` 名单逐项对）；`asarUnpack` 只许加「不解出来就没法执行」的原生件/可执行文件（`*.node`、`bin/**`、`node-pty`），`dist/server` 永不进该名单（见 §八 Windows 行）；
   解包目标必须是新建的空目录。
4. **HTTPS**：非 `PI_DESKTOP_UPDATE_FEED`（本地测试）一律要求 https。
5. **不自动安装**：默认只下载 + 暂存，重启生效；「下载即装」是显式操作。
   实机/CI 用 `PI_DESKTOP_RUNTIME_AUTOCHECK=1` + `PI_DESKTOP_RUNTIME_AUTOAPPLY=1` 模拟点击（默认关闭）。
6. **审计**：每次切换写一行日志（版本、清单哈希、耗时），面板可查最近三次。

## 十一、失败分类（复用现有 `errorCode`）

在 `desktop/updater.ts` 的 `classifyUpdaterError` 基础上新增 runtime 专用码：

| code          | 场景                                      | 面板行为                                  |
| ------------- | ----------------------------------------- | ----------------------------------------- |
| `manifest`    | 清单 404 / JSON 坏 / 签名不匹配           | 重试 + 手动下载壳安装包                   |
| `unsupported` | `protocol`/`minShell` 不满足              | 「请先更新桌面壳」+ 壳下载入口（不重试）  |
| `corrupt`     | `sha256`/解包失败                         | 重试（重新下载），连续两次 → 手动         |
| `busy`        | 文件被占用（Windows 杀软/正在运行的插件） | 重试（退避）                              |
| `health`      | 新运行时启动不健康                        | 自动回滚 + 提示"已回到上一版"，附日志入口 |

## 十二、发布流水线改造

每个平台的 `desktop-release.yml` job 追加：

1. `npm run build:desktop-runtime -- --platform <p> --arch <a> --out release/runtime --from <已组装好的 app 目录>`
   → 产出 `core-<ver>-<p>-<a>.tar.zst`、`runtime-<p>-<a>.json`、`runtime-<p>-<a>.sig`（有私钥时）、`runtime-<p>-<a>.pub.pem`；
   清单里 `protocol` 从 `dist/server/protocol-version.js` 现读，`minShell` 由 `--min-shell` 给；
2. 资产上传到同一个 GitHub Release（`--clobber` 可重跑）；
3. 现有 `latest*.yml`（壳）保持不变，两套并行。
4. 干跑校验：`npm run verify:desktop-runtime -- --manifest … --signature … --public-key … --archive …`
   —— 清单↔归档↔签名互验 + 条目白名单逐条过（CI 必跑）。

**CI 已接**：`.github/workflows/desktop-release.yml` 的三个 job 在出完安装包后各跑一次
`build-desktop-runtime` → `verify-desktop-runtime`，把 `release/runtime/*` 一并挂到同一个 Release。
没有 `DESKTOP_RUNTIME_SIGNING_KEY`（fork / 未配 secret）时该步只打一行 warning 后跳过，不阻塞安装包。

**打包源必须给 `--from`**：默认从仓库根打包会把 devDependencies（electron / vite / oxlint …）一起塞进运行时
（实测 353 MB），CI 里应指到 electron-builder 的 `win-unpacked/resources/app` 或 `npm ci --omit=dev` 的副本——
同一份内容实测 **31.1 MB / 18,832 条目**，与 §三「core 压缩后 30–60 MB」的估算吻合。

## 十三、代码落点

**已落地（P0 + P1）**：`desktop/runtime-store.ts`、`desktop/runtime-manifest.ts`、`desktop/main.ts` 接线、
`scripts/build-desktop-runtime.mjs`、`scripts/verify-desktop-runtime.mjs`，
单测 `tests/unit/desktop-runtime-store.test.ts` / `tests/unit/desktop-runtime-manifest.test.ts`。
下面表里其余行（下载通道、面板、CI 接线、失败计数回滚）仍是待做项。

| 文件                                                                            | 变更                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `desktop/runtime-store.ts`（新）                                                | ✅ P0：布局常量、指针解析、四道回落、协议闸门、隔离；P1–P2 再加原子读写/解包白名单/切换/回滚                   |
| `desktop/runtime-manifest.ts`（新，纯函数）                                     | ✅ P1：清单解析、ed25519 校验、四道闸门、归档白名单、摘要校验（不 import electron）                            |
| `desktop/main.ts`                                                               | ✅ P0/P2：先问 `runtime-store` 再回落包内；生命周期串行队列、重启 + 健康检查 + 回滚、启动失败计数              |
| `desktop/updater.ts`                                                            | ✅ P2：状态机加 `runtime` 片段，`check/download/cancel` 带 `channel`，新增 `applyRuntime`；仍是一条广播通道    |
| `desktop/preload.cts` / `web/src/desktop-updater.ts` / `DesktopUpdatePanel.tsx` | ✅ P2：面板分两段显示；新增「立即重启服务」；运行时错误码独立文案                                              |
| `scripts/build-desktop-runtime.mjs`（新）                                       | ✅ P1：打归档（tar.zst）、写清单、签名（ed25519）、`--keygen`                                                  |
| `desktop/runtime-updater.ts`（新）                                              | ✅ P2：清单拉取 + 验签 + 闸门 + 流式下载（进度/取消）+ 摘要校验 + 解包暂存                                     |
| `desktop/runtime-config.ts`（新）                                               | ✅ P2：内置公钥（留空=拒绝）、`SHELL_CAPABILITY_VERSION`、默认 feed                                            |
| `scripts/desktop-update-feed.mjs`                                               | 本地 feed 可直接用静态目录喂（`runtime-<p>-<a>.json`/`.sig`/归档）；专用脚本未加                               |
| `.github/workflows/desktop-release.yml`                                         | 三平台追加 runtime 产物与签名                                                                                  |
| `docs/env-vars.md`                                                              | ✅ P0/P2：`PI_DESKTOP_RUNTIME_ROOT`（实机测加载）、`PI_DESKTOP_RUNTIME_AUTOCHECK` / `_AUTOAPPLY`（实机测更新） |

### P0 实现要点（定稿的判断，后续阶段别再另写一套）

1. **只读**：P0 一行不写盘。"最坏情况退回包内自带"这条兜底路径不依赖任何可写状态（包括指针文件本身）。
2. **闸门用"相等"**：运行时 `protocol` 必须等于壳自带那份（现读 `<app>/dist/server/protocol-version.js`，
   读不到则**放行**而不是判死）。`lastGood` 没在指针里写 protocol，所以现读它自己的 `protocol-version.js`
   （文本解析，不 import —— 未校验的目录不执行代码）。
3. **版本号只认安全字符**（`[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}`）：`current.json` 被手改也拼不出路径穿越。
4. **包内根目录按入口相对推导**（`<app>/dist/desktop/main.js` 往上两级），**不用 `app.getAppPath()`**：
   dev 下它指向 `dist/desktop`，会把兜底路径算到不存在的 `dist/desktop/dist/server`。
5. **`PI_DESKTOP_RUNTIME_ROOT`**：把运行时集合指到任意目录，实机验加载/回落用（见 [`env-vars.md`](env-vars.md)）。

## 十四、分阶段与验收

| 阶段                  | 内容                                                                             | 验收                                                                                                                                                          | 估时   |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **P0** 加载路径       | `runtime-store` 只读：存在合法 `current.json` 就用，否则回落包内；无网络、无更新 | ✅ 单测 23 例；实机（dev Electron：假运行时命中 / 删指针回落 / 入口缺失拒绝）；Linux（WSL + Docker）同一套判定全绿                                            | 1–2 天 |
| **P1** 归档与签名     | 构建脚本 + ed25519 校验 + 解包白名单 + `verify` 脚本；CI 出产物                  | ✅ 篡改清单签名被拒、缺公钥被拒、白名单外条目整包拒绝并清空目标目录；本机真实产物 31.1 MB / 18,832 条目、解包 17,292 文件（22.4 s）后真壳从该运行时启动并健康 | 3–4 天 |
| **P2** 更新通道       | 下载→校验→staging→切换→健康检查→回滚；面板展示                                   | ✅ 本地 HTTP feed 端到端（真 Electron）：换版成功；健康检查失败自动回滚；坏签/坏摘要/协议不符/防降级全部拒绝                                                  | 3–5 天 |
| **P3** macOS 壳自更新 | ad-hoc 签名 + 自管换包 + quarantine/translocation 检测                           | 真机（需一台 Mac）：未签名包能自更新；dmg 直跑时拒绝并说明                                                                                                    | 3–5 天 |
| **P4** 可选           | 差分下载、按平台灰度、`channel: beta`                                            | 灰度可按比例回退                                                                                                                                              | —      |

**P0 之前的先决条件**：确认 `natives` 在各平台可独立于壳存在（现有 CI 已按平台构建 ffmpeg/codec/p2p，应该成立）。

## 十五、测试策略

- **纯函数单测**：清单解析/签名/闸门/错误分类（`tests/unit/desktop-runtime-manifest.test.ts`）。
- **文件系统单测**：`runtime-store` 的指针原子性、回滚、保留两版、跨卷 rename 退避（临时目录 + 假归档）。
- **端到端（本机）**：把 `scripts/desktop-update-feed.mjs` 扩展成可喂 runtime 清单；用**几 KB 的假运行时**跑
  「下载 → 校验 → 切换 → 健康检查失败 → 回滚」，不依赖真实 400 MB 产物。
- **三平台冒烟清单**（人工，写在 `desktop/README.md`）：装包 → 起 → 更新 → 重启 → 版本正确 → 回滚演练。
- 现有守卫全部保留：`desktop-update-state` / `desktop-updater-bridge`（IPC 三面对齐）/ `docs-index`。

### P2 实机验证记录（2026-11-17）

| 场景 | 手段                                                                                                                           | 结果                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 换版 | 本地静态 HTTP feed（真 `runtime-<p>-<a>.json` + `.sig` + 极小 `tar.zst`），私钥签名；真 Electron 带 `AUTOCHECK/AUTOAPPLY` 启动 | ✅ 下载→解包→`current.json` 写 0.200.0→重启服务→`/api/health` 报 `piVersion=0.200.0`（跑的是新运行时那份） |
| 回滚 | feed 换成「启动即 exit(1)」的 0.201.0                                                                                          | ✅ 健康检查失败 → 指针写回 0.200.0 → 重启旧版 → `/api/health` 回到 0.200.0，服务不断                       |
| 闸门 | 单测覆盖坏签名 / 空公钥 / 协议不符 / 防降级 / 摘要不符 / 目标目录非空                                                          | ✅ 全部拒绝且不留半成品目录（`downloads/` 也收掉）                                                         |

### P1 实机验证记录（2026-11-17）

| 场景                           | 手段                                                                                                                                  | 结果                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 构建 + 签名                    | `npm run build:desktop-runtime -- --from release/win-unpacked/resources/app --include dist/server,web/dist,node_modules,package.json` | ✅ 31.1 MB `.tar.zst` / 18,832 条目；清单 + `.sig` + 公钥                                                                                      |
| 验收                           | `npm run verify:desktop-runtime -- --manifest … --signature … --public-key … --archive …`                                             | ✅ 签名、摘要、白名单、`dist/server/index.js` 全过                                                                                             |
| 篡改清单                       | 清单尾部加一个空格再验                                                                                                                | ✅ 签名校验失败（exit 1）                                                                                                                      |
| 缺公钥                         | 只给清单                                                                                                                              | ✅ 拒绝（除非 `--allow-unsigned`）                                                                                                             |
| 端到端：归档 → 解包 → 真壳加载 | `extractRuntimeArchive` 解到 `<runtimeRoot>/0.121.0`、写 `current.json`、起真 Electron                                                | ✅ `source=runtime version=0.121.0`；`/api/health` 由**解包出来的那份**服务端返回（`piSdkCopies` 指向 `<runtimeRoot>/0.121.0/node_modules/…`） |

### P0 实机验证记录（2026-11-17）

| 场景                                | 手段                                                                                              | 结果                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有运行时 → 命中                     | 真 Electron（dev 入口）+ `PI_DESKTOP_RUNTIME_ROOT` 指到假运行时（自带 `/api/health` + 落 marker） | ✅ 日志 `source=runtime version=0.9.9`，marker 落盘，health 来自假运行时                                                                                                         |
| 无指针 → 回落包内                   | 同上，去掉指针                                                                                    | ✅ `source=bundled reason=no-pointer`，真服务端健康（`/api/health` 返回真 `piVersion`）                                                                                          |
| 半成品（缺 `dist/server/index.js`） | 同上                                                                                              | ✅ `reason=missing-entry`，拒绝执行，回落包内并正常起来                                                                                                                          |
| Linux 路径语义                      | WSL（node 26）+ Docker `node:24` 各跑一遍同一套判定                                               | ✅ 全绿（含 POSIX 路径 / 协议动态 import）                                                                                                                                       |
| 打包态（`app.isPackaged=true`）     | `release/win-unpacked` 手替 `dist/desktop` 后启动                                                 | ⚠️ 未跑通：本机 Chromium process-singleton 锁报 `拒绝访问 (0x5)`，亮出「已在运行」对话框后挂住。与本次改动无关（发生在 runtime 解析之前）。发版前需在干净机器/新安装包上补做一次 |

## 十六、风险与回退

| 风险                                 | 缓解                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 新服务端改了数据格式，回滚旧版读不了 | 数据目录按"向后兼容一个 minor"要求；切换前把 `<dataDir>/*.json` 备份成 `.lastgood`（magpie 的 lastgood 思路） |
| 插件与新运行时 ABI/API 不匹配        | 清单里带插件 API 版本，不匹配则禁用该插件并提示，而不是整体失败                                               |
| Windows 文件占用导致切换失败         | rename 退避重试；失败保持旧指针（不产生半成品目录）                                                           |
| 用户手动删 `runtime/`                | 每次启动校验目录完整性，缺失即回落包内                                                                        |
| 私钥泄露                             | 私钥只存 CI secret；轮换需发一次壳（公钥内置），轮换流程写进 release 文档                                     |
| 运行时体积过大                       | core/natives 拆分 + `natives` 按版本复用；P4 再上差分                                                         |

**兜底原则**：任何异常都必须能回到"安装包内自带运行时"，这条路径不依赖网络、签名、指针文件。

## 十七、待决策（需要拍板）

1. **是否引入 ed25519 自有密钥**作为第二信任根（CI secret + 壳内置公钥）——这是 macOS 免证书路线的前提。
   已启用：公钥内置在 `desktop/runtime-config.ts`，私钥待入 CI secret；清空公钥可随时关掉这条通道。
2. **macOS 壳自更新（P3）**现在就做，还是先只做运行时自更新、等有 Developer ID 再说。
3. **core / natives 是否拆两个载荷**（推荐拆；不拆则每次更新 ~150–200 MB）。
