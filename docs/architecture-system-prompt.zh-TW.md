[English](./architecture-system-prompt.en.md) · [简体中文](./architecture-system-prompt.md) · **繁體中文**

# 系統提示片語成與組合模板（compose）

> 本文件說明 SDK（`@earendil-works/pi-coding-agent`）如何組裝最終發給模型的系統提示詞，
> 以及 pi-web-ui 的「組合模板」如何讓你**自由組合**這些來源、**單獨覆蓋**其中任意一層。
> 事實源：SDK `dist/core/system-prompt.js`（`buildSystemPrompt`）、`dist/core/resource-loader.js`
> （`discoverSystemPromptFile` / `loadProjectContextFiles` / override 重放）、
> `dist/core/agent-session.js`（`_rebuildSystemPrompt`）、`dist/core/extensions/runner.js`
> （`before_agent_start` 鏈式替換）；pi-web-ui 側在 `server/prompt-composer.ts`（純函式引擎）、
> `server/agent-service.ts`（整合）、`web/src/components/SettingsModal.tsx`（設定 UI）。

## 一、總覽：最終提示詞的組裝順序

    最終提示詞 = 基礎提示詞(soul) + 專案上下文(context) + 工具列表(tools)
              + pi-web-ui 引導(markers) + 技能段(skills) + 工作目錄行(cwd)
              + 追加段(append) + 外掛開發指南(plugin_dev，出廠停用)
    以上順序就是**內建預設提示詞配置**（PROMPT_TOKENS / DEFAULT_PROMPT_TEMPLATE 的出廠順序）；
    `{{guidelines}}`（行為準則）與 `{{pi_docs}}`（Pi 文件指引）已下線，不再進入預設提示詞。
    主會話啟用「組合模板」後，以上每一層都是一個 {{token}}：模板裡寫哪些 token、
    按什麼順序、穿插什麼自己的話，決定最終提示詞；每層未覆蓋時用**自動內容**
    （工具/上下文/技能等永遠由 SDK 用最新資料重新生成）。

## 二、組合模板與來源 token

    token 列表（server/prompt-composer.ts 的 PROMPT_TOKENS，預設順序即自然拼裝順序）：
        {{soul}}        角色（agent 人物設定；有 SYSTEM.md 時其內容，否則內建預設 =「六條工程準則」，**純英文**，所有介面語言同一份）
        {{context}}     <project_context>（AGENTS.md / CLAUDE.md 收集結果）
        {{tools}}       按需工具列表（Available tools / On-demand tools）+ “In addition…” 句
        {{markers}}     內建標記工具引導（markers 開啟時）
        {{skills}}      <available_skills> 技能清單
        {{cwd}}         Current working directory 行
        {{append}}      追加段 = APPEND_SYSTEM.md 內容；覆蓋 = 自定義追加文字
        {{plugin_dev}}  pi-web-ui 外掛開發指南（DEFAULT_PROMPT_DISABLED 出廠停用）
    已下線來源：`{{guidelines}}` / `{{pi_docs}}`（連同 `{{terminal}}` / `{{persona}}` 一起進
    LEGACY_PROMPT_TOKENS，存量模板裡殘留時渲染為空串，不留字面量）。
    每層可「單獨覆蓋」：overrides[token] 有內容時用你的文本替換自動內容；
    留空 = 用自動內容。模板為空 = 預設模板（全部 token 按上面的順序），
    而只有「模板 / 覆蓋 / 停用項全空」時才走零開銷分支（before_agent_start 返回空，
    等同 SDK 預設拼裝）；出廠 `promptDisabled` 含 plugin_dev，所以預設走組合渲染。
    存量設定收斂（server/client-state.ts 的 normalizePromptOverrides / normalizePromptDisabled）：
    已下線來源鍵與停用項直接剔除；soul 覆蓋與內建預設逐字相同則丟掉（等於沒覆蓋）。

## 三、各來源自動內容從哪來（buildSystemPrompt 視角）

    基礎提示詞 base（resource-loader.discoverSystemPromptFile，按優先順序）：
        1. 專案級：<cwd>/.pi/SYSTEM.md（受信任時）
        2. 全域性級：<agentDir>/SYSTEM.md
        3. 都沒有 → undefined → SDK 預設分支拼出內建模板（persona + tools +
           guidelines + pi_docs）。注意：這段 SDK 自帶文本**不是** pi-web-ui 的內建預設，
           內建預設（六條工程準則 + 上面那套順序）由組合渲染產出。
    組合模式下 systemPromptOverride 恆返回 base（= SYSTEM.md 原文，沒有就 undefined）
    → 組合模板啟用時 before_agent_start 整體換掉提示詞（`{{soul}}` 用同一份 base），
    組合模板未啟用時 SDK 預設分支據此保留 .pi/SYSTEM.md（TUI 同語義；舊實現恆返回
    undefined，於是在「全預設 + 有 SYSTEM.md」的會話裡這份檔案被靜默丟棄）。

    base 的歸屬（issue #812，紅線）：
        override 是**回撥**，它推給宿主的 base 必須落在 **loader / session** 名下
        （`server/prompt-base-store.ts`，key = resourceLoader 物件），**禁止**存成
        ClientSession（= 一個瀏覽器客戶端）上的「最近一次觀察到的值」欄位。
        歷史事故：`lastBaseSystemPrompt` 只在 base 非空時更新，切到沒有 SYSTEM.md 的
        專案時沒人清舊值 → 上一個專案的系統提示詞漏進本專案的設定預覽與新建對話，
        只有恰好訪問一個「空白 SYSTEM.md」的專案才會被意外重置。
        口徑：
        - 記錄：每次 reload **無條件覆蓋**（base 缺失即寫空），沒檔案的專案永遠是空記錄；
        - 讀取：`readPromptBase(目標會話的 session.resourceLoader)` —— 預覽算哪個
          會話就讀哪個會話（回顧「拿活躍會話算後臺會話」的同類串賬）；
        - 過戶：搬的是 session 本體，記錄跟著走；session 銷燬後 WeakMap 自動回收；
        - 空白語義與 SDK 對齊：空串 / undefined = 沒檔案（用內建預設），純空白檔案
          = 空提示詞（`{{soul}}` 保留原文，不做 trim 回退）。
        守衛：tests/unit/prompt-base-{store,scope,isolation}.test.ts。
    專案上下文（loadProjectContextFiles）：候選 AGENTS.override.md > AGENTS.md >
        AGENTS.MD > CLAUDE.md > CLAUDE.MD；全域性 agentDir 一份 + cwd 逐級向上，
        包裝成 <project_context><project_instructions path="…">…</project_instructions></project_context>。
    技能段：可見技能（disableModelInvocation=false）formatSkillsForPrompt 輸出；
        read 工具不可用時省略。pi-web-ui skillsOverride 按停用集過濾。
    工作目錄行：`Current working directory: <正斜槓 cwd>`。
    Pi 包路徑（README.md / docs / examples）：隨安裝位置解析一次
        （require.resolve("@earendil-works/pi-coding-agent/package.json")）。

## 四、引擎（server/prompt-composer.ts，純函式、瀏覽器可複用）

    resolveSectionTexts(inputs) → 每 token 的自動內容
    renderPromptTemplate(template, texts, overrides) → {{token}} 替換
        - 覆蓋優先：overrides[token] 非空白 → 用之；否則 texts[token]
        - 未知 token 保留原文（UI 可提示 typo）
        - 自動內容為空的 token（如沒有 APPEND_SYSTEM.md 時的 {{append}}）展開為空串
    DEFAULT_PROMPT_TEMPLATE / PROMPT_TOKENS 供設定 UI（token 插入、恢復預設）。
    單測：tests/unit/prompt-composer.test.ts。

## 五、執行時整合（server/agent-service.ts）

    每個會話 runtime 註冊隱藏內聯擴充套件 <inline:pi-webui-persona>：
        before_agent_start（每個 agent run 前）—
            - 主會話：若配置了模板或任一覆蓋，用本次 run 的 systemPromptOptions
              （selectedTools / toolSnippets / promptGuidelines / contextFiles /
              skills 全是當時最新）渲染組合模板，替換該 run 的 systemPrompt 主體；
            - 子代理模板 replace：預設分支下把靈魂段換成模板提示詞（自動段保留）；
              模板 append 仍走 loader 追加段。
        鏈式保留（兩個分支共用）—— 我們是 before_agent_start 鏈上最後一個 handler
        （resource-loader 把內聯擴充套件排在所有檔案/包擴充套件之後），返回 systemPrompt 即
        forceSystemPrompt 整體替換，會把別的擴充套件寫進去的內容一起丟掉。所以先拆：
            splitAgentStartPrompt(event) → { pre, core, post }
                forceSystemPrompt 無值 = 沒人動過，core 即當前提示詞，pre/post 為空
                （零開銷，輸出與今天逐位元組一致）；
                有值 = 前面有擴充套件替換過，臨時清掉它再讀 event.systemPrompt 拿到 SDK
                原始基線，splitExtensionWrap(基線, 當前) 把首尾增補摘成 pre/post。
            渲染/換段只在 core 上做，最後 pre + 結果 + post 套回去。
        優先順序：使用者模板/覆蓋始終贏得提示詞主體，擴充套件只保住自己的首尾增補。基線不是
        原樣嵌在當前文本里時（擴充套件做了中間插入或整體替換）無法安全摘取，退回今天的
        行為（pre/post 為空），絕不把整段提示詞翻倍。完全預設（未自定義）時主會話仍
        返回 undefined，擴充套件的改動原樣生效。
        純函式 splitExtensionWrap 在 prompt-composer.ts，單測見
        tests/unit/prompt-composer.test.ts；設定面板預覽不跑擴充套件，因此預覽與真實 run
        會相差這部分擴充套件增補。
    設定改動無需 reload 即可在下一個 run 生效（逐 run 讀取 settingsSvc）；
    session.reload() 僅用於讓 loader 側（預設分支/技能過濾等）同步。
    設定面板預覽（settings_state.effectiveSystemPrompt）：用當前會話資源
        走同一渲染函式 —— 與真實 run 一致（只讀檢視）。

## 六、設定與遷移

    欄位（client-state.json / 協議 UiSettingsState）：
        promptTemplate: string           組合模板文本（空 = 預設模板）
        promptOverrides: Record<string,string>   每來源覆蓋
    舊存檔遷移（getSettings）：customSystemPrompt 非空時 —
        append → 文字成為 {{append}} 覆蓋（獨立追加塊）
        replace → 文字成為 {{soul}} 覆蓋
    遺留欄位 promptMode/customSystemPrompt 保留在資料結構裡（DSH 子系統與舊預設
    共用同一份 client-state 儲存，見 dsh-agent-service.ts），主會話 UI 不再使用。
    預設（SettingsPreset）新增捕獲 promptTemplate/promptOverrides，應用時舊預設
    缺欄位保留當前值。

## 七、設定 UI（SettingsModal → 「系統提示詞」頁）

    提示詞模板庫（只捕獲 prompt 欄位組的預設）：
        save_preset 訊息帶 groups:["prompt"] → snapshotPreset 經 narrowPresetToGroups 裁剪成只含
        prompt 組欄位（promptMode/customSystemPrompt/promptTemplate/promptOverrides/promptDisabled/
        reviewPrompt/reviewDisabledSkills）；推送時 settingsPresetToUi 用 isPromptOnlyPreset 打
        scope:"prompt" 標記。面板按 scope 過濾：模板庫只列 scope==="prompt"，預設頁/預設計數只列
        scope!=='"prompt"'。切換模板 = apply_preset（只回寫 prompt 組欄位）；刪除/分享/匯入全部複用
        預設通道（preset_export / preset_import / PresetShareModal），匯入的 prompt-only JSON 自動
        進模板庫。「使用中」判定：effectiveTemplate + 規範化覆蓋 map + promptDisabled 集合與服務端
        快照全等。
    提示詞來源（單列表：開關 + 中文名 + 一句話 + ↑↓；點名字就地展開編輯）：
        每行 = 開關（是否進入提示詞）+ 中文名/一句話說明 + 「已改|自動」標籤 + ≈tokens + ↑↓。
        點名字展開：可寫來源給編輯區（小標題 promptSec_<token>_edit，提示 _hint，留空 = 自動內容）
        + 「檢視預設內容」摺疊對照（可一鍵填入）；只讀來源只展示系統生成內容與「恢復預設」。
        展開區鋪滿整行（左右無留白，只有輸入框自身內邊距）—— .prompt-src-list / .prompt-src-body。
        模板串語義不變：開關走 promptDisabled（與舊「啟用」勾選同語義）；
        自定義模板：模板串就是唯一事實源（collectTemplateTokens 取序），開關= 增刪 token、
        ↑↓ = 相鄰交換；序列化 join("\n\n")，恰好等於預設串時歸零回 ""（零開銷預設分支）。
        預設順序下首次調整順序 → 物化為自定義模板（預設停用段不進模板，promptDisabled 不動）。
        舊模板含自由文字/未知 token 時展示警示：開關/順序編輯後只保留已啟用的來源段。
        setTemplateValue 與舊編輯框同一套提交紀律（與 serverSettings 不一致才發，回執前保草稿）。
    整體「恢復預設模板並清空所有覆蓋」按鈕（仍是逐 token 發空串，空物件補丁刪不掉）
    「檢視當前完整提示詞」只讀預覽 = 組合渲染結果
    文案鍵：promptTok_<token>（名稱）/ promptTok_<token>_desc（一句話）
        + promptSec_<token>_edit（編輯框小標題）/ promptSec_<token>_hint（留空提示）
        + promptSecEdited / promptSecShowDefault + promptAssembly* / promptTemplate*
        （zh/en 同步；其餘 12 個語言包預設回退英文，繁中包單獨寫繁體文案）

    儲存與回執（事實源 web/src/settings-sync.ts，迴歸 tests/settings-prompt-save-test.mjs
    + tests/unit/settings-sync.test.ts）—— 改這塊前必須讀懂四條：
    1. 任何修改先進 pending overlay（服務端快照 ⊕ 未確認補丁），只有服務端 settings_state
       回執與補丁值一致才移除。UI 因此不會因為一次未確認（或已失敗）的儲存回退舊值。
    2. promptOverrides / toolPromptOverrides 是 map 語義欄位（服務端「子鍵覆蓋、空串刪除」）。
       本地 overlay 用同一語義疊加，絕不把區域性 patch 當整值 —— 否則面板會把沒動過的 token
       當成已刪除，再把重建結果寫回服務端就是真丟配置。
    3. 草稿重建只重新整理未被本地佔用的 token（reconcileOverrideDraft）：正在編輯（focus）
       與已改未回執（dirty）的 token 永遠保留；服務端回執一致後才釋放 dirty。
    4. 頂部膠囊顯示真實回執狀態：saving / saved / failed（超時未確認或通道斷開）。failed
       可點選重試，禁止用定時器假裝「已儲存」。

    覆蓋框兩種落盤路徑：輸入後 800ms 自動提交（不依賴 blur）+ 失焦立即提交；
    關面板 / 切分割槽 / 解除安裝時 flushAllDrafts 再補一次（比對基準一律是服務端真值，
    不是疊加了 pending 的 settings）。
    「恢復預設模板並清空所有覆蓋」必須把現存 token 逐個發空串：空物件補丁在服務端
    是「不刪任何子鍵」，發 {} 等於什麼都沒清（歷史 bug，已有單測守衛）。

## 八、與子代理模板的關係

    子代理模板保留自身 append/replace 語義（角色化預設）：白名單過濾技能/擴充套件；
    replace 在無 SYSTEM.md 時把子代理預設分支的靈魂段換成模板提示詞；append 追加
    到該子代理的追加段。模板會話不套主會話組合模板（角色由模板定義）。主會話
    組合模板不影響模板派生的子代理。
    另外兩個模板維度與提示詞無關，在派發時（spawnSubagentConversation）套用：
    model（provider/id）與 thinkingLevel（off…max，見 server/subagent-templates.ts
    的 THINKING_LEVELS）。優先順序：顯式 model 引數 > 模板 model > 設定面板子代理
    預設模型 > 跟隨派發會話當前模型；thinkingLevel 無顯式引數，模板空值 = 跟隨
    派發會話當前強度（session.thinkingLevel）。兩者都在換模型之後套用，
    setThinkingLevel 會按模型能力收斂（reasoning:false → off，xhigh/max 需
    thinkingLevelMap），不傳 persist，隻影響該子代理會話。
    內建模板在 server/subagent-templates.ts 的 DEFAULT_TEMPLATES（含 oh-my-pi
    specialist 系列：oracle/librarian/explore/metis/momus/multimodal-looker/
    sisyphus-junior）；老使用者已有檔案時缺失的內建模板一次性補齊（sidecar
    subagent-templates.seeded.json 記已播種名單，刪後不再復活）。
    繁中檢視：resolveServerLang 把 zh-TW/zh-HK/zh-Hant 都折成 "zh"，繁中使用者
    會拿到簡體。localizeTemplate 按**原始 locale**（isTraditionalLocale）在內建
    模板的 description/systemPrompt 仍等於出廠簡中時，換成
    subagent-templates-hant.ts 的臺灣用語文案（三個繁中介面共用一份），用於設定
    快照、templates 工具與子代理系統提示詞；只是檢視，不回寫庫，使用者改過的欄位
    不動。canonicalizeTemplate 在 upsert 時把「恰為出廠繁中」的文字還原成簡中，
    避免繁中介面點一下開關就把全域性庫改寫成繁體。出廠簡中文案改動時，
    subagent-templates-hant.ts 必須同步（守衛：subagent-templates.test.ts）。

## 九、結構化派單與 skill 全文注入（oh-my-pi 精髓的原生移植）

    設定（client-state.json / 協議 UiSettingsState）：
        delegate_task: 結構化派單工具（server/delegate-task.ts），六段必填 + 服務端校驗
        skillsFullText: string[]        skill 全文注入名單（預設空 = 名錄模式）
    生效點（server/agent-service.ts）：
        before_agent_start 主會話分支 — SDK 拼好的提示詞（或組合模板渲染結果）
        delegate 六段拼裝 + 校驗打回（見 server/delegate-task.ts 的 validateDelegation）。
        composeInputs — skillsFullText 名單非空時 fillSkillContents() 最好努力讀名單裡
            技能的 SKILL.md 正文（單檔案 skillsMaxFileBytes、總量 skillsFullTextMaxBytes
            封頂，預設 8KB / 32KB，按 UTF-8 位元組計，GBK 回退經 decodeText），
            填進 PromptComposerInputs.skills[].content；{{skills}} 對名單技能按全文格式展開。
            skill 工具讀正文用同一個單檔案上限（skill-tool.ts 從宿主即時取），
            兩個設定項 0 = 顯式不設限（issue #819）。
    名單由 before_agent_start 逐 run 即時讀取：改完下一輪即生效，不走
    session.reload()（settings-service needsReload 不含它們）；設定預覽
    （sessionPromptSnapshot）走同一邏輯。DSH 引擎只透傳儲存值（切回 pi 生效）。
    預設捕獲名單（舊預設缺欄位保留當前值）。

## 相關原始碼定位

    - pi-web-ui：server/prompt-composer.ts（token/引擎/預設模板）、
      server/agent-service.ts（override + 內聯擴充套件 + 渲染預覽）、
      server/settings-service.ts / client-state.ts（設定持久化與遷移）、
      server/protocol.ts（UiSettingsState 欄位）、web/src/components/SettingsModal.tsx
    - SDK：dist/core/system-prompt.js（buildSystemPrompt 預設拼裝）、
      dist/core/resource-loader.js（SYSTEM.md / 上下文收集 / override 重放）、
      dist/core/extensions/runner.js（before_agent_start 鏈式替換）
