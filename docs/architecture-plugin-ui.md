# 插件界面集成与 UI 扩展点

插件如何长到界面上：renderer 渲染能力、宿主动作桥与语言单源、静态服务与常驻播放器，以及 slot（UI 扩展点）框架的全部规则（挂载点、合并优先级、溢出隐藏、弹窗）。插件内核见 [`architecture-plugins.md`](architecture-plugins.md)，宿主 API 见 [`architecture-plugin-host-api.md`](architecture-plugin-host-api.md)。

## 目录

- [fenced-code 渲染插件（renderer plugins）](#fenced-code-渲染插件renderer-plugins)
- [聊天正文装饰（`chatDecorations`）](#聊天正文装饰chatdecorations)
- [前端集成](#前端集成)
  - [插件 → 宿主动作桥（`window.__piWebUiHost`）](#插件--宿主动作桥windowpiwebuihost)
  - [插件界面语言（全局语言单源，issue #920）](#插件界面语言全局语言单源issue-920)
- [常驻播放器：红果短剧](#常驻播放器红果短剧)
- [静态服务](#静态服务)
  - [特权 DOM 访问（`dom` 能力族）](#特权-dom-访问dom-能力族)
- [UI 扩展点（slot 框架，issue #146）](#ui-扩展点slot-框架issue-146)
  - [22 个挂载点](#22-个挂载点)
  - [manifest 里怎么写](#manifest-里怎么写)
  - [条目字段（`UiContribution`）](#条目字段uicontribution)
  - [合并优先级（四级）与「同一份计算」](#合并优先级四级与同一份计算)
  - [溢出与隐藏](#溢出与隐藏)
  - [`host.ui.*`：运行时注册](#hostui运行时注册)
  - [内置条目的实现留在组件里（踩过的坑）](#内置条目的实现留在组件里踩过的坑)
  - [弹窗（`modal.dialog`）](#弹窗modaldialog)

## fenced-code 渲染插件（renderer plugins）

> 让消息里 ` ```lang ` 围栏由插件渲染成自定义 DOM（第一个实现：mermaid → SVG）。

**形态**：`manifest.json` 声明 `view:false, renderers:["lang"]`，`client/entry.mjs`
默认导出 `{ renderers: { lang: (code, ctx) => HTMLElement|null } }`。返回 `null`
＝不渲染，回退普通代码块。renderer 是任意技术栈（不共享 React 实例），主应用只
负责把返回的 DOM 挂进消息流；ctx 与视图 mount 同一套窄通道（`send`/`onData`）。

**协议**：`UiPluginInfo` 新增 `renderers`/`view` 两个可选字段，随 plugins 清单推送。

**分发**：普通插件随 GitHub 仓库分发；Superagent 等明确随包的内置模块除外。普通插件使用 `pi-web-ui install <owner>/<repo>/<subdir>`
（install 原生支持子路径 source）或复制目录到 `<dataDir>/plugins/`。需要大引擎的
renderer 插件可自带 vendor（如 mermaid 插件 `vendor/mermaid.bundle.mjs`，构建产物随
插件分发，本地优先加载、缺省回退 CDN）。

**前端路由**：`web/src/plugin-fence.ts` 维护「语言 → 插件 id」注册表（由 plugins
清单构建），`Markdown.tsx` 的 `PreWithCopy` 遇到 ` ```lang ` 围栏时查表——有插件
认领则交给 `PluginFenceBlock` **按需懒加载**该插件 bundle 并渲染（命中才下载，
与视图插件在 `syncPluginViews` 里常驻加载不同）；加载中/失败/返回 null 一律回退
普通代码块，绝不空白。epoch（plugins_reload）变化时清缓存并 `?e=` 重拉。

**注意**：renderer 是浏览器直接执行的裸 ESM，**不能 import npm 包**（无 bare
specifier 解析）。需要大依赖的插件自带打包 bundle（如 vscode-editor）或自带
vendor 本地加载（如 mermaid 插件 `vendor/mermaid.bundle.mjs`，本地优先、缺省回退 CDN）。


## 聊天正文装饰（`chatDecorations`）

> 「按内容模式上样式」（对话引号高亮、邮件正文里的地址/工单号…）不需要每个需求写一个插件，
> 也不用授整页 `dom` 权限：插件在 manifest 里**声明规则**，宿主统一注入。issue #956 评论里的
> 「内置输出正则」诉求就落在这里——产品内置的是「声明式规则 + 宿主执行」，不是用户可见的正则编辑器。

**形态**：`permissions: ["decorate"]` + `chatDecorations` 数组。规则字段：

| 字段 | 可选 | 说明 |
| --- | --- | --- |
| `pattern` | 否 | 正则源字面量，或 `{ "setting": "<text/select 设置>" }`（用户没填 = 静默不生效） |
| `flags` | 是 | 只允许 `gimsu`，自动补 `g` |
| `scope` | 是 | `assistant` / `user` / `all`（默认）：靠消息根的 `data-role` 分流 |
| `enabledBy` | 是 | 一个或多个 **boolean** 设置（AND）：实现总开关 + 分组开关；关掉的分组连正则都不编译 |
| `style` | 否 | `color` / `backgroundColor` / `fontWeight`，值可写 `{ "setting": "<key>" }` |

```json
{
  "permissions": ["decorate"],
  "settings": [
    { "key": "enabled", "type": "boolean", "default": true },
    { "key": "quotes", "type": "boolean", "default": true },
    { "key": "color", "type": "text", "default": "var(--accent)" },
    { "key": "custom", "type": "text", "default": "" }
  ],
  "chatDecorations": [
    { "id": "quotes", "pattern": "“[^”\\n]+?”", "flags": "gu", "scope": "assistant",
      "enabledBy": ["enabled", "quotes"], "style": { "color": { "setting": "color" } } },
    { "id": "custom", "pattern": { "setting": "custom" }, "enabledBy": ["enabled"],
      "style": { "color": { "setting": "color" } } }
  ]
}
```

**能力边界**：只支持 `color` / `backgroundColor` / `fontWeight`。不替换文本、不插 HTML，
所以复制、全局搜索、导出图片、TTS 读到的永远是原文；「格式化」这种会污染内容的能力**故意不做**。

**分层（一份实现，三个使用者）**：

| 层                              | 文件                                                                                    | 职责                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约 + 限额 + 编译 + 匹配       | `shared/chat-decorations.ts`                                                            | 纯函数（无 DOM / 无进程），服务端与浏览器共用；`compileChatDecorations()` 是**唯一语义阑门**（权限、正则合法性、样式白名单、设置引用、名字唯一性、总条数） |
| manifest 形状归一 + 面板告警    | `server/plugins.ts`（`normalizeChatDecorations`）、`server/plugin-manifest-validate.ts` | 只收形状（类型 / 条数 / 长度）；「声明了 decorations 但没有 `decorate` 能力」给一条 warning 进插件面板                                                     |
| 注入                            | `web/src/plugin-decorations.ts`                                                         | `useChatDecorations(enabledPlugins)` 在 App 挂一次；一个 `<style>` + 每规则一个 `Highlight`                                                                |

**作用域**：只装饰 `[data-chat-transcript]`（`MessageList` 的消息滚动容器）里的 `.md`；插件页、笔记等 markdown 不受影响。属性名与常量的一致性由 `tests/unit/plugin-decorations-dom.test.ts` 守着。

**协议**：`UiPluginInfo.chatDecorations` 是可选字段（纯加法，旧客户端忽略即可，`PROTOCOL_VERSION` 不升）；
设置改色后服务端 `pushToAll()` 重推 plugins 清单，客户端重新编译就生效，不用重载。

**实现要点（都是踩过的坑）**：

- CSS Custom Highlight API（`CSS.highlights` + `::highlight()`）：DOM 结构零改动——正文由
  React/ReactMarkdown 渲染且流式反复重写，拆文本节点会和它抢 DOM。
- 按块扫描（`p/li/blockquote/td/th/h1..h6`，嵌套块只扫最内层），跳过 `pre/code/kbd/samp/.codeblock`；
  Range 可跨行内标签（`**“引用”**` 照样整段命中）。
- `MutationObserver` + `rAF` 合批 + 每帧 6ms 预算：流式不停刷也不会占住主线程；旧 Range 重扫前统一回收。
- 样式声明直接来自编译产物；用户值已过 CSS 白名单（`{}` `;` `<>` 引号与 `url(` 全拒），`fontWeight`
  只认 CSS 关键字与百位数值；`secret` 类型的设置**永不**进 CSS（防凭据落进样式表）。
- 限额：单插件 ≤12 条、全局 ≤48 条、pattern ≤200 字符、每块命中 ≤200、flags 只留 `gimsu`（强制 `g`）。
- 浏览器没有 Highlight API（Firefox < 140）时静默降级：不报错、不空白、不影响正文。
- 禁用插件不生效（App 传的是已过滤的 `enabledPlugins`）。
- 整颗正文根被移除（切会话 / 卸载）时主动回收 Range，不把旧节点钉在内存里。

**示例**：内置插件 `plugins/chat-highlight/`（正文高亮）就是纯 manifest —— 11 组规则、零代码、零 `dom` 授权；
用户插件 `dialogue-color` 也能同样退化成「纯 manifest」。验证：`tests/unit/chat-highlight-plugin.test.ts`
（真 manifest → 真编译：分组、scope、颜色令牌、自定义正则、引用键都存在）。


## 前端集成

App 按 chat.plugins 动态 import 各插件的 client bundle（`/* @vite-ignore */`），TopBar 为每个插件加一个 🧩 tab（激活失败的置灰）；插件不共享 React 实例，与主应用只有 ctx.send/onData 两条窄通道。

### 插件 → 宿主动作桥（`window.__piWebUiHost`）

插件 bundle 是裸 ESM，import 不到应用模块；需要主应用配合的**动作**（不只是数据）走 `window.__piWebUiHost`：

| 字段                                                         | 说明                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                    | 宿主 API 版本（`PLUGIN_HOST_API_VERSION`，当前 **19**；插件可用它判断宿主能力）                                                                                                                                                                                                                                                                                                                                 |
| `setView(view)`                                              | 切主视图（`"chat"` / `"terminal"` / `"git"` / `"plugin:<id>"`）                                                                                                                                                                                                                                                                                                                                                 |
| `startChat({ prompt, newChat?, cwd? })`                      | 新建对话（可选切工作目录）并把 prompt 作为用户消息发出；返回"已受理"                                                                                                                                                                                                                                                                                                                                            |
| `compose({ text?, attachments? })`                           | 把内容放进**输入框草稿**（用户补一句话再自己发），返回是否受理。与 startChat 的差别：**不要求连接就绪**（草稿是本地状态）、输入框没挂载时拒收。实现走 `web/src/composer-bridge.ts` 的模块级 sink（草稿文本在 ChatInput 内部 state、待发附件在 App state，两处各自注册自己那一半）；合并语义复用 `composer-draft.ts`（空则填入、非空追加、绝不覆盖），附件按 path+mode+行区间去重                                |
| `openSession({ cwd?, folders?, roots?, prompt?, newChat? })` | 可等待的开会话：目录授权 + 多根工作区（见「项目 / 会话 API」）                                                                                                                                                                                                                                                                                                                                                  |
| `sessions.list()` / `sessions.open(id)`                      | 会话列表与打开：本客户端运行中的对话 + 当前项目的历史会话                                                                                                                                                                                                                                                                                                                                                       |
| `onUiAction(name, fn)`                                       | 接管 UI 条目的动作（slot 框架；旧名 `onTopbarAction` 保留为别名）                                                                                                                                                                                                                                                                                                                                               |
| `setFooterStatus(key, value)`                                | 往**宿主内置**的底栏状态槽（`host:cost` 那一格，斜杠接在「当前对话费用」后面）写一段文本；`value.content.render(container)` 可选 —— 给了它，点这段文字时**宿主**弹跟随浮层并把容器交给插件画内容（v18 起）：锚点、上下翻转、滚动跟随、点外/Esc 关闭、层级与主题全归宿主（`components/FooterSlotPopover.tsx` + `use-floating-panel`），插件不写 `position:fixed`、不抢 z-index。传 `null` 清槽（浮层一起消失）。 |
| `locale`                                                     | **宿主全局语言单源**（v19）：`locale.current()` 返回当前 locale tag（首次挂载即可读，不必猜 localStorage），`locale.onChange(fn)` 订阅切换。插件只维护自己的 ZH/EN 字典，用这个 tag 选词；**不得**保存独立语言偏好。旧名 `onLocale` 保留为别名。见「插件界面语言」                                                                                                                                              |
| `reloadCatalog(source, opts?)`                               | 插件市场目录同步（issue #148，见「插件市场」）                                                                                                                                                                                                                                                                                                                                                                  |

定义：`web/src/plugin-host.ts`（纯逻辑 `createPluginHostApi`，App 挂载时 `installPluginHostApi`）。
**时序坑**：服务端 `new_chat` 是异步的（`void cs.newChat()`），紧接着发 `prompt` 会落到旧对话，
所以 `startChat` 内部串行等：cwd 切过去 → 对话变空白/换新 → 才发 prompt（每步有超时，超时也发，不静默丢）。
现有用户：legado-web 插件的「🤖 AI 修复源 / AI 新建书源」按钮（阅读页与书源页一键把现场发给 AI 开新对话）。

`syncPluginViews(plugins, epoch)` 统一同步注册表：清单消失/被禁用即卸载视图（调 cleanup）、epoch 变化清 failed 重拉 bundle。

设置面板 ⚙ 有「界面插件」开关区（`set_settings.disabledPlugins`，持久化 client-state、纯 UI 隐藏不触发 runtime reload —— 被禁用的插件不算「界面布局」里的条目，它的贡献与 `arrange` 整份丢弃）+ **安装即启用**（`plugin_job` 的 `install` 作业成功后，服务端把该 id 从 `disabledPlugins` 摘掉再重推列表：出厂默认设置把一批可选插件写在禁用清单里，不同步启用就会出现「装好了但界面上找不到」；`update` / `uninstall` 不动这条状态，用户显式禁用过的插件升级后保持禁用——逻辑单源 `enablePluginAfterInstall()` @ `server/plugin-installer.ts`，写入点 `AgentService.enableInstalledPlugin()`）+ **每行「更新/卸载」按钮**（更新需 CLI install 记录的来源 `.pi-source.json` → `UiPluginInfo.source`；两个操作都走**服务端后台作业** `plugin_job`，见下「插件市场」，不占用户终端、不关设置面板）+「界面布局」页（内置条目与插件条目的隐藏 / 排序 / 恢复，见「UI 扩展点（slot 框架）」）+「已授权目录」段（见「目录授权与跨目录 fs」）。

### 插件界面语言（全局语言单源，issue #920）

插件**不保存自己的语言偏好**。界面语言只有一份事实源：宿主传到前端的 locale（`web/src/ui-locale.ts` → `useI18n().locale`），按下面两条使用：

| 位置                                                                | 怎么取值                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件名 / 描述（宿主渲染：顶栏 tab、插件菜单、设置面板、插件页错误） | manifest 同时写 `name`（中文）与 `nameEn`（英文）、`description` / `descriptionEn`；客户端统一走 `web/src/plugin-name.ts` 的 `pluginDisplayName()` / `pluginDisplayDescription()` 按 locale 选词。**不要在组件里直接读 `p.name`。**                                                                                     |
| 插件自画的界面（按钮 / 菜单 / 提示）                                | `createPluginI18n({ zh, en })`（SDK 0.4.0，`@pi-web-ui/plugin-sdk/client`）—— 一个 `t(key, vars)` + `onChange`，语言归一与回落全在 SDK 里；要自己实现时底线是 `window.__piWebUiHost.locale.current()` 取首帧、`locale.onChange(fn)` 订阅切换，插件自带 ZH/EN 字典，非中英宿主语言回落到英文。旧字段 `onLocale` 仍可用。 |

顶栏自动生成的插件视图条目（`<id>:__view`）由 `web/src/ui-slots.ts` 的 `withPluginViewItems()` 同时填 `label` / `labelEn`，渲染层按 `zh` 选词；插件自己贡献的 `ui.items` 仍用 `label` / `labelEn` 字段。

参考实现：`plugins/vscode-editor/src/client.js` 的 `hostLangRaw()` + `followHostLang()`（删掉了自带的语言开关）。

**SDK 侧的 `createPluginI18n`（issue #939）**：宿主 SDK 0.4.0 起在 `plugin-sdk/client.mjs` 导出 `createPluginI18n()`，实现见 `plugin-sdk/client-utils.mjs`：接受 `{ zh, en }` 或 locale tag 键名（也兼容 `createPluginI18n(zhDict, enDict)` 位置参数），返回 `{ t, lang, locale, current, onChange, destroy }`；`zh-CN` / `zh-TW` 都归一到 `zh`，其余语言回 `en`，缺词回落到另一语言的同名 key 再回落到 key，插值支持 `{x}` / `{{x}}` / `${x}`。这同时是那类线上事故的解法：插件代码比宿主新、却 import 了宿主没有的 SDK 导出时，浏览器直接 `SyntaxError: Importing binding name 'createPluginI18n' is not found`（服务端日志干净），守卫在 `tests/unit/plugin-sdk-export-contract.test.ts`（插件声明什么导出，宿主就必须真的有），行为守卫在 `tests/unit/plugin-sdk-i18n.test.ts`。

**设置 → 工具页不留写死文案**：三态标签、批量按钮、搜索框占位、插件兑底名一律走 i18n key，分类标题只由 `web/src/tool-inventory.ts` 的 `titleKey` / `subKey` 给出（渲染层不再按 id 另写一套标题），守卫在 `tests/unit/settings-tool-rows.test.ts`。


## 常驻播放器：红果短剧

`plugins/hongguo/` 将 [dsh-hongguo](https://github.com/frostming/dsh-hongguo) 移植到原生插件接口，支持搜索、选集、续播、自动连播以及悬浮 / 分屏切换。布局只使用 `dom.anchors().app`，同一个视频元素常驻，切换布局和对话不会重新加载视频。部署、FFmpeg、缓存及接口细节见 [红果短剧插件](plugin-hongguo.md)。

常驻 `preload: true` 客户端可在默认导出中提供 `dispose(): void`。`plugin-loader.ts` 在插件禁用、移除、报错、epoch 重载以及异步加载结果过期时调用它；插件应暂停媒体、取消请求 / 订阅、移除浮层并恢复布局。无此方法的旧插件继续按原协议加载。


## 静态服务

`GET /plugins/:id/client/*` 映射到插件目录的 client/ 子树（**只暴露这个子树**——manifest 与服务端 index.mjs 可能含凭据，绝不下载；id 校验 + resolve 前缀防穿越）。dev 模式 vite 已代理 /plugins。

前端动态 import 的 bundle URL 经 `web/src/base-url.ts` 的 `appUrl()` 加上应用根前缀
（nginx 子路径反代时页面在 /pi/ 下，请求会变成 `/pi/plugins/<id>/client/entry.mjs`），
子路径部署无需任何额外配置；根部署时行为与根路径完全一致。

### 特权 DOM 访问（`dom` 能力族）

slot 框架的原则是「插件声明、宿主渲染」——插件碰不到宿主外壳的 DOM。需要突破
这一层（往顶栏/输入框/任意位置挂原生 DOM、改样式、拦事件）的插件声明
`permissions: ["dom"]`，并走**用户授权**：

- 服务端在 `<dataDir>/plugin-dom.json` 记授权表（`server/plugin-dom.ts` 的
  `PluginDomConsent`，与目录授权表同口径：全局共享、坏文件当空表、变更才落盘）。
- 未授权时该插件的 client bundle 直接 **403**（`server/index.ts` 静态门禁经
  `PluginManager.isDomBundleBlocked` 判定）—— bundle 与页同源，JS 层面拦不住
  `document`，门只能放在下发处。未授权的插件在清单里带 `wantsDom: true` +
  `error` 置灰说明原因。
- 授权/撤销走 `plugin_dom_consent`（设置面板插件行上的「授权/撤销 DOM 访问」按钮，
  带 ⚠ 警示），服务端写表后 **epoch+1 重推清单**（浏览器丢旧模块缓存重拉 bundle）。
- 已授权的 bundle 可用 `window.__piWebUiHost.dom.anchors()` 拿稳定挂载点
  （`data-pi-anchor="app|topbar|composer"`，v7 引入，`web/src/plugin-host.ts`）——
  bundle 原生就有 `document`，anchors 只是跨版本稳定的查询入口，不用再猜类名。

设计取舍：限制的不是**能力**（授权后就是完整 DOM），而是**谁可以**——用户在设置面板
点一次头。服务端 `index.mjs` 本来就是完整 Node 可信代码，不在此门禁内。


## UI 扩展点（slot 框架，issue #146）

插件对宿主 UI 的贡献走**声明式挂载点（slot）**：插件只声明「有什么条目、想放哪儿」，渲染 / 排序 /
溢出 / 可访问性全部归宿主，**插件不碰 DOM**。契约在 `server/protocol.ts`（`UiSlotId` /
`UiContribution` / `UiArrangeOp` / `UiPluginUi` / `UiLayoutPrefs` / `UiSlotSpec`），服务端解析与运行时注册在
`server/plugins.ts`（`parseUiItem` / `parseUiContributions` / `parseUiArrange` / `UI_SLOTS` /
`UI_SLOT_ALIASES`），前端合并引擎是 `web/src/ui-slots.ts` 的 `buildUiSlots()`（纯函数，有单测）。

**失败不静默（DSH 对照 P0-1）**：`buildUiSlots(..., { diagnostics })` 可收集合并过程中的诊断
（未知 slot / 未知 kind / 宿主不认识的 `when` / arrange 目标不存在 / 同一插件重复声明同 id /
插件被禁用或激活失败），每条带 `pluginId` + `entryId` + `slot` 归因；不传 `diagnostics` 时行为
与原来**逐字一致**。App 把它们 `console.warn` 出来，设置面板「界面布局」页顶部同时渲染一个可
折叠横幅（`uiLayoutDiagTitle` / `uiLayoutDiagHint`）——以前这些情况是静默丢弃，表现为「注册了但
界面上没有」，最难排查。渲染层另配 `web/src/components/SlotErrorBoundary.tsx`：每个条目**独立**
包一层，某条目渲染抛错只丢它自己并就地置灰，不炸掉整条工具栏。

> 别和**插件视图 tab** 混起来：安装后出现在顶栏的 🧩 视图 tab（`plugin:<id>`）由 `plugins` 清单经
> `withPluginViewItems` 合成 `kind="view"` 条目（`<id>:__view`）后走 slot 框架，与宿主三连同流渲染
> （报错插件的 tab 由 TopBar 兜底置灰保留，因合并引擎会整份丢弃它的贡献）。

### 22 个挂载点

每个挂载点都有宿主定义的 `UiSlotSpec`：`cardinality` 为 `list` 时多个条目并列渲染，
为 `single` 时合并引擎按最终排序选出第一个可见条目，其余可见候选会被置为隐藏并产出布局诊断。
当前这 22 个已有挂载点全部是 `list`，因为它们都表达工具栏、菜单、tab 或页面入口的并列集合；
`modal.dialog` 的“同一时刻只开一个”是打开状态机约束，不是 slot cardinality。未来新增独占挂载点只需
在 `web/src/ui-slots.ts` 的 `UI_SLOT_SPECS` 标成 `single`，无需改变插件 manifest 形状。

| slot                         | 位置                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `topbar.primary`             | 顶栏主栏（与内置 tab 同排；单一扁直流，见下方“顶栏平铺化”）                                                                                                                                                                                                  |
| `topbar.overflow`            | 顶栏溢出菜单（被隐藏的条目＋直接声明在这里的常驻条目）                                                                                                                                                                                                       |
| `bottombar`                  | 底栏（连接状态 / 上下文 / 成本那一条）                                                                                                                                                                                                                       |
| `composer.leading`           | 输入框前置区（文件上传按钮左侧，纯插件新增位）                                                                                                                                                                                                               |
| `composer.actions`           | 输入框动作区（上传按钮右侧到发送按钮之间）                                                                                                                                                                                                                   |
| `message.actions`            | 每条消息 hover 时的工具条                                                                                                                                                                                                                                    |
| `rightpanel.tabs`            | 右栏 tab（默认是文件树 + 源代码管理）                                                                                                                                                                                                                        |
| `bottomdock.tabs`            | 底部面板 tab（默认是终端；标签 >1 时才出现标签条）                                                                                                                                                                                                           |
| `contextmenu.topbar`         | 顶栏条目右键菜单                                                                                                                                                                                                                                             |
| `contextmenu.message`        | 消息右键菜单                                                                                                                                                                                                                                                 |
| `contextmenu.session`        | 左栏会话右键菜单                                                                                                                                                                                                                                             |
| `contextmenu.file`           | 文件树条目右键菜单                                                                                                                                                                                                                                           |
| `contextmenu.search`         | 全局搜索（Ctrl+K）结果行右键菜单（`target.kind` 为 `session` / `project` / `file` / `folder` / `plugin`；`when` 可用 `search.isSession` 一类判据）                                                                                                           |
| `contextmenu.toolcall`       | 工具调用卡片的**工具名**右键菜单（宿主唯一菜单；内置一条「显示工具详细信息」，见 `ToolInfoDialog.tsx`）                                                                                                                                                      |
| `contextmenu.bot`            | 左栏「智能体」Bot 行右键菜单（`target.kind="agent-bot"`；宿主条目：私聊 / 引用到对话 / 编辑 / 设备中心管理 / 记忆 / 复制 ID，见 `AgentBotsSection.tsx`）                                                                                                     |
| `settings.pages`             | 插件自定义页：声明几页就在「设置 → 插件 → 安装的插件 → 详情」里占几个标签（懒挂载，`ctx.page` = 该页 itemId；`hidden: true` 不进导航，界面布局里可再隐藏/排序）。没声明页但带 `client/entry.mjs` 的插件退回一个通用「插件页」标签（`ctx.page` 为 undefined） |
| `leftpanel.projects.actions` | 左栏「最近项目」标题栏按钮（宿主「管理项目」按钮之后追加；无条目不画）                                                                                                                                                                                       |
| `leftpanel.project`          | 左栏项目行内嵌区（项目名旁的徽标 / 快捷按钮；点击回传 `target={id: 项目路径, kind: "project"}`）                                                                                                                                                             |
| `leftpanel.running.actions`  | 左栏「运行的对话」标题栏按钮                                                                                                                                                                                                                                 |
| `leftpanel.history.actions`  | 左栏「历史对话」标题栏按钮（宿主「新对话」按钮之后追加）                                                                                                                                                                                                     |
| `contextmenu.project`        | 左栏项目行右键菜单（`target.kind="project"`；无可见条目时不抢浏览器右键）                                                                                                                                                                                    |
| `leftpanel.running`          | 左栏「运行的对话」行内嵌区（只在运行行上出现；与 leftpanel.sessions 并集）                                                                                                                                                                                   |
| `leftpanel.history`          | 左栏「历史对话」行内嵌区（只在历史行上出现；与 leftpanel.sessions 并集）                                                                                                                                                                                     |
| `leftpanel.sections`         | 左栏三个分区的顺序与显隐（**仅宿主条目** `host:lp-*`；插件不能往里放条目，只能 arrange 隐藏）                                                                                                                                                                |
| `leftpanel.sessions`         | 左栏会话行内嵌区（会话标题旁的徽标 / 快捷按钮）                                                                                                                                                                                                              |
| `chat.header`                | 对话头部条（标题旁的操作区）                                                                                                                                                                                                                                 |
| `chat.empty`                 | 空对话占位区（新对话的快捷入口）                                                                                                                                                                                                                             |
| `file.preview.toolbar`       | 文件预览工具条                                                                                                                                                                                                                                               |
| `terminal.toolbar`           | 终端工具条                                                                                                                                                                                                                                                   |
| `scm.toolbar`                | SCM 面板工具条                                                                                                                                                                                                                                               |
| `goalbar.actions`            | 目标条动作区                                                                                                                                                                                                                                                 |
| `notice.actions`             | 通知条动作区（notice 上的快捷按钮）                                                                                                                                                                                                                          |
| `tasks.panel`                | 「后台任务」面板（BgTasksModal）内容区：kind=`view` 的条目就地内嵌插件 bundle（同 `settings.pages` 的挂载口径），其余 kind 当动作按钮；宿主自己 diff 出来的后台进程仍走该面板原生列表                                                                        |
| `modal.dialog`               | 弹窗（`modal` 可简写；kind=`view` 的条目经宿主桥 `openModal` 按需打开，`closeModal` 关闭；同一时刻只开一个）                                                                                                                                                 |

**自然简写**（`UI_SLOT_ALIASES`：解析时映射成完整名，让作者少踩坑）：`topbar`→`topbar.primary`、
`topbar.more`→`topbar.overflow`、`composer`→`composer.actions`、`message`→`message.actions`、`modal`→`modal.dialog`、
`rightpanel`→`rightpanel.tabs`、`bottomdock`/`bottompanel`→`bottomdock.tabs`、`settings`→`settings.pages`。没有别名的（`bottombar`、`composer.leading`、`tasks.panel` 与五个
`contextmenu.*`）必须写完整名；认不出的 slot 直接丢掉该条目（不报错、不崩）。`arrange` 的目标 slot
只接受完整名（不走别名）。

### manifest 里怎么写

```json
{
	"permissions": ["ui"],
	"ui": {
		"topbar": [
			{
				"id": "inbox",
				"label": "收件箱",
				"labelEn": "Inbox",
				"icon": "📬",
				"kind": "action",
				"action": "webmail:open-inbox",
				"group": "mail",
				"order": 10
			}
		],
		"contextmenu.file": [{ "id": "send", "label": "发到邮箱", "action": "webmail:send-file" }],
		"settings": [{ "id": "mail", "label": "邮箱", "icon": "📬" }],
		"arrange": [{ "id": "host:github", "hide": true }]
	}
}
```

两种形状都收：按 slot 分组（推荐，见上）或平铺 `{ "ui": { "items": [{ "slot": "...", ... }] } }`
（与运行时 `host.ui.register` 入参同形，两边复用同一套解析）。整份贡献共享一个 **32 条**上限、
`arrange` 上限 64 条；非法条目 / 重复 id / 认不出的 slot 静默丢弃（宽容但不放任：坏字段跳过，不因为
一条脏数据丢掉整份贡献）。

> 兼容性：这一版之前（同一 issue 的第一稿）的顶层 `manifest.topbar` 字段**已不再解析** —— 现在写
> `manifest.ui`（别名 `ui.topbar`）。保留兼容的只有宿主动作桥的旧名 `host.onTopbarAction`
> （= `onUiAction` 的别名，见「插件 → 宿主动作桥」）。

### 条目字段（`UiContribution`）

`id`（插件内唯一，须匹配插件 id 字符集；**全局 id = `<pluginId>:<id>`**，用户偏好与 `arrange` 的 key
就是它）、`label`（中文界面文案）+ `labelEn`、`icon`（emoji/单字符，或宿主图标词表里的名字）+ `iconSvg`（内联 SVG，有则优先于 `icon` 渲染）、
`hint` / `hintEn`（悬浮提示，落成渲染层的 `title` —— 只给一种语言时另一种回落它）、`kind`、`children`、
`order`（缺省 100，小的靠前）、`group`（同组连续排布）、`hidden`、`action`、`view`、`when`、`badge`。
文本字段会截断（label 60 / icon 16 / hint 200 字符）。

**kind 词表**：`view` | `action` | `badge` | `menu` | `page` | `organizer` | `divider` | `toggle` | `input` | `progress` | `select`（缺省 `action`；
`slot == "settings.pages"` 时缺省 `page`）。语义：`view` 切视图（`view` 缺省 `plugin:<id>`）；`action`
点击回给插件（经 `host.onUiAction`）；`badge` 只显示状态文本/角标（可经 `host.ui.update` 刷新）；
`menu` 展开 `children`；`page` 是插件详情里的一页（`settings.pages` 声明页，标签直接显示该页 label）；`divider` 分隔线；`organizer` 是整理器（词表里
保留的种类，当前各渲染层没有专门处理）；`toggle` 开关（`checked`，点击回插件）、`input` 单行输入
（`value`，回车回插件时附带输入值）、`progress` 进度条（0-100，只展示）、`select` 下拉（`options` 候选 +
`value` 当前值，切换回 `onUiAction(itemId, value)`）。`select` 全槽位可画：顶栏/输入框/消息工具条/
终端-SCM-目标条共享工具条/底栏/左栏会话行/通知条落成原生下拉，右键菜单展开成子菜单（点选子项回
父条目 + value，见 `expandSelectEntries`），右栏 tab 按既有口径当 tab 打开（与 toggle/input 一致）。

**`children` 只一层**：解析时子项自己的 `children` 被清掉（防嵌套），子项也没有稳定的全局 id ——
所以子项**不参与** `arrange` 与用户偏好。当前实现里只有**右键菜单**把 `children` 画成子菜单
（`ContextMenu.tsx`），其它槽位只画父条目。

**`when`**：宿主上下文条件，宿主不认识的值直接忽略、不报错。当前只有右键菜单评估它
（`web/src/context-menu-state.ts` 的 `evaluateWhen` + `buildWhenContext`，`ContextMenu.tsx`
按槽位 + 被右键对象现场构造上下文）：字面量 `"disabled"` / `"never"` 恒置灰、`"always"` 恒可用、
以 `!` 开头的条件（如 `"!message.hasSelection"`，有上下文按上下文判、无上下文按 legacy 直接置灰），
以及肯定形适用条件 —— `file.isDir` / `file.isFile`（文件菜单，按 target.kind）、`session.isRunning`
（会话菜单）、`message.hasSelection`（消息菜单）、`search.isSession` / `search.isProject` / `search.isFile` /
`search.isFolder` / `search.isPlugin`（全局搜索菜单，按 target.kind）—— 为假则**保留但置灰**。未知条件名默认可用
（未来加新条件不翻旧插件）。

### 合并优先级（四级）与「同一份计算」

每个 slot 的最终条目都由 `buildUiSlots(plugins, { locale, t, disabledPlugins, layout })` 算出：

| 层         | 来源                                                                                                                                                                                                                                                   | 规则                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 宿主默认 | `BUILTIN_UI_ITEMS`（**119** 条 `host:*` 内置条目，覆盖 **13** 个 slot：顶栏 18 / 文件右键 27 / SCM 工具条 12 / 底栏 10 / 文件预览头栏 9 / 目标条 8 / 输入框动作 7 / 会话右键 6 / 消息工具条 5 / 终端工具条 3 / 搜索右键 10 / 左栏分区 3 / 右栏 tab 1） | 可见性、顺序、分组、文案的基线                                                                                                                       |
| 2 插件贡献 | `UiPluginInfo.ui.items`                                                                                                                                                                                                                                | 同 id 后声明的插件覆盖前面的（**位置仍按首次声明**，避免重声明把条目挤到列表尾部）；报错插件与「界面插件」里被禁用的插件整份丢弃                     |
| 3 插件安排 | `ui.arrange`（可改 `slot` / `hide` / `group` / `order` / `label` / `hint` / `icon` / `iconSvg`）                                                                                                                                                       | 只能改**已存在**的条目（目标不存在 = 静默忽略）；改了别人的条目会记进它的 `arrangedBy`（含 `movedFrom`）—— 这是「插件不许偷偷改宿主 UI」的可见性保障 |
| 4 用户偏好 | `settings.uiLayout`（`UiLayoutPrefs`：`hidden` / `shown` / `order` / `groups` / `labels`）                                                                                                                                                             | 最高：用户点过什么就由它最后说话；`shown` 在 `hidden` 之后应用（「显示」是对上一次隐藏的撤销，必须生效）                                             |

同 order / 无排序信息时保持声明顺序（稳定排序兜底）。**「同一份计算」是这套框架的核心不变量**：渲染层
（TopBar / FooterBar / ChatInput / Message(List) / RightPanel / LeftPanel / SettingsModal）与设置面板
「界面布局」页跑的是同一个 `buildUiSlots()` —— 布局页里看到的顺序 / 分组 / 文案就是界面上生效的，所以那页
能逐条隐藏（勾选框）、↑/↓ 调序、单条「恢复」与「全部恢复默认」，并给被插件改过的条目标一个「插件调整过」
（`arrangedBy`）。恢复只撤**用户偏好**（插件 `arrange` 的意图仍生效，要连它一起撤就禁用插件）；条目上的
`source` / `userOverrides` / `arrangedBy` / `movedFrom` 就是布局页用来解释「这条是谁挪走的」的依据。

**文案（`labels`）的落地规则**：`UiSlotEntry.label` 分两类 —— 宿主内置默认（`t(labelKey)`）与**显式指定**
（用户在布局页改名 / 插件 `arrange.label` / 插件自己声明的条目）；后者会置 `UiSlotEntry.labelExplicit`。
渲染层必须看这面旗：内置条目一直画的是自己写死的 i18n 文案与实时数值（顶栏按钮、底栏数值徐标），只有
`labelExplicit` 立着时才让位 ——名字型条目（视图三连 / 搜索 / 插件条目…）用用户文案顶掉内置文案；数值型
（上下文 / 成本 / 缓存 / 消息数 / 连接态…）把名字插在数值前，**不吞掉实时数据**（`BarItem` 里的 `named()` /
`withName()`）。没置旗时渲染结果与旧版逐字节一致，所以「插件的 label 与用户的改名对内置条目也真的生效」
（issue #555；回归：`tests/unit/bar-item-unified.test.ts`、`tests/ui-layout-ui-test.mjs`）。

### 溢出与隐藏

只有**顶栏**有溢出概念：主栏本身不限量（与底栏同款直排，窄屏横滑/桌面端换行），被 `hidden` 的条目、
以及直接声明在 `topbar.overflow` 的常驻条目进「⋯」溢出菜单 —— 也就是说插件能把宿主内置入口从主栏挪走，
但它在溢出菜单与布局页里都还在，用户点一下布局页的「恢复」就能拿回原位（插件能整理一切，却锁不死用户）。
其它槽位没有溢出：`hidden === true` 就是不显示（右键菜单连菜单项都不生成）。布局页按 22 个挂载点全量分组
（`SettingsModal.tsx` 的 `uiLayoutSections`，与 `SLOT_IDS` 同顺序——两边都严格按实际界面的 DOM/视觉顺序排：
顶栏 → 通知 → 左栏 → 主列 → 右栏 → 终端/Git 视图 → 底栏 → 悬浮层 → 右键菜单 → 设置页 → 对话框；搜索框可过滤，
搜索时 ↑↓ 禁用）。顶栏 / 底栏 / 输入框动作区在界面上按对齐段（左 start → 中 center → 右 end）分段渲染，
布局页同口径按段列出（段头即界面上的段），↑↓ 只在段内移动，换段走对齐下拉。左右停靠栏
（`sidebar.left` / `sidebar.right`）同口径但轴是**竖的**：start=靠上 → center=居中 → end=靠下，
布局页的段头与对齐下拉用「靠上/居中/靠下」措辞（同一套取值、同一份 `uiLayout.align` 偏好）。

**宿主内置条目同样受这些规则管**（这是「设置里看到的 == 界面上看到的」这条不变量的关键一半）：

| 位置                                                         | 渲染方式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 隐藏 / 调序的效果                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶栏全条目（品牌/历史/文件/新对话/视图三连/插件视图/工具组） | `TopBar.tsx`：**单一扁直流** —— 所有条目都是 `.topbar-flow` 的直接子节点（无任何按种类包裹的容器，也无两端贴边例外），宿主查 `hostNodes` 节点工厂、插件通用渲染（插件视图经 `withPluginViewItems` 合成 `kind="view"` 条目），`align` 只决定落两个 `.tb-spacer` 划出的 start/center/end 哪一段                                                                                                                                                                                                                      | 勾掉 → 从主栏消失并进「⋯」溢出菜单（点回仍可用）；↑↓ 换位置；align 搬分区 —— 三者对**每一个**条目生效；**菜单型条目（声音/语言/主题/版本/GitHub/浏览器）整块组件搬进菜单**（不是只剩一个点了没反应的标题）；**桌面与手机同一份数据**：宽度放不下的条目按视觉顺序从尾部退进同一个「⋯」（`web/src/topbar-fit.ts` 实测宽度），旧版手机端那套 CSS 整组隐藏 + 硬编码「⋯」面板已删 |
| 底栏                                                         | 按 slot 顺序从 `bottombarItems` 渲染（`FooterBar.tsx`），左/中/右三区按 `align` 落位                                                                                                                                                                                                                                                                                                                                                                                                                               | 勾掉 / ↑↓ / 对齐三者都生效                                                                                                                                                                                                                                                                                                                                                   |
| 输入框动作区（`composer.actions`）                           | `ChatInput.tsx`：宿主 7 项（上传/模板库/模型/思考/DSH 权限/预设/发送簇）＋插件按 slot 顺序交错渲染                                                                                                                                                                                                                                                                                                                                                                                                                 | 勾掉 / ↑↓ / 对齐三者都生效（发送簇 `align=end` 落右侧；藏掉发送后回车仍可发送）                                                                                                                                                                                                                                                                                              |
| 输入框前置区（`composer.leading`）                           | `ChatInput.tsx` 按 slot 顺序渲染在上传按钮左侧                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 勾掉 / ↑↓ 都生效（纯插件位，无内置条目）                                                                                                                                                                                                                                                                                                                                     |
| 消息 hover 工具条                                            | `Message.tsx` 跳过 `hidden` 的条目                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 全被隐藏 → 整条容器都不画（不留空壳）                                                                                                                                                                                                                                                                                                                                        |
| 左右停靠栏（`sidebar.left` / `sidebar.right`）               | `SideDock.tsx`：`align` 读作竖轴（start=靠上 / center=居中 / end=靠下），三段各画一颗**内容高**的贴边药丸（空段不画底、也不吃点击），弹性格子把停靠栏撑满整列                                                                                                                                                                                                                                                                                                                                                      | 勾掉 / ↑↓ / 对齐三者都生效；折叠按钮**只在悬浮模式**出现（流内收起省不下宽度），收起后只剩一个展开小按钮。回归 `side-dock-align-ui-test.mjs`                                                                                                                                                                                                                                 |
| 右栏 tab                                                     | `RightPanel.tsx` 按 slot 顺序渲染（含内置「文件」tab 的位置，不再固定第一）                                                                                                                                                                                                                                                                                                                                                                                                                                        | 勾掉（含内置「文件」tab）/ ↑↓ 都生效                                                                                                                                                                                                                                                                                                                                         |
| 左栏分区（最近项目 / 群组；运行的对话与历史已并入项目树）    | `LeftPanel.tsx` 按 `web/src/left-sections.ts` 的计划渲染：顺序与显隐走宿主 `leftpanel.sections` 的条目（`host:lp-projects` / `host:lp-groups`，布局页可勾选 / 调序；插件 arrange 可隐藏，不能挪走）。`host:lp-running` / `host:lp-history` 两个条目仍在注册表里（`leftpanel.running` / `leftpanel.history` 行内插槽与插件 arrange 兼容用），但 `sectionNodes` 的 `convs` / `sessions` 恒为 `null` —— 运行中与历史会话都在「最近项目」树内按时间分组渲染，所以这两条不再进布局页（`HIDDEN_FROM_LAYOUT_ITEM_IDS`）。 | 勾掉 → 整区不渲染、不占权重；上下调序生效（分隔条按可见分区重新配对）。左栏不再有「项目 / 群组」tab：智能体、群组两块与项目树同层排开，群组块跟 `host:lp-groups` 的显隐走（勾掉就整块不渲染），且一条群组都没有时不占位。                                                                                                                                                    |
| 文件预览头栏                                                 | `FilePreview.tsx` 的 `.fp-head-actions`：宿主 9 项＋插件按 slot 顺序交错                                                                                                                                                                                                                                                                                                                                                                                                                                           | 勾掉 / ↑↓ 都生效（markdown/html/编辑/换行/缩放仍受文件类型条件约束）                                                                                                                                                                                                                                                                                                         |
| 目标条                                                       | `GoalBar.tsx`：编辑行（设目标/提炼/锁定/收起）/ 选项行（审查模型/轮次）/ 活跃行（清除）/ 收起 pill 四簇分别按 slot 排序，插件跟随同行                                                                                                                                                                                                                                                                                                                                                                              | 勾掉 / ↑↓ 都生效（pill 全藏且无插件条目时整条不占位）                                                                                                                                                                                                                                                                                                                        |
| SCM 面板                                                     | `SCMPanel.tsx`：头栏（视图 tab/刷新＋插件）与分支行（分支/切换/推送/拉取/提交输入/提交/全部提交）分别按 slot 排序                                                                                                                                                                                                                                                                                                                                                                                                  | 勾掉 / ↑↓ 都生效（分支名展示是纯信息不进槽位；底部「去终端」按钮只跟显隐）                                                                                                                                                                                                                                                                                                   |
| 终端面板                                                     | `TerminalPanel.tsx`：命令列表头（刷新/新建）与终端 tab 头（新建＋插件）分别按 slot 排序                                                                                                                                                                                                                                                                                                                                                                                                                            | 勾掉 / ↑↓ 都生效（命令/标签行是数据，不动）                                                                                                                                                                                                                                                                                                                                  |

顶栏还支持**直接拖拽换位**（issue #920）：用的是 Pointer 事件（不是 HTML5 DnD，触屏同样可用 —— 见 `docs/agent-rules.md`「拖拽与触控交互标准」）。桌面按住移动过 6px 即拖；触屏先长按 420ms 再拖（未长按就滑动视为滚动，不抢手势）。拖到同 `align` 分区内另一条目前/后松手，等价于布局页的 ↑↓ —— 落点写回 `uiLayout.order`（`TopBar.tsx` 复用 `applyIconDrop` 生成同一份偏好，随即 `set_settings` 持久化），刷新后保持。

停靠栏里的宿主按钮走**同一份回调**：`SideDock` 不再逐个手抄 `BarItem` 的 props，而是把 `BarHostProps`（App 里的
`sidebarBarProps`）整份透传给 `BarItem`。漏传的回调会在 `onClick={() => cb?.()}` 处**静默变成空操作**——沙箱、打开项目
的按钮一旦被布局编辑挪进 `sidebar.left` / `sidebar.right` 就画得出来、点下去没反应（“沙箱按钮放侧边就失效”的来历）。
同理，项目选择器与沙箱弹窗都是 App 里挂的单实例（顶栏 chip / 停靠栏条目 / cwd chip 打开同一个），
不在各渲染点各自 `useState`。守卫：`tests/unit/side-dock-host-callbacks.test.ts`。

顶栏没有结构性容器划分：整条按 slot 顺序直排（连续同类才成组裹容器，组间顺序即 slot 顺序），布局页的 ↑↓ 跨
品牌/视图/工具真实换位（默认顺序号即旧版视觉顺序：history 锁扣首位、new-chat/files 工具组之尾，见
`BUILTIN_UI_ITEMS` 注释）。面板内部同理按簇划分（SCM 头栏↔分支行、终端双头、目标条四态各行、左栏纵向分区）。
`uiPrimary` 完全没传时（单测 / 未来别的调用方）渲染层退化为「按内置默认顺序全画」，不会因为拿不到 slot 数据就把顶栏清空。

### `host.ui.*`：运行时注册

| 方法                | 语义                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `register(items)`   | 注册 / 覆盖条目（同 id 覆盖 manifest 声明的，单次最多 32 条），返回注销函数（把本次注册的 id 移进 `removed`）                           |
| `update(id, patch)` | 部分更新一个**当前生效**的条目（manifest 的与运行时注册的都算；不存在的一律忽略，防插件凭空造条目绕过声明审查），典型用途是刷新 `badge` |
| `remove(id)`        | 移除条目 —— manifest 声明的也能移除（id 记进 `removed`，合并时不会复活，直到 reload 重新解析）                                          |
| `arrange(ops)`      | 追加整理意图（与 manifest 的 `arrange` 顺序拼接），只改已存在的条目并留痕 `arrangedBy`                                                  |
| `list()`            | 当前生效的贡献快照 `{ items, arrange }`（调试 / 自查用）                                                                                |

生效结果 = manifest 基线 + 运行时注册（同 id 覆盖、`removed` 删除），随 `plugins` 清单的
`UiPluginInfo.ui` 下发；每次 `register` / `update` / `remove` / `arrange` 都重推一次清单。注册时的 slot
解析与 manifest **同一套口径**（先映射别名、再校枚举）—— 早期运行时注册少了这一层校验，插件写个别名
（或写错）会得到一个前端不认识的 slot，表现为「注册了但界面上没有」，最难排查。

### 内置条目的实现留在组件里（踩过的坑）

App 只分发**插件**动作（`triggerPluginUiAction`：先找该插件名下的处理器，再按需加载它的 client bundle
后重试，都没人接管就提示一句）；`host:*` 内置条目的实现住在渲染 / 打开它的那个组件里，由组件按
`entry.id` 自己分派 —— 例如 `host:file-add-root` / `host:file-open-project` 在 `RightPanel.tsx`、
`host:conv-force-dismiss` 在 `LeftPanel.tsx`、`host:msg-edit-reask` 在 `Message.tsx`。原因：这些动作
需要组件自己的上下文（右键的是哪个目录、哪条对话、消息的附件与重问逻辑），App 拿不到。右键菜单因此还
要在打开时把「host 条目分派器」（`onHostAction`）随请求交给 `web/src/context-menu-state.ts` 的全局唯一
菜单状态。**踩过的坑**：早期把内置条目也当插件动作统一交给 App 分发，那些点击全都没反应（App 不知道
上下文，只能静默失败）。

### 弹窗（`modal.dialog`）

第 22 个槽位：插件声明 `kind="view"` 的条目，经宿主桥按需弹成弹窗（`PluginModal.tsx`）。

```json
{
	"permissions": ["ui"],
	"ui": {
		"modal": [{ "id": "preview", "label": "预览", "kind": "view", "view": "plugin:my-plugin" }]
	}
}
```

```js
// client/entry.mjs：某个按钮点一下弹自己的弹窗，关由用户（Esc/遮罩/✕）或 closeModal()
window.__piWebUiHost.onUiAction("my-plugin:open", () => {
	window.__piWebUiHost.openModal("my-plugin:preview");
});
```

- 开关走宿主桥 v10（`openModal(id)` / `closeModal()`）：id 是全局 id（`<pluginId>:<itemId>`），
  不存在 / 被用户在布局页隐藏 → 返回 `false`；同一时刻只开一个（后来者顶掉先开者）。
- 内容按 kind 分发：`view` 挂插件视图（bundle 按需加载，没好先转 loading，与顶栏动作同一条
  `ensurePluginViewLoaded`）；其它 kind 落成单个大按钮（点了回 `onUiAction` 并关弹窗）。
- 开关状态是浏览器本地态（不进快照、不进 layout）：刷新即关；`hidden` 只管“能不能开”。
- 布局页有独立“弹窗”分组（可隐藏条目；排序无意义——弹窗一次只开一个）。



