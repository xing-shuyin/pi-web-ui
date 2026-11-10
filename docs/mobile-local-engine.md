# 本机引擎：手机版 pi-web-ui 完全独立运行

> 目标：手机不依赖 PC，APK 内自带 Linux rootfs + Node + pi-web-ui，本机跑 server 与 pi 引擎，用自家 WebView UI 操作；同时保留现有遥控能力。
> 参考实现：`ccch1mneyyy/dsh-go`（DeepSeek Harness Android 客户端，Flutter + proot 免 root 路线已在真机验证）。**只参考架构思路与部署手法，不拷其代码**（AGPL-3.0）。

## 定位：第三种连接方式

现有手机端（[`mobile.md`](mobile.md)）是遥控端：本地打包 React UI，连 PC 上的 pi-web-ui，任务在 PC 执行。本篇新增「本机引擎」：

| 模式         | 引擎在哪 | 依赖    | 入口     |
| ------------ | -------- | ------- | -------- |
| 直连 / Hub   | PC       | PC 在线 | 现状不动 |
| **本机引擎** | 手机内   | 无      | 本篇     |

用户视角：装上 APK → 一键「安装运行环境」（解压 rootfs）→ 填 API Key → 直接用，UI、终端、文件树、画布、插件与桌面端同一套。

## 架构

```
Capacitor WebView（mobile/src 全量复用）
  └─ http://127.0.0.1:<port>/  ← 同源 + token 换 Cookie
Kotlin 原生层（新增，Capacitor 插件形式）
  ├─ LocalEnginePlugin        MethodChannel：状态/安装/启停/日志
  ├─ LocalEngineService       前台服务，托管 node 进程
  ├─ RuntimeInstaller         解压 APK 内 rootfs.tgz 到 filesDir/engine/
  └─ proot (libproot.so)      filesDir/engine/node … 免 root 执行
rootfs（Ubuntu 24.04 arm64，APK assets 内分卷）
  ├─ node（22.x LTS，pin 精确版本）
  ├─ npm 全局：pi-web-ui + @earendil-works/pi-coding-agent
  ├─ git、ca-certificates、tzdata
  └─ node-pty 原生绑定（构建期在 rootfs 内编译，ABI 与运行期完全一致）
```

启动链：WebView 调 `start` → Service 用 proot 拉起 `node dist/server/index.js`（`PI_WEB_HOST=127.0.0.1`、`PI_WEB_PORT` 随机、`PI_WEB_TOKEN` 随机、`PI_WEB_DATA_DIR=filesDir/data/`、`PI_WEB_CWD=filesDir/workspace/`）→ 解析 stdout 拿 `<port>` 与 token → WebView `loadUrl("http://127.0.0.1:<port>/?token=…")`。之后一切走既有协议与快照。

**UI 零重写**：不用 Flutter 自研聊天界面，直接复用 `web/dist` 构建产物（dsh-go 也把「官方 Web + WebView」做了兜底路线，证明此路可用；我们把这当主线，收益是所有既有 UI 能力与主题免移植）。

## 仓库策略：同仓库承载，独立性落在产物层

代码与脚本收在**本仓库** `mobile/` 邻域（与现有 Capacitor 工程同源）：

| 维度              | 同仓库（选它）                                                                | 独立仓库                                                  |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| 版本一致性        | CI 从同一次 build 直接打 rootfs，协议 / UI / 引擎 / node-pty 绑定天然同版     | 只能咬 npm 发布版，升级永远滞后一拍                       |
| 与现有工程        | 本机模式就是在 `connections` 里加一种 connection，插件进现有 Capacitor 工程   | 要么复制整个 Capacitor 工程，要么另起壳，连接代码双份漂移 |
| git 体积          | rootfs 不进 git：CI 机构建，产物发 Releases                                   | 相同                                                      |
| dsh-go 为什么独立 | 上游（DSH 官方）没有自带 App 工程可复用，它只能独立 + 消费官方 npm 包         | 复刻它意味着放弃复用现有工程                              |
| 发布节奏          | `runtime.json` 的 builtinVersion 就钉 pi-web-ui 版本，tag `vX.Y.Z` 顺手出 APK | 上下两个仓库的发布节奏对齐靠人                            |

「完全独立」的独立指**产物**：APK 自带 rootfs、无 PC 可用，不指代码库物理隔离。

何时拆出独立仓库（逃逸门）：UI 决定 Flutter 重写（iOS / 鸿蒙野心成立），或 APK 需要与 npm 完全脱钩的渠道节奏。那时 `mobile/local-engine/` + 原生插件目录整体搬走，改为消费 `pi-web-ui@^x` npm 包（dsh-go 同款方式），唯一要重写的是现有壳里的连接胶水。

## 事实源（★=本篇唯一单源）

| 功能                                          | 事实源                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 本机引擎文档（本篇）★                         | `docs/mobile-local-engine.md`                                                                                          |
| Runtime 构建脚本 ★                            | `mobile/local-engine/runtime/build-runtime.sh`（已建，Linux/CI 用）                                                    |
| Android 原生层 ★                              | `mobile/native/local-engine/`（本地 Capacitor 插件：TS 桥 + Java 原生层）                                              |
| 连接入口与三模式                              | `mobile/src/connections.ts` · `mobile/src/connection.ts` · `mobile/src/ConnectionScreen.tsx`                           |
| 服务器连接方式 / env 全表                     | [`env-vars.md`](env-vars.md)（`PI_WEB_PORT`/`PI_WEB_HOST`/`PI_WEB_TOKEN`/`PI_WEB_DATA_DIR`/`PI_WEB_CWD`/`PI_WEB_SDK`） |
| 移动端通知与构建                              | [`mobile.md`](mobile.md)                                                                                               |
| 生产形态（dist/server、web/dist、bin 启动器） | `package.json` scripts · `bin/pi-web-ui.mjs`                                                                           |

## Runtime 打包（`mobile/local-engine/runtime/`）

输入全部 pin 版本 + sha256（腾讯/清华镜像），产物分卷放 APK assets，解压时校验：

1. **Ubuntu 24.04 arm64 base rootfs**（官方 ubuntu-base 压缩档）+ `dpkg` 装 `tzdata ca-certificates git python3 make g++`；x64 构建机经 `qemu-user-static` chroot 组装。
2. **Node 22.x LTS**（≥22.19.0，见 `engines`）官方 linux-arm64 tar.xz，解进 `/usr/local`。
3. **npm 包**：`pi-web-ui`（发布包含 `dist/server`、`web/dist`、`bin/`）+ `@earendil-works/pi-coding-agent` 全局安装；`PI_WEB_SDK` 指进 rootfs 固定路径，绕开任何全局发现逻辑。
4. **node-pty** ^1.1.0 必须随 rootfs 内 `npm install` 原生编译（Python + make + g++ 在第 1 步已就位；之后可裁掉构建工具减体积）。
5. **proot** 二进制以 `libproot.so` 放 jniLibs（`useLegacyPackaging` 解压到 `nativeLibraryDir` 才可执行）；proot 为 GPL，发布时在 THIRD_PARTY 附源码引用。
6. 产物 `out/arm64-v8a/`：`rootfs.tgz` 分卷 + `runtime.json`（abi、builtinVersion、baseId）。可选 x86_64 flavor 供模拟器。

### 安装与升级事务

参考 dsh-go 的契约，自实现精简版：

- 首次安装或用户确认「重置」才落整套 rootfs；普通升级不换 rootfs，只按精确路径替换引擎 waż 工件（node、`node_modules` 发布包目录），不扩到 `/usr`、`/opt` 整体。
- `engine.prepare` 落盘 → `engine.upgrade` 原子改名 → 失败可回滚；启动遇到半成品事务先恢复再清理，不整根覆盖。

## Android 原生层设计

MethodChannel `pwu/localengine`，事件流推送状态：

| 方法             | 行为                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `getStatus`      | `phase: notInstalled/installing/installed/starting/running/stopping/error` + 版本 + baseUrl |
| `install`        | 分卷解压 + 校验；进度经事件流                                                               |
| `start` / `stop` | 前台服务托管；stdout 环形日志；crash 自动重启（上限退避）                                   |
| `getLogSnapshot` | 最近 N 行日志（seq 递增，重启不归零），供引擎日志页                                         |

- 数据落点：`rootfs/root/piwebui-data/{data,workspace,pi-agent}`——三份都在「重置运行环境」的保留名单里（reset 只重建 rootfs）。
  `pi-agent` 通过 `PI_CODING_AGENT_DIR` 显式指定：pi 默认的 `~/.pi/agent` 住在 rootfs 内部，跟着 rootfs 一起被删，
  会把 API Key 配置与聊天记录一起洗掉。

- `targetSdk = 28`（同 Termux 做法，绕开 Android 10+ 私有目录 `exec` 禁令；本项目分发不走 Google Play，无 28→35 约束）。
- 前台服务 + 部分唤醒锁 + 电池优化白名单引导页；通知栏常驻显示运行状态。
- ABI 产品风味 `arm64`（真机）/ `x64`（模拟器）。

## App 沙箱与 rename（proot 内的 ENOSYS）

现象：引擎进程能起来，但 `writeAtomicSync`（client-state 等）、`plugin-materialize`（内置插件物化）等所有 rename 都报
`ENOSYS: function not implemented, rename …`。

根因既不在 proot、也不在 rootfs：

- App 进程带 zygote 下发的 seccomp 过滤器（`/proc/<pid>/status` 的 `Seccomp_filters: 1`）；同一份 rootfs 用
  `adb shell run-as … proot …`（无 seccomp）跑，`rename` / `renameat` / `renameat2` 全部成功。
- 过滤器让 `renameat2` 直接返回 ENOSYS；glibc 2.28+ 的 `rename()` 只走 `renameat2`、不做回退（Node 的 `fs.rename*`
  都落到这里），于是 App 进程内一次 rename 都成功不了 → 引擎起得来也存不住状态。

对策分两层，都不去改调用点、也不去文本替换 rootfs 里的 `dist`：

1. **rootfs 内置 C 垫片（主路，覆盖所有子进程）**：`mobile/local-engine/runtime/rename-preload.c` 编译成
   `/usr/local/lib/pi-mobile/librename-compat.so`，并在 rootfs 的 `/etc/ld.so.preload` 里登记 —— guest 内每个
   glibc 程序（node、bash、git、mv）启动时自动加载，`rename` / `renameat` 改道 `renameat`（它在允许名单里）。
   proot 自身是 bionic，不读这个文件。实测：App 进程内 `rename` 恢复成功，`[rename-compat]` 降级日志不再出现。
2. **node 侧 JS 兜底（旧 rootfs / 垫片缺失时）**：
   `assets/pi-localengine/rename-compat.cjs` 把 `fs.renameSync` / `fs.rename` / `fs.promises.rename` 包一层，
   **只有** ENOSYS（及 ENOTSUP/EOPNOTSUPP）才降级为「复制 + 删源」，其它错误码原样抛出。`LocalEngineService`
   每次启动把它写进 `rootfs/root/.pi-mobile/rename-compat.cjs`，以 `node --require` 注入；写不进去只告警不阻断。

代价与边界：

- C 垫片保留了 rename 的真实语义（`renameat` 仍是原子改名）；只有走兜底路径时才丢原子性（复制 + 删源）。
- `renameat2` 带 flag 的语义（`RENAME_NOREPLACE` / `RENAME_EXCHANGE`）没有 `renameat` 等价物，保持和沙箱一样的
  ENOSYS 失败语义，不做假装支持。
- 旧 rootfs（没有垫片）启动时，Service 会在日志里明说「终端里的 git 等子进程可能仍报 ENOSYS」。

## React 连接层（`mobile/src/`）改动

- `connections.ts`/`connection.ts` 增加 `kind: "local"`：仅 `Capacitor.isNativePlatform()`（Android）显示；。
- `ConnectionScreen.tsx` 增加本机向导：安装运行环境（进度/失败重试）→ 启动 → 进入工作区；失败分支提供「查看引擎日志」「重置运行环境」。
- 本机模式不设 JPush 推送：前台服务常驻，任务完成提醒直接走系统通知（服务自身具备 UI，无需极光）。
- 工作区目录引导：本机模式默认工作区在应用私有目录；`PI_WEB_CWD` 一次性写死，避免用户误把 `filesDir` 外路径当根。

## 服务器侧预期改动（尽量为零）

本机模式 WebView 直接打开 `127.0.0.1:<port>`，`?token=` 换 Cookie 后全同源：

- `server/index.ts` 已有 loopback 判定（`isLoopbackAddress`/`isLoopbackHost`）与 `mobileCors`/`mobileOriginAuthorized` 通道（`server/mobile-origin.ts`）；同源请求不产生跨 Origin 问题。
- 若真机实测 WebView 初始请求带异常 Origin（如 `null`），在 `mobile-origin.ts` 登记本机模式专用放行分支即可——改动收敛在这一个文件。
- 审批门禁、终端 PTY、附件上传在 loopback 场景语义不变，不做平台差异分支。

## 分阶段计划与验收

| 阶段                      | 内容                                                                      | 验收                                                       | 状态                                     |
| ------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| A. Runtime 冒烟（开发机） | 脚本产出 arm64 rootfs；qemu 内 `node dist/server/index.js` 拉起           | 本机 curl 首页 200、`PI_WEB_TOKEN` 生效、node-pty 加载成功 | 脚本已建，待 CI/qemu 执行                |
| B. Android 壳             | 插件 + 前台服务 + 安装向导；WebView 打开本地服务                          | 真机一键安装→聊天可用                                      | TS 桥 + Java 原生层 + 连接层已接，待真机 |
| C. 能力验证               | 终端 PTY 跷跷板、git 工具、附件、截图、设置保存、前台服务后台存活 30 分钟 | 真机全绿；后台被杀后冷启自恢复会话                         | 待 B                                     |
| D. 升级与打磨             | 发新运行环境包走升级事务；x86_64 模拟器包                                 | 换版本不破坏用户数据                                       | 未开始（MVP 用重置代替升级）             |

### MVP 实施状态

- ✅ 构建脚本 `build-runtime.sh`：pin 输入（Ubuntu base / Node 22 / proot + sha256）→ qemu chroot 装 git/python3/make/g++ → `npm -g` 装 pi-web-ui 与 pi SDK → node-pty 绑定冒烟 → 100MiB 分卷 + `runtime.json`（每卷 bytes/sha256）→ `--sync-assets` 落插件 assets。
- ✅ `mobile/native/local-engine/`：`@pi-mobile/native-local-engine` 本地插件（file: 引用，`capacitor.plugins.json` 自动注册）。TS 桥 `getStatus/install/start/stop/getLogSnapshot/reset` + `status/logs/progress` 事件；Java 侧：EngineState（状态机 + 2000 行环形日志，seq 重启不归零）、RuntimeInstaller（分卷流式 sha256 → staging → 原子提交，symlink/exec 位还原）、LocalEngineService（前台服务 + proot/node 进程 + 随机端口/令牌 + TCP 探测就绪 + 崩溃退避重启≤3 次）、LocalEnginePlugin（Capacitor 桥）。
- ✅ 连接层：`ConnectionMode` 增 `"local"`；`ensureLocalEngineRunning()` 幂等拉起；ConnectionScreen 三模式（Android 显示「本机运行」）带进度/引擎状态/重置入口；boot 恢复对 local 重新走 ensure 流程（凭据每次启动重新铸币）。
- ⏳ 待办：CI 跑阶段 A 产物 → 真机（arm64）安装→启动→聊天/终端/设置验收；升级事务（阶段 D）。

体积预估：rootfs + node + 依赖 ≈ 250–450MB（arm64 单 flavor），均摊到 APK 下载一次；后续升级只发差量引擎工件。

## 风险与对策

| 风险                                                      | 对策                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| node-pty 在 ARM rootfs 编译失败                           | 阶段 A 前置验证；备选：rootfs 内预装 `package.json` 锁定版本 + 离线 native 模块；终端不可用时可置灰终端面板运行主链路 |
| 手机厂商杀后台                                            | 前台服务 + 白名单引导；文档教用户关闭 PiPilot 省电限制                                                                |
| ROM 对 `exec` 私有目录的策略                              | 维持 targetSdk 28；禁止上架 Play 前贸然提升 targetSdk                                                                 |
| `bin/pi-web-ui.mjs` 在 rootfs 内有桌面假设（frp/homedir） | 启动绕过 bin 包装，直接 `node dist/server/index.js`；bin 启动器作为 PC 形态继续单源                                   |
| AGPL 边界                                                 | 不引 dsh-go 代码，只复述思路；proot GPL 源码引用随发布包                                                              |
| 模拟器/小众 ABI                                           | MVP 只承诺 arm64-v8a；x86_64 flavor 属可选产物                                                                        |

## 不做的事

- 不重写聊天 UI（Flutter/RN），不自研 `dsh_client` 式独立协议客户端；协议消费继续走单一 `web/dist`。
- 不动 `server/protocol.ts` 协议；不为本机模式开新 API。
- MVP 不装 DSH 引擎（后续作为可选层，`docs/dsh-engine.md` 的 file: 克隆隔离不受影响）。
- 不承诺 iOS：路径与 dsh-go 相同（未来可复用 CI），本期不投入。
