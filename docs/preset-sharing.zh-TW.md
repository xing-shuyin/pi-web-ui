[English](./preset-sharing.en.md) · [简体中文](./preset-sharing.md) · **繁體中文**

# 預設分享（匯入 / 匯出 / 社群共享倉庫）

> 程式碼：`server/preset-share.ts`（純邏輯 + 編排）、`server/settings-service.ts`（port 適配）、
> `server/dsh/dsh-agent-service.ts`（DSH 的 port 適配）、`web/src/components/PresetShareModal.tsx`（三頁籤面板）、
> 共享倉庫 [xing-shuyin/pi-web-ui-presets](https://github.com/xing-shuyin/pi-web-ui-presets)。

設定預設（**設定 → 預設**）原本只能在本機儲存/應用。現在它是**可交換的檔案**：能匯出成 JSON、
按網址匯入、一鍵發到社群倉庫，並在面板裡瀏覽別人分享的預設。

## 1. 三條路徑

| 路徑        | 入口                                                         | 走哪條通道                                                | 落點                                                  |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| 匯出 / 分享 | 預設區頂部「分享預設」主按鈕，或預設行的分享圖示，或面板頁籤 | `preset_export` / `preset_share`                          | 剪貼簿 / 下載 `.json` / 社群倉庫 Issue                |
| 匯入        | 預設區頂部「匯入預設」按鈕，或面板「匯入」頁籤               | `preset_import`（貼上/檔案）、`preset_import_url`（網址） | 本地 `presets` 儲存（同名覆蓋），可選立即應用         |
| 瀏覽分享    | 預設區頂部「瀏覽共享」按鈕，或面板「瀏覽分享」頁籤           | `preset_catalog`                                          | 拉倉庫 `index.json` → 列表 → 一鍵匯入（複用網址匯入） |

三個頂部按鈕開啟的是同一個面板（`PresetShareTab` 決定先落在哪個頁籤），不再需要在面板裡先切頁籤。

設定區把三塊內容合併成一張卡片（**引擎預設 / 許可權兩個下拉 + 設定預設列表**）：原來 Agent 預設與
許可權各有一份只讀列表（逐條列名稱 + 說明），精簡成下拉框 + 一行當前值說明；許可權只剩一個下拉。

**為什麼匯入/抓取必須在服務端**：下發給瀏覽器的 `UiSettingsPreset` 是**裁剪檢視**（只有
name/promptMode/customSystemPrompt/promptTemplate/promptOverrides/disabledSkills/disabledExtensions/
reviewPrompt/reviewDisabledSkills），完整欄位只存在服務端的 `SettingsPreset` 裡；而且瀏覽器直接抓
raw.githubusercontent.com 會撞 CORS。所以「解析 → 淨化 → 落盤」全在服務端做，前端只負責展示與確認。

## 外掛依賴與應用結果

分享面板允許顯式勾選需要隨預設攜帶的外掛。交換文件頂層 `plugins` 最多 32 項，僅保留 `id`、顯示名 `name`、參考 `version` 和可移植的 GitHub `source`。本地路徑、帶憑據 URL、外掛配置、金鑰、儲存與許可權授權均不匯出。來源白名單在 `server/preset-plugin-dependencies.ts`，與設定欄位淨化分開；缺少可用來源的依賴仍可展示，但不能直接安裝。

依賴與預設一起儲存，之後再匯出不會丟失；`plugins` 只屬於預設後設資料，不能合併到 `ClientSettings`。預覽和普通匯入不執行安裝。前端顯式安裝缺失外掛時複用 `plugin_job`（含安裝確認、託管模式限制、日誌、失敗結果及重試）；已安裝外掛不會自動升級或重新授權。參考版本用於提醒差異，不是版本鎖定。外掛安裝和預設儲存/應用是獨立操作，不承諾事務回滾。

匯入回執 `ok: true` 表示預設已經儲存。勾選立即應用時，服務端等應用完成才返回 `applied`；應用拋錯仍保留已儲存預設，並返回 `applyError`。介面必須區分儲存與應用結果。部分預設在儲存讀取時必須保持缺失欄位，不補重試/壓縮/審查預設值；只有實際攜帶的欄位才能改變設定。

## 2. 交換格式（`pi-web-ui-preset` v1）

```jsonc
{
	"format": "pi-web-ui-preset",
	"version": 1,
	"name": "預設名", // 必填，≤60 字；匯入後的預設名（同名覆蓋）
	"description": "適合什麼場景", // ≤500 字
	"author": "github 使用者名稱", // ≤80 字
	"tags": ["程式設計", "極簡"], // ≤8 個，單條 ≤24 字
	"createdAt": "2026-01-01T00:00:00.000Z",
	"appVersion": "0.99.0", // 生成端的包版本
	"plugins": [{ "id": "notes", "name": "Notes", "source": "owner/repo/plugins/notes", "version": "1.0.0" }], // 可選依賴
	"settings": {/* 見下 */},
}
```

`settings` 與 `server/client-state.ts` 的 `SettingsPreset` 同構，**欄位白名單 = `ClientSettings` 全集**
（47 個，清單與分組在 `server/preset-fields.ts`，前後端共用）：

| 分組                      | 欄位                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt` 提示詞           | `promptMode` · `customSystemPrompt` · `promptTemplate` · `promptOverrides` · `reviewPrompt` · `reviewDisabledSkills`                                                                                                                                                                                                         |
| `tools` 工具與開關        | `disabledAgentTools` · `disabledPluginTools` · `toolPromptOverrides`（逐工具文案）· `toolLazyLoading` · `readDirEnabled` · `toolApprovalEnabled` · `toolWatchdogTimeoutMs` · `questionnaireEnabled` · `terminalToolsEnabled`                                                                                                 |
| `terminal` 終端接管       | `terminalBash` · `terminalBashIdleMs` · `terminalBashMaxForegroundMs`                                                                                                                                                                                                                                                        |
| `skills` 技能與擴充套件   | `disabledSkills` · `disabledExtensions` · `skillsFullText`                                                                                                                                                                                                                                                                   |
| `ai` 模型行為與專用提示詞 | `retryMaxAttempts` · `softCapTokens` · `softCapByModel` · `subagentDefaultModel` · `visionBridgeEnabled` · `visionBridgeModel` · `visionBridgePromptMode` · `visionBridgePrompt` · `scmCommitMsgPromptMode` · `scmCommitMsgPrompt` · `planModePromptMode` · `planModePrompt` · `goalModeEnabled` · `parallelReminderEnabled` |
| `ui` 介面與互動偏好       | `uiLayout` · `disabledPlugins` · `thinkingWrap` · `toolsWrap` · `toolImagesEnabled` · `keepRecentMessages` · `showForkedParentSessions` · `quickPhrases` · `quickPhrasesEnabled` · `devNoCache` · `autoReload`                                                                                                               |
| `engine` 引擎預設         | `defaultAgentPreset` · `defaultPermissionPreset`                                                                                                                                                                                                                                                                             |

**仍在預設之外**（不在 `ClientSettings` 裡，各有自己的儲存）：標記開關（`disabledMarkers`；無獨立全域性開關，全關即全域性關閉）、
審批規則庫（`approval-rules.json`）、子代理模板庫（`subagent-templates.json`）、以及純前端 localStorage 的
偏好（牆紙、寬屏聊天列、present 自動預覽、標題設定、聲音/TTS、通知、輸入歷史）。

**欄位可選**：舊版文件（只有 19 個欄位）與「只匯入一部分」都靠 `SettingsPreset` 的 `Partial` 語義落地 ——
應用預設時缺哪個欄位就**保持當前值**。單測用編譯期斷言守「`ClientSettings` 的每個欄位都在清單裡」。

JSON Schema 也在共享倉庫裡：`schema/preset.schema.json`、`schema/index.schema.json`。

## 3. 匯入紀律（白名單 + 上限 + 收口）

匯入的外部 JSON **絕不直接攤進設定**，四道閘門：

1. **形狀**：`format` 必須等於 `pi-web-ui-preset`、`version` 必須是 `1`、`name` 非空、`settings` 是物件；
   失敗給**穩定的 errorKey**（`presets.import.format` / `.version` / `.name` / `.settings` / `.parse` /
   `.tooLarge` / `.empty` / `.shape` / `.noFields`）與本地化文案。單元素陣列也接受（有人會包一層陣列）。
2. **白名單 + 型別**：只認上面那 47 個欄位；型別不符的**丟棄**（不拋錯）並在預覽裡列出（`rejected`）；
   未知欄位列進 `ignored`（舊版客戶端/拼錯欄位的提示）。列表欄位去空白、去重、單條 ≤200 字、≤500 條；
   對映欄位 ≤200 條；長文本欄位 ≤100KB。`disabledAgentTools`/`softCapTokens`/`softCapByModel`/
   `retryMaxAttempts`/`skillsFullText` 走應用側**同一批歸一化函式**（`tool-manager` / `soft-cap` /
   `client-state`），所以「匯入的預設」和「本地儲存的預設」語義一致。
3. **上限**：單個文件 ≤512KB（`PRESET_JSON_MAX_BYTES`，與倉庫收錄指令碼一致）。
4. **抓取收口**：網址匯入只允許 `http(s)`，且**拒絕內網/迴環/鏈路本地/`.local`/`.internal`/IPv6 本地**
   （`isBlockedHost`，SSRF 收口）；帶 10s 超時與大小上限，只走注入的 `Fetcher`（預設
   `update-check.ts` 的 `defaultFetcher`，因此跟隨全域性代理配置）。

**兩段式**：前端先發 `dryRun: true` 拿預覽（名稱、說明、作者、標籤、將寫入的欄位、被忽略/被丟棄的欄位、
摘要徽標、自定義提示詞/模板/審查提示詞片段、是否覆蓋同名），使用者確認後才發 `dryRun: false` 真正落盤
（可選 `apply: true` 立即應用）。匯入成功會推 `settings_state` + 一條 notice。

**可選匯入**：確認時帶 `fields: string[]`（最後一個 `dryRun` 預覽裡的欄位名，按分組/按欄位勾選，預設全選）→
服務端只把勾選的欄位寫進預設；未勾選的欄位不落盤，應用時保持當前值。名單裡出現白名單之外的名稱會被過濾掉；
名單為空陣列 = 一個都不勾，服務端回 `ok:false` 並拒寫。不給 `fields` = 全量（舊客戶端行為不變）。

## 4. 社群共享倉庫

預設倉庫 `xing-shuyin/pi-web-ui-presets`（`PI_WEB_PRESET_REPO` 可換成自己的 fork / 自建倉庫）。結構：

```
index.json                     # 目錄（瀏覽列表的唯一來源）
presets/<slug>-<sha1前7>.json  # 收錄的預設檔案
schema/…                       # 兩個 JSON Schema
scripts/ingest-preset.mjs      # Issue → 收錄（校驗 → 寫檔案 → 更新 index.json）
scripts/validate-repo.mjs      # 倉庫自檢（PR/push 跑）
.github/workflows/ingest-preset.yml    # 標題以 [preset] 開頭的 Issue：開啟/編輯 → 自動收錄 → 評論 → 關閉
.github/workflows/validate-presets.yml # index ↔ 檔案自洽
```

**一鍵分享**（`preset_share`）——服務端按「使用者要動手的程度」依次嘗試三條落地路徑：

1. **gh CLI**（裝了且已登入）——全自動：
   `gh issue create --repo <repo> --title "[preset] <name>" --body-file <臨時檔案>`
   （`PI_WEB_PRESET_GH` 可指定 gh 路徑；正文走臨時檔案，不受命令列長度限制）；
2. **GitHub API + 令牌**（無 gh 也能全自動）：令牌取 `PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`，
   有令牌就 `POST https://api.github.com/repos/<repo>/issues`（走同一個注入的 Fetcher，因此跟隨代理設定）；
   令牌無效/無權時錯誤體裡的 message 會一併回報；
3. **預填網頁**（不需要任何憑據）——前端複製 JSON 後開啟建 Issue 頁。**大多數情況點一下 Submit 就行**：
   正文能塞進 URL（編碼後 ≤7K）時連結裡就**預填了正文且不帶 `template=`**（GitHub 在帶 template 時會忽略
   body，兩個一起給反而要手動粘）；正文太大才退回模板頁，並把 JSON 放進剪貼簿讓使用者粘。

回執 `method` 為 `"gh"` / `"api"`（兩者都已建好 Issue，前端直接開啟 URL）或 `"browser"`（前端複製 JSON + 開啟連結）。
倉庫 Action 校驗通過後寫入 `presets/`、更新 `index.json`、評論並關閉 Issue（失敗則評論原因 + 打 `needs-fix`，改完正文自動重試）。

**瀏覽列表**（`preset_catalog`）：拉 `PI_WEB_PRESET_CATALOG_URL`（預設
`https://raw.githubusercontent.com/<repo>/main/index.json`），解析 `index.json` →
逐條過濾（`id`/`name`/`file` 必填、`file` 必須是倉庫內相對路徑、擋 `..` 與絕對地址、`id` 去重、
≤500 條）→ 按 `updatedAt` 倒序 → 回執。**5 分鐘程序內快取**（`refresh: true` 繞過）；
抓取失敗時**保留上一次成功的列表**（`cached: true`），離線只是列表變舊。列表裡的每條都能直接
「匯入」（複用網址匯入，URL 由 raw 基址拼出）或跳來源 Issue。

## 5. 環境變數

| 變數                        | 預設                                                       | 作用                                                                                                                               |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_PRESET_REPO`        | `xing-shuyin/pi-web-ui-presets`                            | 共享倉庫 `owner/name`（也接受 `https://github.com/owner/name(.git)`）；`off`/`0`/`false`/`no` = 關閉分享（匯入/匯出仍可用）        |
| `PI_WEB_PRESET_CATALOG_URL` | `https://raw.githubusercontent.com/<repo>/main/index.json` | 目錄文件地址；空串或 `off` = 關閉「瀏覽分享」                                                                                      |
| `PI_WEB_PRESET_GH`          | `gh`                                                       | 一鍵分享呼叫的 GitHub CLI 路徑                                                                                                     |
| `PI_WEB_PRESET_TOKEN`       | 空                                                         | 無 gh 時的直連 API 令牌（回落順序：`PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`）；未設就走「預填網頁」路徑，不需要任何憑據 |

完整表見 `docs/env-vars.md`。

## 6. 隱私

預設**只含設定**：API key、provider 登入、專案路徑都不在預設裡（`SettingsPreset` 的型別定義就排除了它們）。
但預設**可以**攜帶自定義系統提示詞、組合模板與審查提示詞——**匯入前請先看預覽**；預覽會把這幾段文本截斷展示，
不點「匯入」不會落盤，不點「應用」不會生效。分享到公開倉庫 = 這些文本會公開，別把私有提示詞發出去。

## 7. 協議訊息

```
client → server
  preset_export      { source?: "preset"|"current", name?, description?, author?, tags?, requestId? }
  preset_import      { json, dryRun?, name?, apply?, fields?, requestId? }
  preset_import_url  { url, dryRun?, name?, apply?, fields?, requestId? }
  preset_catalog     { refresh?, requestId? }
  preset_share       { source?, name?, description?, author?, tags?, requestId? }

server → client
  preset_export_result { requestId?, ok, name?, fileName?, json?, error? }
  preset_import_result { requestId?, ok, dryRun, preview?: UiPresetImportPreview, applied?, error? }
  preset_catalog_result{ requestId?, ok, entries: UiPresetCatalogEntry[], source, cached, fetchedAt, error? }
  preset_share_result  { requestId?, ok, method?: "gh"|"browser", url?, name?, json?, error? }
```

`requestId` 原樣回顯；前端把匯入來源編在字首裡（`paste:` / `file:` / `url:`），預覽頭部據此提示
（服務端不關心來源）。`fields` = 可選匯入的欄位名（見 §2 末）；不給 = 全量。兩個引擎共用同一份編排
（`PresetSharePort`）：`SettingsService`（pi）與 `DshClientSession`（DSH）各自實現「取預設 / 存預設 /
應用預設 / 推設定」四件事。

## 8. 測試

- `tests/unit/preset-share.test.ts` — 60 個純函式/編排單測：slug/短雜湊、白名單淨化（47 欄位 + 可選匯入
  選擇過濾）、解析與 errorKey、SSRF 收口、目錄解析與快取、env 讀取、Issue 文本、port 編排
  （匯出/匯入/分享回落/目錄）。
- `tests/settings-test.mjs` — 真機協議往返（隔離 data-dir）：匯出 → dryRun 預覽 → 改名匯入 + 應用
  （改掉當前設定，匯入後應被恢復）→ 可選匯入（只寫勾選欄位 / 空選拒寫）→ 淨化（未知欄位/型別不符）
  → 壞 JSON → 網址匯入攔迴環與非 http(s) → 分享被 env 關閉時明確拒絕但仍回傳 JSON → 目錄形狀。
  該測試**顯式把分享關掉**，絕不真在共享倉庫開 Issue。
- `tests/scratch/preset-share-live.mjs` — 手動聯調（真網路）：預設 env 下拉官方倉庫目錄 → 網址匯入
  真實預設 → 匯出閉環。需要聯網，不入 smoke。
- `tests/scratch/preset-share-nogh-live.mjs` — 無 gh 的回落驗證（真網路）：無效令牌打真實 api.github.com
  應拿到乾淨的 `HTTP 401: Bad credentials`（不拋），以及網頁回落 URL 的預填/長度/`template` 二選一規則。
- `tests/scratch/preset-share-api-live.mjs` — 令牌直連 API 的**成功**路徑（真網路 + 真倉庫）：建一條
  Issue → 讀回校驗標題/正文 → GraphQL `deleteIssue` 刪掉。跑之前先 `gh workflow disable "Ingest shared preset"`。
