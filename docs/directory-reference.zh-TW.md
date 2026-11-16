[English](./directory-reference.en.md) · [简体中文](./directory-reference.md) · **繁體中文**

# 目錄樹參考（directory-reference）

> 來源：2026-09 精簡前的 `AGENTS.md` §3 全文（備份見 `AGENTS.md.bak`）＋ 之後新增檔案的補齊。
> 約定：`★` = 單源/入口，先讀；行內註釋裡的數字（工具個數、slot 個數等）以原始碼為準；
> 新增檔案先在樹裡佔位，註釋以後補（以各檔案頭註釋為準）。
> 新增頂層檔案 / `server/*.ts` / `web/src/*` / 元件時，同步更新本文件。

## 頂層

```
pi-web-ui/
├── server/                     # 後端（Node ESM，編譯到 dist/server/）
├── web/                        # 前端（React + Vite，編譯到 web/dist/）
├── bin/pi-web-ui.mjs           # CLI：前臺啟動 / server install|uninstall|start|stop|restart|status
├── desktop/                    # Electron 桌面殼（sidecar：隨機空閒口起 dist/server + BrowserWindow）
│   ├── main.ts                 # 主程序：ready → 選空閒口 → spawn server(ELECTRON_RUN_AS_NODE) → loadURL
│   ├── electron-builder.yml    # 打包配置（win nsis / mac dmg / linux AppImage；npmRebuild:false）
│   └── README.md               # 桌面版說明：跑起來 / 約定 / 釋出 / 簽名（SignPath）
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任務 XML
├── themes/                     # 內建主題（完整樣式表：:root 變數 + 任意選擇器/佈局覆蓋皆可，styles.css 只是共享基線）
├── make-light-theme.mjs        # 主題生成器（從 styles.css 的 :root 變數清單生成純調色盤）
├── tests/                      # 全部測試指令碼（自包含：獨立埠 ≥8900 + 臨時 data-dir）
│   ├── run-smoke.mjs           # 零 token 協議冒煙聚合跑器（ALL 列表；外掛後臺作業/目錄同步 plugin-jobs-test、多根工作區
│   │                           #   workspace-roots-test 都在裡面）
│   ├── unit/                   # vitest 純函式單測（外掛 UI 擴充套件點：plugin-ui-manifest / ui-slots / context-menu /
│   │                           #   plugin-grants / plugin-project / plugin-installer / plugin-catalog-sync；多根工作區：workspace-roots）
│   │                           #   外掛設定（宣告式 schema / select 候選值）：plugin-settings / plugin-setting-options
│   ├── *-test.mjs              # 手寫 Playwright E2E / WS 協議測試
│   │                           #   ⚠ 需 Chrome 的瀏覽器 E2E **不入 run-smoke**，手動 `node tests/<name>.mjs` 跑（缺 Chrome 自動 SKIP）：
│   │                           #     context-menu-ui-test（右鍵選單槽位）/ ui-layout-ui-test（佈局頁 ↔ 介面一致性）/ plugin-settings-page-test（外掛設定頁）/ plugin-settings-select-ui-test（外掛設定下拉）/ plugin-topbar-ui-test（頂欄條目 + 面板內後臺解除安裝）/ elsewhere-click-takeover-ui-test（「另一處」行左鍵兩段確認過戶）
│   └── scratch/                # 一次性除錯指令碼（gitignore，不入庫）
├── scripts/check-protocol-sync.mjs  # 守護 types.ts shim 單源機制 + protocol.ts 純型別約束
├── scripts/safe-exec.mjs       # 跨平臺防卡死執行器：stdin 接地 + 硬超時/空閒超時殺程序樹（複用 killPidTree）+ 日誌落盤 + --detach 守護程序託管 + --wait/--status(JSON) 輪詢；日誌落 .safe-exec/（gitignore）
├── .github/workflows/ci.yml    # CI：協議同步 → typecheck → build → vitest → 冒煙
├── .github/workflows/release-notes.yml   # tag 推送 → 按 CHANGELOG 建/更新 GitHub Release
├── .github/workflows/desktop-release.yml  # tag 推送 → windows-latest 出 NSIS 安裝包並附到 Release（簽名以後加這裡）
├── extensions/                 # pi 擴充套件：webui.ts（/webui 命令啟動本機服務並開啟瀏覽器）
├── plugins/                    # 官方外掛（webmail / db-client / vscode-editor / sftp / demo-mailbox / mermaid / run-trace / legado-web / wechat-ilink / image-toolkit / notes / live-preview / voice-input / desktop-use / pm2-manager，各自的 README.md 見其目錄；page-picker/extension 是**瀏覽器擴充套件**，不是 pi-web-ui 外掛）
│   └── catalog.json            # ★ 外掛市場內建列表（隨包釋出；只收本倉庫自帶的 plugins/<id>，第三方外掛走社群清單倉庫）
├── dev/                        # 本地開發輔助（notice/search 預覽等，不入 npm 包）
├── Dockerfile / docker-compose.yml
├── docs/                       # 詳細文件（architecture-core / architecture-attachments / architecture-terminal /
│                               #   architecture-plugins / architecture-system-prompt / goal-conversation-design /
│                               #   tool-context-budget / agent-rules（編碼紅線細則）/
│                               #   device-center / device-collaboration / architecture-canvas / architecture-sandbox /
│                               #   development / release / deployment / dsh-engine / antigravity-proxy / env-vars ＋ 本檔案）
└── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

## server/

```
server/
├── index.ts                # 入口：express 靜態 + /ws 端點、訊息分發、心跳、優雅停機
├── protocol.ts             # ★ 唯一事實源：wire 協議型別（client↔server 訊息）
├── protocol-version.ts     # wire 協議版本（新舊端互斥時頂掉舊 tab）
├── agent-service.ts        # 核心：ClientSession（每客戶端一個會話組，可並行多個對話）+ AgentService
├── serialize.ts            # SDK 訊息 → UiMessage 序列化
├── message-window.ts       # 歷史訊息服務端按需載入：尾部視窗（條數 + 字元預算）+ load_earlier_messages 往前翻頁；掛在每連線 send 漏斗上，四引擎通吃
├── text-sniff.ts           # 檔案預覽純函式（previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines）
├── queue-utils.ts          # 排隊訊息純函式（removeFirstOccurrence：只移除第一條匹配，重複文本不連帶刪除）
├── process-utils.ts        # 程序工具：snapshotListeningPorts/killPidTree/lookupProcessName
├── client-state.ts         # ClientStateStore：<dataDir>/client-state.json 持久化
├── uploads.ts              # 檔案對話上傳 + 保留期清理
├── bg-servers.ts           # 後臺任務跟蹤（bash 前後埠快照 diff + 存活重新整理 + 閒置超閾值自動清理/📌釘住）
├── settings-service.ts     # 設定面板狀態機
├── preset-share.ts         # ★ 設定預設的匯入/匯出/分享/社群目錄（交換格式 pi-web-ui-preset v1：白名單淨化、SSRF 收口、gh issue 回落預填網頁、index.json 目錄 5 分鐘快取；編排走 PresetSharePort，見 docs/preset-sharing.md）
├── preset-fields.ts        # 預設可攜帶的欄位清單 + 分組（零依賴，前後端共用；編譯期守衛對齊 ClientSettings 全集）
├── goal-service.ts         # 目標/審查迴圈/調研嚮導
├── i18n.ts                 # 服務端語言協商 + 翻譯表註冊（resolveServerLang/pick/bilingual/getServerBlock）
├── locales.ts              # 可下載語言包（核心只含 zh/en，其餘語言走語言包 serverStrings 節）
├── tool-manager.ts         # ★ Agent 工具統一開關：AGENT_TOOL_CATALOG ＋ tool_manage 出入口（setAgentToolEnabled/applyAgentToolsGating），持久化只有 disabledAgentTools
├── tool-approval.ts        # 人機協同攔截與改寫執行（HITL：Edit & Run），門禁在 ClientSession.askApproval
├── approval-rules.ts       # ★ 審批規則庫與匹配引擎（ApprovalRulesStore：<dataDir>/approval-rules.json，多工具/多欄位/多模式規則；ask/deny/allow 三種動作；純函式評估）
├── compact-context-tool.ts # ★ 主動壓縮上下文工具（compact_context）：AI 主動根據當前任務精簡上下文，自主控制保留範圍並在回合後生效
├── compaction-markers.ts   # 壓縮 transcript 標記 + 修復（issue #235）
├── context-budget.ts       # 多級分層上下文預算裁剪（觸發 LLM 全文摘要之前的梯度裁剪）
├── soft-cap.ts             # 自定義上下文壓縮軟上限（Soft Cap，issue #229/#773；純函式 normalize/effective/softCapToReserve/softCapReserveFor：後者算出注入 SDK 的 reserve=cw-cap，回合內工具間隙即壓）
├── dangling-tools.ts       # 懸空 toolCall 檢測與修復（issue #280）
├── edit-tool.ts            # 覆蓋內建 edit：原樣轉發精確替換，`soft: true` 時改走行核心匹配（原 edit_soft 工具已合併進來，無獨立開關）
├── read-tool.ts            # 覆蓋內建 read：路徑是目錄時列目錄條目（複用 SDK ls 的口徑，其餘原樣轉發內建；行為開關 readDirEnabled 在設定「工具」頁，不入 AGENT_TOOL_CATALOG）
├── present-files-tool.ts   # ★ AI 展示檔案（present_files）：只讀探測 stat/未知擴充套件嗅探/文本摘錄 → 結構化 items 走 toolResult 的 details → 前端預覽卡片；不自動開啟任何視窗
├── skill-tool.ts           # 讓 AI 按名取技能全文（名錄 + skill 工具）
├── claim-files-tool.ts     # 檔案認領（claim_files）：並行衝突的事前打招呼
├── claim-store.ts          # 檔案認領表（claim store）+ 觸碰 sidecar
├── conversation-read-tool.ts # 讓 AI（含子代理）讀取別的對話（list 看執行+歷史，read 分頁讀）
├── conversation-touches.ts # 會話「觸碰檔案集」提取（純函式，零 node 依賴）
├── question-params.ts      # ★ 結構化提問 schema 單源（富檔給 ask_user_question；communicate / conversation 只收純文本 message，問題/回答在狀態機折成內部結構）
├── delegate-task.ts        # 結構化派單工具 delegate_task（委派協議的程式碼級硬化）
├── eval-tool.ts            # 受控的持久程式碼求值沙箱工具（eval，opt-in）
├── hashline-engine.ts      # 基於內容雜湊錨定與語法塊解析的高可靠 Patch 引擎
├── patch-tool.ts           # 匯出給 AI 的結構化補丁工具（Hashline Patch Tool）
├── lsp-tool.ts             # 匯出給 AI 的原生 LSP 語言伺服器工具
├── plan-manager.ts         # 結構化任務計劃看板與步驟狀態機（Plan Mode / Step State Machine）
├── schedule-agent-tool.ts  # 把內建排程器暴露給 Agent（issue #193）
├── scheduler-tasks.ts      # 內建定時任務排程（issue #184）：任務 CRUD + cron/間隔觸發 + 無頭執行
├── tool-info.ts            # 工具定義說明（工具卡右鍵 → 顯示工具詳細資訊）：按名現取 SDK / DSH 執行時的工具定義 → `tool_info`（定義是大物件，不進快照；DSH 拿不到時回 `unsupported`）
├── tool-prompt-overrides.ts # 逐工具文案覆蓋（設定→工具區「編輯文案」）：歸一化 + 給會話 _toolRegistry 打 description/snippet/guidelines 補丁（出廠定義永不動，可復原）
├── load-tools-tool.ts      # 工具延遲載入入口（load_tools）：目錄（名字 + 一行摘要）在系統提示詞裡，模型按需把引數 schema 拉進本對話
├── tool-prompts.ts         # bash / edit 工具模型可見文案（description/snippet/guidelines/引數 schema）的唯一事實源（多條執行路徑共用）
├── subagents.ts            # 第一方子代理：唯一的 conversation 工具（spawn/get_result/steer/list/stop/templates/wait_all/handoff）+ 執行態快照
├── subagent-templates.ts   # 子代理模板庫（全域性 <dataDir>/subagent-templates.json；白名單語義；可選模型/思考強度，空=跟隨主對話；enabled=false 對 AI 不可見）
├── subagent-templates-hant.ts # 內建子代理模板的繁中（臺灣用語）文案；zh-TW/zh-HK/zh-Hant 共用，僅作展示/取用檢視，不回寫庫
├── wait-subscription-scan.ts # 掛起 wake 訂閱掃描（保留帶 pending 子代理 wake 的對話）
├── slash-commands.ts       # 斜槓命令（NATIVE_COMMANDS 內建命令攔截執行 + 目錄推送）
├── prompt-composer.ts      # 主會話系統提示詞自由組合模板（{{token}} 在每次 run 前展開）
├── model-admin.ts          # 模型/服務商配置管理（含內建服務商多金鑰：provider-keys.json + add/activate/remove_provider_key，模型目錄複用系統預設，不復制；閘道器 /models 自報的 reasoning_levels / supported_reasoning_levels[].effort 會推導成模型級 thinkingLevelMap 並貫穿儲存/合併/下發，見 issue #771）
├── model-enrich.ts         # 用公開模型目錄給自定義供應商的模型行補引數
├── provider-oauth-flow.ts  # 見檔案頭註釋
├── resolve-global-sdk.ts   # 優先用全域性/祖先那份 pi SDK 的解析鉤子（issue #260）
├── sdk-origin.ts           # 本程序實際載入的是哪份 pi SDK 及被遮蔽的副本（issue #260）
├── update-check.ts         # 全源更新檢查（本體 / pi core / DIRECT 擴充套件）
├── managed.ts              # 外部託管例項（自更新：頂欄更新徽標 + 面板）
├── attachments.ts          # 附件構建（路徑/行範圍引用 + imageData/fileData + 視覺橋；內容不注入）
├── attachment-store.ts     # 基於 SHA-256 內容定址（CAS）的附件儲存
├── file-archives.ts        # 見檔案頭註釋
├── file-transfer-routes.ts # 見檔案頭註釋
├── office-parse.ts         # Office 文件純文本提取（docx / xlsx，供預覽與附件走 file_content 用）
├── composer-drafts.ts      # 未傳送輸入框草稿單中心檔案（<dataDir>/composer-drafts.json，issue #166）
├── webui-context.ts        # 擴充套件 UI 橋（WebUIContext：widgets/statuses/dialog → 瀏覽器）
├── themes.ts               # 主題管理（listThemes/resolveThemeFile）
├── tabs.ts                 # 例項能力頁籤選擇（Chat / Terminal / Git / Search / …）
├── plugins.ts              # 可選介面元件外掛（掃描 <dataDir>/plugins/<id>/ 程式碼；狀態在 <dataDir>/plugin-data/<id>/；renderer 外掛欄位 view:false + renderers）
├── plugin-api-catalog.ts   # 機器可讀的註冊面目錄（slot 的 key/kind/occupants/example）
├── plugin-catalog.ts       # 外掛市場列表（builtin plugins/catalog.json + 使用者自定義 <dataDir>/plugin-catalog.json）+ 目錄同步純函式（normalizeSyncPayload/writeCustomCatalog，issue #148）
├── plugin-catalog-sync.ts  # 市場目錄同步編排（拉取/校驗/原子寫/可選安裝/過載+重推，issue #148）
├── plugin-conversation-view.ts # ★ 外掛會話快照選會話策略（#542：按 clientId 取本標籤頁正看的對話 / 預設跳過子代理回落 + 模型變更去重鍵，純函式）
├── plugin-dom.ts           # 特權 DOM 訪問授權表（<dataDir>/plugin-dom.json）
├── plugin-facilities.ts    # 外掛宿主設施：外掛私有 KV 儲存 + 加密 secrets
├── plugin-grants.ts        # 外掛目錄授權表（<dataDir>/plugin-grants.json）：工作區外目錄的「記住」授權（父目錄覆蓋子目錄），設定面板可撤銷
├── plugin-install-spec.ts  # 「安裝前先讀 spec」（引導式安裝）
├── plugin-installer.ts     # ★ 外掛後臺作業：安裝/更新/解除安裝跑 CLI 子程序（不佔使用者終端、不打斷設定面板），輸出按行回傳 + 單作業鎖 + 看門狗（issue #152）
├── plugin-llm.ts           # 外掛直調模型（host.llm.complete 的底層：一次性孤立無工具會話）
├── plugin-manifest-validate.ts # manifest 本體校驗（schema 失敗即拒）
├── plugin-permissions.ts   # 外掛能力動態授權表（host.requestPermission 的底層）
├── plugin-project.ts       # ★ 外掛專案組裝執行層（host.project.create：clone/寫檔案/git init；路徑越界三道校驗，授權由上層判，本模組不動授權）
├── plugin-bundled.ts       # 隨包外掛首次物化（內建模組 + catalog 裡 `preinstall` 的候選；回執裁定「已裝好」，半殘目錄就地修，issue #856）
├── plugin-materialize.ts   # ★ 外掛目錄物化單源：staging + 驗收 + 回執（.pi-materialized.json）/ 只補缺 / 覆蓋式升級
├── plugin-paths.ts         # ★ 外掛程式碼目錄與狀態目錄的單源（`plugins/<id>` = 純快取；`plugin-data/<id>` = 設定/機密/定時，老佈局冪等遷移）
├── plugin-schedule.ts      # 外掛定時任務的 cron 解析與持久化（host.schedule 的底層；schedules.json 寫狀態目錄）
├── plugin-tool-guard.ts    # 外掛工具攔截擴充套件點（pre + post，只覆蓋已接管的 bash/read）
├── plugin-updater.ts       # 外掛更新輔助（程式碼目錄備份/回滾 + 遠端 sha 對比；狀態目錄不參與）
├── fs-copy.ts              # ★ 目錄複製原語：跳過項按**相對路徑**判定（絕對路徑含 node_modules 會把整棵樹過濾光），附檔案清單/清理空目錄
├── mcp-bridge.ts           # MCP 工具橋（外部 stdio MCP 伺服器的工具接入 pi 會話）
├── mcp-hot-reload.ts       # mcp.json 熱載入（改完即生效，不重啟）
├── icon-svg.ts             # 外掛內聯 SVG 圖示（manifest `iconSvg`）校驗與規範化
├── host-metrics.ts         # 見檔案頭註釋
├── http-proxy.ts           # 代理設定透傳（~/.pi/agent/settings.json + 環境變數）
├── auth-cookie.ts          # pi_web_token cookie 編解碼（decodeCookieToken；髒值原樣返回）
├── auth-login.ts           # 未登入頁表單登入契約（POST /__pi/auth 回跳清洗 sanitizeNextPath）
├── vision-bridge.ts        # 視覺橋：純文本主模型看圖轉寫
├── files-service.ts        # 檔案服務（readDirForUI/readFile/searchFiles/watcher）
├── workspace-snapshot.ts   # 工作區版本影子快照（Workspace Snapshot / Dual-State Rollback）
├── scm.ts                  # SCM 只讀 git 查詢（execFile git status/branches/history/filediff/commit）
├── scm-commitmsg.ts        # AI commit-message 生成（prompt 拼裝 + 回覆清洗；git 採集在 scm.ts）
├── patch-node-pty.ts       # node-pty × Node --watch 相容自愈補丁
├── patch-remote-catalog.ts # pi.dev 模型目錄整表替換補丁（冪等改寫 SDK remote-catalog-provider：重新整理後內建服務商列表=官方目錄整表，不保留內建舊模型/不報“新增 N 個”）
├── ensure-bash.ts          # Windows 輕量 bash 兜底（busybox-w32）
├── control-socket.ts       # 本地控制 socket（status / quiesce / unquiesce）
├── launch-origin.ts        # ★ 啟動來源探測：本例項是否被 launchd/systemd/Windows watchdog 託管（更新面板「重啟服務」的前置條件）
├── terminals.ts            # TerminalManager（PTY 管理 + 增量輸出/按鍵工具）
├── marker-service.ts       # 標記服務（內建版 pi-marker-tools）
├── dsh/                    # DSH 引擎（詳見 docs/dsh-engine.md）：dsh-agent-service / dsh-client / dsh-serialize /
│                           #   dsh-sessions / dsh-usage（底欄統計純對映）/ preset-clones（file: 克隆）/ probe-*.mjs /
│                           #   runtime/{launcher.mjs, goal-rpc.mjs（問卷 answerer + 技能鉤子掛 agent scope）, custom-prompt.mjs, cordis.yml, override.patch.yml, runtime-root.mjs}
└── markers/                # 標記子系統（配 marker-service.ts）：index / marker / registry / store / builtins
```

## web/src/

帶註釋的是常用/有機制的模組；其餘按檔名自解釋，讀原始碼（`use-*.ts` 均為 React Hook，`*.css` 只有 model-management.css 一個例外）：

```
web/src/
├── App.tsx             # 頂層佈局
├── main.tsx            # 入口：首幀前應用主題防閃爍 + initAuthToken
├── use-chat.ts         # ★ useChat()：WebSocket 連線管理、reducer 狀態機、終端 bridge
├── app-globals.ts      # ★ 全域性執行態 store（engine/managed/tabs/版本號 + 全域性傳送器 appSend）
├── types.ts            # ★ wire 協議 re-export shim（export type * from "../../server/protocol"）
├── protocol-version.ts # 協議版本常量
├── i18n.tsx            # ★ 多語文案（核心 zh/en；新 key 兩處都加；value 只許字串字面量，見 docs/agent-rules.md「三、UI 佈局與樣式規範」）
├── pick-locale.ts      # 語言選擇輔助
├── styles.css          # ★ 全部樣式（按元件分割槽，帶註釋分隔線）；也是預設深色主題本體
├── model-management.css # 模型管理頁專用樣式（唯一的第二個 css）
├── theme.ts            # 主題切換（/api/themes 列表 + localStorage 持久化 + applyTheme）
├── wallpaper.ts        # 桌布（主題伴隨資源）
├── sounds.ts           # WebAudio 提示音
├── notify.ts           # 桌面/OS 通知（PWA）：是否吞掉通知的判定（Windows 最小化檢測）+ 診斷
├── download.ts         # 下載（fetch→blob，繞開 Chrome Safe Browsing）
├── base-url.ts         # appUrl()：服務端 URL 包應用根字首（子路徑部署必需）
├── auth-token.ts       # PI_WEB_TOKEN 口令注入
├── ui-slots.ts         # ★ 宿主 UI 擴充套件點引擎：BUILTIN_UI_ITEMS + buildUiSlots（宿主預設→外掛貢獻→外掛 arrange→使用者偏好 四層合併）+ splitOverflow/restoreUiItem
├── slot-toolbar.tsx    # 各元件 *HostNodes + renderMergedToolbar
├── topbar-fit.ts       # ★ 頂欄「放不下的自動進 ⋯」純函式（fitTopbar）：按實測寬度從尾部丟，寬度 0 的條目不佔位也不進選單，測不到寬度全保留，有單測
├── context-menu-state.ts # ★ 通用右鍵選單狀態（contextmenu.* 槽位的 open/close + 定位/停用/鍵盤導航純函式，有單測）
├── use-floating-panel.ts # ★ 浮層統一 Hook（scroll/resize 只重算錨點；mousedown/Escape 才關）
├── composer-bridge.ts  # ★ 輸入框注入橋：宿主（擴充套件/外掛）把內容塞進輸入框草稿的模組級 sink 註冊點，有單測
├── composer-draft.ts   # 草稿合併/去重 + advanceComposerSession（附件跟會話走）純函式，有單測
├── use-composer-session.ts # 輸入框會話繫結 Hook
├── caret-visual-line.ts # ★ 輸入框游標的首/末視覺行判定（映象 div 量 offsetTop），供 ↑/↓ 翻輸入歷史用，有單測 + 真瀏覽器迴歸
├── prompt-history.ts   # 輸入歷史（↑/↓）儲存
├── message-delta.ts    # message_delta 增量 patch 純函式，有單測
├── lazy-window.ts      # 訊息列表惰性視窗化純函式，有單測
├── search-folded.ts    # 摺疊區搜尋輔助
├── present-items.ts    # ★ present_files 卡片純函式（引數解析/與 details 合併/能力判定/自動開啟閘門），有單測
├── present-settings.ts # 卡片偏好：自動開啟預覽彈窗（localStorage，預設關）+ 已開過的 toolCallId 去重表
├── file-preview-bridge.ts # 工具卡片 → 檔案預覽彈窗的模組級 sink（App 註冊 opener）
├── file-transfer.ts    # 檔案傳輸前端邏輯（配 FileTransferDialog + file-transfer-routes）
├── tool-info-state.ts  # 工具定義彈窗的模組級 store（開啟/關閉/應答 → 檢視，純函式 + 單測）
├── footer-status.ts    # ★ 底欄「內建狀態槽」模組倉（外掛 setFooterStatus → host:cost 那一格；`content.render` 交給宿主跟隨浮層，useSyncExternalStore）
├── tool-prompt-state.ts # 逐工具文案編輯器的預設值 store（get_tool_prompt 應答 → 檢視，純函式）
├── tool-schema.ts      # 引數 JSON Schema → 表格行（引數名/型別/必填/說明，純函式 + 單測）
├── tool-args.ts        # 工具卡頭引數提示純函式（路徑/超時安全提取，髒引數不拋錯），有單測
├── skill-block.ts      # parseSkillBlock：<skill> 塊解析，有單測
├── image-paste.ts      # 貼上圖片等比縮放 ≤1568px + PNG/JPEG 轉碼
├── message-image.ts    # 訊息內圖片渲染輔助
├── export-image-state.ts # 圖片匯出狀態
├── uuid.ts             # randomUuid（crypto 兜底），有單測
├── pending-question.ts # 待答問卷恢復（UiState.pendingQuestion → 恢復對話方塊）
├── optimistic-queue.ts # 流式排隊/插隊訊息與撤回的本地樂觀更新與權威快照對賬純函式（有單測）
├── question-attachments.ts # 問卷附件 chips
├── plugin-host.ts      # 外掛宿主橋（window.__piWebUiHost，宿主 API 時序）
├── plugin-loader.ts    # 外掛 client bundle 載入（含 view:false 懶載入 / preload 預載入）
├── plugin-fence.ts     # fenced-code 渲染外掛匹配
├── plugin-file-handlers.ts # 外掛檔案處理器
├── plugin-logs.ts      # 外掛日誌檢視資料
├── plugin-phase.ts     # 外掛生命週期階段
├── plugin-setting-options.ts # 外掛設定 select 候選值
├── plugin-icon.tsx     # 外掛圖示渲染
├── at-mention.ts       # @ 提及補全
├── slash-filter.ts     # 斜槓命令過濾
├── quick-phrases.ts    # 快捷短語
├── conv-groups.ts      # 對話分組（左欄）
├── copy-text.ts        # 複製文本輔助
├── use-copy-feedback.ts # 複製反饋 Hook
├── scroll-classify.ts（在 components/，見下）
├── banner-notice.ts    # 頂欄公告條資料
├── browser-control.ts  # 瀏覽器操作橋邏輯（配 BrowserControl 元件 + page-picker 擴充套件）
├── cache-stats.ts      # 快取統計（底欄）
├── chat-width-settings.ts # 聊天列寬設定
├── code-lines.ts       # 程式碼行號輔助
├── desktop.ts / desktop-updater.ts # 桌面殼前端側（更新檢查/重啟）
├── model-usage.ts      # 模型用量統計
├── panel-sash.ts       # 面板分隔條（拖拽調寬）
├── provider-oauth-state.ts # 服務商 OAuth 前端狀態（配 ProviderOAuthControls）
├── rollback-state.ts   # 回滾（workspace-snapshot）前端狀態
├── scm-commit-history.ts / scm-history-filter.ts / scm-quote.ts / scm-sidebar.ts # SCM 面板輔助模組
├── scrollbar-gutter.ts # 捲軸槽位
├── shortcut-stack.ts   # 快捷鍵棧
├── stream-markdown.ts  # 流式 Markdown 渲染
├── swipe-drawer.ts / use-swipe-drawer.ts # 手機端抽屜橫滑手勢（純判定 + DOM 粘合）
├── term-touch.ts       # 終端觸屏支援
├── thinking-levels.ts  # 思考強度檔位
├── tip-position.ts     # 提示定位
├── title-settings.ts   # 標題設定
├── token-input.ts      # Token 輸入框
├── touch-device.ts     # 觸屏裝置判定（IS_TOUCH）
├── update-command.ts   # 更新命令拼裝
├── use-click-outside.ts # 點選外部關閉（浮層通用）
└── components/         # 見下
```

## web/src/components/

| 元件                                                                                      | 職責                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePreview.tsx`                                                                         | 檔案預覽彈窗：行號、點選/拖拽/Shift 選區、新增到對話；Markdown 預覽可切換原文；可編輯儲存                                                                                                                                                            |
| `PluginFilePreview.tsx`                                                                   | 外掛提供的檔案預覽器宿主                                                                                                                                                                                                                             |
| `PresentedFiles.tsx`                                                                      | `present_files` 工具卡片正文：圖片/影片/音訊內聯顯示/播放，文本開頭摘錄 + 「預覽」按鈕；每行「預覽/本地開啟/在資料夾中顯示/下載/複製路徑」；`focus` 條目按偏好自動彈預覽窗（三道閘）                                                                 |
| `ToolInfoDialog.tsx`                                                                      | 「工具詳細資訊」彈窗（工具卡右鍵）：展示工具**定義**（說明/引數 schema 表格+原始 JSON），點開現取不進快照；portal 到 body（訊息流祖先有 overflow/transform）                                                                                         |
| `ToolPromptEditor.tsx`                                                                    | 逐工具文案編輯器（設定→工具區「編輯文案」）：description/snippet/guidelines 三欄位，留空=預設；儲存走 `set_settings.toolPromptOverrides`                                                                                                             |
| `ToolApprovalDialog.tsx`                                                                  | 審批彈窗（ask 規則命中時的人機協同攔截 + 改寫執行）                                                                                                                                                                                                  |
| `LeftPanel.tsx`                                                                           | 左欄：最近專案、執行的對話、歷史對話（含刪除）                                                                                                                                                                                                       |
| `RightPanel.tsx`                                                                          | 右欄標籤容器（檔案樹 / 原始碼管理 / 外掛標籤）：檔案樹瀏覽（list_files），檔名點選→預覽，🔗 引用路徑（僅路徑，無內容注入）/👁 預覽/⬇ 下載等按鈕；服務端原生遞迴 watcher                                                                               |
| `ChatInput.tsx`                                                                           | 輸入框 + 附件 chips（引用/行範圍/圖片/上傳/網頁/對話多彩）；全視窗拖放目標；followUp 排隊/steer 插隊；斜槓命令選擇器                                                                                                                                 |
| `Message.tsx` / `MessageList.tsx`                                                         | 訊息渲染（附件卡片、流式游標、tool 結果關聯）；編輯重問保留原附件；技能卡片摺疊；惰性視窗化；問題導航雙通道；流式 StreamMarkdown                                                                                                                     |
| `StreamMarkdown.tsx`                                                                      | 流式 Markdown 渲染元件（配 stream-markdown.ts）                                                                                                                                                                                                      |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock`                                   | 工具呼叫卡片（卡頭關鍵引數提示 `.toolcall-path`/`.toolcall-timeout`，髒引數靜默不顯示）、思考塊、bash 輸出                                                                                                                                           |
| `TerminalPanel.tsx` / `TermXterm.tsx`                                                     | 終端檢視 + xterm 例項橋接；例項 tab 條在面板頭，左列是常駐命令欄（`.term-cmd-rail`，寬度可拖）、右列頂部才是 tab 條，窄屏退成蓋住右列的二級頁                                                                                                        |
| `BottomDock.tsx`                                                                          | 底部全寬麵板：高度（`pi-web-ui:bottom-dock-h`）、摺疊、拖拽把手、多標籤全掛載（終端 + 外掛 `bottomdock.tabs`）                                                                                                                                       |
| `SCMPanel.tsx`                                                                            | 原始碼管理（Git）檢視：status/branch/diff；提交/推送/拉取/切換分支；左欄寬度可拖分隔條調、雙擊復位、寬度存 localStorage（#139）                                                                                                                      |
| `BrowserControl.tsx`                                                                      | 頂欄「瀏覽器」入口 + 狀態面板；已授權頁面一鍵「引用到對話」（單頁面時按鈕直接變頁面標題）                                                                                                                                                            |
| `TopBar.tsx` / `FooterBar.tsx`                                                            | 頂欄（模型/思考強度/後臺任務/聲音/新對話/檢視切換）、底欄（上下文/成本/工作目錄）；單一扁平流，slot 順序直排 + `hostNodes`                                                                                                                           |
| `FooterSlotPopover.tsx`                                                                   | 底欄內建狀態槽的跟隨浮層**外殼**（宿主所有）：portal + `use-floating-panel` 定位（預設貼錨點上方、塞不下翻轉、夾進視口）+ 滾動/resize 跟隨 + 點外/Esc 關閉 + 焦點歸還；外掛只通過 `footer-status.ts` 的 `content.render(container)` 填內容，不碰外殼 |
| `Dialog.tsx`                                                                              | 擴充套件 `ui.select/confirm/input` → 瀏覽器彈窗（正文/選項走 `Markdown(rawHtml)` 富渲染）                                                                                                                                                            |
| `Modal.tsx`                                                                               | 通用彈窗殼                                                                                                                                                                                                                                           |
| `QuestionDialog.tsx`                                                                      | 模型提問對話方塊（`question_pending`，DSH 經 goal-rpc / pi 經 `ask_user_question` 共用）：單選/多選/自定義文本 + 選項 `preview` 富文本；掛 `UiState.pendingQuestion`，重新整理後恢復                                                                 |
| `DshPresetBar.tsx`                                                                        | DSH Agent 預設條（模式切換 + 首輪鎖定）                                                                                                                                                                                                              |
| `DshPermissionBar.tsx`                                                                    | DSH 許可權提示條                                                                                                                                                                                                                                     |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx`                                               | models.json 管理 / 首次配置引導                                                                                                                                                                                                                      |
| `ProviderOAuthControls.tsx`                                                               | 服務商 OAuth 授權控制元件                                                                                                                                                                                                                            |
| `SettingsModal.tsx`                                                                       | 設定面板（擴充套件分組並排技能/MCP/外掛三個選單；外掛頁分「安裝的外掛 / 外掛市場」；DSH 另有問卷頁、補丁頁，無工具頁）                                                                                                                               |
| `InstalledPluginsPanel.tsx`                                                               | 安裝的外掛單列摺疊列表：介面外掛 + Pi 擴充套件同列表，點行展開配置/外掛頁/日誌或註冊能力，啟停分別寫回兩個欄位                                                                                                                                       |
| `PluginSettingsForm.tsx`                                                                  | 外掛宣告式設定表單（schema 驅動）                                                                                                                                                                                                                    |
| `PromptTemplates.tsx`                                                                     | 提示詞模板管理                                                                                                                                                                                                                                       |
| `GoalBar.tsx`                                                                             | 輸入框上方目標條：設目標/清除/AI 提煉/輪數下拉                                                                                                                                                                                                       |
| `PlanBoard.tsx`                                                                           | 結構化任務計劃看板（配 plan-manager.ts）                                                                                                                                                                                                             |
| `BgTasksModal.tsx`                                                                        | 後臺任務彈窗：AI 啟動的監聽埠程序列表                                                                                                                                                                                                                |
| `SchedulerPanel.tsx`                                                                      | 定時任務面板（配 scheduler-tasks.ts）                                                                                                                                                                                                                |
| `ModelThinking.tsx`                                                                       | 模型 + 思考強度下拉（按服務商篩選 + 頂部搜尋）                                                                                                                                                                                                       |
| `GlobalSearchModal.tsx`                                                                   | 全域性搜尋彈窗（Ctrl+K）：搜歷史對話/最近專案/工作區檔名；結果行右鍵選單走 `contextmenu.search`                                                                                                                                                      |
| `ProjectPicker.tsx`                                                                       | 專案選擇器                                                                                                                                                                                                                                           |
| `LocaleModal.tsx`                                                                         | 語言切換彈窗                                                                                                                                                                                                                                         |
| `PluginView.tsx`                                                                          | 外掛檢視宿主：薄 React 殼 + 動態 import client bundle                                                                                                                                                                                                |
| `PluginViewFallback.tsx`                                                                  | 外掛檢視載入失敗兜底                                                                                                                                                                                                                                 |
| `PluginFenceBlock.tsx`                                                                    | fenced-code 渲染外掛塊（配 plugin-fence.ts）                                                                                                                                                                                                         |
| `PluginMenu.tsx`                                                                          | 外掛菜單面板（浮層，走 useFloatingPanel）                                                                                                                                                                                                            |
| `PluginModal.tsx`                                                                         | 外掛彈窗宿主（host.openModal）                                                                                                                                                                                                                       |
| `SlotTabs.tsx`                                                                            | slot 驅動的 tab 容器（`rightpanel.tabs` 與設定面板共用）：除當前選中項一律不掛載，切走即 cleanup；只有一個標籤時不畫標籤條；選中態存 localStorage                                                                                                    |
| `SlotErrorBoundary.tsx`                                                                   | slot 內容錯誤邊界                                                                                                                                                                                                                                    |
| `ContextMenu.tsx`                                                                         | 通用右鍵選單渲染層（`contextmenu.*` 槽位）：portal + fixed + 先渲染再實測尺寸鉗制；只渲染，點條目交回宿主 `onAction`                                                                                                                                 |
| `PluginPage.tsx`                                                                          | 外掛自定義設定頁宿主（`settings.pages` 槽位）：隨選中項掛載/解除安裝；容器子節點只由外掛寫                                                                                                                                                           |
| `CollapsedMessage.tsx` / `LazyMount.tsx`                                                  | 訊息摺疊摘要行 / 訊息級惰性掛載包裝                                                                                                                                                                                                                  |
| `SearchBar.tsx`                                                                           | 會話內搜尋欄（Ctrl+F，CSS Custom Highlight API 高亮）                                                                                                                                                                                                |
| `HoverDetail.tsx`                                                                         | 懸浮詳情（? 提示內容體，配 HintTip 定位）                                                                                                                                                                                                            |
| `RollbackDialog.tsx`                                                                      | 工作區回滾確認（配 workspace-snapshot.ts）                                                                                                                                                                                                           |
| `SaveImageDialog.tsx`                                                                     | 圖片儲存對話方塊                                                                                                                                                                                                                                     |
| `FileTransferDialog.tsx`                                                                  | 檔案傳輸對話方塊（配 file-transfer.ts）                                                                                                                                                                                                              |
| `BannerContainer.tsx`                                                                     | 公告條容器（配 banner-notice.ts）                                                                                                                                                                                                                    |
| `NotifyToggle.tsx`                                                                        | 聲音/通知開關（含隱藏的通知診斷面板 `SHOW_NOTIFY_TEST_PANEL`）                                                                                                                                                                                       |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `HintTip.tsx` / `SoundSettings.tsx` | 通用件（HintTip：`?` 懸浮提示 portal 頂層渲染）                                                                                                                                                                                                      |
| `mermaid.ts` / `scroll-classify.ts`                                                       | 非元件輔助（mermaid 渲染 / 滾動分類，與元件同目錄存放）                                                                                                                                                                                              |
