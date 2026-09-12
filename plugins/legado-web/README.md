# legado-web（📖 阅读）

把 [Legado / 阅读](https://github.com/gedoor/legado) 的核心读书链路搬进 pi-web-ui：
**搜索 / 发现 / 详情 / 目录 / 正文**，书源 JSON 与安卓版兼容，另带书源导入、废源检测与清理。

界面是原 `legado-web`（Vite + vanilla TS）应用，**整幅内嵌在插件视图里**（iframe），
插件负责它需要的一切后端：跨域+GBK 代理、本地存储、静态托管。

另外给 AI 配了一套**修源接口**（agent 工具 `legado_rules` / `legado_book_sources` /
`legado_source_probe` / `legado_run_rule`）：agent 能读规则速查、读书源文件、逐步跑链路看断在哪一步、
拿真实页体试规则，然后只改坏掉的字段（详见下文「AI 修源接口」）。

## 安装

```bash
# 本机仓库里直接装（开发调试）
pi-web-ui install <repo>/plugins/legado-web

# 已推到 GitHub 后
pi-web-ui install <owner>/<repo>/plugins/legado-web
```

装好刷新浏览器，顶栏出现 📖 tab（设置面板 →「界面插件」里可隐藏）。

## 构建

`client/app/`（内嵌前端）与 `server/engine.mjs`（AI 诊断用的规则引擎）都是构建产物，
随插件分发。改了 `app/src/` 后：

```bash
node plugins/legado-web/build.mjs            # 缺 node_modules 时自动 npm install + vite build + esbuild 引擎
node plugins/legado-web/build.mjs --install  # 强制重装依赖
pi-web-ui install <repo>/plugins/legado-web --force   # 覆盖安装（插件目录里也有一份产物）
```

## 结构

```
plugins/legado-web/
├── manifest.json      # id/name/icon 📖，permissions: http（host.route）+ net（出站抓取）+ tools（AI 工具）
├── index.mjs          # 服务端入口：/proxy、/store，并注册四个 AI 工具
├── net.mjs            # 公共抓取层（GBK 编解码 + cookie jar），UI/引擎/同步桥共用
├── store.mjs          # 数据落盘（<dataDir>/legado-web/<键>.json，原子写）
├── tools.mjs          # AI 工具：legado_rules / legado_book_sources / legado_source_probe / legado_run_rule
├── rules.md           # 书源规则速查（人看 + AI 的知识库，legado_rules 原样返回）
├── engine-bridge.mjs  # 主进程侧的引擎桥（worker 生命周期 + 超时重建）
├── engine-host.mjs    # 引擎 worker：注入 transport、localStorage 垫片，跑 probe/check/rule
├── sync-bridge.mjs    # 同步桥（worker 线程里 Atomics.wait，给 java.ajax 这类同步规则用）
├── sync-worker.mjs    # 同步桥 worker：真发请求，结果写回共享内存
├── client/
│   ├── entry.mjs      # 视图入口：占满视图的 iframe（零依赖纯 DOM，无工具栏）
│   └── app/           # 内嵌前端构建产物（index.html + assets/*，构建生成，勿手改）
├── server/
│   └── engine.mjs     # 规则引擎构建产物（esbuild 从 app/src/core/engine-entry.ts 打包，勿手改）
├── app/               # 内嵌前端源码（源自 legado-web，见其 README）
│   ├── src/core/      # 书源规则引擎（analyzeRule/analyzeUrl/js/webBook/check/probe…）
│   └── vite.config.ts # base './' + outDir ../client/app
└── build.mjs          # 构建脚本（npm install + vite build + esbuild 引擎）
```

## AI 修源接口（agent 工具）

插件注册了四个工具（`manifest.permissions` 里的 `tools` 族），让 agent 能“知道规则 → 读书源文件 →
跑链路找病因 → 试规则验证 → 改回去”：

| 工具                  | 作用                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `legado_rules`        | 返回 `rules.md`（规则语法/字段/差异/流程速查），可带 `topic` 只要某章                                                                |
| `legado_book_sources` | 读书源文件：`list`（可按名字/URL 过滤，带健康状态）/ `get` / `update`（按字段**深合并**）/ `add` / `remove`                          |
| `legado_source_probe` | 逐步跑「连通 → 搜索 → 详情 → 目录 → 正文」，每步回报：请求地址/状态/页体片段、解析出的值、用到的**规则原文**、新增的**规则失败明细** |
| `legado_run_rule`     | 抓页试跑单条规则（`listRule` 支持条目级子规则），返回页体片段与真实求值结果                                                          |

实现要点：

- 规则引擎跑在 **worker 线程**里（`engine-bridge.mjs` + `engine-host.mjs`）——一次诊断要发好几个外部请求（几秒到几十秒），不能卡住主进程的 WS/HTTP；超时或崩溃自动重建 worker。
- 引擎产物由 esbuild 从 `app/src/core/engine-entry.ts` 打成 `server/engine.mjs`（`platform=node`），与浏览器里那份规则引擎**同一份源码**，行为一致。
- 书源 JS 规则里的 `java.ajax/connect/get/post` 是同步语义：浏览器用同步 XHR，Node 里由 `sync-bridge.mjs`（嵌套 worker + `SharedArrayBuffer` + `Atomics.wait`）实现，所以带这类规则的源也能诊断。
- 引擎侧注入了 `localStorage` 内存垫片（供 `java.cache`/infoMap）、异步 transport（`net.mjs`，与 UI 的 `/proxy` 同一份实现）与同步 transport。
- 写操作会 `host.notify` 提醒用户刷新阅读页（浏览器里那份是内存副本）。

## 发现页：收藏书源 + 直接搜这个源

发现页（按 `exploreUrl` 浏览分类）上有两件省事的事：

| 功能                   | 说明                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **☆ 收藏 / ⭐ 已收藏** | 收藏当前书源：下拉里多一个「⭐ 常用（收藏）」分组排在最前，下面还会多一行「⭐ 常用」按钮，**点一下直接切源**（不用每次下拉翻）                                      |
| **直接搜这个源**       | 发现页的搜索框输入关键词 → 调当前源自己的搜索接口 → 结果就列在下面同一个列表里（标题写「🔍 搜索「x」」），不用切到「搜索」页；搜不到/报错时旁边就有「🤖 AI 修复源」 |
| 分类浏览               | 点分类照常翻页（`下一页`）；搜索与分类共用一个列表容器，互不串味                                                                                                    |

收藏就是本机偏好（和书源页的 ⭐ 置顶同一份数据）：`<dataDir>/legado-web/prefs.json` 的
`{"pinned":[书源URL…]}` —— 两个页面看到的是同一批"常用源"，删源会一起清掉。

## 「AI 修复源」按钮（阅读页 → AI 对话）

内嵌阅读页里凡是“这本书读不了”的地方都有 `🤖 AI 修复源`：

- 阅读页工具栏（当前这本书）+ 正文加载失败的卡片
- 详情加载失败的卡片
- 书源列表每行（检测不通过的源才显示）
- 书源页顶部「导入书源」卡片里的 `🤖 AI 新建书源`：**只填一个网站链接**，AI 自己抓页写出 searchUrl / ruleSearch / ruleBookInfo / ruleToc / ruleContent 并用 legado_source_probe 验证，最后 legado_book_sources add 存盘

书源多的时候（几百个很常见）靠这几件在书源页里找：

| 功能                | 说明                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **搜索框**          | 按「名称 / 地址 / 分组」实时过滤（输入防抖、光标不丢，Esc 清空）；标题栏会写「匹配「xx」N 个」 |
| **⭐ 置顶**         | 每行左侧一个 ⭐/☆ 按钮：置顶的源排到列表最前（置顶行左侧有强调色条），点「取消全部置顶」一键清 |
| **只看置顶**        | 勾上只显示已置顶的源（配合搜索等于"收藏夹分组"）                                               |
| 隐藏废源 / 隐藏可疑 | 按检测结果过滤；单行的「标回可用」可清掉误判                                                   |

置顶是**本机偏好**（不是书源 JSON 的字段），存 `<dataDir>/legado-web/prefs.json` 的 `{"pinned":[书源URL…]}`；删源时会顺手把它的置顶清掉。

- 检测页每个失败项
- 发现页：书源选择行（任何源都可手动修）+ 分类解析失败处 + 分类加载失败卡片

「AI 新建书源」的正文长这样（只要一个链接，其余交给 AI）：

```
【AI 新建书源】请为下面这个网站新建一个 Legado 文本书源（bookSourceType=0）并存盘。只加书源数据，不要改阅读插件本身。
- 网站：https://www.example.com
- 书源文件（要加进去的就是它）：~/.pi-web/legado-web/sources.json
- 规则速查（只读）：<插件目录>/rules.md
- 工作目录：~/.pi-web/legado-web
1) legado_rules 看语义 → 2) legado_run_rule 抓首页找搜索入口 → 3) 写 searchUrl+ruleSearch 并验证 →
4) ruleBookInfo/ruleToc/ruleContent 逐步验证 → 5) legado_source_probe 跑全链路 → 6) legado_book_sources add 存盘
```

点下去发生什么：

```
阅读页（iframe）  postMessage {type:"legado:ai-fix", context:{书源/书籍/出错地址/报错/相关规则}}
   ↓
entry.mjs（插件视图，同源 + source 校验）→ client/ai-fix.mjs 组正文
   ↓  window.__piWebUiHost.startChat({ prompt, newChat:true, cwd: 书源所在目录 })
pi-web-ui 主应用：切到「对话」视图 → 新建对话（cwd = `<dataDir>/legado-web`）→ 自动发送
   ↓
AI 拿到正文后：legado_rules → legado_source_probe → legado_run_rule → legado_book_sources update
```

细节：

- **只改书源数据，不碰插件本体**：正文里给的是**书源文件**（`<dataDir>/legado-web/sources.json`）与**规则速查文件**（`<插件目录>/rules.md`，只读参考）；
  插件目录仍然会告知，但明确标为**只读**（install --force 会整目录覆盖，本机也可能没有源码），并硬性要求「不要修改 app/、client/、server/、*.mjs，引擎不支持的写法给等价规则绕法」。
- **cwd = 书源所在目录**（dataDir，`sources.json`/`shelf.json`/`check.json` 就在那儿）——AI 的工作区就是它要改的那份数据，而不是插件代码。
- 目录信息（书源文件 / 规则速查 / dataDir / pluginDir / workspace）由插件服务端在收到 `{type:"info"}` 时回。
- `startChat` 会等 `set_cwd` → 等新对话真的就绪（服务端的 `new_chat` 是异步的，不等的话 prompt 会落到旧对话）→ 才发消息；每步都有超时，超时也照发，不静默丢消息。
- 宿主 API 是 `window.__piWebUiHost`（定义见 `web/src/plugin-host.ts`，当前 `version: 1`）。宿主旧到没有这个 API 时，按钮退化成「把给 AI 的正文复制到剪贴板 + 提示」，不做哑操作。

### 顺手修掉的引擎偏差

`app/src/core/analyzeRule.ts` 的 CSS 求值原本把**单段规则**当“输出说明”而非选择器，
导致 `ruleContent.content = "#content"`、`ruleSearch.name = ".title##正则"` 这类写法（真实书源里极常见）
一律取不到值。现改为：关键字（`text/textNodes/ownText/html/all`）仍当输出，其余先当**选择器 + 取文本**，
选不到再退回输出说明（保住条目范围里的 `href`/`text` 写法）。两端（内嵌 UI 与 AI 引擎）同步生效。

## 协议（host.route，实际路径 `/plugins-api/legado-web/*`）

| 路由                   | 方法       | 说明                                                                                   |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `/proxy?url=&charset=` | GET / POST | 抓书源站：绕 CORS、按 `charset` 编 URL 中文与 POST body、GBK 解码、按域隔离 cookie jar |
| `/store[?key=<键>]`    | GET        | 无 `key` → `{keys:[…]}`；有 `key` → `{value}`（不存在 404 `{value:null}`）             |
| `/store?meta=1[&key=]` | GET        | 各键（或单个键）文件版本 `{metas:{<键>:{size,mtime}}}`——前端据此发现**外部改动**       |
| `/store?key=<键>`      | POST       | body `{value:…}` → 原子写 `<dataDir>/legado-web/<键>.json`，回 `{ok,bytes,meta}`       |

- **零 npm 依赖**：GBK 解码用内置 `TextDecoder('gbk')`；编码用惰性构建的反查表（遍历 GBK 双字节空间反向建映射，约 20ms、只在用到非 UTF-8 charset 时构建）。
- **绝不透传浏览器请求头**：只带默认 UA/Accept 与书源自己声明的 `headers`——否则 pi-web 的 token cookie 会被带去第三方站点（`tests/legado-web-test.mjs` 有回归）。
- 静态资源不用插件挂路由：`client/app/` 由宿主 `/plugins/<id>/client/*` 托管；前端用相对路径加载，应用根前缀（nginx 子路径 `/pi`）自适应（`app/src/core/apiBase.ts`）。

## 数据

书源 / 书架 / 阅读进度 / 检测结果**只落数据目录文件**：`<dataDir>/legado-web/*.json`
（`sources.json` / `shelf.json` / `progress.json` / `check.json`，另有本机偏好 `prefs.json` 存置顶书源；默认在 `~/.pi-web/legado-web/`）。

- **不写浏览器 localStorage**：书源动辄几 MB（5MB 配额装不下，曾报 QuotaExceededError），而且清缓存/换浏览器就没了；
- 页面里只留一份**内存镜像**（渲染是同步读，所以要在 `hydrateFromBackend()` 之后才渲染）；
- 发现页筛选值、书源 JS 规则的 `java.cache` 也只放内存（刷新重算）；
- 老版本存在浏览器里的数据会在启动时做**一次性只读迁移**（搬进文件后把老键删掉）；
- 后端不可用时状态栏会写「存储：仅内存（后端不可用，刷新会丢）」。

### 刷新与「废源隐藏」的坑

- **自动刷新**：删源/「删除废源」/导入/检测完都会把受影响页（书源/搜索/检测/书架，必要时发现）一次重渲染；
- **外部改动自动探测**：数据目录里的 `sources.json` 等被**别人**改了（AI 工具 `legado_book_sources`、另一个页面、手工编辑），
  页面会在**切页**、**标签页/窗口重新可见**时比对文件的 `size+mtime`，发现变了就自动重读并重渲染。
  阅读页会顺带用新规则**重拉当前章正文**（目录规则变了还会重拉目录）——
  “AI 说修好了、切回阅读页却还是旧结果”就是这个：以前页面只在启动时读过一次文件；
- **手动刷新（兜底）**：书源页/检测页「刷新」（重读全部数据再重渲染）、搜索页「刷新数据」、
  阅读页工具栏「刷新」、以及各失败卡片上的「刷新数据重试」——都是同一件事：
  从数据目录文件**重读**，然后用新规则重跑当前这一步（发现分类 / 这一章正文）；
- **删源会清检测记录**（连同 http/https、末尾 `/` `#` 的同址变体）——否则顶栏「废源 N」与检测页会挂着已删源，看着像没刷新；
- **被隐藏不等于被删**：书源页默认勾着「隐藏废源」，搜索默认「跳过废源」，发现页也过滤 `kind==='dead'`，
  所以一个源被判废后会**三处都看不见**。页面会提示隐藏了几个，单个源可点行内「标回可用」回到未检（不用重新导入）。

> **为什么不在插件目录**：`pi-web-ui install --force`（设置面板的「更新」）会先删掉整个插件目录、
> 只保留 `config.json`——700 个书源这种数据放那里会被更新洗掉。放 `<dataDir>/legado-web/` 则
> 升级/重装/卸载都不受影响；想清空就 `rm -rf <dataDir>/legado-web`。旧版插件目录里的
> `storage/*.json` 仍会被当作回退源读取，并在首次读到时就搬过来。

从旧版 legado-web（独立部署）搬数据：

```bash
cp <legado-web>/server/data/*.json <dataDir>/legado-web/
```

## 测试

```bash
npm run build:server && node tests/legado-web-test.mjs         # 端口 8993/8994：协议/代理/存储
node tests/legado-web-engine-test.mjs                          # 端口 8995：AI 工具 + 规则引擎（零 token）
node tests/legado-web-ai-fix-test.mjs                          # 端口 8996：「AI 修复源」按钮 E2E（缺 Chrome 自动 SKIP）
node tests/legado-web-storage-test.mjs                         # 端口 8997：大数据量下的存储降级（缺 Chrome 自动 SKIP）
```

`legado-web-test`：清单推送 / 内嵌前端静态托管 / 代理 UTF-8+GBK / charset 编码（URL 与 POST body）/
自定义头透传 / 浏览器头不外泄 / 上游失败 502 / 存储读写·大 payload·非法键 / **`GET /store?meta=1` 版本信息（外部改动探测）**。

`legado-web-engine-test`：四个工具注册 / `legado_rules` 内容 / 「AI 修复源」正文组装 / 书源文件 list·get·add·update（深合并落盘）·remove /
链路诊断（含 `step` 单步模式）/ 试规则（页面级 + 条目级）/ 单段 CSS 规则回归 / 书源 JS 规则的同步 `java.ajax` / 前端问目录的 info 回包。

`legado-web-ai-fix-test`：桥接 E2E——harness 页冒充宿主（假 `window.__piWebUiHost`）+ 真内嵌阅读页，点「🤖 AI 修复源」后断言正文含现场、切了 chat 视图、要求新对话、cwd = 书源所在目录（dataDir）；书源页与发现页各测一次。

`legado-web-storage-test`（Chrome）：存储契约——1.8MB 书源 + 3000 章书架下不报 QuotaExceededError、
跑完后 localStorage **一个 `legado.*` 键都不剩**、刷新后数据仍在（来自文件）、老浏览器数据被迁进文件且老键被清。
前两个进了 `npm run test:smoke`；宿主动作桥的时序另有单测 `tests/unit/plugin-host.test.ts`。
