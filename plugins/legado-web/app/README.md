# Legado Web（插件内嵌版 · 仅文本源 + 代理模式）

从 `legado-E`（阅读 Sigma / Legado 衍生）剥离的核心读书链路：
`搜索 / 发现 / 详情 / 目录 / 正文`，书源 JSON 与 Android 版兼容。

> **这份源码内嵌在 pi-web-ui 的 `plugins/legado-web/` 插件里**，作为插件视图
> （📖 顶栏 tab）运行。构建、安装、代理与存储都由插件承担：
>
> - 界面：`client/app/`（本目录 `npm run build` 的产物）经宿主 `/plugins/<id>/client/*` 托管
> - 代理：插件服务端 `../index.mjs` 的 `GET/POST /plugins-api/legado-web/proxy`（CORS + GBK，实现在 `../net.mjs`）
> - 存储：插件服务端 `/plugins-api/legado-web/store`，落 `<dataDir>/legado-web/*.json`
> - 基址推导：`src/core/apiBase.ts`（按页面路径自适应应用前缀，无构建期配置）
> - 规则引擎还有一份 **Node 打包版**（`src/core/engine-entry.ts` → `../server/engine.mjs`），
>   给插件注册的 AI 工具（诊断/试规则）用，与浏览器里这份是同一份源码
>
> 日常构建走插件根的 `../build.mjs`（vite + esbuild）；本目录保留 `npm run dev` 仅供纯前端调试（无同源代理，需自备）。

## 构建

```bash
node ../build.mjs          # 等价于本目录 npm install + npm run build
npm run build              # 仅构建（需先 npm install）
```

## 结构

- `src/types.ts` — 对应 `app/.../data/entities/BookSource.kt`
- `src/core/analyzeUrl.ts` — 对应 `AnalyzeUrl`（`,{json}` + `{{key/page}}`）
- `src/core/js.ts` — JS 规则（原 Rhino，直跑原生）。`java` 对标原版 bindings：`put/get`（按书源隔离的跨规则变量）、`ajax/connect/get/post`（经代理同步请求）、`base64Encode/Decode`、`md5Encode`、`log/toast`；`<js>` 内可用 `result/baseUrl/key/page/source/book/chapter/title/java`，`{{...}}` 模板同样支持 `java.get(...)`
- `src/core/analyzeRule.ts` — 对应 `AnalyzeRule`：CSS（含原版基写法与索引、`@` 逐段收窄+输出分离）/XPath/JSONPath/Regex + `||`/`&&`/`%%`（分隔符感知嵌套）+ `##`（无替换=删除，有替换=替换，`###`=首匹配）+ `@put/@get/{{}}`（`{{$.x}}` 按嵌套规则求值）+ JS 链式 + 前缀 + `:N` 兼容。**任何规则都不抛错**，失败记入 `ruleErrors`（console 搜 `[规则失败]`）。
  **单段规则**（无 `@`）：先当选择器 + 取文本（对标安卓版，`#content`/`.title##正则` 直接可用）；
  选不到再退回输出说明（属性名），所以条目范围里 `chapterName="text"`、`chapterUrl="href"` 依旧有效。
- `src/core/probe.ts` — 链路诊断（AI 修源用）：逐步跑连通/搜索/详情/目录/正文，回报请求地址与状态、页体片段、解析值、规则原文、规则失败明细
- JS 规则原生执行（Rhino 语义：松散模式、completion 返回值、按源隔离共享变量、`java.put/get/ajax/post`、数组/元素外观 `toArray/size/get/select/attr/text`）
- `src/core/js.ts` — JS 规则原生执行（Rhino 语义：松散模式、completion 返回值、**按源隔离沙箱**（隐式全局不串源）、`java.put/get/ajax/post/getElement/getString/setContent`、数组/元素外观 `toArray/size/get/select/attr/text`）
- 正文为空/非正文不再白页：会直接告诉你原因，并在 console 打 `[正文为空]` / `[正文非正文]` 详情
- `src/core/pageProblem.ts` — 盾页/乱码/空页识别与网络错误分类（“检测”与正文抓取共用）
- **随处删源/标废源**（“打开的书不能用就当场删掉”）：发现页顶部（删源/标废源）、发现加载失败卡片（删源/标废源/换个源）、阅读页工具栏（删源/移出书架）、正文失败卡片、详情失败卡片、书架每行（删源）、书源页「删除废源」——删源会同时清掉该源的检测记录与发现缓存
- **删源就删书**：所有删源入口（阅读页/书架行/发现页/失败卡片/「删除废源」批量）都会把书架上该源的书**一并移出**（含阅读进度），确认框会先提醒“该源的书会一并移出”；进度清理只发生在删源（「移出书架」仍保留进度，重加书可接着读）
- **阅读页删源 = 一条龙换源**：阅读页工具栏「删源」或正文失败卡片的「删掉这个源」——删源（连书）后自动跳到「发现」页，并把阅读页状态清空（不留在已删源的旧正文上）；若被删的源正是发现页当前查看的源，会清掉它的分类/结果缓存重新选源
- **发现页**：选书源 → 自动解析分类（JS/JSON/文本三种格式）→ 点分类看书 + 下一页；筛选类控件（text/select/toggle）值存 infoMap 并对接 JS；分类加载失败会给出原因
- 已实测源：酷我小说（JSON API）、阅友小说（HTML），搜索→详情→目录→正文全通；发现页在可用源上 18/18 成功
- **废源自动检测与隐藏**（“书看不了也算废源”）：
  - `快速检测废源`：站点连通 + 搜索，抓挂了/被墙/盾页/无搜索规则
  - `完整检测废源`：再跟到详情/目录/正文，链断裂、正文为空、**返回的不是正文而是站点提示**（如“版本过低请升级”）都算废源
  - 书源列表默认隐藏废源（可同时隐藏可疑）、搜索默认跳过废源（可选仅可用源/全部源）、“删除废源”一键清理、导入后自动检测
  - **阅读失败自动标记**：读某书时确认是源失效（无正文规则/WebJS/站点提示/盾页/网络不可达），自动将该源标为废源并提示
- `src/core/explore.ts` — **发现（explore）**：解析 `exploreUrl`（`@js:`/`<js>` 产出 JSON 分类数组、直接 JSON 数组、旧式 `分类::url` 文本）+ 分类点击加载列表 + `infoMap` 筛选值（对拼原版，含 `java.t2s/s2t` 兼容占位、`cache.getFile/putFile`）
- `src/core/check.ts` — **书源检测**：三档（仅连通 / 连通+搜索 / 完整链路），分步记录耗时与结果，失败分成人话结论；结果分为 `ok` / `dead`（站点级废源，可隐藏）/ `suspect`（可疑：搜索无结果/规则不兼容）
- `src/core/webBook.ts` — 对应 `model/webBook/*` 五件套
- `src/core/request.ts` — 统一走代理请求（基址见 `src/core/apiBase.ts`）
- `src/core/apiBase.ts` — 接口根推导：插件内 → `<前缀>/plugins-api/legado-web`，独立部署 → `VITE_API_BASE`
- `src/store.ts` — 持久化：**内存为事实源 + 双写** localStorage（缓存，有 5MB 上限，超上限的键自动跳过）与本地文件（`<dataDir>/legado-web/*.json`）；`src/store-cache.ts` 负责瘦身/容量判定。启动时调 `hydrateFromBackend()`：后端有数据以后端为准，后端为空而浏览器有则自动迁移过去；后端不可用时自动回退成仅浏览器
- `src/core/backend.ts` — 本地存储服务客户端（`/store?key=<键>` 读、`POST` 写）
- `src/store.ts / src/main.ts` — 书架 + 四页 UI（书架/搜索/书源/检测/阅读）

## 存储

书源 / 书架 / 阅读进度 / 检测结果**只落数据目录文件**（`<dataDir>/legado-web/*.json`，默认 `~/.pi-web/legado-web/`）：

- 本地文件位置：`sources.json`（书源）、`shelf.json`、`progress.json`、`check.json`、`prefs.json`（置顶书源等本机偏好）
- **不写浏览器 localStorage**：书源动辄几 MB（5MB 配额装不下，曾报 QuotaExceededError），清缓存/换浏览器还会丢
- 页面里只留一份**内存镜像**（渲染同步读）；发现页筛选值、JS 规则 `java.cache` 同样只放内存
- 老版本浏览器里的数据启动时做一次性只读迁移（搬进文件后删掉老键）
- 从旧版 legado-web 搬数据：把 `server/data/*.json` 拷进 `<dataDir>/legado-web/` 即可
- 后端不可用（如只跑前端 dev）时状态栏会提示「存储：仅内存（后端不可用，刷新会丢）」

