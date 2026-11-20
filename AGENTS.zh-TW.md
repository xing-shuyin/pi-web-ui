[English](./AGENTS.en.md) · [简体中文](./AGENTS.md) · **繁體中文**

<!-- prettier-ignore-start -->
# AGENTS.md — pi-web-ui 關鍵功能 → 事實源 → 文件

> **本檔案只做對映與索引，不寫細則**：想知道某塊能力怎麼改、有哪些禁令，按下表去讀 `docs/` 對應文件。
> 新規則請寫進對應 `docs/`（紅線細則執行 [`docs/agent-rules.md`](docs/agent-rules.md)），**不要再往本檔案堆段落**——體積與死鏈由 `tests/unit/agents-md.test.ts` 守衛。
> 修改本檔案後在 pi 裡 `/reload`。精簡前的全文備份：`AGENTS.md.bak`。

## 0. 是什麼

pi 編碼智慧體（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天介面：瀏覽器對話、檔案樹、附件、內建終端、模型管理、外掛市場、裝置中心/群組、畫布工作流、Electron 桌面殼。
技術棧：Node（>= 22.19.0）+ Express + `ws` 後端 · React 19 + Vite 前端 · xterm.js + node-pty 終端 · 單檔案 `web/src/styles.css` 主題基線。版本號 `package.json` 與 `package-lock.json` 兩處同步。

## 1. 關鍵功能 → 事實原始檔 → 文件

| 功能 | 事實原始檔（★=唯一單源） | 文件 |
| --- | --- | --- |
| **文件總索引**（主題 / 權重 / 按場景閱讀路線） | — | [`docs/README.md`](docs/README.md) |
| 快照驅動 / 協議單源 / 多對話併發 | `server/protocol.ts`★ · `server/agent-service.ts` · `web/src/app-globals.ts` · `web/src/types.ts`（shim） | [`architecture-core.md`](docs/architecture-core.md) |
| 側欄會話排序 / 使用者傳送置頂 / 對話↔歷史行歸屬與身份 | `web/src/conversation-order.ts`★ · `server/conversation-rows.ts`★ · `web/src/session-identity.ts`★ · `web/src/components/LeftPanel.tsx` · `web/src/use-chat.ts` | [`architecture-core.md`](docs/architecture-core.md#側欄歷史會話載入) |
| 安全邊界（loopback/Origin/Cookie/appUrl） | `server/index.ts` · `server/auth-cookie.ts` | [`architecture-core.md`](docs/architecture-core.md) · [`agent-rules.md`](docs/agent-rules.md#一通訊協議與資料安全) |
| 隨手問 / 選中文字解釋 | `server/quick-ask.ts` · `web/src/quick-ask.ts` · `web/src/components/QuickAskPopover.tsx` | [`architecture-core.md`](docs/architecture-core.md#隨手問獨立小窗) |
| 系統提示片語裝 / 設定儲存回執 | `server/prompt-composer.ts`★ · `web/src/settings-sync.ts`★（pending overlay + 回執） | [`architecture-system-prompt.md`](docs/architecture-system-prompt.md) |
| 工具開關 / 工具提示詞 / 內建工具覆蓋 | `server/tool-manager.ts`★ · `server/tool-prompts.ts`★ · `server/tool-overrides.ts` · `server/bash-timeout.ts`（bash/powershell 預設超時單源） | [`agent-rules.md`](docs/agent-rules.md#二工具定義與提示詞規範) · [`tool-context-budget.md`](docs/tool-context-budget.md) |
| 上下文預算 / 延遲載入 / 證據外接 | `server/soft-cap.ts` · `server/request-context.ts` · `server/evidence-tool-hooks.ts` | [`tool-context-budget.md`](docs/tool-context-budget.md) |
| 工具審批門禁與規則庫 | `server/tool-approval.ts` | [`architecture-core.md`](docs/architecture-core.md#審批佇列與共享展示) |
| 內建瀏覽器 / 桌面三模式 / Web 原生橋 | `browser/` · `desktop/browser-host.ts` · `web/src/browser-control.ts` | [`architecture-browser.md`](docs/architecture-browser.md) |
| 憑據保險庫（密碼 + TOTP，圖示工具條 / 掃碼 / 按站點匹配 / 填碼） | `browser/renderer/vault.ts`★ · `browser/runtime/totp.ts`★ · `browser/runtime/qr.ts` · `browser/runtime/credentials.ts` · `desktop/browser-host.ts`（密碼只下發投影） · `browser/storage/index.ts` | [`architecture-browser.md`](docs/architecture-browser.md#憑據保險庫密碼--totp) |
| 頁面指令碼注入（臨時 / 永久，`browser_script`） | `browser/runtime/scripts.ts` · `browser/automation/scripts.ts` · `server/browser-script-tool.ts` | [`architecture-browser.md`](docs/architecture-browser.md) |
| 自定義新標籤頁 / 主題覆蓋（`browser_design`） | `browser/runtime/customize.ts`★ · `browser/runtime/manager.ts` · `desktop/browser-host.ts` · `server/browser-design-tool.ts` | [`architecture-browser.md`](docs/architecture-browser.md#自定義新標籤頁與主題覆蓋使用者改--agent-設計) |
| 左上角裝置浮層（列表 / 手機抽屜） | `web/src/components/DevicePanel.tsx`★ · `BrandDeviceMenu.tsx` · `DeviceDirectory.tsx` · `use-coarse-pointer.ts` · `styles.css`（`.dp-*`） | [`device-center.md`](docs/device-center.md#左上角裝置浮層桌面浮層--手機抽屜) |
| 手機 App / 多裝置切換 / 原生通知 | `mobile/` · `web/src/mobile-runtime.ts` · `server/mobile-push.ts` · `server/device-center/hub-mobile.ts` | [`mobile.md`](docs/mobile.md) |
| 終端 PTY / 原生 CLI / bash 接管 / SCM | `server/terminals.ts` · `server/terminal-query.ts`（終端查詢/回話單源） · `server/native-cli.ts` · `server/engine-catalog.ts`★ · `server/engine-cli.ts` · `web/src/components/NativeCliPanel.tsx` · `web/src/components/BottomDock.tsx` · `web/src/components/TerminalPanel.tsx` · `web/src/components/SCMPanel.tsx` | [`architecture-terminal.md`](docs/architecture-terminal.md) |
| 命令執行防卡死 / 硬超時 / 後臺託管 | `server/job-runner.ts`★（`bash({background:true})` 程序內 job）· `scripts/safe-exec.mjs`（原始碼倉庫 / CI 執行器）· `server/process-utils.ts`（`killPidTree` 單源） | [`development.md`](docs/development.md#命令執行防卡死) · [`agent-rules.md`](docs/agent-rules.md#七終端命令執行防卡死) |
| 附件 / 圖片預覽 / OCR / 標註 / 系統截圖 | `server/file-save.ts` · `web/src/components/ImageLightbox.tsx` · `plugins/image-ocr/` · `server/system-screenshot.ts` · `server/system-screenshot-macos.ts` | [`architecture-attachments.md`](docs/architecture-attachments.md) |
| 外掛體系 / UI 插槽 / MCP 專案執行態 | `server/plugins.ts` · `web/src/ui-slots.ts`★ · `server/mcp-project-runtime.ts` | [`architecture-plugins.md`](docs/architecture-plugins.md) |
| 外掛物化（程式碼純快取）/ 狀態目錄 | `server/plugin-paths.ts`★ · `server/plugin-materialize.ts`★ · `server/fs-copy.ts`★ | [`architecture-plugins.md`](docs/architecture-plugins.md#外掛目錄程式碼是純快取狀態獨立存放plugin-pathsts--plugin-materializets) |
| 統一 TTS / 系統語音 / 外掛音色 / QQ 語音回覆 | `server/tts-service.ts`★ · `server/tts-system.ts` · `server/tts-routes.ts` · `web/src/tts-client.ts` · `plugins/qq/voice.mjs` | [`architecture-tts.md`](docs/architecture-tts.md) |
| 子代理 / 對話通訊 / 工作樹 / 過戶 | `server/subagents.ts` · `server/conversation-identity.ts` · `#take_over_conversation` | [`architecture-core.md`](docs/architecture-core.md) · [`root-cause-boundaries.md`](docs/root-cause-boundaries.md) |
| 目標模式 2.0 / 委派 / 計劃模式 | `server/goal-service.ts` · `server/delegate-mode.ts` · `server/plan-mode.ts` | [`goal-conversation-design.md`](docs/goal-conversation-design.md) · [`agent-rules.md`](docs/agent-rules.md#四架構與執行態約束) |
| 無人值守 / 常駐執行者 / `alwaysOn` 外掛 | `server/background-executors.ts`★ · `server/plugins.ts`（`ensureLoaded` scope） · `manifest.alwaysOn` | [`unattended-operation.md`](docs/unattended-operation.md) |
| DSH 預設 / 問卷 / 底欄統計 | `server/dsh-*.ts` · `server/dsh/dsh-usage.ts` | [`dsh-engine.md`](docs/dsh-engine.md) |
| 沙盒工作區 | `docs/architecture-sandbox.md` 列出的執行會話身份鏈 | [`architecture-sandbox.md`](docs/architecture-sandbox.md) |
| 裝置中心 / 群組 Bot / 遠端桌面 / 檔案同步 | `server/device-center/`（`hub-conversations.ts` · `task-recovery.ts` · `desktop*.ts`） | [`device-center.md`](docs/device-center.md) · [`device-collaboration.md`](docs/device-collaboration.md) · [`device-desktop.md`](docs/device-desktop.md) · [`device-file-sync.md`](docs/device-file-sync.md) |
| **Bot 獨立化 / 直聊 / 獨立記憶** | `server/device-center/direct-rooms.ts`★ · `server/device-center/bot-memory.ts`★ · `server/bot-memory-tool.ts` · `web/src/components/AgentBotsSection.tsx` | [`agent-bot-design.md`](docs/agent-bot-design.md) |
| Hub 線上升級 / 釋出包驗收 | `bin/hub-upgrade.mjs`★ · `server/device-center/hub-upgrade.ts` · `tests/hub-upgrade-release-test.mjs` | [`device-center.md`](docs/device-center.md#hub-線上升級) · [`hub-upgrade-release-testing.md`](docs/hub-upgrade-release-testing.md) |
| 畫布協同（版本 / 執行 / 產物） | `server/canvas/` · `server/workspace-handle.ts`（共享工作樹原語） | [`architecture-canvas.md`](docs/architecture-canvas.md) |
| 預設匯入匯出 / 社群分享 | `server/preset-share.ts` · `server/preset-fields.ts` | [`preset-sharing.md`](docs/preset-sharing.md) |
| 本地化 / 模組字典 / 語言包同步 | `web/src/i18n/catalog.ts`★ · `web/src/i18n/messages/` · `scripts/lib/i18n-catalog.mjs` | [`i18n.md`](docs/i18n.md) |
| UI 佈局 / 主題 / 樣式紅線 | `web/src/styles.css` · `themes/` | [`agent-rules.md`](docs/agent-rules.md#三ui-佈局與樣式規範) |
| 目錄結構與全量檔案清單 | — | [`directory-reference.md`](docs/directory-reference.md) |
| 檔案落位 / 暫存產物（根目錄白名單、指令碼落點） | `.gitignore` · `scripts/` | [`agent-rules.md`](docs/agent-rules.zh-TW.md#八檔案落位與暫存產物) |

## 2. 工程流

| 主題 | 文件 | 常用入口 |
| --- | --- | --- |
| 開發工作流 / CI | [`development.md`](docs/development.md) | `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run test:smoke` · `npm run ci:local`（本地復刻 CI 門禁） |
| 測試規範 | [`development.md`](docs/development.md) | 埠 ≥8900、data-dir `mkdtemp`、禁 `pkill -f`、冒煙停用 `ensure-build.mjs` |
| 釋出 | [`release.md`](docs/release.md) | `npm run changelog:i18n` → commit → tag `vX.Y.Z`（自動桌面/說明）→ 手機包 `npm run release:local -- vX.Y.Z --skip-desktop` → `npm run release:npm` → `npm run release:check` |
| 部署 | [`deployment.md`](docs/deployment.md) | `pi-web-ui server install` · `docker compose up -d` |
| 環境變數全表 | [`env-vars.md`](docs/env-vars.md) | `PI_WEB_PORT` · `PI_WEB_HOST` · `PI_WEB_CWD` · `PI_WEB_DATA_DIR` · `PI_WEB_TOKEN` · `PI_WEB_SDK` |

## 3. 紅線（細則見 `docs/agent-rules.md`，守衛均對應 `tests/unit/<守衛>.test.ts`）

| 域 | 一句話禁令 | 守衛 |
| --- | --- | --- |
| **安全/協議** | `details` ≤64KB；服務端 URL 必包 `appUrl()`；Cookie 校驗前先解碼；未登入頁口令表單必須原生 `POST /__pi/auth`（禁 JS 拼 `?token=`） | `auth-login` |
| **提示詞/工具** | 工具提示詞三處職責分離、純英文精簡；匯出 schema 只留欄位名/型別（裝飾約束與自解釋欄位說明不寫） | `tool-prompt-hygiene` · `tool-schema-slim` · `lazy-tools-test` |
| **提示詞/工具** | 新增可開關工具三處聯動（catalog / customTools / 註冊單測） | `tool-registration` |
| **提示詞/工具** | 提示詞 base（SYSTEM.md / APPEND_SYSTEM.md）歸屬 session 的 loader，禁客戶端級「最近一次」欄位 | `prompt-base-scope` |
| **服務端/執行態** | 壓縮軟上限雙層監控；換模型只走 `applySessionModel` | — |
| **服務端/執行態** | 會話過戶必須事務性回滾；跨 await 用穩定身份，禁讀 active | `takeover-rollback-test` |
| **服務端/執行態** | 工作區命令（set_cwd/new_chat/switch_*/沙盒）一律走 `server/workspace-queue.ts` 佇列；`new_chat.cwd` 切不過去就不建會話 | `workspace-queue` · `pending-workspace` |
| **服務端/執行態** | 服務端禁同步子程序（`spawnSync`/`execSync`/`execFileSync`），熱路徑改非同步 spawn 或靜態推導 | `sync-child-process-guard` |
| **服務端/執行態** | 遠期定時器 >6h 必須 `armDelay` 分片；預設分享必須白名單淨化 + dryRun | `plugin-cron-overflow-test` · `preset-share` |
| **前端/樣式** | 強調色/語義色實底文字走 `--accent-contrast` / `--on-*`；主題文字令牌有對比度下限 | `accent-contrast` · `semantic-contrast` · `theme-text-contrast` |
| **前端/樣式** | 長文本/路徑防溢位三件套；獨立浮層才可 `overscroll-behavior: contain`；卡頭只放自身複製鍵 | `text-wrap` · `messages-behind-composer` |
| **前端/樣式** | 疊棧浮層禁寫死 z-index，一律 `useOverlayZIndex()`；輸入框上帶子單源 `--composer-strip`，禁把短語行改回 `absolute` | `overlay-stack` · `messages-behind-composer` |
| **前端/狀態** | 左欄「執行中對話 / 歷史會話」行歸屬只由 `server/conversation-rows.ts`（`rowKind`）裁定、身份只走 `web/src/session-identity.ts`，禁在元件裡另寫臨時鍵 | `session-identity` · `conversation-row-declared` |
| **外掛/依賴** | 宿主提供的包只進 `peerDependencies`（子程序副本進 `optionalDependencies`） | `extension-host-packages` |
| **外掛/依賴** | 複製黑名單隻走 `server/fs-copy.ts` 按相對路徑判定；外掛程式碼目錄可重建、狀態只住 `plugin-data/<id>/` | `plugin-copy-single-source` · `plugin-bundled` |
| **外掛/依賴** | 外掛市場 builtin 清單 `plugins/catalog.json` 只收本倉庫 `plugins/<id>` 自帶的外掛；第三方外掛登記到社群清單倉庫 | `plugin-catalog-builtin-scope` |
| **外掛/依賴** | 改內建外掛必遞增 `manifest.json` 版本號並同步資料目錄；外掛 `arrange.label` 改名必落到渲染層 | `plugin-version-bump-guard` · `bar-item-unified` |
| **測試規範** | 會話/守護假體一律走 `tests/helpers/fake-session.ts`（預設值從生產原始碼推導），禁手搓 `Object.create`（存量名單隻許變短，遷移完刪名單行） | `fake-session-sync` · `fake-session-adoption` |
| **終端/執行** | 長駐服務走 `bash({background:true})`（面板可停）；原始碼倉庫/CI 死命令走 `safe-exec`（硬超時 + 殺程序樹 + 日誌先落盤）；禁前臺 watch/pager/等 stdin，禁手寫 `timeout`/`nohup` 字首 | `safe-exec` |

## 4. 提交前三連驗（CI 硬門禁）

1. `npx prettier --write <改動檔案>`
2. `npm run typecheck`（5 個 tsconfig 零錯誤；單測 mock 用 `{} as any`）
3. `npx vitest run <相關單測>`
<!-- prettier-ignore-end -->
