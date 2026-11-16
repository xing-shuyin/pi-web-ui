[English](./issue-885-triage.en.md) · [简体中文](./issue-885-triage.md) · **繁體中文**

# Issue #885 分診：Full Pi CLI 繼承 + 統一擴充套件管理

> 只讀核實，不改邏輯。並行 PR 在跑，本次只寫本文件，不碰 `SCMPanel` / `vscode-editor` 相關檔案。
> 核實日期：2026-11-13；工作目錄 `E:/pi-web-ui`；無 gh token，未拉取遠端 issue 全文，按任務描述中的“史詩（7 節 11 條驗收）”做分診。

## 結論前置（給非技術讀者）

- **#885 “完全不繼承”不成立**：WebUI 與 Pi CLI 已經共用同一個 `agentDir`（預設 `~/.pi/agent`），`auth.json / models.json / mcp.json / skills` 都是同一份；SDK 內建擴充套件也會載入。
- **#885 後半句成立**：缺的是“統一管理介面”和“防覆蓋的顯式宣告”。即：使用者看不到“這個擴充套件到底來自 Pi CLI / WebUI / 外部”，壞了看不到錯誤詳情，想開關要翻好幾個地方，一鍵重新整理也沒有。
- **值得做，但不要一次做完**：繼承鏈是底座（已通），管理 UI 是上層（缺 5–6 塊）。一次全做會同時碰執行時、設定、外掛市場、MCP 熱載入，極易與並行 PR 衝突，且任何一塊 regression 都會導致會話起不來。拆成 6 個可獨立上線的小任務，第一步只做“只讀清單”，零風險。

## 1. 這次讀了什麼（證據鏈）

| 檔案                                      | 看了什麼                                                                                                                                                       | 結論                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `server/agent-service.ts:4055`            | `const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir()`                                                                                            | 與 SDK 共用 `agentDir`，環境變數可覆蓋                  |
| `server/agent-service.ts:3743–3789`       | `ClientSession` 構造存 `this.agentDir`，`agentDir: () => this.agentDir` 傳給 `SettingsService`                                                                 | 全會話共享同一目錄身份                                  |
| `server/agent-service.ts:4233, 4319`      | `getSdkBuiltinExtensionFactories()` + `disabledBuiltinExtensions: ["mcp"]`，`extensionsOverride` 按 `disabledExtensions` 過濾                                  | SDK 內建擴充套件已載入，唯獨 `mcp` 被顯式停用走自家橋   |
| `server/sdk-builtin-extensions.ts:25–81`  | `resolveSdkExtensionsIndexPath()` → `builtInExtensions`（跳過 `mcp`），兜底 `codemode / tool-search`（`hidden: true, replaceable: true`）                      | 內建擴充套件來源是 SDK 包本身，隱藏但可替換             |
| `server/mcp-bridge.ts:13–36`              | `getGlobalMcpPath(agentDir)` → `<agentDir>/mcp.json`；`getProjectMcpPath(cwd)` → `<cwd>/.pi/mcp.json`；另有 `dataDir/mcp.json` 遺留相容                        | MCP 雙層繼承：全域性 + 專案                             |
| `server/agent-service.ts:4284–4315, 9295` | `discoverDiskSkills({ cwd, agentDir, workspaceRoots })` + `mergeSkillCollections(res.skills, discovered)`，再按 `disabledSkills / enabledSkills / preset` 過濾 | Skill 雙層繼承：SDK 自帶 + 磁碟發現合併                 |
| `server/client-state.ts:846–880`          | `isExtensionDisabled / isExtensionEnabled` + `extensionKeyCandidates`；`isInternalExtension`（`<inline: / <builtin: / hidden`）永不停用                        | Pi CLI 自定義擴充套件會被繼承，但內部擴充套件鎖死不可關 |
| `server/plugins.ts:2561–2720`             | `ensureLoaded({ scope: "all" \| "alwaysOn" })`，`ensureAlwaysOnLoaded` 開機無 WS 時只拉 `manifest.alwaysOn`，其餘懶啟用                                        | WebUI 外掛是另一套體系，與 SDK 擴充套件完全分開         |
| `server/tool-manager.ts:1–60`             | 只有工具名常量與門禁（`CANVAS / TERMINAL / MCP_MANAGE / SKILL` 等），不管擴充套件載入                                                                          | 工具開關 ≠ 擴充套件管理，不要混為一談                   |

一句話：**底座已通（同一 agentDir + 同一 MCP/Skill/Extension 過濾器），上層缺（統一檢視 + 統一開關 + 錯誤詳情 + 一鍵重新整理 + 防覆蓋宣告）**。

## 2. 現狀已繼承什麼

1. **身份目錄**：`agentDir` 單源，`auth.json`（登入）、`models.json`（模型）、`mcp.json`（全域性 MCP）、`skills/`（全域性技能）、`sessions/`、`bot-sessions/` 全共用。改 Pi CLI 的登入，WebUI 立刻生效，反之亦然。
2. **SDK 內建擴充套件**：`codemode / tool-search` 等經 `getSdkBuiltinExtensionFactories()` 注入 `createAgentSessionServices({ extensionFactories })`。`mcp` 是唯一被禁的內建擴充套件（走 WebUI 自己的 `McpBridge`，避免雙跑）。
3. **MCP 配置**：全域性 `<agentDir>/mcp.json` + 專案 `<cwd>/.pi/mcp.json` 雙層合併，另有 `dataDir/mcp.json` 舊路徑兜底。`mcp_manage` 工具描述裡也寫了這兩條路徑。
4. **Skills**：SDK `res.skills` 與本地 `discoverDiskSkills` 合併，支援 `global / project / ancestor / package` 多 scope，再走預設與 `disabledSkills` 門禁。
5. **第三方擴充套件過濾**：Pi CLI 裝的自定義擴充套件會出現在 `res.extensions`，WebUI 用 `disabledExtensions / enabledExtensions`（`extensionKeyCandidates` 匹配）做啟停，內部擴充套件（`hidden / <inline: / <builtin:`）強制保留。

## 3. 缺什麼（#885 真正要補的）

1. **沒有統一列表**：SDK 擴充套件、WebUI UI 外掛（`server/plugins.ts`）、MCP servers 三處各說各話。設定頁能看到 WebUI 外掛的 `來源 owner/repo`（`pluginCatalogSource` 文案已存在），但看不到 SDK 擴充套件的來源（Pi CLI / WebUI / 外部）。
2. **沒有統一啟停**：SDK 擴充套件走 `disabledExtensions`，Skill 走 `disabledSkills`，WebUI 外掛走 `alwaysOn + 懶啟用`。使用者要關一個能力，得猜它是哪類。
3. **沒有錯誤詳情**：`bindExtensions({ onError: makeExtensionErrorReporter })` 的錯誤只進 notice / 日誌，沒有“哪個擴充套件掛了、為什麼掛、點哪重試”的面板。`alwaysOnSnapshot()` 有體檢快照，但只給 `/api/health` 用，前端沒展示。
4. **沒有一鍵重新整理**：MCP 有熱載入（`mcp-hot-reload.ts` 監聽 `mcp.json`），WebUI 外掛有 `rescanAlwaysOn`（只管失敗的常駐外掛），SDK 擴充套件沒有。三者沒合成一個“重新整理”按鈕。
5. **沒有防覆蓋顯式宣告**：`<agentDir>/mcp.json` vs `<cwd>/.pi/mcp.json` vs `dataDir/mcp.json` 的優先順序只寫在程式碼裡（`mcp-bridge.ts`），文件和 UI 裡沒寫。使用者不知道專案配置會不會蓋掉全域性配置，`PI_CODING_AGENT_DIR` 改了之後更懵。

## 4. 拆解：6 個可獨立交付的子任務

> 原則：只讀先行 → 只展示 → 再動開關 → 最後動載入。每條可單獨提 PR、單獨回滾。

### T1 — 統一擴充套件清單隻讀 API + 文件（S）

- 做什麼：在服務端拼一個只讀聚合（SDK `extensions` + WebUI `plugins.list()` + MCP `listAllMcpServers`），欄位至少 `id / kind(sdk-extension | webui-plugin | mcp-server | skill) / source(Pi CLI / WebUI / 外部 / 內建) / enabled / error?`；先只打日誌 + 寫文件，不接 UI。
- 驗收：調一次新介面，能看到三類條目且 `source` 不為空；`hidden:true` 的內建擴充套件標註為“內建”，不參與計數；有單測覆蓋聚合函式。
- 估算：**S（1 天內）**。
- 為什麼先做：零 UI 風險，後續 T2–T6 都依賴這份清單口徑。

### T2 — 設定頁/外掛市場補“來源”展示（S）

- 做什麼：純展示。在現有外掛行 / 擴充套件行加 `來源：Pi CLI / WebUI / 外部` 文案 + 錯誤 tip 入口，不改任何開關邏輯。動檔案限 `docs/ + 最多 1 個展示檔案`，改前 `claim_files` 先佔。
- 驗收：三類來源在 UI 上可區分；`無來源資訊`（`uiPluginNoSource`）保持原樣；無邏輯變更，`typecheck + 相關單測` 通過。
- 估算：**S**。
- 依賴：T1 的 `source` 口徑。

### T3 — 統一啟停：三套開關打通（M）

- 做什麼：把 `disabledExtensions / disabledSkills / disabledAgentTools` 與 WebUI 外掛的啟用態收斂到同一份“擴充套件期望狀態”；`alwaysOn` 常駐外掛的停用要顯式確認（避免停掉後臺執行者依賴）。
- 驗收：在統一列表點停用 → 對應 `disabled*` 落盤 + 會話 `reload` 生效；再啟用可恢復；內部擴充套件（`isInternalExtension`）拒絕停用並給出原因。
- 估算：**M（2–4 天）**。
- 風險：動執行時門禁，需與目標模式 / 委派模式的工具閘門聯測。

### T4 — 錯誤詳情 + 一鍵重新整理（M）

- 做什麼：把 `makeExtensionErrorReporter` 的錯誤、`alwaysOnSnapshot()`、`mcp-hot-reload` 的失敗收斂到“擴充套件詳情抽屜”；一個“重新整理”按鈕按序調 `session.reload() → rescanAlwaysOn() → mcp reload`，每步有進度與結果。
- 驗收：模擬一個壞 MCP server / 壞外掛，能看到錯誤堆疊摘要 + “重試”按鈕；重新整理後恢復，無需重啟服務端。
- 估算：**M**。
- 依賴：T1 清單；不碰會話過戶邏輯。

### T5 — 防覆蓋顯式宣告：優先順序文件 + UI 提示（S）

- 做什麼：把 `mcp-bridge.ts` 的優先順序（`agentDir/mcp.json > dataDir/mcp.json` 遺留，專案 `.pi/mcp.json` 與全域性合併）和 `PI_CODING_AGENT_DIR` 的覆蓋語義寫成文件 + 設定頁小字提示；必要時在寫入時彈“你正在覆蓋全域性配置”確認。
- 驗收：文件說清三條路徑誰贏；UI 上改專案 MCP 時能看到“僅影響本專案”提示；有單測鎖住 `getGlobalMcpPath / getProjectMcpPath` 順序。
- 估算：**S**。
- 為什麼獨立：純文件 + 文案，零執行時風險，可隨時合。

### T6 — MCP 專案執行態收斂（L）

- 做什麼：把 `mcp-project-runtime.ts`（專案態）、`McpBridge`（橋）、後臺執行者的 `allowedServers` 收斂到 T1 清單的 `mcp-server` 項；專案切換時自動 `prepare/retain`，失敗不拖死整個會話。
- 驗收：切專案後 MCP 列表自動更新；單個 server 啟動失敗只標紅該 server，會話照常可用；有整合單測。
- 估算：**L（約 1 周，可再拆）**。
- 放最後：涉及多會話併發 + 沙盒門禁，面最大。

## 5. 為什麼不一次做完

1. **面太大**：7 節 11 條驗收橫跨執行時（`agent-service`）、外掛宿主（`plugins`）、MCP 橋、設定 UI，一次合入等於把三套開關同時換掉，回滾都不知道回哪段。
2. **易衝突**：另一併行任務正在改展示層（本任務已避開 `SCMPanel` / `vscode-editor`）；大 PR 必撞車。
3. **風險不對等**：T1/T2/T5 是隻讀 + 文案，隨時可合；T3/T4/T6 動執行時，一個 regression 就是“會話起不來 / 工具全沒”。先拿小的建立清單口徑，大的才敢動。
4. **驗收可測性**：拆開後每條都有“看得見的完成態”（清單能調通 / 來源能看見 / 開關能記住 / 錯誤能重試），一次做完則 11 條驗收攪在一起，測不出誰壞了。

## 6. 第一步建議

**只做 T1（只讀聚合 + 單測 + 本文件）**。理由：不碰 UI、不碰執行時、不與並行 PR 搶檔案；一旦清單口徑定下來，T2 的展示文案、T3 的開關、T4 的錯誤詳情才有共同語言。如果連 T1 都覺得重，那就只合本文件，下次按 T1 開工。

本次任務按要求**沒有做 T2 的程式碼改動**（只改了本文件一個 md），所以無展示檔案變更、無需 `claim_files` 佔位。

## 7. 是否建議提交

- **建議提交本文件**：純新增 `docs/issue-885-triage.md`，無邏輯變更，`prettier` 已跑，不影響構建與並行 PR。
- 提交前：`npx prettier --write docs/issue-885-triage.md`（已執行）即可；`typecheck / 全量構建` 按任務要求不跑。
- 下一步（另起 PR）：T1 只讀 API，或 T2 純展示（記得 `claim_files` + 最多 1 個展示檔案 + 避開 `SCMPanel` / `vscode-editor`）。

## 附：給維護者的一句話

Pi CLI 的東西 WebUI 本來就繼承著，別再傳“完全不繼承”；真正的債是“看不見、關不掉、壞了不知道找誰”。先把清單（T1）和來源展示（T2）補上，#885 就完成了一半。

## 8. 落地記錄（2026-11-13，T1~T6 全量收尾）

> 本節為收尾 PR 追加：只改本地，不自動提交；並行 PR 仍在跑，已避開 plugins/vscode-editor 與 SCMPanel.tsx；新 UI 文案中英雙語直寫，未碰 en.json/zh.json（避開 #884）。

### 8.1 改了什麼（檔案清單）

| 任務          | 檔案                                              | 說明                                                                                                                                                   |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 只讀清單   | server/extension-inventory.ts（新增）             | 純函式 buildExtensionInventory + 只讀採集 collectExtensionInventory，三類來源統一 shape；失敗只記 error 原文，不拋錯、不改執行時                       |
| T1 查詢通道   | server/protocol.ts                                | 新增 UiExtensionInventoryEntry/Source + ClientMessage extension_inventory + ServerMessage extension_inventory_data                                     |
| T1 只讀分支   | server/dispatch-plugin-handlers.ts                | case extension_inventory：SDK 內建 + WebUI 外掛 + MCP + disabled 集合，只讀聚合後 send                                                                 |
| T2 來源展示   | web/src/components/ExtensionInventory.tsx（新增） | 來源徽標 CLI/WebUI/外部 + 啟用狀態 + 描述，純展示；錯誤原文紅框 + 一鍵重新整理；底部防覆蓋小字                                                         |
| T2 掛載       | web/src/components/SettingsModal.tsx              | extensions tab 頂部掛載，無新路由；服務端資料優先、本地快照兜底；進 tab 主動 appSend                                                                   |
| T2/T3/T4 狀態 | web/src/use-chat.ts                               | 新增 extensionInventory + extension_inventory_data 接收入庫                                                                                            |
| T3 統一啟停   | SettingsModal + ExtensionInventory                | WebUI 走 disabledPlugins；CLI 走 disabledExtensions（內建隱藏 switchable:false 置灰+原因）；MCP 解析 mcp:scope:name 走 toggle_mcp_server；絕不靜默跳過 |
| T4 重新整理   | 同上                                              | error 原文 + 一鍵重新整理（extensions_reload + plugins_reload + reload_mcp + extension_inventory），無需重灌                                           |
| T5 防覆蓋     | 本文件 8.2 + 設定頁小字                           | 對照表 + 繼承只讀、Web 專屬可寫、覆蓋須顯式可逆                                                                                                        |
| T6 一致性     | 本文件 8.3                                        | 會話/模型共用 agentDir，不斷鏈；缺口只補文件，不另起程序                                                                                               |
| 護欄          | tests/unit/extension-inventory.test.ts（新增）    | 4 用例：三類拼裝 / disabled+error 透出 / 排序穩定 / 單源失敗不拋錯                                                                                     |

### 8.2 繼承 vs 專屬對照表（T5 防覆蓋宣告）

| 能力                  | 繼承（只讀展示）                                                                                           | 專屬（可寫）                                                                      | 覆蓋語義（顯式可逆）                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 身份目錄 agentDir     | PI_CODING_AGENT_DIR ?? getAgentDir()，auth.json / models.json / mcp.json / skills / sessions 全會話共用    | 無（WebUI 不另起目錄）                                                            | 改環境變數即換身份，需重啟會話；文件顯式說明，不靜默                                                        |
| SDK 內建擴充套件      | codemode / tool-search（hidden:true，isInternalExtension 豁免 disabledExtensions），來源 CLI，不可單獨啟停 | 無                                                                                | 置灰 + SDK 不支援單獨啟停，僅展示；不提供假開關                                                             |
| Pi CLI 第三方擴充套件 | resourceLoader.getExtensions() → settings.extensions，走 disabledExtensions 啟停，來源 CLI                 | 無（繼承項）                                                                      | 關了可再開，落盤 disabledExtensions + session.reload() 生效，可逆                                           |
| WebUI UI 外掛         | 無                                                                                                         | pluginMgr.list() → chat.plugins，走 disabledPlugins + alwaysOn/懶啟用，來源 WebUI | 安裝即啟用；停用常駐外掛需顯式確認，可逆                                                                    |
| MCP 全域性            | agentDir/mcp.json，隨 agentDir 繼承，來源 外部                                                             | 可寫（全域性頁）                                                                  | 專案 .pi/mcp.json 按名覆蓋全域性同名（overriddenBy:project），UI 顯示 scope；改全域性影響全部專案，可逆確認 |
| MCP 專案              | cwd/.pi/mcp.json，隨 cwd 繼承                                                                              | 可寫（僅影響本專案）                                                              | 只寫專案檔案，不碰全域性；reload(cwd, scope) 即時生效，可逆                                                 |
| Skills                | SDK 自帶 + discoverDiskSkills(cwd, agentDir) 合併，走 disabledSkills                                       | 專案/全域性 skill 檔案可增刪                                                      | 預設 + disabled 門禁疊加，文件顯式優先順序，可逆                                                            |
| 模型/會話選擇         | 同一 agentDir 下 models.json / auth.json，切模型不斷鏈、不另起程序                                         | 會話內切換模型（setModel）                                                        | 缺口只補文件 + 架構說明，不另起重複程序（T6）                                                               |

設定頁小字（已進 ExtensionInventory.tsx，中英直寫）：

> 繼承的只讀展示，Web 專屬才可寫；必須覆蓋時顯式標註可逆 / Inherited entries are read-only; only WebUI-specific entries are writable. Overrides must be explicitly marked reversible.

### 8.3 T6 一致性核實（會話/模型共用 agentDir，不斷鏈）

- 會話：agent-service.ts ClientSession 構造 new ClientSession(clientId, cwd, agentDir)，agentDir = PI_CODING_AGENT_DIR ?? getAgentDir() 單源；settingsSvc / mcpProjects / SessionManager 全掛同一目錄。
- 模型：auth.json / models.json 同目錄；setModel / setDefaultModel 只換會話內模型引用，不重建 agentDir、不另起 SDK 程序。
- MCP：listAllMcpServers({agentDir, cwd, dataDir, bridge}) 同一份全域性+專案合併；toggle/save/reload 後 mcpProjects.reload(cwd, scope) + broadcastMcpServers + pushSettings，不斷鏈。
- 結論：無缺口需補程序；本 PR 缺口只補文件 + 顯式架構說明，符合 T6 不另起重複程序。

### 8.4 11 條驗收逐條（本 PR 口徑）

1. T1-清單三源齊全：SDK 內建 + WebUI 外掛 + MCP global/project，三類 source 非空 —— extension-inventory.ts + dispatch-plugin-handlers.ts，單測覆蓋。
2. T1-統一 shape 只讀：name/source/enabled/version/description/error，採集失敗只記 error，不改執行時 —— 同上 + protocol.ts 型別。
3. T2-來源徽標+狀態+描述純展示：CLI/WebUI/外部徽標 + 已啟用/已停用 + 描述 —— ExtensionInventory.tsx。
4. T2-現有入口掛載無新路由：SettingsModal extensions tab 頂部掛載 —— 同上。
5. T3-WebUI 開關走現有：disabledPlugins —— toggleInventoryWebui。
6. T3-CLI/MCP 直通或置灰：CLI 內建隱藏 switchable:false 置灰 + 原因文案；MCP toggle_mcp_server；絕不靜默跳過 —— ExtensionInventory + SettingsModal。
7. T4-錯誤原文+一鍵重新整理免重灌：error 原文紅框 + extensions_reload/plugins_reload/reload_mcp —— 同上。
8. T5-對照表+小字：本節 8.2 + 元件底部小字 —— 文件 + 元件。
9. T5-覆蓋顯式可逆：專案覆蓋全域性顯式 scope + 可逆 reload/落盤 —— 文件宣告 + 現有 mcp-manager 語義複用。
10. T6-共用 agentDir 不斷鏈：會話/模型/MCP 同目錄 —— 8.3 核實。
11. T6-缺口只補文件不另起程序：無新程序/守護 —— 本 PR 未新增執行時程序，單測 + typecheck 為證。
