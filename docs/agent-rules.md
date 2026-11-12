# 编码红线细则（原 AGENTS.md §9 全文）

> `AGENTS.md` 只保留「功能 → 事实源文件 → 文档」的映射与一行红线索引；**细则全在这里**。
> 改代码前按主题跳到对应章节，改完跑该条标注的守卫测试。

本文件收纳的章节：

- [一、通信协议与数据安全](#一通信协议与数据安全)
- [二、工具定义与提示词规范](#二工具定义与提示词规范)
- [三、UI 布局与样式规范](#三ui-布局与样式规范)
- [四、架构与运行态约束](#四架构与运行态约束)
- [五、其余边界（只在别处维护，见链接）](#五其余边界只在别处维护见链接)
- [六、源码注释](#六源码注释)

以下规则由历史线上问题与核心架构硬约束提炼而成，编写代码时必须严格遵守。

## 一、通信协议与数据安全

- **`details` 字段硬限制 ≤64KB**：下发与持久化会超限整包丢弃。新工具严禁塞入大块原始数据（参照 `present-files-tool.ts` 做摘录预算）；前端渲染必须支持无 details 降级（`present-items.ts`）。
- **服务端 URL 必须包裹 `appUrl()`**：包括 `/ws`、`/api/*`、`/plugins/*`、`/themes/*`，杜绝反向代理子路径部署时 404。
- **Token Cookie 校验前必须解码**：`pi_web_token` 经 `encodeURIComponent` 存储，服务端读取必须先 `decodeCookieToken` 再校验（`server/auth-cookie.ts`）。
- **工作区严禁使用家目录根**：禁止设置 `$HOME` 为工作区根，防止递归扫描坏挂载造成事件循环卡死。
- **远期定时器必须使用 `armDelay` 分片**：Node.js 中 `setTimeout` 超过 2^31-1 毫秒（约 24.8 天）会整型溢出被截断为 1ms 从而引发死循环。超过 6 小时任务必须分片（守卫：`plugin-cron-overflow-test.mjs`）。
- **文本解码与行号统计规范**：预览与附件统一使用 `decodeText`（UTF-8 → GBK → latin1）；`countLines` 不计末尾空行，前端需 pop 末尾空串。详见 [`architecture-attachments.md`](architecture-attachments.md)。

## 二、工具定义与提示词规范

> 与 [`development.md`](development.md)「编码约定」、[`tool-context-budget.md`](tool-context-budget.md) 互补：本节是**禁令视角**，那两处是工作原理。

- **工具提示词三处职责分离（严禁跨处复述）**：
  1. Tool Schema 的 `description`：仅描述「做什么与边界」，≤600 字符；
  2. 系统提示词中的 `promptSnippet`：仅写「何时触发」，≤80 字符，不带工具名前缀；
  3. `Guidelines` 段落的 `promptGuidelines`：仅写「调用顺序/禁令/跨工具路由」。
     _必须使用精炼纯英文，违规会被守卫单测拦截_（守卫：`tests/unit/tool-prompt-hygiene.test.ts`）。`bash` / `edit` 的模型可见文案单源在 `server/tool-prompts.ts`。
- **编辑能力只有一个工具名**：宽松匹配是 `edit` 的参数 `soft: true`（`server/edit-tool.ts`），**禁止**再新增 `edit_soft` 这类第二个编辑工具：同名能力拆成两个工具会逼模型二选一，并把开关、提示词、审批规则三处联动凭空翻倍。旧存档里的相关开关只需在归一化里折算，不留运行时分支。
- **工具延迟加载硬约束：绝不破坏前缀缓存**：
  供应商 Prompt Cache 依赖系统提示词前缀完全一致。系统提示词 `{{tools}}` 目录必须保持完整且不随已加载状态变化；新加载工具的要点随 `load_tools` 回执进入对话；注册表仅允许追加（`toolsAdded`），严禁就地修改或删除（守卫：`tests/lazy-tools-test.mjs`，文档：[`tool-context-budget.md`](tool-context-budget.md)）。
- **单工具多执行路径必须提示词单源**：以 bash 为例，原生、终端和自适应分流路径共用 `server/tool-prompts.ts`，禁止在 execute 覆盖实现中硬编码或复制描述。
- **bash / powershell 的默认超时单源在 `server/bash-timeout.ts`**：模型漏传 `timeout` 时按 `DEFAULT_BASH_TIMEOUT_SEC`（120s，`PI_WEB_BASH_TIMEOUT_SEC` 可改）执行，过大值夹到 `MAX_BASH_TIMEOUT_SEC`（1 小时）—— 不得退回「无超时」只等会话看门狗（默认 20 分钟）收尸。三条执行路径（`bash-tool.ts` 本地/SSH、`terminals.ts` 终端接管、`agent-service.ts` 的 powershell）必须都过 `withDefaultBashTimeout()`，禁止各处另写数值或把 `0` 当「不限」（SDK 对 0/负数直接抛 `Invalid timeout`）（守卫：`tests/unit/bash-timeout.test.ts`）。
- **Schema 只写字段名与类型**：导出的 JSON Schema 里不放 `minItems` / `maxItems` / `minimum` / `maximum` / `minLength` / `anyOf` 这类装饰约束，也不给自解释的字段写 `description`；约束校验搬到 handler（`readArguments` 一类），候选值写 `enum`，每个参数能填什么写在该参数的**唯一**一句签名里（`communicate`、`browser_page` 的 `action`/`op` 就是范例）。少数确实不自解释的字段（`read.offset`、`bash.persist`、`edit.soft`、`present_files.items[].focus`、`skill.name`）才留一句短说明。SDK 自带但文案归我们的 `write` / `grep` / `find` 用 `withSlimPrompt()` 在 `server/tool-prompts.ts` 里换文案与 schema，实现仍走 SDK（守卫：`tests/unit/tool-schema-slim.test.ts`，它同时比对字段名与 SDK 内置定义，SDK 增删参数会直接报红）。
- **工具关闭只有一个漏斗**：`disabledAgentTools`（开关）与 `toolOnDemandTools`（按需列表）都由 `effectiveDisabledAgentTools()` 取并集，只做减法、不产生第二条门控路径；禁止为新开关另写一套 `setActiveTools` 过滤（守卫：`tests/unit/tool-manager.test.ts`「按需列表」用例）。
- **新增工具三处联动**：新增可开关工具必须同时登记到 `tool-manager.ts`（`AGENT_TOOL_CATALOG` 事实源）、`agent-service.ts`（`customTools` 列表）以及 `tests/unit/tool-registration.test.ts`；内置工具覆盖必须走 `tool-overrides.ts`。
- **逐工具文案可编辑机制**：用户自定义文案仅作为偏好存入 `toolPromptOverrides`，新增可配置维度必须同步打补丁逻辑、wire 协议与设置页编辑器三处（守卫：`tests/unit/tool-prompt-overrides.test.ts`）。

## 三、UI 布局与样式规范

> 共享基线是 `web/src/styles.css`；主题见 [`architecture-core.md`](architecture-core.md)「主题切换」。

- **项目选中态只跟随当前打开的项目**：运行中、未读状态通过项目徽标表达，不得为其他项目标题添加状态底色；保留普通悬停反馈。

- **CSS 变量必须先定义后引用**：未定义的 `var(--x)` 会导致整条 CSS 声明失效；内联代码的 `--link-soft` 在 `--bg` 上须满足文字令牌的 ≥4:1 对比度门槛（守卫：`tests/unit/css-tokens.test.ts`、`theme-text-contrast.test.ts`；行内代码检查已并入文字令牌守卫）。
- **强调色实底上的文字必须走 `--accent-contrast`**：`background: var(--accent)` 配 `color: #fff` 会在浅色强调主题（`flow`/`wallpaper-flow` 的纯白、`wallpaper-obsidian` 的 `#e2e8f0`、`aetheris`/`cyberpunk`/`nord` 等）变成白底白字，按钮直接隐形。前景一律写 `var(--accent-contrast, #fff)`；插件同理：若私设前缀别名（如 `--xxx-accent: var(--accent)`）**必须成对声明** `--xxx-accent-contrast: var(--accent-contrast, #fff)`，推荐直接复用宿主全局 `.btn.primary`，严禁私设单向底色别名而硬编码白字；半透明 `color-mix(… var(--accent) 30% …)` 染色底则用 `var(--text)`；主题若把 `--accent` 定成浅色，必须同时声明反色的 `--accent-contrast`（守卫：`tests/unit/accent-contrast.test.ts`、`semantic-contrast.test.ts` 动态符号追踪别名）。
- **语义色实底同理走 `--on-*`**：`background: var(--green|--red|--amber|--blue|--send-blue|--stop-red)` 配 `color: #fff` 同样会隐形（默认主题 `--amber` 白字 1.67:1、`--green` 1.92:1、`--red` 2.77:1）。前景写 `var(--on-green|--on-red|--on-amber|--on-blue|--on-send-blue|--on-stop-red)`；状态色按「白/深取对比更高者」派生、动作色（blue/send/stop）白字 ≥3:1 就保留白字，主题侧由 `make-light-theme.mjs` 自动派生（守卫：`tests/unit/semantic-contrast.test.ts`）。
- **主题的「文字令牌」必须有明暗下限**：`--text-faint`（3.05:1）、`--accent`（3.5:1）、`--amber/--green/--red/--blue/--link/--link-soft/--info-blue/--skill-blue/--auth-green/--plugin-purple/--amber-text/--red-text/--err-text/--md-strong/--code-text`（4.5:1）在 `--bg` 与 `--bg-elev2` 上必须够对比——亮色主题照抄深色默认值会让警告文字、状态 chip、链接整体糊掉（曾出现 `--plugin-purple` 1.50:1）。`make-light-theme.mjs` 的 `TEXT_FLOORS` 会自动保持色相压暗，手写主题自行声明（守卫：`tests/unit/theme-text-contrast.test.ts`）。
- **长文本与长路径防溢出标准**：
  - 行容器（flex 容器）必须添加 `min-width: 0` 与 `max-width: 100%`；
  - 可断行文本（`.md` 内正文、路径）必须使用 `overflow-wrap: anywhere` 与 `word-break: break-word`；
  - 单行文本使用 `overflow: hidden` 与 `text-overflow: ellipsis`；
  - 独立面板与弹窗列表（如计划看板、沙箱差异）必须声明 `overscroll-behavior: contain` 防止整页滚动条穿透；但流内工具输出与代码文本块等非独立浮层容器严禁声明 `overscroll-behavior: contain`，防止滚轮黑洞锁死外部对话流（守卫：`tests/unit/text-wrap.test.ts`）。
- **卡头与操作按钮落点规范**：
  - 折叠卡头（`.chead`）右端**仅放置自身复制键**（`.chead-copy`，钉 `flex: none`），卡头内严禁悬挂消息级操作按钮；卡头提示文本设置 `flex: 0 1 auto` + `min-width: 0` 吸收缩放，窄屏下限制最大宽度，严禁用 `flex-wrap: wrap`。
  - 消息级操作栏（`.msg-actions`）仅对有正文的助手消息和用户消息生效；助手消息操作栏必须紧锚在最后一个正文块后，杜绝与工具卡分离。
- **UI 扩展点与浮层规则**：
  - 下拉菜单必须 Portal 到 `body` + `fixed` 布局，防止被父容器 `overflow` 截断；
  - 浮层统一使用 `useFloatingPanel`，禁止在 `scroll` 事件中强制关闭浮层（仅重算锚点，通过 mousedown/Escape 关闭）；
  - **叠人式浮层禁写死 z-index**：能盖在另一个浮层之上的浮层（工具详情、文件预览、图片预览、全屏 diff、审批/授权弹窗……）一律用 `web/src/overlay-stack.ts` 的 `useOverlayZIndex()` 取层号，内联 `style.zIndex` 覆盖主题；叠栈从 `var(--z-overlay-stack)`（100000）起、按打开顺序往上排，临时通知固定在 `var(--z-notice)`（100050）永远在最上。**不要再给“比谁高”另挑一个更大的数字**（100001/100005 那类叠上去只会把下一个套娃浮层又盖住）；需要自开 stacking context 的弹窗用 `.overlay-layer` 壳。静态浮层最高 10000（守卫：`tests/unit/overlay-stack.test.ts`）。
  - 侧边停靠栏（`SideDock`）为流内 flex 项目，浮动模式由 `sideDockFloat` 控制，严禁写死 fixed 遮挡侧边按钮。
- **输入框上方那条带子属于消息区**：快捷短语行只是浮在它上面，正文从芯片**之间**的缝里透出来（芯片本身是实底小卡片，压在正文上必须压得住字）。带子高度单源在 `.main` 的 `--composer-strip`（= `--composer-pad-top` + ChatInput 实测写入的 `--quick-row-h` + 6px）；改输入区上内边距或短语行留白必须同时顾三处：`.messages-wrap` 的负 margin、`.messages` 的底部留白、以及按容器底缘定位的 `.scroll-bottom` / `.qn-rail`（都要 `+ var(--composer-strip)` 回补），严禁把短语行改回 `position: absolute`（会与药丸/浮标抢同一条带子，折行时必叠）。守卫：`messages-behind-composer.test.ts`。
- **拖拽与触控交互标准**：
  - 图标编辑与拖拽必须监听 Pointer 事件，严禁使用 HTML5 DnD（移动端触屏不触发）；内置图标须在 `host-icon.tsx` 登记；菜单行文字统一 12.5px（守卫：`host-icon.test.ts`、`topbar-overflow-menu.test.ts`）。
  - 手机端横滑手势（`swipe-drawer.ts`）必须避开系统侧滑区，手势期间直写内联 transform 禁用动画过渡，松手后清理内联值交由 CSS 类过渡；移动端遮罩常驻（守卫：`swipe-drawer.test.ts`）。
- **消息操作语义**：提示悬浮即显且简短；重新提问和编辑后重问在当前会话截断原问题及后续内容后重发；分叉包含所选消息并创建新对话；回退打开对应用户问题的编辑框，提交后在当前会话重问，取消不改历史。详见 [`architecture-core.md`](architecture-core.md)「消息操作」。
- **新会话初始化交互**：切换或新建会话须经 `focusComposer()` 聚焦（触屏除外），非 chat 视图自动切回，待发附件 chips 随新会话清空（守卫：`composer-draft.test.ts`）。

## 四、架构与运行态约束

- **目标模式 2.0 运行铁律**：主对话作为审查者，服务端另起落盘执行者；轮次、代次与停滞熔断全由服务端管控，严禁模型自行调用 wait/spawn；审查指令必须注入执行证据（`goal-evidence.ts`）；会话中止或关闭即停止循环，不得无限续轮（守卫：`goal-delegated.test.ts`、`goal-evidence.test.ts`，文档：[`goal-conversation-design.md`](goal-conversation-design.md)）。
- **审查者委派模式（Delegate Mode）**：开启后主对话只审不干，用户输入自动派发给常驻执行会话；闸门强制拦截写操作与子代理派发；计划模式优先级高于委派（`server/delegate-mode.ts`、`server/plan-mode.ts`）。
- **预设依赖与部分应用**：交换文档顶层 `plugins` 仅携带插件需求元数据，不含配置、密钥、存储或授权；安装复用显式 `plugin_job`。部分预设未携带的字段不得补默认或清空当前设置，`plugins` 不得进入运行设置；保存、应用、延后加载和应用失败分别回执（见 [`preset-sharing.md`](preset-sharing.md)）。
- **预设分享必须白名单严格净化**：导入外部 JSON 必须通过 `server/preset-share.ts` 白名单校验（`preset-fields.ts`），丢弃未知字段，执行 dryRun 确认，严禁未经校验直接摊入 `ClientSettings`（守卫：`preset-share.test.ts`，文档：[`preset-sharing.md`](preset-sharing.md)）。
- **原子写 / 重试单源在 `server/atomic-file.ts`**：`writeAtomicSync` / `writeAtomic` / `readFileSyncRetry` 自带 EPERM/EACCES/EBUSY 的**真退避**（20/60/150/400ms）——Windows 上杀毒与索引器会短暂占用刚写完的文件，`rename` 的瞬时失败是常态，空转重试（无 sleep）等于没重试。Hub 升级 worker 不能 import TS，故 `bin/lib/atomic-file.mjs` 由 `npm run gen:atomic`（`build:server` 末尾自动跑）从同一份实现生成，禁手改；升级记账写失败**不得**阻断回滚（先恢复旧服务，元数据降级为尽力而为）（守卫：`atomic-file.test.ts`、`atomic-file-generated.test.ts`、`hub-upgrade-runtime.test.ts`）。
- **Windows 最小化通知**：Windows 最小化时页面 visibility 状态不准确，必须通过窗口尺寸矩形判断（`isCollapsedWindow`）；通知禁止携带 `tag` 字段，防止被系统静默吞并。
- **压缩软上限必须双层监控，换模型必须走 `applySessionModel`**：SDK 的 `compaction.reserveTokens` 是**回合内**唯一的检查点（工具调用间隙 `_compactBeforeNextAssistantResponse`），必须逐会话算成 `cw - cap`，否则自治长跑（子代理 / 单回合几十次工具调用）全程无空闲态，永不会压（`#773`）；且 reserve 依赖会话**当前**模型，任何裸 `session.setModel()` 都会让判定线卡在上一模型的 `W - C` 上，换模型一律走 `applySessionModel`；cap ≤ keepRecent + headroom 时不注射（否则每个工具间隙重压一次）。`server/soft-cap.ts`。
- **直连 `ModelRuntime` 必须自带 `sessionId`**：SDK 只在 AgentSession 内注入 `options.sessionId`；绕过会话直调 `completeSimple` / `streamSimple` 的模块（随手问、提交信息生成、视觉转写、群路由）必须传 `modelSessionId()`（`server/model-session.ts`：同一话题传稳定种子，一次性调用不传），否则 opencode / opencode-go 网关缺 `x-opencode-session` 头会直接 400 `MissingSessionID`（守卫：`tests/unit/model-session.test.ts`）。
- **模型目录官方整表替换**：通过 `patch-remote-catalog.ts` 幂等改写 SDK 目录，不残留旧定义，升级后自动重新应用。
- **DSH 运行态三规则**：shipped 预设使用 `preset-clones.ts` 的 file: 克隆隔离；问卷与过滤钩子挂 agent scope；统计指标吃直播帧与 assistant/message.usage（`dsh-usage.ts`）。见 [`dsh-engine.md`](dsh-engine.md)。
- **会话过户与状态迁移**：`take_over_conversation` 完整搬迁 runtime 本体，且**是事务性的**（源侧已摘、目标侧接入失败就原样搬回，绝不留「还在跑但没人持有」的幽灵会话，见 `#556` / `tests/takeover-rollback-test.mjs`）；**断连残骸的「另一处」行有宽限期**（`PI_WEB_OFFLINE_ROWS_TTL_MS`，默认 30 分钟，标 `ownerOffline`，仍可过户——手机 run 途中关页面后换设备仍能接管）；`ask_user_question` / `browser_page` 解析创建时的 session 对象（`bridgeTarget`）；跨页答复带 owner。
- **工作区命令必须串行（`#872`）**：`cs.cwd` / 活动对话 / runtime 绑定是同一组可变状态，改它们的命令（`set_cwd` / `new_chat` / `new_cli_chat` / `switch_session` / `switch_conversation` / `fork_session` / `rollback_session` / `make_dir(setAsCwd)` / 沙盒切换）一律走 `server/workspace-queue.ts` 的会话级 FIFO（派发层「同步认领 + 入队」）；建会话可用 `new_chat.cwd` 声明目标，切不过去就不建（回执 `ok:false`）。**禁止**在前端逐处补 cwd、也禁止把建会话写成不等 `set_cwd` 的并发调用。客户端意图单源为 `web/src/pending-workspace.ts`（守卫：`tests/unit/workspace-queue.test.ts`、`tests/unit/pending-workspace.test.ts`）。
- **宿主提供的包只能声明在 `peerDependencies`（`"*"`）**：pi 扩展加载器只扫 `dependencies`（命中 `@earendil-works/pi-coding-agent` / `typebox` 就告警：嵌套副本会绕开加载器注入、搞出重复运行时模块）。本包同时是扩展与独立服务端，服务端子进程真要这两个包（`PI_WEB_SDK=bundled` 也要自带副本）→ 落在 `optionalDependencies`（npm 默认照装）。守卫 `tests/unit/extension-host-packages.test.ts`。
- **布局页改名 / 插件 `arrange.label` 必须落到渲染层**：合并引擎对「显式指定的文案」置 `UiSlotEntry.labelExplicit`；内置条目（顶栏按钮、底栏数值徽标）一直画写死的 i18n 与实时数值，只有旗立着时才让位（名字型顶掉内置文案；数值型把名字插在数值前，不吞实时数据）。只在设置页生效 = 假承诺（`#555`，守卫 `tests/unit/bar-item-unified.test.ts`）。
- **插件修改必须递增版本号（Bump Version）**：内置官方插件（`plugins/<id>/`）凡修改了代码/功能/静态资源（非纯文档），必须同步递增 `manifest.json` 中的 `version`（若有 `package.json` 的 `version` 须保持一致）。原因：随包热同步（`syncBuiltinPlugins`）与更新器（`plugin-updater`）均以 `compareVersions(srcVer, tgtVer) > 0` 作为升级判定的唯一权威事实源；若漏改版本号，老用户更新主程序后数据目录中的旧插件代码永远不会被热更新覆盖，导致缺陷滞留（守卫：`tests/unit/plugin-version-bump-guard.test.ts`）。
- **插件代码目录是纯缓存，状态只住 `plugin-data/<id>/`**：`plugins/<id>/` 会被物化/升级重放（完整性由回执 `.pi-materialized.json` 裁定，半残就地补齐），所以设置 / 机密 / 定时任务 / 能力确认标记一律走 `pluginStateDir()`，不得写在代码目录里；复制黑名单只能在 `server/fs-copy.ts` 按**相对路径**判定——`cpSync` 的 filter 拿到的是绝对路径，npm -g 安装（包目录本身就含 `node_modules`）会把整棵树过滤成空副本还被当成已安装（守卫：`tests/unit/plugin-copy-single-source.test.ts`、`plugin-bundled.test.ts`、`plugin-paths.test.ts`，来源 `#856`）。
- **修改测试插件一定要及时更新本地插件**：本地实际运行加载的插件位于数据目录（`<dataDir>/plugins/<id>/`，如 `~/.pi-web/plugins/<id>/`）。修改或测试工作区内置插件时，除递增版本号外，必须及时将最新源码同步覆盖至本地数据目录的对应插件中，防止开发调试时因旧代码缓存导致行为脱节。
- **国际化字面量要求**：`i18n.tsx` 的词条值必须使用字符串字面量（仅允许 `+` 拼接），确保 `scripts/i18n-diff.mjs` 静态解析器正常运行。

- **服务端禁同步子进程调用（`spawnSync` / `execSync` / `execFileSync`）**：这三个 API 在事件循环线程上 fork+exec，并**一直阻塞到子进程结束**。子进程如果卡在 `exec()` 之前（Termux/Android 上实测能稳定复现），主线程就永远停在 spawn 错误管道的 `read()` 上——定时器、socket、`/api/health` 全部停摆，只能靠外部 watchdog 杀进程。异步 `spawn` / `execFile` 不会被拖到子进程结束，`timeout` 也只对异步版有意义（同步版根本回不到超时处理）。两条可行路线：换成异步 spawn + 超时；或者把答案**静态推导**出来（`server/global-loader.ts` 的 npm prefix、`server/dsh/runtime/runtime-root.mjs` 的计算式前缀都是这么改的）。扫描范围包含**插件主进程代码**（`server/plugins.ts` 用 `import()` 把 `plugins/<id>/index.mjs` 载进主进程，与服务器共用事件循环；`bin/`、`assets/`、`build.mjs` 这类独立进程的东西除外）。存量按**次数**登记在守卫的只减不增名单里，新代码请直接走异步或静态推导（守卫：`tests/unit/sync-child-process-guard.test.ts`，来源 `#830`）。

## 五、其余边界（只在别处维护，见链接）

这些条目已在专门文档里详细维护，`AGENTS.md` 只保留一行指针，新增内容请写进对应文档：

| 边界                                                                          | 文档                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 设置同步（`SettingsService.push()` / `refreshSettings()` / `applyRuntime()`） | [`architecture-core.md`](architecture-core.md)「异步归属与持久化边界」 |
| pi 请求上下文投影、`context-evidence` 证据、压缩任务指令                      | [`tool-context-budget.md`](tool-context-budget.md)                     |
| 跨 await 归属、取消信号、代次、历史分页、CSP sandbox、SSH known_hosts         | [`architecture-core.md`](architecture-core.md)「异步归属与持久化边界」 |
| WS 限额、attach 队列、历史搜索、压缩恢复 sidecar、文件保存、任务持久化        | [`architecture-core.md`](architecture-core.md)「命令、搜索与恢复状态」 |
| 沙盒身份、基线写回、生命周期                                                  | [`architecture-sandbox.md`](architecture-sandbox.md)                   |
| 稳定归属、工作树清理、取消代次                                                | [`root-cause-boundaries.md`](root-cause-boundaries.md)                 |
| 群组 / Bot / 跨设备协作                                                       | [`device-collaboration.md`](device-collaboration.md)                   |
| 画布版本、运行代次、产物隔离                                                  | [`architecture-canvas.md`](architecture-canvas.md)                     |
| MCP 项目运行态                                                                | [`architecture-plugins.md`](architecture-plugins.md)「MCP 项目运行时」 |
| 提示词模板与 `/命令`                                                          | [`development.md`](development.md)「提示词模板命令」                   |

## 六、源码注释

- 默认不写源码注释；删除复述代码、文件头介绍、分段标题、历史变更、临时说明和注释掉的废代码，避免过期说明误导后续判断。维护规则与架构说明放在对应 `docs/` 文档。
- 保留许可证、类型与构建/检查指令、运行时读取的元数据，以及解释非显然安全边界或约束的简短说明；字符串、正则和模板里的文本按实际用途判断。
- 测试按实际代码结构或稳定标识定位源码，不依赖普通注释的文字。

## 七、终端命令执行（防卡死）

挂死只有五类根因，规则按**根因**写，不要按「看起来卡住的命令」逐个打补丁（`| sort` 只是缓冲导致看不到进度，读的是 EOF，本身不会死锁）：

1. **等 stdin**：`npx` 安装确认、`git commit` 无 `-m`、REPL、`read -p`。必须显式非交互（`CI=true`、`npx --yes`、`npm i --no-audit --no-fund`、`git commit -m`）；执行器一律把子进程 stdin 接 `/dev/null`，读到 EOF 即返回。
2. **不退出**：`--watch`、dev server、前台 daemon、死循环。禁止前台跑。**产品内（任意用户项目）用 `bash({background:true})`**：调用立即返回 job id + 日志路径，进程登记在顶栏「后台任务」面板（可单独停止 / 全部关闭 / 不参与遗留清理）；源码仓库与 CI 里仍用 `safe-exec --detach` 托管 + 轮询。
3. **pager**：`less` / `more` / `git log` 默认分页器等 TTY 按键。用 `PAGER=cat`、`GIT_PAGER=cat`、`git --no-pager`；执行器默认注入。
4. **输出淹没上下文 / 后台子进程继承 stdout**：原始输出先落盘，只回显尾部；分析用 `grep` / `read --offset` 分步读，禁止 `cmd | sort` / `| less` / `| head` 这类必须吃到 EOF、T 掉 TTY 或持住管道句柄才算完的直连管道。
5. **静默卡死**：进程活着但再也不产出（等锁、等网络、等一个拿不到的句柄、把活丢给已死的孙进程）。靠 `--idle-timeout` 判：连续 N 秒零输出即强杀。只给「正常跑必有心跳输出」的任务开（默认关闭）；构建 / 类型检查这类天然安静的别开。

时长分档与用法（`scripts/safe-exec.mjs`，跨平台 Node 包装器）：

| 场景               | 命令                                                               | 判据                                    |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------- |
| 单测 / lint / 类型 | `node scripts/safe-exec.mjs --timeout 60 -- npx vitest run <file>` | 超时返回 `124`                          |
| 全量构建 / 编译    | `--timeout 600`，必带 `--log`                                      | 超时返回 `124`                          |
| 预计 >3 分钟       | `--detach` 托管 → `--wait <jobfile> --json` 轮询 → `--kill` 终止   | 启动立即返回；`--wait` 提前结束提前返回 |
| AI 单次工具调用    | pi `bash` 工具的 `timeout` 参数 + 会话级工具看门狗                 | 超时 `session.abort()`                  |

`124` 意味着**换策略**，不是重试：先读日志定位卡点（慢？卡网络？等锁？），再调分档或改后台。进程树终止以 `server/process-utils.ts` 的 `killPidTree` 为单源，不另行手写 `taskkill` / `kill -9` 片段。守卫：`tests/unit/safe-exec.test.ts`。

后台托管协议（AI 照抄即可，禁自行发明轮询方式）：

1. **起**：`--detach --timeout <总秒> [--idle-timeout <N>] --log <path> -- <cmd...>`，从输出（或 `--json`）拿 `job=<jobfile>`。
2. **等**：只跑 `node scripts/safe-exec.mjs --wait "<jobfile>" --wait-sec 10 --json`。它内部计时，任务提前结束立刻返回，到点则返回这段时间的 `newOutput`（游标已推进，**不会重复输出**）。不写 `sleep`、不拼 `&&`、不依赖 `$?`。
3. **判**：`status` 为 `RUNNING` 继续 `--wait`；`SUCCESS` / `FAILED` 看 `exitCode` 与日志；`ABORTED`（含 `childAlive: true` 的「看门狗宽限后未死透」）说明子进程还在跑，先 `--kill` 再重跑；`TIMEOUT` / `IDLE_TIMEOUT` 禁止原样重试，先读日志改分档或去掉管道；`pipesForced: true` 说明有孙进程继承了输出管道且已强制结算，日志可能只到 exit 为止。
4. **收**：`--kill "<jobfile>"` 先杀子进程树再收守护进程；产物三件套 `.pid` / `.state.json` / `.cursor` 留在日志旁，终态后可直接删。`--status` 可以随手查（只读，不消费增量），别用 `--status` 代替 `--wait` 做轮询循环。
