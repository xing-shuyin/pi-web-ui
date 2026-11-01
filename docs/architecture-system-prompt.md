# 系统提示词组成与组合模板（compose）

> 本文档说明 SDK（`@earendil-works/pi-coding-agent`）如何组装最终发给模型的系统提示词，
> 以及 pi-web-ui 的「组合模板」如何让你**自由组合**这些来源、**单独覆盖**其中任意一层。
> 事实源：SDK `dist/core/system-prompt.js`（`buildSystemPrompt`）、`dist/core/resource-loader.js`
> （`discoverSystemPromptFile` / `loadProjectContextFiles` / override 重放）、
> `dist/core/agent-session.js`（`_rebuildSystemPrompt`）、`dist/core/extensions/runner.js`
> （`before_agent_start` 链式替换）；pi-web-ui 侧在 `server/prompt-composer.ts`（纯函数引擎）、
> `server/agent-service.ts`（集成）、`web/src/components/SettingsModal.tsx`（设置 UI）。

## 一、总览：最终提示词的组装顺序

    最终提示词 = 基础提示词(soul) + 工具列表(tools) + 行为准则(guidelines)
              + Pi 文档指引(pi_docs) + 追加段(append) + pi-web-ui 引导
              (persona/terminal/markers) + 项目上下文(context) + 技能段(skills)
              + 工作目录行(cwd)
    主会话启用「组合模板」后，以上每一层都是一个 {{token}}：模板里写哪些 token、
    按什么顺序、穿插什么自己的话，决定最终提示词；每层未覆盖时用**自动内容**
    （工具/上下文/技能等永远由 SDK 用最新数据重新生成）。

## 二、组合模板与来源 token

    token 列表（server/prompt-composer.ts 的 PROMPT_TOKENS，默认顺序即自然拼装顺序）：
        {{soul}}        agent 人物设定（有 SYSTEM.md 时其内容，否则内置默认）
        {{tools}}       Available tools 列表 + “In addition…” 句
        {{guidelines}}  Guidelines：文件探索引导 + 各工具 promptGuidelines + 固定两行
        {{pi_docs}}     Pi documentation 指引（指向已安装 pi 包路径）
        {{append}}      追加段 = APPEND_SYSTEM.md 内容；覆盖 = 自定义追加文字
        {{persona}}     Windows persona（仅 win32）
        {{terminal}}    终端工具使用引导（「终端工具」开关开时）
        {{markers}}     内置标记工具引导（markers 开启时）
        {{context}}     <project_context>（AGENTS.md / CLAUDE.md 收集结果）
        {{skills}}      <available_skills> 技能清单
        {{cwd}}         Current working directory 行
    每层可「单独覆盖」：overrides[token] 有内容时用你的文本替换自动内容；
    留空 = 用自动内容。模板为空 = 默认模板（全部 token 自然顺序），不配置任何
    模板/覆盖时运行完全等同 SDK 默认拼装（零开销，before_agent_start 返回空）。

## 三、各来源自动内容从哪来（buildSystemPrompt 视角）

    基础提示词 base（resource-loader.discoverSystemPromptFile，按优先级）：
        1. 项目级：<cwd>/.pi/SYSTEM.md（受信任时）
        2. 全局级：<agentDir>/SYSTEM.md
        3. 都没有 → undefined → SDK 默认分支拼出内置模板（persona + tools +
           guidelines + pi_docs）
    组合模式下 systemPromptOverride 恒返回 base（= SYSTEM.md 原文，没有就 undefined）
    → 组合模板激活时 before_agent_start 整体换掉提示词（`{{soul}}` 用同一份 base），
    组合模板未激活时 SDK 默认分支据此保留 .pi/SYSTEM.md（TUI 同语义；旧实现恒返回
    undefined，于是在「全默认 + 有 SYSTEM.md」的会话里这份文件被静默丢弃）。

    base 的归属（issue #812，红线）：
        override 是**回调**，它推给宿主的 base 必须落在 **loader / session** 名下
        （`server/prompt-base-store.ts`，key = resourceLoader 对象），**禁止**存成
        ClientSession（= 一个浏览器客户端）上的「最近一次观察到的值」字段。
        历史事故：`lastBaseSystemPrompt` 只在 base 非空时更新，切到没有 SYSTEM.md 的
        项目时没人清旧值 → 上一个项目的系统提示词漏进本项目的设置预览与新建对话，
        只有恰好访问一个「空白 SYSTEM.md」的项目才会被意外重置。
        口径：
        - 记录：每次 reload **无条件覆盖**（base 缺失即写空），没文件的项目永远是空记录；
        - 读取：`readPromptBase(目标会话的 session.resourceLoader)` —— 预览算哪个
          会话就读哪个会话（回顾「拿活跃会话算后台会话」的同类串账）；
        - 过户：搬的是 session 本体，记录跟着走；session 销毁后 WeakMap 自动回收；
        - 空白语义与 SDK 对齐：空串 / undefined = 没文件（用内置默认），纯空白文件
          = 空提示词（`{{soul}}` 保留原文，不做 trim 回退）。
        守卫：tests/unit/prompt-base-{store,scope,isolation}.test.ts。
    项目上下文（loadProjectContextFiles）：候选 AGENTS.override.md > AGENTS.md >
        AGENTS.MD > CLAUDE.md > CLAUDE.MD；全局 agentDir 一份 + cwd 逐级向上，
        包装成 <project_context><project_instructions path="…">…</project_instructions></project_context>。
    技能段：可见技能（disableModelInvocation=false）formatSkillsForPrompt 输出；
        read 工具不可用时省略。pi-web-ui skillsOverride 按禁用集过滤。
    工作目录行：`Current working directory: <正斜杠 cwd>`。
    Pi 包路径（README.md / docs / examples）：随安装位置解析一次
        （require.resolve("@earendil-works/pi-coding-agent/package.json")）。

## 四、引擎（server/prompt-composer.ts，纯函数、浏览器可复用）

    resolveSectionTexts(inputs) → 每 token 的自动内容
    renderPromptTemplate(template, texts, overrides) → {{token}} 替换
        - 覆盖优先：overrides[token] 非空白 → 用之；否则 texts[token]
        - 未知 token 保留原文（UI 可提示 typo）
        - 自动内容为空的 token（如非 win32 的 {{persona}}）展开为空串
    DEFAULT_PROMPT_TEMPLATE / PROMPT_TOKENS 供设置 UI（token 插入、恢复默认）。
    单测：tests/unit/prompt-composer.test.ts。

## 五、运行时集成（server/agent-service.ts）

    每个会话 runtime 注册隐藏内联扩展 <inline:pi-webui-persona>：
        before_agent_start（每个 agent run 前）—
            - 主会话：若配置了模板或任一覆盖，用本次 run 的 systemPromptOptions
              （selectedTools / toolSnippets / promptGuidelines / contextFiles /
              skills 全是当时最新）渲染组合模板，替换该 run 的 systemPrompt 主体；
            - 子代理模板 replace：默认分支下把灵魂段换成模板提示词（自动段保留）；
              模板 append 仍走 loader 追加段。
        链式保留（两个分支共用）—— 我们是 before_agent_start 链上最后一个 handler
        （resource-loader 把内联扩展排在所有文件/包扩展之后），返回 systemPrompt 即
        forceSystemPrompt 整体替换，会把别的扩展写进去的内容一起丢掉。所以先拆：
            splitAgentStartPrompt(event) → { pre, core, post }
                forceSystemPrompt 无值 = 没人动过，core 即当前提示词，pre/post 为空
                （零开销，输出与今天逐字节一致）；
                有值 = 前面有扩展替换过，临时清掉它再读 event.systemPrompt 拿到 SDK
                原始基线，splitExtensionWrap(基线, 当前) 把首尾增补摘成 pre/post。
            渲染/换段只在 core 上做，最后 pre + 结果 + post 套回去。
        优先级：用户模板/覆盖始终赢得提示词主体，扩展只保住自己的首尾增补。基线不是
        原样嵌在当前文本里时（扩展做了中间插入或整体替换）无法安全摘取，退回今天的
        行为（pre/post 为空），绝不把整段提示词翻倍。完全默认（未自定义）时主会话仍
        返回 undefined，扩展的改动原样生效。
        纯函数 splitExtensionWrap 在 prompt-composer.ts，单测见
        tests/unit/prompt-composer.test.ts；设置面板预览不跑扩展，因此预览与真实 run
        会相差这部分扩展增补。
    设置改动无需 reload 即可在下一个 run 生效（逐 run 读取 settingsSvc）；
    session.reload() 仅用于让 loader 侧（默认分支/技能过滤等）同步。
    设置面板预览（settings_state.effectiveSystemPrompt）：用当前会话资源
        走同一渲染函数 —— 与真实 run 一致（只读查看）。

## 六、设置与迁移

    字段（client-state.json / 协议 UiSettingsState）：
        promptTemplate: string           组合模板文本（空 = 默认模板）
        promptOverrides: Record<string,string>   每来源覆盖
    旧存档迁移（getSettings）：customSystemPrompt 非空时 —
        append → 文字成为 {{append}} 覆盖（独立追加块）
        replace → 文字成为 {{soul}} 覆盖
    遗留字段 promptMode/customSystemPrompt 保留在数据结构里（DSH 子系统与旧预设
    共用同一份 client-state 存储，见 dsh-agent-service.ts），主会话 UI 不再使用。
    预设（SettingsPreset）新增捕获 promptTemplate/promptOverrides，应用时旧预设
    缺字段保留当前值。

## 七、设置 UI（SettingsModal → 「系统提示词」页）

    组合模板编辑框（{{token}} 可任意排序/穿插文字；placeholder = 默认模板）
    一键插入 token 的 chips
    每来源覆盖行：token + 说明 + 覆盖输入框（留空 = 自动）
        单来源「恢复默认」按钮（清空该覆盖）
    整体「恢复默认模板并清空所有覆盖」按钮
    「查看当前完整提示词」只读预览 = 组合渲染结果
    文案键：promptTok_<token> / promptTok_<token>_desc（zh/en 同步）

## 八、与子代理模板的关系

    子代理模板保留自身 append/replace 语义（角色化预设）：白名单过滤技能/扩展；
    replace 在无 SYSTEM.md 时把子代理默认分支的灵魂段换成模板提示词；append 追加
    到该子代理的追加段。模板会话不套主会话组合模板（角色由模板定义）。主会话
    组合模板不影响模板派生的子代理。
    另外两个模板维度与提示词无关，在派发时（spawnSubagentConversation）套用：
    model（provider/id）与 thinkingLevel（off…max，见 server/subagent-templates.ts
    的 THINKING_LEVELS）。优先级：显式 model 参数 > 模板 model > 设置面板子代理
    默认模型 > 跟随派发会话当前模型；thinkingLevel 无显式参数，模板空值 = 跟随
    派发会话当前强度（session.thinkingLevel）。两者都在换模型之后套用，
    setThinkingLevel 会按模型能力收敛（reasoning:false → off，xhigh/max 需
    thinkingLevelMap），不传 persist，只影响该子代理会话。
    内置模板在 server/subagent-templates.ts 的 DEFAULT_TEMPLATES（含 oh-my-pi
    specialist 系列：oracle/librarian/explore/metis/momus/multimodal-looker/
    sisyphus-junior）；老用户已有文件时缺失的内置模板一次性补齐（sidecar
    subagent-templates.seeded.json 记已播种名单，删后不再复活）。
    繁中视图：resolveServerLang 把 zh-TW/zh-HK/zh-Hant 都折成 "zh"，繁中用户
    会拿到简体。localizeTemplate 按**原始 locale**（isTraditionalLocale）在内置
    模板的 description/systemPrompt 仍等于出厂简中时，换成
    subagent-templates-hant.ts 的台湾用语文案（三个繁中界面共用一份），用于设置
    快照、templates 工具与子代理系统提示词；只是视图，不回写库，用户改过的字段
    不动。canonicalizeTemplate 在 upsert 时把「恰为出厂繁中」的文字还原成简中，
    避免繁中界面点一下开关就把全局库改写成繁体。出厂简中文案改动时，
    subagent-templates-hant.ts 必须同步（守卫：subagent-templates.test.ts）。

## 九、结构化派单与 skill 全文注入（oh-my-pi 精髓的原生移植）

    设置（client-state.json / 协议 UiSettingsState）：
        delegate_task: 结构化派单工具（server/delegate-task.ts），六段必填 + 服务端校验
        skillsFullText: string[]        skill 全文注入名单（默认空 = 名录模式）
    生效点（server/agent-service.ts）：
        before_agent_start 主会话分支 — SDK 拼好的提示词（或组合模板渲染结果）
        delegate 六段拼装 + 校验打回（见 server/delegate-task.ts 的 validateDelegation）。
        composeInputs — skillsFullText 名单非空时 fillSkillContents() 最好努力读名单里
            技能的 SKILL.md 正文（单文件 8KB、总量 32KB 封顶，GBK 回退经 decodeText），
            填进 PromptComposerInputs.skills[].content；{{skills}} 对名单技能按全文格式展开。
    名单由 before_agent_start 逐 run 实时读取：改完下一轮即生效，不走
    session.reload()（settings-service needsReload 不含它们）；设置预览
    （sessionPromptSnapshot）走同一逻辑。DSH 引擎只透传存储值（切回 pi 生效）。
    预设捕获名单（旧预设缺字段保留当前值）。

## 相关源码定位

    - pi-web-ui：server/prompt-composer.ts（token/引擎/默认模板）、
      server/agent-service.ts（override + 内联扩展 + 渲染预览）、
      server/settings-service.ts / client-state.ts（设置持久化与迁移）、
      server/protocol.ts（UiSettingsState 字段）、web/src/components/SettingsModal.tsx
    - SDK：dist/core/system-prompt.js（buildSystemPrompt 默认拼装）、
      dist/core/resource-loader.js（SYSTEM.md / 上下文收集 / override 重放）、
      dist/core/extensions/runner.js（before_agent_start 链式替换）
