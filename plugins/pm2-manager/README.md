# pm2-manager · 进程管家

pm2 **安装 / 管理 / 卸载一体**：没装 pm2 时面板一键安装；装好后面板直接起新应用
（安装到 pm2），应用表看状态/日志、做停止/重启/删除；不用 pm2 时一键卸载本体。
AI 起的长期服务/调试实例有一个统一去处：pm2 —— 于是**有名字、有状态、有日志、
能单独停**，宿主顶栏「后台任务」面板与插件面板看到的是同一份列表。

> 现场问题：AI 调试时后台起一堆实例（本机实测一次遗留 12 个 `dist/server/index.js`，
> CPU 打满），既不在任何列表里也停不干净。这个插件提供治它的工具与面板。

> **不接管**：本插件不对 AI 的命令做任何拦截或追加提示（没有 `onToolPre` 闸门、没有
> `#bg-ok` 逃生门、没有事后催办）。写不写 `nohup` / 尾部 `&` 由模型自己决定，
> 用户想看/想管就开面板。

## 它做了两件事

| #   | 做什么         | 怎么做的                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **提示词引导** | 注册单个 action 式 `pm2` 工具，`description` / `promptSnippet` / `promptGuidelines` 三处告诉模型「长期任务走 pm2 更省心」，不必猜；`action=install/uninstall` 覆盖 pm2 本体的装卸                                                                                                                                                                                                                           |
| 2   | **内嵌面板**   | 宿主「后台任务」面板里就地嵌一块「pm2 托管的应用」（`view:false` + `ui["tasks.panel"]`）：应用表（状态/CPU/内存/重启/时长）、看日志、停止/重启/删除；「➕ 启动新应用」表单直接起服务（安装到 pm2）；底部「卸载 pm2」二次确认后卸本体；pm2 缺失时一键安装。宿主自己 diff 出来的裸进程列表仍在上方 —— 同一个面板，各管一段，不重复列（**不给每个应用注册 `registerBackgroundTask`**，那会让同一个应用列两遍） |

## 给 AI 的用法（工具 `pm2`）

```
action=list                      # 列出托管的应用（含 CPU/内存/重启/时长）
action=start name=api script=server.js args=["--port","8788"] cwd=/path
action=logs  name=api lines=100  # 读输出（不用再留一个无人看管的进程）
action=stop|restart|delete name=api      # name=all 可整批（delete=卸载单个应用，只删记录不卸本体）
action=install                   # 一键 npm i -g pm2（未安装时）
action=uninstall                 # 卸载 pm2 本体（先 pm2 kill，再 npm uninstall -g pm2）
```

约定（写在工具提示词里，模型每轮都能看到）：

- 起后台/长期任务用 `action=start`，比 `nohup`、尾部 `&`、Windows `start`、`Start-Process` 更省心；
- 起第二份同名服务前先 `action=list`，不需要的用 `action=delete` 清掉；
- 想看输出用 `action=logs`，别把进程丢在后台不闻不问。

这些都是**建议**：插件不拦截任何命令，AI 真用了脱管写法也能跑，只是那些进程不在 pm2 列表里。

面板首帧**不抢答**：首次 `GET /status` 回来前只显示中性的「正在检测 pm2 环境…」，不说
「未检测到 pm2」也不说「没有托管任何应用」—— 否则每次点开「后台任务」都会先闪一下黄条
（看着像报错，其实只是状态还没到）。

## 跨平台

pm2 是 npm 全局包，**Windows / macOS / Linux 都能跑**，本插件在三个平台上都走同一条调用链：

1. 先按 `设置.pm2Bin` → 环境变量 `PI_WEB_PM2` → node 前缀（`dirname(process.execPath)/node_modules/pm2/bin/pm2`）
   找 pm2 的 **JS 入口**；
2. 都没命中才去问 `npm root -g`（这一步才起子进程，且只在按需路径上）；
3. 调用一律 `node <pm2 的 JS 入口> <args>` —— **不走 PATH、不碰 `.cmd` 垫片**，绕开
   Windows 上 `execFile("pm2")` 直接 EINVAL、以及服务化运行时 PATH 里没有全局 bin 目录两个坑。

平台差异只在一处：**Windows 不支持 `pm2 startup` 开机自启**（官方限制），所以本插件不碰自启。
「遗留裸实例」的跨平台扫描（netstat/ss/lsof + 进程树）由**宿主**的后台任务面板自己负责，本插件
不再重复实现一套，避免同一份信息在一个面板里列两遍。

## 设置

| key      | 默认 | 作用                                                                       |
| -------- | ---- | -------------------------------------------------------------------------- |
| `pm2Bin` | 空   | pm2 入口绝对路径（留空自动探测）；填的是 `bin/pm2`（JS 入口），不是 `.cmd` |

## HTTP 路由（面板用）

`/plugins-api/pm2-manager/*`：`GET /status`、`POST /install`（装本体）、`POST /uninstall`（卸本体，先 `pm2 kill` 再 `npm uninstall -g pm2`）、`POST /action`（`stop`/`restart`/`delete`/`logs`/`describe`/`start`，start 需 `script`）。删单个应用走 `delete`（只删记录不卸本体），和卸本体是两回事。

## 权限

`ui`（`tasks.panel` 槽位）、`tools`（AI 工具）、`http`（面板路由）。

## 文件

- `manifest.json`：manifest（含 settings schema、`view:false` 与 `ui["tasks.panel"]` 条目）
- `index.mjs`：服务端入口 —— 上半是**纯函数区**（pm2 入口候选 / jlist 解析 / 格式化 / `buildPm2StartArgv` 拼 start 参数，单测直接从本文件 import），下半是 activate（探测、AI 工具、HTTP 路由：装本体 / 卸本体 / 管应用）
- `client/entry.mjs`：内嵌面板（`mount(container)` → 返回 cleanup；面板关闭或插件重载时宿主调 cleanup 收摊）

> 纯函数**刻意内联**在 `index.mjs` 而不是单独成文件：宿主的 `plugins_reload` 只给
> `index.mjs` 的 import 加 `?e=<epoch>` 缓存击穿，被它静态 import 的兄弟模块会命中
> Node ESM 模块缓存 —— 改了不随 reload 生效，必须重启服务（踩过一次）。

- 单测：`tests/unit/pm2-manager.test.ts`（纯函数 + 假宿主 activate，零端口零子进程，含装卸常量与 `buildPm2StartArgv`）、
  `tests/unit/pm2-manager-panel.test.ts`（面板首帧不抢答、启动表单下发 start、卸载二次确认）
