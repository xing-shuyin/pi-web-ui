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

## 2. 事实源

| 关注点                                  | 唯一事实源                                       | 说明                                                 |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| 内核身份（版本/安装形态/托管者/uptime） | `server/kernel-identity.ts`                      | 纯推导，无 I/O；`/api/health` 的 `kernel` 块由它产出 |
| 数据目录单实例                          | `server/instance-lock.ts`                        | pid 文件 + 探活 + 陈旧接管                           |
| 内核公开快照的形状                      | `server/protocol.ts` 的 `KernelPublicInfo`       | 客户端与内核之间的线形状                             |
| 壳要不要自己拉内核                      | `desktop/kernel-mode.ts` 的 `decideKernelMode()` | main.ts 里不许再写第二份 if                          |
| 一键装成系统服务                        | `desktop/kernel-install.ts`                      | 只拼参数 + 起子进程，判断在 kernel-mode              |
| 状态文案（人话）                        | `browser/kernel-view.ts`                         | 面板与未来设备页共用                                 |
| 跨层视图形状                            | `browser/contracts.ts` 的 `BrowserKernelState`   | 进 `pi-browser:state`，面板读 `kernel.status`        |

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
		"lock": "held", // held / disabled（PI_WEB_ALLOW_MULTI_INSTANCE=1）
	},
}
```

**刻意不含 pid / 数据目录 / node 路径**：`/api/health` 是免鉴权端点（`page-picker` 扩展靠它探测"这是不是
pi-web-ui"），公网绑定场景不该把本机路径吐给任何人。要路径的排障走日志、启动横幅与 `pi-web-ui server status`。
`server/kernel-identity.ts` 的注释与 `tests/unit/kernel-identity.test.ts` 一起守着这条边界。

`installKind` 只认结构事实（`app.asar` → `packaged`；`node_modules/pi-web-ui` → `global-npm`；其余 `source`），
不看环境变量——否则同一份代码在不同启动方式下会报不同的形态。

## 4. 壳的判定顺序（`decideKernelMode`）

```text
磁盘上配置的 Agent 地址
        │
        ├─ 没配 ─────────────────────► local：拉本地 sidecar（既有行为）
        │
        └─ 配了 ─► 探 /api/health
                    ├─ 可达 ─────────► external：只连，**不 spawn**（"关掉壳内核还在跑"的前提）
                    └─ 不可达 ───────► local：回退本地 sidecar + 把失败原因透给面板
```

- 探测超时 1500ms（`KERNEL_PROBE_TIMEOUT_MS`），判据与 `page-picker` 扩展一致（`ok: true`）。
- 回退必须**可见**：面板会显示"配置的内核不可达：…"，不允许静默切到本地内核让用户以为连的还是远程那份。
- 老版本内核不返回 `kernel` 块也照样可达（向后兼容），只是面板少几行信息。

## 5. 一键装成系统服务

按钮 → 壳主进程 → 本包 CLI（`bin/pi-web-ui.mjs server install`，**不经 shell**）。顺序是有原因的：

```text
1. 本地 sidecar 正持着数据目录锁 → 先停它（否则服务启动会被单实例锁拒绝）
2. 装并启动服务：--port（服务已存在则沿用当前端口，否则用稳定默认 8790）
                 --data-dir / --cwd（取当前内核正在用的那份，装完看到的是同一批会话）
3. 交棒：把 Agent 地址写成服务地址 → 下次启动不再拉本地 sidecar
4. 任一步失败：回滚，把本地内核重新拉起来（不能"点完按钮反而没内核了"）
```

实现落点：`desktop/main.ts` 的 `installKernelService()`；参数拼装与子进程在 `desktop/kernel-install.ts`
（120s 硬超时，超时连同子进程树一起杀）。这套协议与 `server/device-center/hub-setup.ts`（Hub 一键安装）同构，
差别只在被安装的对象。

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
- 重启的语义按托管方式分派：服务托管 → `server restart` 交给服务管理器；本地 sidecar → 自己杀重生。
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

## 9. 还没做（明确的缺口，不当 bug 修）

| 缺口              | 现状                                                              | 方向                                                                          |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 内核自更新链退役  | `desktop/runtime-updater.ts`（签名清单）与全局 npm 包是两条权威链 | 定一条（建议全局 npm），另一条降级为离线兜底                                  |
| 「安装 Node」按钮 | 现在只读 `process.execPath`，缺 Node 时只能靠用户自己装           | `node-downloader-helper` + 官方 `SHASUMS256.txt` 校验，或调 `winget` / `brew` |
| npm 全局前缀检测  | 未检测用户是否已装全局包                                          | 缓存 `npm prefix -g` 结果，面板显示"已装 vX，可一键升级"                      |
| 双内核的自动收敛  | 锁只负责拒绝，不负责"帮你停掉旧那个"                              | 面板给"停掉另一个内核"按钮（`server stop`）                                   |

## 10. Windows 的现实约束

`pi-web-ui server install` 在 Windows 是 **HKCU Run 键 + wscript 隐藏启动 + PS1 看门狗**（不是 session-0 服务）：

- ✅ 关掉桌面壳、关掉浏览器 → 内核继续跑
- ❌ 关机 / 注销后未登录 → 不跑；休眠 → 不跑

真要 7×24 只有一条路：把内核放到一台常开的机器（Linux/服务器）上，客户端远程连它。
