# 内核与客户端：一份运行时、一个内核、随便关客户端

> 术语：**内核** = 唯一的 pi-web-ui 服务进程（跑调度器、渠道插件、Bot、群组、终端 PTY）；
> **客户端** = 桌面壳 / 浏览器 / 手机，只连内核，不承载任何常驻工作。
>
> 本文是这套关系的唯一说明；代码落点见 §2。

## 1. 为什么要有这篇

历史上"内核"有两个来源，互不知情：

| 来源                                                         | 数据目录          | 常驻                                               | 谁更新              |
| ------------------------------------------------------------ | ----------------- | -------------------------------------------------- | ------------------- |
| 桌面壳拉起的 sidecar（`desktop/main.ts:startServerSidecar`） | `<userData>/data` | ❌ 退出壳即杀（`will-quit` → `serverProc.kill()`） | 壳的 runtime 自更新 |
| `pi-web-ui server install` 装的服务                          | `~/.pi-web` 默认  | ✅ 系统托管                                        | 全局 npm 包         |

由此有三类事故（都是"修不了，只能不让它发生"）：

1. **双写**：两个内核同一数据目录 → 会话 JSONL 双写、`plugin-data/`（QQ 凭据/白名单）互相覆盖。
2. **双份重复触发**：`schedules.json` 各一份 → 定时任务各触发一次；渠道插件各起一条长连接 → 同一条 QQ 消息被处理两次。
3. **身份分裂**：`device-center` 的机器级 Bot 作用域按数据目录存放 → 同一台机器注册成两台设备。

目标形态只有一条：**内核永远独立于客户端、由系统托管、一份数据目录；客户端随便开随便关。**

现在已经落地为**默认行为**（§4.1）：打包版首次启动就把全局包内核装成系统服务，壳只做客户端；
本地 sidecar 只剩开发/冒烟、Linux（无 TTY）与离线兜底三种临时形态。

## 2. 事实源

| 关注点                                  | 唯一事实源                                                                                                             | 说明                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 内核身份（版本/安装形态/托管者/uptime） | `server/kernel-identity.ts`                                                                                            | 纯推导，无 I/O；`/api/health` 的 `kernel` 块由它产出                                                                     |
| 数据目录单实例                          | `shared/instance-lock.ts`                                                                                              | pid 文件 + 探活 + 陈旧接管                                                                                               |
| 内核公开快照的形状                      | `packages/keel/src/protocol.ts` 的 `KernelPublicInfo`                                                                  | 客户端与内核之间的线形状                                                                                                 |
| 权威链（哪份代码是内核）                | `desktop/kernel-authority.ts`                                                                                          | 全局 npm 包 > `<userData>/runtime`（离线兜底）> 包内自带；`npm prefix -g` 缓存一天                                       |
| 环境探测（node/服务/安装指引）          | `desktop/kernel-env.ts`                                                                                                | 纯函数 + 可注入 `exists`/`env`；不读注册表、不 spawn                                                                     |
| 壳要不要自己拉内核 / 装服务             | `desktop/kernel-mode.ts` 的 `planKernelBoot()` + `resolveKernelServiceFirst()`；策略常量在 `desktop/runtime-config.ts` | 唯一出口：`connect` / `provision-service` / `install-kernel` / `install-node` / `ephemeral`；main.ts 里不许再写第二份 if |
| 装服务（装/启/健康检查/交棒）           | `desktop/main.ts` 的 `provisionKernelService()`                                                                        | 参数拼装与子进程在 `kernel-install.ts`；启动、面板、升级后三处共用                                                       |
| 状态文案（人话）                        | `browser/kernel-view.ts`                                                                                               | 面板与未来设备页共用                                                                                                     |
| 跨层视图形状                            | `browser/contracts.ts` 的 `BrowserKernelState`                                                                         | 进 `pi-browser:state`，面板读 `kernel.status`                                                                            |

## 3. `/api/health` 的 `kernel` 块

```jsonc
{
	"ok": true,
	"kernel": {
		"mode": "service", // service = 有系统托管者；standalone = 裸进程
		"supervisor": "systemd", // launchd / systemd / windows-watchdog / null
		"serviceName": "pi-web-ui",
		"version": "0.121.3", // pi-web-ui 包版本
		"installKind": "global-npm", // global-npm / packaged / source
		"startedAt": 1762400000000,
		"uptimeMs": 10800000,
		"minShell": 1, // 内核要求的最低壳能力（与 SHELL_CAPABILITY_VERSION 对表）
		"lock": "held", // held / disabled（PI_WEB_ALLOW_MULTI_INSTANCE=1）
	},
	"web": { "ok": true }, // 界面资源是否齐全；缺入口时是 { ok:false, missing:"web/dist/index.html" }
}
```

**刻意不含 pid / 数据目录 / node 路径**：`/api/health` 是免鉴权端点（`page-picker` 扩展靠它探测"这是不是
pi-web-ui"），公网绑定场景不该把本机路径吐给任何人。要路径的排障走日志、启动横幅与 `pi-web-ui server status`。
`server/kernel-identity.ts` 的注释与 `tests/unit/kernel-identity.test.ts` 一起守着这条边界。

`installKind` 只认结构事实（`app.asar` → `packaged`；`node_modules/pi-web-ui` → `global-npm`；其余 `source`），
不看环境变量——否则同一份代码在不同启动方式下会报不同的形态。

### 3.1 界面资源缺失

「内核活着」与「内核能提供界面」是两个事实，必须分开报（否则客户端只能把 503 错误页当成界面）。
判据单源是 `server/web-build.ts` 的 `resolveWebBuild()`：**只认 `web/dist/index.html`**，目录存在不算数。
装了一半的包（目录在、入口不在——Windows 上内核还在跑时执行 npm 更新就会出现）以前会被当成正常安装：
进程起得来、`/api/health` 照常 ok，然后每个页面请求都回 503「正在更新 pi-web-ui，请稍后刷新…」。
那句话是假的：没有人在更新，也永远不会变，壳还把这张错误页当成了「界面已就绪」（实机：白屏 + 无法关窗）。

现在这条路径分三段收口：

| 阶段 | 行为 |
| --- | --- |
| 启动 | 缺入口 → 打结构化错误（含修复命令）；受托管重启（`RESTART_CHILD_ENV`）直接 `exit 1`，由壳给修复入口；普通启动仍提供 API（手机 / 设备中心 / CLI 不陪葬） |
| 页面请求 | 每次现算一次 → 缺就回**自包含诊断页**（缺哪个文件 / 修复命令 / 每 3 秒自动重试，装好后自动进界面，无需重启内核） |
| 客户端 | `/api/health.web.ok=false` → 桌面壳把覆盖层留着并给「修复内核 / 重试 / 退出」（见 §9.1.3） |

「升级内核」装完之后也走同一个判据验收：装出来的包缺入口就不交棒（`desktop/main.ts` 的 `upgradeKernel`），
否则壳会高高兴兴接手一个只能白屏的内核。

## 4. 启动判定（`planKernelBoot`）

壳**要不要自己拉进程**只由 `desktop/kernel-mode.ts` 的 `planKernelBoot()` 裁定，`main.ts` 只执行结论。
每一步的输入都是探测结果（配置地址 / 数据目录锁 / 默认端口 / 服务配置有没有 / 全局包在不在 / node 可用不可用），
所以判定本身是纯函数，跑在 `tests/unit/desktop-kernel-boot.test.ts`。

```text
启动
 ├─ 设置里配的内核可达 ──────────────────► connect(configured)：只连不拉
 ├─ 数据目录锁里有活内核（系统服务）────► connect(adopted)：只连不拉
 ├─ 默认端口 8790 上已有内核 ────────────► connect(default-port)：只连不拉
 │
 ├─ 打包版（策略开）＋ 全局包内核 ＋ node ≥22
 │        └─────────────────────────────► provision-service：装/起系统服务后只连
 │              （服务已装 → 先 `server start`；起不来再 `server install` 重写一遍自愈）
 │
 ├─ Linux（systemd 要 root，无 TTY）─────► ephemeral：临时内核 + 面板给命令
 ├─ 开发/冒烟（策略关）──────────────────► ephemeral：临时内核
 └─ 前置条件不满足
          ├─ 还有能跑的代码（包内自带/全局包）► ephemeral：临时内核
          ├─ 连内核都没有 + node 可用 ─────► install-kernel：界面给「安装内核」
          └─ 连 node 都没有 / 太老 ────────► install-node：界面给「安装 Node」
```

- 探测超时 1500ms（`KERNEL_PROBE_TIMEOUT_MS`），判据与 `page-picker` 扩展一致（`ok: true`）。
- 回退必须**可见**：面板会显示"配置的内核不可达：…"，不允许静默切到本地内核让用户以为连的还是远程那份。
- 老版本内核不返回 `kernel` 块也照样可达（向后兼容），只是面板少几行信息。
- `ephemeral` 是**唯一**会 `spawn` 的形态：随壳退出而停，`browser/kernel-view.ts` 的 `kernelPersistenceHint`
  会明说"当前内核随本窗口退出而停止"。

### 4.1 打包版默认：首次启动就把内核交给系统托管

**不要求用户点任何按钮**：打包版第一次启动发现"本机有全局包内核但没被系统托管"，就自己跑
`pi-web-ui server install`（参数取**当前内核正在用的** `--port / --data-dir / --cwd`），健康检查通过后把
`agentUrl` 写成服务地址。之后每次启动都只连它 —— 关掉桌面端、重启桌面端、同时开两个客户端，都不影响内核。

- 开关：`desktop/runtime-config.ts` 的 `KERNEL_SERVICE_FIRST`（默认 `true`），环境变量
  `PI_DESKTOP_KERNEL_SERVICE_FIRST=0/1` 单机覆盖。开发态（`app.isPackaged === false`）默认关，
  保持 `npm run dev` 与冒烟脚本的本地 sidecar 手感。
- **不静默下载内核**：磁盘上没有全局包内核时只在界面提示「安装内核」（`npm i -g pi-web-ui@latest`）；
  该按钮成功后会**接着装成服务并交棒**（`upgradeKernel()` → `provisionKernelService()`），
  不会又退回"壳自己拉一份"。
- **装服务必须用内核自己的 CLI 与系统 node**：`runKernelCli()` 传 `pkgRoot`（全局包根）与 `nodePath`
  （系统 node）。CLI 会把 `process.execPath` 烘焙进看门狗脚本，用 Electron 的 execPath 装出来的服务会拿
  `electron.exe` 去跑内核，永远起不来。
- 数据目录沿用壳当前那份（`PI_WEB_DATA_DIR` → 否则 `<userData>/data`），装完看到的还是同一批会话。
- 离线 / 纯壳包机器：没有全局包内核就没有可托管的代码，只能先跑临时内核（面板会提示可以升级成服务）。

## 5. 一键装成系统服务

按钮 / 启动流程 → 壳主进程 → 本包 CLI（`bin/pi-web-ui.mjs server install`，**不经 shell**）。顺序是有原因的：

```text
1. 本地 sidecar 正持着数据目录锁 → 先停它（否则服务启动会被单实例锁拒绝）
2. 先 `server start`（配置在、用户只是停过它）→ 8s 内没就绪才 `server install` 重写一遍（自愈：实机见过 vbs 丢失）
3. 装并启动服务：--port（沿用当前内核的端口，否则稳定默认 8790）
                 --data-dir / --cwd（取当前内核正在用的那份，装完看到的是同一批会话）
4. 交棒：把 Agent 地址写成服务地址 → 下次启动不再拉临时内核
5. 任一步失败：回滚，把本地内核重新拉起来（不能"点完按钮反而没内核了"）
```

实现落点：`desktop/main.ts` 的 `provisionKernelService()`（启动流程、面板按钮、升级后三处共用）+
`installKernelService()`（面板的"该不该装 + 失败回滚"）；参数拼装与子进程在 `desktop/kernel-install.ts`
（120s 硬超时，超时连同子进程树一起杀）。这套协议与 `server/device-center/hub-setup.ts`（Hub 一键安装）同构，
差别只在被安装的对象。

**幂等**（实机 2026-11-21）：`server install` 会先停掉**这份数据目录的持有者**（读 `<dataDir>/kernel.lock`）
与遗留看门狗，再写配置并拉起；pid 文件也只由写它的那个看门狗删。否则会出现"老内核占着锁、
新看门狗每 10s 空转"的假成功，而活着的那个的 pid 文件会被退出的那个顺手删掉——
`server status`/`stop` 从此找不到服务。

## 6. 单实例锁

`<dataDir>/kernel.lock`，内容 `{ pid, port, version, cwd, startedAt }`。

| 结果       | 语义                            | 进程行为                                      |
| ---------- | ------------------------------- | --------------------------------------------- |
| `held`     | 拿到锁                          | 正常启动；`process.once("exit")` 释放         |
| `denied`   | 另一个**活着的**内核占着        | 打印 FATAL + 三条出路，`exit(1)`              |
| `disabled` | `PI_WEB_ALLOW_MULTI_INSTANCE=1` | 不写锁，`/api/health` 的 `lock` 报 `disabled` |

- 为什么是 pid 文件而不是 `flock`：Node 标准库没有跨平台文件锁，Windows 上根本没有 `flock(2)`；
  pid 文件 + `process.kill(pid, 0)` 是常驻进程的通用做法，崩溃后不留死锁（死进程探活即失败）。
- **陈旧接管**：进程已死 / 锁文件是坏 JSON / `startedAt` 超过 7 天 → 直接接管。测试覆盖在
  `tests/unit/instance-lock.test.ts`。
- 已知边界：pid 被系统回收后可能误判"还活着"。此时宁可拒绝启动也不双写，并给出
  `--data-dir` / 停掉另一个 / 环境变量三条出路。

## 7. 运维与排障

```bash
curl -s localhost:8787/api/health | jq .kernel   # 谁是内核、谁在托管、跑了多久
cat ~/.pi-web/kernel.lock                        # 谁持着这份数据目录
pi-web-ui server status                          # 服务装没装、起没起
```

- 面板：设置 → 「内核（服务进程）」一行状态 + 两个按钮（安装为系统服务 / 重启内核）。
- 重启的语义按托管方式分派：服务托管 → `server restart --port … --data-dir …`；本地 sidecar → 自己杀重生。
  **连的是外部裸内核（external 且无托管者）时按钮直接隐藏** —— 壳没有办法重启别人的进程，给了按钮只会白点，
  文案改为「重启请到它所在的机器上执行」。
- 面板行为有真点击冒烟：`node tests/kernel-panel-smoke.mjs`（Electron + Playwright，跑两个场景：
  外部内核 → 重启按钮隐藏、安装可见；本地 sidecar → **真点「重启内核」并断言 uptime 归零**）。
- 换 node 版本（nvm/fnm）后必须 `server install` 重装一次：服务配置里烘焙的是 `process.execPath`。

## 8. 参考实现（照抄的对象，不是感觉）

| 项目                                                          | 抄了什么                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `tailscale/tailscale`、`ollama/ollama`、`syncthing/syncthing` | 常驻 daemon + 若干瘦客户端；GUI 关掉不影响内核               |
| `rustup` / `volta-cli/volta`                                  | 工具链装在自有目录 + 稳定 shim，不依赖用户 shell 的 PATH     |
| `Schniz/fnm`、`pnpm` 的 `env use`                             | 由程序自己下载/管理 Node 版本（"内置安装 Node"按钮的下一步） |
| `npm/cli` 的 `@npmcli/arborist`、`pacote`                     | 程序化安装整棵依赖树（不依赖系统 npm 的路线）                |
| `desktop/desktop`、`podman-desktop/podman-desktop`            | 环境检测 + 引导安装的 UX：先说清缺什么，再给按钮             |
| `microsoft/vscode`                                            | 壳/运行时双层 + 版本闸门 + 下载校验                          |

## 9. 权威链、环境探测与收敛

### 9.1 只有一条权威链

`desktop/runtime-config.ts` 的 `KERNEL_AUTHORITY`：

| 取值                 | 内核以谁为准                  | 运行时自更新                                                     |
| -------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `npm-global`（默认） | 全局 npm 包                   | 停用（`RUNTIME_SELF_UPDATE_ENABLED=false`，壳不再下载/切换内核） |
| `bundled-runtime`    | `<userData>/runtime` 签名清单 | 启用（旧双层模型，留着便于回退）                                 |

解析优先级在 `desktop/kernel-authority.ts`：**全局 npm 包 → `<userData>/runtime`（离线兜底）→ 包内自带**。
包内自带永远兜底（"永远能起来"这条活路不变），但它随壳更新，所以排在最后。
`npm prefix -g` 要起子进程（几百毫秒），结果缓存在 `<userData>/kernel-authority.json`，有效期一天。

### 9.1.1 纯壳包（安装包不装内核）

`desktop/electron-builder.shell.yml`（`npm run desktop:nsis:shell`）出的是**只有壳**的安装包：
`files` 只收 `dist/desktop` + `dist/browser` + 壳主进程 require 的四个包（`electron-chrome-extensions` /
`debug` / `ms` / `jsqr`），内核（`dist/server`、`web/dist`、其余 `node_modules`、`bin`、`themes`、`plugin-sdk`）一律不装。

这份包把权威链末端（包内自带）拿掉，于是 `pickKernelSource` 有三种结果而不是必然有值：

| 机器状态                | 结果                                 |
| ----------------------- | ------------------------------------ |
| 装了全局 npm 包         | 用它（与完整包同一条路）             |
| 有 `<userData>/runtime` | 用它                                 |
| 两者都没有              | **`null`**，壳不 spawn，界面提示安装 |

`null` 的处理是三层，缺一层就变成"点了没反应"：

1. `desktop/main.ts` 的 `resolveServerEntry()` 返回 `null`；`startServerSidecar()` **在 spawn 之前**拦下，
   走 `markKernelUnavailable()` 算清"还缺什么"（系统 node 有没有、够不够 ≥22），
   写进 `BrowserState.kernelMissing` 并把说明交给 `agentError`。
2. `browser/renderer/shell.ts` 的启动覆盖层（`pb-boot-actions`）据 `kernelMissing` 出三个按钮：
   **安装 Node**（`kernel.installNode`）/ **安装内核**（`kernel.upgrade` = `npm i -g pi-web-ui@latest`）/
   **重试**（`kernel.restart`）。三个动作全是既有通道，没有新增 IPC —— 同一件事只能有一个实现。
3. 内核真正起来后（`startServerSidecar` 健康检查通过）立刻 `setKernelMissing(null)` 收回覆盖层，
   不需要用户重启壳。

**取舍**：纯壳包首次启动依赖网络 + node（内核就是 npm 包，这是产品本来就要的运行时）。
因此**完整包不能取消**——它是离线 / 没装 node 的机器唯一能起来的形态；两种包按命令分开，产物目录也分开
（`release/` vs `release-shell/`），`publish: null` 保证壳包不会污染完整包的 `latest.yml`。

**顺带的好处**：完整包把 node-pty 的 console helper 铺进 `app.asar.unpacked`，主进程被强杀后它们成孤儿、
抱着原生模块导致覆盖安装卡进度（[`architecture-desktop-update.md`](architecture-desktop-update.md) §十二）。
纯壳包不含这些文件，安装器要覆盖的只剩自己的 exe。

### 9.1.2 壳与全局包不匹配：装完之后才需要回答的事

纯壳包把「壳」和「内核」变成两个独立安装物（`setup.exe` + `npm i -g pi-web-ui`），
所以**版本不匹配是常态，不是异常**。两边的本钱不同，判定必须分开说：

| 谁的本钱              | 在哪里                                                                                                                  | 不匹配时能不能就地修              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 壳的协议期望          | `desktop/protocol-expectation.ts`（构建期由 `scripts/gen-desktop-protocol.mjs` 从 `server/protocol-version.ts` 烘进来） | 不能（已装好的壳不可热更）        |
| 壳的能力版本          | `desktop/runtime-config.ts` 的 `SHELL_CAPABILITY_VERSION`                                                               | 同上                              |
| 内核的协议 / 兼容下限 | `/api/health.kernel.protocol` / `.minShell`（`server/kernel-identity.ts`）                                              | 能（`npm i -g pi-web-ui@latest`） |

**为什么协议要烘进壳里而不是 import**：纯壳包不带 `dist/server`，运行时 `../server/protocol-version.js`
根本不存在。所以只能在构建期把数字写进 `desktop/protocol-expectation.ts`；
它与源文件不一致时单测会红（`tests/unit/desktop-kernel-compat.test.ts`）。

判定单源是 `desktop/kernel-compat.ts` 的 `compareKernelCompat`，顺序本身即语义：

1. `kernel.minShell > 本壳能力` → **升级壳**（升内核救不了：IPC/preload 是编译进去的）。
2. 内核没报 `protocol`（老内核）→ **升级全局包**（不能白屏）。
3. `protocol` 不相等（两个方向）→ **升级全局包**（壳不可热更，能动手的一侧永远是内核）。
4. 其余 → ok。

结论进 `BrowserKernelState.compat`，渲染层只展示不重算：设置面板的「内核」小节会显示一条警告，
并把「升级内核」按钮亮出来 —— `shouldOfferKernelUpgrade()` 不只看注册表有没有新版，
还看协议是否不匹配（否则“本地已是最新、但与壳不兼容”会变成一个点不动的按钮）。

用全局包当内核时，**内核进程用系统 node 启动**（不是 Electron 的 node）：全局包里的原生模块按系统 node ABI 编译，
塞进 `ELECTRON_RUN_AS_NODE` 可能加载失败；找不到 node 才退回 Electron 自带运行时并在日志里说清。

### 9.1.3 内核界面起不来时的壳侧口径（白屏 = 不许沉默）

壳判定「界面就绪」不能只看 `did-finish-load`：内核回一张 503 诊断页，它照样成功。所以
`desktop/browser-host.ts` 在 Agent 页加载完成后再问一次内核（`probeAgentBuild` → `/api/health.web`），
不齐就把结论写进 `BrowserState.kernelRepair`，此时：

- 启动覆盖层**不收**（`agentReady` 为真只是「文档加载完了」），标题说清「内核在运行，但界面资源缺失」，
  正文是缺哪个文件 + 修复命令，按钮「修复内核（`kernel.upgrade` 重装）/ 重试（`kernel.restart`）/ 退出」；
- Agent 模式下本来整条隐藏的壳 chrome **放回来**（窗口按钮由内核界面的标题栏提供，它没了就等于没有），
  另外失败态必备一个「退出应用」按钮 —— 实机出现过白屏后连关窗都做不到。

`kernelRepair` 与 `kernelMissing` 分开：前者是「连上的内核要修」，后者是「这台机器还没有内核」。

### 9.2 环境探测 + 一键装 node / 升级内核

`desktop/kernel-env.ts` 答三件事：node 够不够新（≥22）、服务配置装没装（三平台各一处路径）、
缺 node 时该跑哪条命令（`winget install OpenJS.NodeJS.LTS` / `brew install node@22` / `apt install nodejs npm`）。
**Win 用 winget、mac 用 brew 直接跑**（会弹系统授权）；**Linux 只给命令**（要 sudo + TTY，GUI 里必然失败）。
升级内核是两步且顺序不能反：`npm i -g pi-web-ui@latest` 成功后才重启内核 —— npm 失败时旧内核仍在跑，
用户不会"点完变没"。版本比对/命令生成在 `desktop/kernel-upgrade.ts`（纯函数，有单测）。

Linux 上「安装为系统服务」直接返回命令而不是硬跑：`server install` 在 Linux 要写 `/etc/systemd/system`，
GUI 里 `sudo` 拿不到终端（`a terminal is required`），硬跑只会得到一条没用的失败。面板那边同样只给命令行。

### 9.3 撞锁不再只是报错：自动收敛

壳在拉本地内核前先读 `<dataDir>/kernel.lock`：持有者 pid 还活着、且它的端口 `/api/health` 可达 → **直接连它**
（通常是上次壳退出遗留的 sidecar，或用户刚装好的服务），而不是再拉一份然后被锁拒掉。

```text
[desktop] kernel: 直接复用数据目录里已在内核（http://127.0.0.1:8907）
```

锁负责"拒绝第二个写者"，收敛负责"把你接回已有的那个"——两者缺一不可。

## 10. 还没做（明确的缺口，不当 bug 修）

| 缺口                | 现状                                        | 方向                                                                                 |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Node 免包管理器安装 | Win 走 winget / mac 走 brew；Linux 只给命令 | `node-downloader-helper` + 官方 `SHASUMS256.txt` 校验后装到 `<userData>/kernel/node` |
| Web 端只读状态卡    | 只有桌面壳面板                              | 复用 `/api/health.kernel`，在设置里加一行                                            |
| 多用户同机          | 锁按数据目录，不按用户                      | 每用户独立 `--data-dir`（本文已按此约定）                                            |

## 11. Windows 的现实约束

`pi-web-ui server install` 在 Windows 是 **HKCU Run 键 + wscript 隐藏启动 + PS1 看门狗**（不是 session-0 服务）：

- ✅ 关掉桌面壳、关掉浏览器 → 内核继续跑
- ❌ 关机 / 注销后未登录 → 不跑；休眠 → 不跑

真要 7×24 只有一条路：把内核放到一台常开的机器（Linux/服务器）上，客户端远程连它。
