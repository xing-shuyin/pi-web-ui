[English](./architecture-terminal.en.md) · [简体中文](./architecture-terminal.md) · **繁體中文**

# 終端架構

> 覆蓋 PTY 管理、原生 CLI 工作臺、按鍵編碼、輸出合併、SCM git 查詢、活力檢測、終端接管 bash 等。

## Windows PTY 與輸入法定位

本地 PTY 在 Windows 上通過 `node-pty` 的 `useConptyDll: true` 使用包內附帶的 ConPTY。系統自帶的舊版 ConPTY 會在游標隱藏時重繪螢幕，卻丟棄 CLI 最後發出的游標定位序列；TUI 繪製的輸入游標與 xterm 實際游標因此分離，中文輸入法候選欄會落在狀態列或視窗底部。包內 ConPTY 保留這些序列，使 xterm 的輸入 textarea 跟隨 CLI 的真實輸入位置。該設定覆蓋本地 shell、原生 CLI 和 bash 接管終端，遠端虛擬 PTY 不受影響。

`tests/native-cli-smoke-test.mjs` 使用真實 PTY 驗證：隱藏游標後繪製輸入行和右側狀態列，再移回輸入行，最終定位序列必須到達客戶端；該回歸與貼上、重連、退出、重啟共用完整鏈路。

## 原生 CLI 工作臺

- 標準 Pi `ClientSession` 宿主內，每次建立 CLI 都新增獨立 `Conversation`，與該宿主的普通聊天共用 `ConversationSummary` 列表、專案列表、檔案樹和預覽；型別由當前對話快照決定，不儲存為客戶端全域性標籤。啟動配置可選擇 Pi、Claude Code、Codex、Antigravity（agy）等具備獨立 CLI 的程式，這與當前聊天宿主引擎不同。DSH、Claude、Codex、Durable 等其他聊天宿主暫未適配 `new_cli_chat`，請求返回錯誤 notice 與失敗回執；不會自動切換使用者引擎，也未聚合跨引擎列表。`PI_WEB_TABS` 由 `terminal` 開關統一管控 CLI 與普通終端，服務端也拒絕停用後的輸入。
- 事實源：`server/native-cli.ts`（啟動配置、型別持久化、輸入與檔案準備）、`server/native-cli-model.ts`（執行時模型連線解析與子程序認證適配）、`server/native-cli-state.ts`（原生會話繫結與事件游標）、`server/native-cli-runtime.ts`（宿主/終端適配契約）、`server/native-cli-session.ts` / `native-cli-session-hooks.ts`（精確續接與官方事件）、`server/remote-cli-persistence.ts`（tmux 保活與例項控制）、`server/remote-native-cli.ts`（遠端檢測與安全啟動資料）、`server/native-cli-routes.ts`（按需檢測 API）、`server/native-cli-remote-files.ts`（遠端引用與附件暫存）、`server/native-cli-remote-cleanup.ts`（離線清理重試）、`server/remote-ssh-service.ts`（共享 SSH 通道與租約）、`server/native-cli-references.ts`（頁面、對話、畫布引用內容物化）、`server/engine-catalog.ts`（引擎、包名與 CLI 能力單源）、`server/engine-cli.ts`（共用啟動解析與版本探針）、`server/native-cli-discovery.ts`（本機 CLI 路徑檢測）、`server/terminals.ts`（真實 PTY 生命週期）、`server/dispatch-domain-handlers.ts`（建立與貼上路由）、`web/src/components/NativeCliCreateModal.tsx`（建立彈窗與展開式新建控制元件）、`web/src/components/NativeCliPanel.tsx`（內嵌 TermXterm）、`web/src/native-cli-reference.ts`（引用計劃與目標）、`web/src/native-cli.css`（主題樣式）。
- 從其他本地或 SSH 專案新建 CLI 時，啟動成功後將視窗當前目錄切到目標專案，停止舊專案的 Git 監聽，再重新整理工作區根目錄、專案列表、會話、檔案樹與命令；頁面快照使用目標目錄。啟動失敗時保留原專案和活動對話。
- 頂欄「＋」新建對話保持圖示 + 「新對話」文字；它右側是一個獨立的「⌘ CLI」膠囊按鈕（圖示用 `FiCommand`，與終端檢視的 `FiTerminal` 區分），點選用當前目錄開啟引擎選擇彈窗，不懸停展開、不用負邊距，因此不會覆蓋左側 logo 等相鄰控制元件。新建 CLI 對話還從左側頂部「＋」選單與左欄專案行進入，三處都複用同一個彈窗並遵循 `terminal` 功能開關。左欄專案行空間窄，仍用展開式控制元件：懸浮或聚焦時同一控制元件向左擴展出僅顯示圖示的 CLI 點選區，兩區以原按鈕高度為邊長、共享整塊背景與外輪廓，展開與收起通過寬度和負邊距同步過渡，不擠動相鄰操作，關閉時 CLI 區域隱藏且不可聚焦。
- 預設與引擎管理共用 `ENGINE_CATALOG`，從 `cliCommand` 派生可直接啟動的 Pi、DSH（`dsh-tui`）、Claude Code、Codex、Antigravity（`agy`）。agy 是獨立互動式 CLI，直接啟動原生 TUI，不走 IDE 啟動器、`--print` 或 ACP；[官方安裝說明](https://antigravity.google/docs/getting-started?tab=cli)，macOS/Linux 原生路徑 `~/.local/bin/agy`，Windows `%LOCALAPPDATA%\\agy\\bin\\agy.exe`，服務端無 PATH 時也會檢測。首次執行保留 CLI 自身的主題、渲染、工作區信任及登入流程。agy 沒有 npm 包及 SDK 聊天驅動，不進入 SDK 引擎安裝和升級目錄；`NativeCliEngineId` 與 `BuiltinEngineId` 分別描述 CLI 預設和 SDK 引擎。
- DSH 原生 CLI 預設基於生態互動式 TUI 包 `@deepseek-harness-tui/dsh-tui`（命令 `dsh-tui` / 別名 `dst`，底層由 `@deepseek-ai/dsh` 驅動，安裝命令 `npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`）。DSH 沿用其自身 profile 配置與環境變數/模型憑據，CLI 啟動模型繼承保持關閉（`cliModelArgs: null`）。Pi Durable 僅提供庫 API、沒有 npm bin，選項停用並說明無獨立 CLI，服務端同樣拒絕啟動。
- 直接啟動互動式 CLI，預設沿用目標主機的環境與登入配置；啟用 Claude/Codex 模型繼承時按下述規則將連線資訊傳給子程序。不加跳過許可權引數，不解析回答為聊天訊息。引數每行一個，不把輸入當 Shell 表示式執行。
- 設定 → 模型與提供商 →「CLI 啟動模型」以 `nativeCliInheritModel` 儲存各 CLI 的獨立繼承開關，預設全部關閉；這是全域性共享的啟動偏好，不進入主代理預設。支援能力由 `ENGINE_CATALOG.cliModelArgs` 單源宣告：Pi 傳 `--provider` 與 `--model`，Claude Code / Codex / Antigravity 傳 `--model`，自定義命令不猜測其引數格式。開啟時 `newCliChat` 在首次 await 前捕獲當前對話的模型 `{ provider, id }`，儲存到 `NativeCliConfig.model` 並持久化進原生 CLI 元資訊；沒有當前模型則繼續使用 CLI 預設配置。已有 CLI、顯式重啟及歷史恢復沿用捕獲值，不受後續模型選擇或開關變化影響。使用者顯式 `--model` / `-m`（含 `=value`）與 Pi 的 `--provider` 引數分別優先，`--` 之後的文本不當作選項。Claude Code / Codex 在每次建立、重啟及歷史恢復時，通過宿主 SDK `modelRuntime.getAuth` 重新解析該提供商的執行時 API 金鑰、端點與請求頭，支援當前金鑰與動態認證配置；不把金鑰寫入 `NativeCliConfig`、會話元資訊、協議快照或 CLI 全域性配置。Claude 通過子程序的 `ANTHROPIC_BASE_URL`、官方 API-key 或自定義端點 token 環境變數連線，並把同一組值並入啟動時已有的 `--settings` 覆蓋層：`~/.claude/settings.json` 的 `env` 優先順序高於繼承的程序環境變數（cc-switch 之類的工具正是把中轉端點存在那裡），只有命令列覆蓋層能反向壓過它。覆蓋層只合併 `env`（衝突項置空而非省略），其餘鍵——使用者與 pi-web-ui 各自的 `hooks`、`permissions`——原樣保留，絕不改寫使用者設定檔；多層 `hooks` 是合併執行而不是替換。合併後的文件含金鑰，因此落成 0600 私有檔案、argv 只出現路徑；遠端工作階段在同一套 bootstrap 通道里把該檔案寫到主機 `/tmp`（內容走加密通道、不進任何 argv）。使用者自帶 `--settings` / `--disable-hooks` / `--bare` 導致沒有覆蓋層時，退回純程序環境變數。Codex 通過 `-c` 指定臨時 provider，金鑰和請求頭值只用環境變數引用，不進入 argv，`wire_api` 按繼承模型的協議在 Responses/Chat 間選擇（DeepSeek 這類純 Chat Completions 端點走 Chat）。Claude 要求 Anthropic Messages 協議：原生端點直接透傳位址與金鑰；迴環協議轉換閘道（Magpie、Antigravity-Manager 這類與 cc-switch 同款思路——同一金鑰、同一主機上的 Anthropic 路徑做協議轉換）自動派生其 Anthropic 端點；官方直連的非 Anthropic 端點無法服務 Claude Code，此時回退並提示。訂閱 OAuth 同樣透傳：Claude 側以 `CLAUDE_CODE_OAUTH_TOKEN` 傳入（正是 `claude login` 寫入的那一種），Codex 側以 ChatGPT 後端 Bearer + `chatgpt-account-id` 請求頭傳入（僅 openai-codex 提供商）。Pi / Antigravity 僅傳模型引數，認證與端點沿用各 CLI 自身配置。無可用連線時同時去掉繼承的 `--model`/`--provider`，讓 CLI 乾淨地回到自身登入，而不是帶著一個對端不可用的模型 id 啟動。非同步認證期間關閉終端或對話會取消待啟動請求，防止遲到憑據解析重新拉起程序。
- 本地啟動的預設通過 `resolveEngineCliLaunch` 在每次啟動時自動檢測執行 pi-web-ui 的機器：先按 `PATH` 順序查詢，再查使用者原生安裝目錄（如 `~/.local/bin`）、當前 Node 目錄、npm prefix、pnpm / Volta / Bun / Scoop 目錄及 fnm / nvm 持久版本目錄。多個持久版本按版本號降序查詢；若仍無啟動器，複用 `global-loader.ts` 的全域性包檢測，並核對對應 `package.json.bin` 的真實入口。包已安裝不等於 CLI 入口可用。不掃描整盤，路徑檢測不執行 shell 或額外探測命令，不快取未安裝結果。POSIX 下跳過沒有執行許可權的候選，npm 的 JavaScript 入口經相鄰 Node 或服務端當前 Node 直接啟動，不依賴 shell 中的 `node` 命令；顯式自定義路徑保持優先，檢測失敗提示安裝 CLI 或配置自定義路徑。遠端瀏覽器使用的是服務端機器的 CLI，無法檢測瀏覽器所在機器的安裝。建立彈窗開啟時對本地工作區呼叫同一檢測 API（`target: "local"`），未安裝的預設置灰並顯示“未安裝”，安裝命令取自 `ENGINE_CATALOG.installCommand`，一鍵安裝複用宿主既有的 `pi-web-ui:plugin-run-command` 事件在終端標籤裡執行（agy 沒有 npm 命令，連結到官方安裝說明）；檢測本身失敗（如 terminal 功能關閉）時不停用預設，回退到直接建立，避免探測把建立卡死。
- 引擎管理中的 CLI 版本探針、Claude/Codex 驅動實際啟動、原生 PTY 工作臺共用 `engine-cli.ts`，驅動不再維護各自的 PATH、版本管理器或 npm 入口查詢。版本探針僅執行共用解析結果加 `--version`；Pi/DSH/Durable 的 SDK 或執行時可用性仍按各自引擎契約判斷，不把庫可用性強行等同於獨立 CLI。
- Windows 上解析 npm `.cmd` 包裝指令碼中的字面入口：Node 指令碼經 Node 啟動，原生 `.exe` / `.com`（如 Claude Code）直接啟動。引數保持獨立 argv，不經 `cmd.exe` 展開；需要變數展開、附加引數或命令的包裝指令碼仍拒絕，使用者可配置實際執行檔。
- `new_cli_chat { config: NativeCliConfig, cwd?, requestId? }` 建立並激活獨立 CLI；有 `requestId` 時複用 `new_chat_result { requestId, ok, conversationId? }` 回執。`UiState.nativeCli?` 與 `ConversationSummary.nativeCli?` 均為 `NativeCliConversation { config, terminalId, status? }`。SDK runtime 僅作為現有 Conversation 的宿主，普通 `prompt()` 拒絕向 CLI 傳送模型訊息；CLI 不參與空白聊天重用。
- CLI 使用已有 conversation-owned PTY；輸入、貼上、attach、resize、kill 帶 `conversationId` 與 `ownerKind: "conversation"` 精確路由。`TerminalInfo.nativeCli` 保留啟動配置，同一個 PTY 只掛一個 xterm writer。啟動目錄固定為建立時的專案目錄，切換專案不會改變程序 cwd。
- 切換普通聊天或不同 CLI、重新連線和網頁重新整理僅 attach 已有 PTY並回放其緩衝；切走與 LRU 自動收起不會釋放 CLI。程序退出後保留 descriptor 與輸出，使用者顯式用 `terminal_create`（`ownerKind: "conversation"`、所屬 `conversationId`、descriptor 的 `terminalId`）重啟。重啟配置和 cwd 從對話讀取，忽略客戶端覆蓋；重啟失敗保留舊輸出。顯式關閉對話才整體釋放 runtime 與 PTY。
- 建立前先準備 SDK 宿主與 PTY，成功後再啟用；SSH 啟動等待遠端目錄、執行檔與無回顯引導握手確認。建立失敗釋放新資源並保留原活動對話；同一終端的併發建立共用一次啟動，關閉或宿主釋放會取消待啟動請求，遲到通道立即關閉；pending 例項同樣參與終端歸屬查詢，確保首次啟動階段的關閉能命中原 owner。遠端建立設定 90 秒截止，到期後拒絕遲到啟用；前端等待回執 120 秒，避免先報超時後又切入新 CLI。session custom entry `webui/native-cli { version: 1, config }` 儲存型別，即使沒有聊天訊息也顯式寫盤；從歷史開啟時恢復 CLI descriptor、分配當前 runtime 的 terminalId；保活會話優先掛接原程序，程序已結束時才按精確原生繫結啟動續接程序。歷史啟動失敗仍保留 CLI 型別，可顯式重試；損壞或未知版本的型別元資訊拒絕開啟，避免誤當聊天。原生聊天轉錄仍由 CLI 自身儲存；獨立 `webui/native-cli-state` 元資訊儲存精確會話繫結與事件游標，恢復時自動補原生續接引數。普通 PTY 不跨服務重啟恢復程序或緩衝；啟用 SSH tmux 保活後可重新掛接仍存活的原程序。
- 建立 CLI 後主動重建並推送所屬專案的 `sessions` 歷史列表，不依賴 SDK 訊息事件或使用者再次展開專案；若建立前的目錄掃描仍在進行，待其結束後丟棄舊快取再掃描。歷史掃描器從同一 `webui/native-cli` marker 提取配置，`SessionSummary.nativeCli?: NativeCliConfig` 投影歷史型別（沒有執行時 `terminalId`）；零 SDK 訊息仍保持 `messageCount: 0`，不偽造普通聊天訊息。增量掃描、長配置行與改名均保留型別元資訊。
- `NativeCliPanel` 只內嵌 `TermXterm`，沒有獨立 composer。使用者直接在原生 CLI 輸入文字；當前 CLI 啟用時通過共享 `composer-bridge` target 與右欄 `App.attach` 將引用注入終端。引用走 `terminal_cli_paste`，以 `requestId` 等待 `terminal_cli_paste_result`；服務端清理控制字元後向同一 PTY 一次寫入 bracketed paste，**不追加 Enter**，不通過螢幕文本猜測 CLI 是否等待輸入。
- 非同步讀取頁面、對話或畫布時，先捕獲目標 manager 與 PTY 程序例項；await 後只向原例項貼上。切換對話不會改投新 CLI，退出後同 ID 重建的程序也拒絕接收舊請求。物化或貼上失敗、斷線、ACK 超時顯示 notice，不自動 Enter，不自動重試。
- 檔案和目錄傳真實路徑，可附行號；顯式選取的絕對路徑沿用普通附件策略，允許右欄機器瀏覽和額外 root 的引用。相對路徑及其符號連結必須留在 CLI cwd 內；上傳檔案和圖片儲存到現有 per-client uploads 目錄後傳實際路徑，uploadPath 始終校驗當前客戶端歸屬。圖片是否可讀由 CLI 決定，此功能不代表原生多模態注入。小段文本引用保留原文，超過 PTY 預算的引用落盤；已授權頁面讀取可見文本，對話讀取真實轉錄，畫布匯出真實 JSON，交給 CLI 的是實際內容檔案路徑。讀取失敗或內容為空時失敗回執，不降級為只有 URL/ID 的元資訊。
- SSH 工作區支援 POSIX（Linux/macOS）遠端 CLI。複用已儲存的 SSH 主機、認證、known_hosts 與連線池，不增加獨立憑據表；未知或變更的主機金鑰仍通過現有 SSH 工作區流程確認。`cwd` 保持規範的 `ssh://user@host:port/path`，SDK 宿主與歷史通過 `resolveWorkspaceSessionDir` 存在本機快取，`.pi-remote-uri` 保留真實遠端身份；啟動、重開和歷史恢復始終在對應遠端目錄執行。遠端 Windows 暫不支援，不會降級到本機執行。
- 建立彈窗按需請求 `appUrl('/api/native-cli/discovery?cwd=…')`，顯示可用預設和不可用原因（SSH 還顯示主機、目錄與保活狀態）；關閉、重試或切換專案時取消舊檢測並忽略遲到結果。API 受現有鑑權與 terminal 功能開關保護。遠端檢測與啟動共用遠端 PATH，覆蓋原生、agy、npm/pnpm/Volta/fnm/nvm 安裝目錄；不使用本機 Node、PATH 或 `.cmd`。自定義執行檔填寫遠端命令或路徑。SSH 預設必須由檢測確認才可點選，本地預設只在檢測明確報告缺席時停用。
- SSH 使用 `createCommandPty` 的 exec + PTY 通道。非互動 POSIX 引導先驗證目錄與可執行許可權並關閉回顯，收到隨機握手標記後通過 stdin 傳入有界的安全引用環境變數；金鑰不進入 exec 命令、argv、shell 歷史、配置或日誌。恢復終端模式後 exec 原生 CLI，不依賴遠端 Python/Node，也不依賴 `AcceptEnv`。繼承的模型地址必須從遠端可訪問，`localhost` 指向遠端本機；不自動建立模型代理隧道。純 POSIX 引導不能確認所有 execve 失敗型別，壞直譯器等立即退出仍通過退出事件呈現。
- 活躍遠端 shell、CLI 與 exec 持有連線租約，阻止原 30 分鐘空閒回收誤關執行中的通道；完成、取消、斷線均釋放租約。未啟用保活時，顯式關閉只關閉所屬通道；啟用保活後先確認所屬 tmux 例項停止。兩者均保留共享連線上的其他會話，不會把 `exit` 當作 CLI 輸入。斷線後保留輸出和退出狀態，使用者顯式重開；原生選單、工具許可權和登入由 CLI 自己處理。
- 遠端引用使用真實 POSIX 路徑，預設驗證同主機、工作區及 realpath/symlink 邊界；工作區外絕對路徑只能由服務端顯式授權。本機 `uploadPath` 使用解析後的例項 `dataDir`（包含 `--data-dir` 覆蓋）校驗 per-client 歸屬，與物化引用的儲存位置保持同源；圖片、上傳與頁面/對話/畫布物化檔案經 SFTP 寫入隨機 `/tmp/pi-native-cli-<UUID>` 目錄（0700），再貼上遠端路徑；首期不遞迴上傳目錄。成功貼上將暫存清理繫結到捕獲的程序例項；保活會話同時持久化目錄所有權，僅在確認程序退出或停止後清理。失敗、取消與遲到 mkdir 也清理；離線清理失敗保留路徑並在服務執行期間後臺退避重試。
- 左欄執行中的 CLI 對話單擊關閉即傳送 `dismiss_conversation`，確認程序停止後釋放執行時並保留歷史；停止失敗保留對話供重試。歷史記錄刪除仍需二次確認，`delete_session` 先確認所屬程序停止並移出執行對話，再刪除記錄，適用於前臺及後臺 CLI。會話自帶的 CLI 終端參與切換保活（`countBlockingLive`），但不計入阻止移出的使用者終端（`countUserBlockingLive`）；使用者另開的互動式終端和獨立 CLI 標籤仍保護現場。刪除成功後推送記錄所屬專案的最新歷史列表，跨專案及 SSH 歷史無需重新整理頁面；刪除前啟動的舊列表掃描失效後重讀，不能回灌已刪記錄。

## 原生 bash 生命週期

`resolve-global-sdk.ts` 預載入時註冊 `patch-bash-process.ts` 的 Node 模組載入鉤子，在 SDK 原生 shell 模組首次編譯前應用記憶體相容補丁（#794），同時覆蓋自帶與跟隨 SDK，繼續複用 SDK 的 shell 配置、環境及程序樹清理。不改寫任何已安裝 SDK 檔案。未識別的上游結構會輸出警告，不靜默假定已修復。CLI、生產、桌面和開發服務均須在入口之前預載入該模組；直接匯入 SDK 的測試不註冊鉤子、不產生磁碟副作用。另一個載入鉤子 `patch-executable-lookup.ts`（#810）用同樣的方式把 SDK 的 `which` / `<cmd> --version` 子程序探測換成 PATH 掃描（Android/Termux 預設開啟，見 `docs/env-vars.md`），同樣只改寫記憶體中的 ESM 原始碼，未識別的結構同樣告警而非假定已修復。

執行 timeout 只約束主程序執行階段；收到 `exit` 即儲存真實退出碼並停止執行計時，之後等待輸出關閉或 100ms 靜默。輸出收尾另有不可被持續輸出延長的 1 秒上限，觸及時明確標註停止收集並關閉本地讀取端，避免後臺子程序持有繼承管道造成無限等待。正常退出不主動殺後臺任務。取消及真正執行超時會呼叫 SDK 的程序樹終止，並最多等待 1 秒清理，即使未收到 `exit`/`close` 也結算。所有結算路徑釋放監聽器、輸出流和計時器。

`timeout` 不改變原生/PTY 路由或永續性；Windows 仍只在顯式 `persist: true` 且開啟終端接管時走持久終端，避免一次性控制台耗盡。

`abort_bash` 的可選 `conversationId` 精確指定當前客戶端持有的會話，省略時僅使用當前會話，不查詢其他執行命令。原生、終端和擴充套件 bash 的控制器統一掛在穩定的 `Conversation` 物件上，執行時解析歸屬，隨過戶與 ID 衝突改名一起遷移。取消前捕獲目標 runtime，停止提示只注入該 runtime；前端切換會話期間不傳送停止請求。

### 原生會話續接、遠端保活與狀態

- `webui/native-cli-state { version: 1, key, preset, cwd, nativeId?, processId?, lastEventId?, seenEventIds, stagingPaths? }` 是服務端所有的繫結元資訊，與客戶端可填寫的 `NativeCliConfig` 分開。`key` 是獨立 UUID，歷史恢復校驗引擎和工作區，不按專案「最近一次」猜測原生會話。內部 hook 引數、提供商金鑰、指令碼內容不進入公開配置或快照；返回的啟動配置只用於當前程序。
- Pi 使用獨立會話目錄和精確 `--session`；Claude 使用同一 UUID 的 `--session-id` / `--resume`；支援官方 hooks 的 Codex 從 SessionStart 捕獲精確執行緒 ID，後續 `resume <ID>`，不回退 `--last`。agy 支援基於 `--settings` 的 hooks 生命週期事件與首次 ID 捕獲（SessionStart / PreInvocation / PreToolUse / Stop），使用者傳 `--disable-hooks` 時降級為程序狀態；dsh 與 Custom 保留程序狀態。使用者顯式會話引數優先；繫結會話已丟失時明確失敗，不換成別人的歷史。相同 key 的 `native-id` 在對應轉錄驗證存在後可恢復父層尚未持久的 ID 或會話切換；不讀取專案 latest。
- 生命週期來自官方事件：Pi 的 interactive input、agent_settled、使用者提問事件，以及 Claude/Codex 的 SessionStart、UserPromptSubmit、Stop、PermissionRequest 等。`working` 不等價於使用者傳送；獨立 `submitted` 才投影為 `native_cli_prompt_submitted`，供側欄排序消費，不觸發 OS 通知。使用者現有 hooks/settings 保持優先，Codex 按事件避讓（包含合法 TOML 引號鍵）；沒有可靠事件時降級為程序狀態，不解析螢幕猜測完成或授權。新增 hooks 的首次信任由 CLI 自身官方介面處理，不跳過許可權。
- 原生記錄位於本地 `<dataDir>/native-cli/<key>` 或遠端 `~/.pi-web/native-cli/<key>`，私有目錄 0700、記錄/指令碼 0600。事件檔案有界；恢復時按持久游標繼續消費，無游標的歷史基線不重放提交或完成事件。派生身份事件獨立去重，只有原始 SessionStart 的 cursor 或後續語義事件推進游標，避免身份落盤後中斷丟失完成。新程序不回放舊程序活動或提問，掛接活程序則繼續補讀。觀察器錯誤和合成程序錯誤不替換原生游標。自然退出先 `flush()` 再停止觀察，取消的 done 僅更新空閒狀態，不傳送完成通知。
- `NativeCliConversation.status` 提供啟動、執行、工作、等待輸入/授權、斷開、退出與錯誤資訊，以及最近活動、原生 ID 和續接能力。單輪錯誤保留活 PTY 可寫，只顯示錯誤；SSH 斷開不當作任務完成。可靠 done/error/question/approval 同時走有界去重的瀏覽器事件與統一 `onNotificationEvent` 手機通知介面；導航使用宿主 Web/SDK sessionId，原生 ID 僅用於續接和顯示，通知不攜帶正文。手機等只讀共享檢視僅展示狀態與原生 ID，不掛接 PTY、註冊 composer 或顯示程序控制；原生提問和許可權操作仍需在擁有該 CLI 的可寫視窗處理。
- SSH 建立彈窗按需檢測 tmux（要求 ≥3.2），預設不啟用保活。勾選後通過固定 `TMUX_TMPDIR=/tmp` 與 `tmux -L pi-web-cli-<UUID>` 使用 UID 私有 socket 目錄，避開超長 HOME 的 Unix socket 長度限制。每次實際新建寫隨機例項 generation；原子建立、probe、attach 與 handle stop 校驗例項，舊 handle 不會終止同 key 的新程序。`remain-on-exit` 保留退出狀態，宿主定期 probe 獲取真實退出碼；網路不可達不能當作已結束。
- 「斷開連線」只關閉當前 attachment，保留遠端程序、觀察器與仍在使用的附件；「重新連線」優先 probe + 嚴格 attach-only，已有程序不依賴舊 CLI 路徑、當前模型憑據或轉錄檔案仍存在，原 CLI 已升級/提供商已變更也可重掛。掛接期間例項消失則報重試，不啟動佔位程式。只有程序確實不存在時才重新解析 CLI、模型並走精確續接。
- 「停止」、顯式關閉對話或刪除歷史先確認遠端 stop；確認失敗保留歸屬/歷史供重試。服務關閉、SSH 丟線及使用者 detach 都不傳送 stop；待重連 manager 的關服路徑同樣使用 `shutdown: true`。同一 terminalId 的 stop/create 序列，跨 await 校驗例項，取消清理完成前不復用待啟動槽。歷史沒有 live handle 時可按已驗證繫結獨立 stop，不需要啟動 CLI。
- 保活會話把 SFTP 暫存目錄所有權寫進繫結，斷線或關服不刪仍可能被遠端任務讀取的檔案；確認退出/停止後清理，失聯失敗進入現有退避清理佇列。該實現不保證本機服務停止期間傳送通知，也不自動安裝 tmux 或搭建模型網路隧道。

## 終端管理

- **使用者終端與 Agent 終端分層**：
  - **使用者直接建立的終端**（UI 加號新建、執行自定義命令，`agentBash !== true`）：歸屬於 `ClientSession`（工作區級別），按客戶端存活；在終端列表中**始終顯示**，不再受單個對話切換、回退、刪除或生命週期的影響和過濾；輸出即時直接下發；只有使用者手動關閉或程序自身退出時才銷燬。
  - **CLI 會話終端**：歸屬於單個 CLI `Conversation`，切換始終保留，關閉對話才回收；不進入 client-owned 全域性終端標籤。
  - **Agent 內部接管/呼叫的終端**（`agentBash: true` 或 agent 工具呼叫的互動終端）：歸屬於單個 `Conversation`，跟隨該對話的生命週期與活力檢測（靜默 ≥15s 注入 steer 提醒）。
- **統一列表推送與路由**：服務端 `pushTerminals()` 自動合併使用者終端與當前對話的 Agent 終端；`handleTerminalMessage` 對輸入（`terminal_input`）、大小調整（`terminal_resize`）、關閉（`terminal_kill`）、重新命名（`rename_terminal`）通過 `findTerminalManager` 全域性索引匹配目標終端，跨對話操作無縫直達。
- **所有 spawn 路徑統一準入**：`terminal_create`（瀏覽器/agent）與 `run_command`（命令列表）共用 `validateId`（字母/數字/.-_:/≤80 字元）+ `ensureSpawnAllowed`（新 live PTY 需低於 `MAX_TERMINALS`；已在執行的同名終端原地重啟不佔新名額；**history 裡的已退出終端不保留名額**——滿員時重跑已退出終端同樣拒絕，堵住"唯一 ID 無限生成 PTY"的洞）；失敗統一走 `fail()`（notice + 終端內紅色報錯 + terminal_exit）。

## terminal_key 按鍵編碼

`encodeTerminalKey(key, modifiers)` 是純函式（匯出，位元組級斷言在 terminal-smoke-test.mjs）：命名鍵按名稱路由，Ctrl/Alt 組合絕不回退成"Ctrl+首字母"——Ctrl+ArrowUp=`ESC[1;5A`（非 Ctrl+A）、Ctrl+Enter=`ESC[13;5u`（非 Ctrl+E）；方向鍵/F1–F4/Home/End 帶修飾符時用 xterm 修飾序列 `ESC[1;<m>X`，其餘命名鍵用 CSI-u `ESC[<code>;<m>u`，普通字元 Ctrl 對映 A–Z→0x01–0x1A、Shift 大寫、Alt 字首 ESC。

## 輸出合併

輸出經帶 `conversationId` 的 `terminal_output` 推給瀏覽器；未掛載終端保留 2MB 輸出視窗，切回對話時回放。socket 斷開不殺 PTY；切換/重連保留狀態，對話被釋放或服務關閉時才殺掉全部 PTY。

**終端輸出微批合併**（`terminals.ts` 的 `queueOut`/`flushPending`，視窗 `OUTPUT_FLUSH_MS=16ms`）：`pty.onData` 每 chunk 先入 `pendingOut` 緩衝再統一 flush 一條 `terminal_output`——構建等場景每秒數百上千個小 chunk 的 WS 幀風暴降 10~50 倍；exit/kill/原地重啟先 flush 再發退出事件保證順序。

## 終端查詢回話必須一問一答（提示符裡冒出 `1;2c`）

終端裡的程式會用 CSI/OSC 查詢終端能力，終端（xterm.js / ConPTY 對端）會**自動回話**，而回話走的是 PTY **輸入**通道。Windows 的 `useConptyDll` ConPTY 啟動時會先發 `ESC [ c`（DA1）並**阻塞輸入**直到收到回話，且**只認第一條**——多出來的回話沒有查詢與之配對，就直接落到 shell 提示符上，被 readline 當成普通按鍵：`ESC[?` 被吞掉，剩下 `1;2c` 打在命令列裡（`ESC[12;40R`、`ESC]11;rgb:…` 同理）。

- **單源**：`server/terminal-query.ts` 一處定義「查詢請求」「回話形態」「ConPTY DA1 應答」。`TERMINAL_QUERY_RESPONSE_RE` / `isTerminalQueryResponse` 由 `terminals.ts` 再匯出（判斷「這段輸入不是人敲的」用，不計入 `used`）。
- **誰回答 ConPTY 的 DA1**：服務端。`registerPty` 的 `pty.onData` 在 `conptyHandshake === false` 期間用 `splitConptyDa1` 把 DA1 從輸出裡摘掉（含被切在兩個 chunk 中間的半截字首），並立刻 `pty.write("\x1b[?1;2c")` 回一次（與 xterm.js 的應答一致）。這條查詢不再下發給任何介面：既不依賴瀏覽器此刻是否掛著 xterm，也不會因為「回放 + 即時流各回一次」而多出一句。只對本地 ConPTY 生效（遠端虛擬 PTY / POSIX 無此握手）。
- **歷史回放只負責畫**：`TerminalManager.attach()` / `replay()` 下發的是 `stripTerminalQueryRequests(entry.output)`，`web/src/terminal-bridge.ts` 的 reset 幀同樣先剝再寫。即時流保持原樣——查詢必須送到終端，否則沒人回話。`server/bash-tool` 的 `read()` 仍返回原始歷史（agent 看的是真實輸出）。
- **迴歸測試**：`tests/unit/terminal-query.test.ts`（剝查/切包/replay 與 attach 幀）、`tests/unit/terminal-bridge.test.ts`（即時原樣、reset 剝查）。

## node-pty × Node `--watch` 相容自愈

`server/patch-node-pty.ts`（必須排在 node-pty 之前 import）：dev 指令碼用 `node --watch`，watch 模式會向 node-pty 的 ConPTY worker / console-list agent 的 IPC 通道推 `watch:require`/`watch:import` 訊息——node-pty 1.1.0 不識別，導致①每條都 `console.warn('Unexpected ConoutWorkerMessage')` 刷屏；②kill 路徑把 watch 訊息當 agent 回覆，`message.consoleProcessList` 為 undefined 直接 `.forEach` 崩潰。補丁模組在啟動時冪等地改寫安裝副本（仿 spawn-helper chmod 先例）；`terminals.ts` 裡另有一層 console.warn 過濾兜底。生產（無 `--watch`）不受影響。

## SCM 原始碼管理

`SCMPanel`（檢視 `git`）的只讀 git 查詢走服務端 `server/scm.ts`，用 `execFile("git", …)` 直跑（不經過 shell——無提示符/回顯/ANSI/zsh 差異），解析成結構化 JSON。

### 協議

客戶端發 `scm_status`（status+branches(含遠端,for-each-ref)+numstat）/ `scm_history`（提交圖，懶載入——切到「提交樹」tab 才查）/ `scm_filediff`（單檔案 staged+worktree diff）/ `scm_commit`（hash 白名單校驗後 git show），服務端必回一條 `scm_data`（echo reqId + kind，ok/error/notRepo），前端按 reqId 匹配 pending 槽位——每個請求必有且僅有一個響應，UI 不可能卡 loading；sendScm 在 socket 斷開時不佔槽位不置 busy（防轉圈卡死）。路徑校驗：filediff 的 path 必須 resolve 後仍在工作區內；非 git 倉庫返回 ok:true + notRepo:true（面板顯示提示而非報錯）。15s 超時/maxBuffer 16MB。

### 左欄寬度可調（issue #139）

改動檔案 / 提交歷史那一欄預設 300px，可拖它右邊的分隔條（`.scm-divider`，雙擊復位到預設）：寬度寫在 `.scm-body` 的內聯 CSS 變數 `--scm-sidebar-w` 上，拖動中按容器寬度給 diff 區留最小寬度、鬆手才寫 `localStorage`（鍵 `pi-web-ui:scm-sidebar-width`）。夾取與存檔解析是純函式（`web/src/scm-sidebar.ts` 的 `clampScmSidebarWidth` / `parseScmSidebarWidth`，單測 `tests/unit/scm-sidebar.test.ts`；瀏覽器迴歸 `tests/scm-test.mjs`：拖 +120px → 重新整理保持 → 雙擊回 300）。CSS 那側還有一條 `max-width: calc(100% - 220px)` 兜底：視窗變窄時不會把 diff 區擠沒。

### git 目錄 watcher

首次 scm_status 時 `git rev-parse --absolute-git-dir` 定位 .git 並 fs.watch（非遞迴——HEAD/index/packed-refs 都在頂層，覆蓋 commit/stage/checkout），事件去抖 600ms 推 `scm_changed` → 前端靜默 refresh（外部 CLI/IDE 改倉庫即時反映）；setCwd/dispose/notRepo 時 unwatch；watch 失敗靜默降級為 30s 可見輪詢兜底。

### 自動重新整理觸發器

全部走 silent refresh 不閃 spinner：scm_changed / 終端 tab 裡 SCM 生成的 git 寫命令 running→exit（標題 `/^git /`）/ 檢視啟用 / cwd 切換 / 30s 輪詢。

### 寫操作

仍走可見終端 tab（TerminalPanel 同款 tab 複用邏輯）並切到終端檢視：提交/推送/拉取/切換分支（遠端分支 `origin/x` → `git checkout -b x origin/x || git checkout x`）/ 單檔案暫存（`git add -- <path>`，行 hover 顯示 + 按鈕）/ 取消暫存（`git reset HEAD -- <path>`，− 按鈕），路徑經單引號轉義。分支下拉本地/遠端分組（optgroup，i18n scmRemoteBranches）。

### 歷史教訓（已廢棄的舊實現）

曾用隱藏 PTY + shell 變數拼接 sentinel 切分文本，踩過 xterm writer 覆蓋解析器、zsh 提示符無尾換行粘行吞掉 `## main` 狀態頭、全域性佇列被流式期間的慢查詢阻塞等三個坑。

## 終端活力檢測（liveness watchdog）

`terminals.ts` 的 `noteAgentActivity` / `armIdleWatch` + agent-service 的 `notifyTerminalIdle`：agent 工具路徑的 terminal(action=create/input/key) 會啟動一個「靜默紀元」——該終端連續 `PI_WEB_TERMINAL_IDLE_MS`（預設 15s）無輸出且**該對話正在流式執行**時，經 onAgentIdle 回撥由宿主 `sendUserMessage` 注入一條 steer 提醒喚醒 AI 去檢查（等輸入/已掛起）。

防騷擾設計：①使用者手開的終端永不參與（只有工具包裝層調 noteAgentActivity，瀏覽器路徑不調）；②一次性——觸發後解除武裝，agent 再次觸碰才重新計時；③紀元內任何輸出/輸入都重置倒計時；④退出/關閉即拆鍾。提醒文案本身就是自包含的 steer 訊息（含終端的 id、最近輸出、建議的 read/input/key/close 動作），它已告知模型該怎麼做；全域性終端引導段已下線，不再另佔系統提示詞。迴歸：`tests/terminal-idle-test.mjs`（直接例項化 TerminalManager + 小閾值，零 token 不起 server；win32 未驗證）。

## 終端接管 bash（terminal-backed bash）

bash 工具始終覆蓋 SDK 內建 bash，並按設定開關 `terminalBash`（預設關）在兩種實現間**動態分流**（agent-service 的 `makeAdaptiveBashTool`）：

- **關（預設）**：`makeKillableBashTool` —— 用 SDK 原生 `createBashToolDefinition`（純程序 spawn，**不開終端**），就是覆蓋前的行為；`persist` 在此路徑無效，`head`/`tail` 對返回行做後處理。
- **開**：`makeTerminalBashTool` —— 命令寫進可見終端（全部指令碼經 `$'...'` 轉義成一個物理行的 eval，再在外層捕獲 `$?` 並列印哨兵，避免互動程式把下一行哨兵讀成輸入），哨兵帶每次呼叫隨機的 12 位 hex nonce，只認本次注入的那一個（真實輸出裡的 `[pi-exit:42]` 不會被當成真退出碼）；等哨兵行拿到**真實退出碼**後返回完整輸出（`stripAnsi` 清理；按注入位置刪回顯行與重繪行，不吞真實輸出）。此路徑下 `persist` 決定終端**生命週期**，`head`/`tail` 決定返回行數。

原生 bash 包裝層必須把 `execute` 的第 5 個引數（`ctx`）透傳給 SDK 的 definition：SDK 用它在每條命令上注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`，子 shell 繼承這些值。不透傳 `ctx` 時，SDK 仍會**清掉**繼承來的會話變數，卻寫不進當前值（子 shell 裡讀到的是缺失或過期值）。這條只針對原生 bash；終端路徑不走 SDK 的會話環境注入。另外，以 SDK 嵌入方式執行時，SDK 也不會自動設定 CLI 專用的 `AI_AGENT` / `PI_CODING_AGENT` 標記。

> 注意：`persist`/`head`/`tail` 始終出現在 bash 工具的引數 schema 裡（雙實現共用一份），關時 `persist` 被忽略，`head`/`tail` 仍生效。
>
> **提示詞單源**：description / promptSnippet / promptGuidelines / 引數說明不在這幾條路徑裡各寫一份 —— 唯一事實源是 `server/tool-prompts.ts`，由 `makeKillableBashTool`（同時也是引數 schema 的宿主）、`makeTerminalBashTool`、`makeAdaptiveBashTool` 共同取用。`makeAdaptiveBashTool` 只覆蓋 `execute`（分流）。歷史上它額外覆蓋 description，於是終端那份文案整段寫死卻永不傳送 —— 一份會持續漂移的死副本（“prefer head/tail over piping” 曾只寫在它裡面）。

### 設定開下的 `persist` 語義

- **`persist=false`（預設，一次性）**：每次呼叫新建終端 `ai-bash-<n>`（`agentBash=true`），命令跑完 shell 用 `exit` 退場（程序結束），終端連同輸出保留在 history 供查閱；阻塞到命令結束，不做靜默解阻（接近普通 bash 語義）。**Windows 適配（issue #269）**：Windows 下 MSYS2 存在全域性控制台硬編碼上限 128（`\cygwin.shared` 的 `MAX_CONS 128`），且每次 `CreatePseudoConsole` 都會啟動一個持久的 `conhost.exe`；高頻建立一次性終端不僅極慢（每次約 1.3s），且累積達到 128 次後會導致 MSYS2 控制台分配徹底耗盡死鎖。因此在 Windows 平臺上，一次性命令（`persist !== true`）自動分流走原生 SDK bash（純程序基於 pipe，極速 20ms、零控制台裝置分配）；只有明確需要持久互動（`persist === true`）時才走常駐可見終端 `ai-bash`（始終複用單個終端，只佔 1 個 slot）。
- **`persist=true`**：複用持久終端 `ai-bash`——shell 狀態（cd/venv）跨呼叫保留，支援靜默解阻後用 `terminal(action="wait"/"read"/"input"/"key")` 觀察與互動。命令未完成時拒絕再次注入 bash，互動程式只能通過 input/key 驅動；巢狀 shell/SSH 的狀態由其自身程序決定，不能假定外層命令已結束。

### Windows ConPTY 退出與 MSYS2 控制台釋放（issue #215 / #269）

Windows 下的偽終端銷燬存在兩大架構陷阱：

1. **ConPTY 關機死鎖（issue #215）**：程序退出時若直接調 `pty.kill()`（底層 `ClosePseudoConsole`），管道有未排空資料時會核心級同步死鎖，凍住事件迴圈。
2. **MSYS2 控制台 slot 洩漏（issue #269）**：若無腦直接調 Node 的 `process.kill(pid)`（Win32 `TerminateProcess`），MSYS2 的 DLL 析構與控制台清理鉤子被直接跳過，導致全域性命名共享記憶體 `\cygwin.shared` 中的控制台裝置 slot（上限 128）永久洩漏，累積後引發 `fatal error - console device allocation failure - too many consoles in use, max consoles is 128`。

`terminals.ts` 的 `killNative` 與終端生命週期對此做了精細分流：

- **程序已自然退出（`entry.exited === true`）**：絕對不呼叫 `process.kill(pid)`（避免誤殺 PID 複用後的新程序），直接呼叫 `entry.pty.kill()` 釋放 HPCON、socket 與 worker 控制代碼；因為程序已死、管道見 EOF，此時 `ClosePseudoConsole` 絕不會死鎖。終端自然 `exit`、`this.history` 淘汰最老項（超出 32）、使用者在 UI 關閉歷史 tab 以及 `killAll` 時均執行該安全清理。
- **程序仍在執行（`!entry.exited`）**：先向 PTY 寫入 `\x03exit\r` 嘗試讓 shell 正常退出並觸發 MSYS2 清理鉤子；若仍未退出才用 `process.kill(pid)` 強制兜底，最後調 `pty.kill()` 釋放控制代碼（關機 `shutdown=true` 時跳過 `pty.kill()` 由 OS 回收）。
- **`conpty_console_list_agent` 容錯（`patch-node-pty.ts`）**：給 node-pty 的 console-list agent 增加 try-catch，程序已死時 `AttachConsole` 失敗不再丟擲未捕獲異常，安全返回空列表。

`head` / `tail`（1–5000）只返回輸出的前/後 N 行，替代 `| head` / `| tail` 管道（管道會緩衝輸出、讓可見終端全程啞火、還易觸發靜默解阻）。純函式 `applyHeadTail(text, head, tail)` 只對真實資料行切片，省略提示行單獨包回，head+tail 組合時尾部不會少截一行。

### 尾部限輸出管道自動化解 + 快照查詢

`makeTerminalBashTool` 會在執行前把模型常寫的**尾部限輸出/透傳管道**（`| tail [-n N|-N]` 不含 `-f`、`| less`、`| more`、`| cat`）拆掉：底層命令直跑（可見終端即時 + 真實退出碼），只在返回給模型時按檢測到的行數截末尾 N 行；`buildTerminalBashLine` 保留當前 shell 的 `$?` 與 pipefail 配置，不強制取管道首命令，也不把退出碼 141 改寫為成功。純函式 `splitTopLevelPipes` / `detectTrailingLimiter` / `detectStdoutRedirect`（處理 `cmd > log 2>&1 | tail -N`：拆掉 tail 後補一個 `tail -N log` 讓模型看到日誌尾部）。`| grep`/`| head`/`| awk`/`| sed`/`| sort`/`| uniq` 等真過濾/變換**不拆**（拆掉丟語義或崩出海量未過濾輸出），`tail -f/--follow` 也不拆，交 prompt 引導模型不用。`terminal(action="read")` 支援 head/tail/search 輸出過濾，cursor 仍按原始流推進；內部活力提示的查詢使用 `queryTerminalOutput(output, q, running, exitCode)`（帶 1-based 行號），終端靜默提示回送的最近行數由 `terminalIdleNotifyLines()`（可配 `PI_WEB_TERMINAL_IDLE_LINES`）控制。

### 行為語義（集中在設定開 + `persist=true`）

- ①預設阻塞到命令結束
- ②連續 `terminalBashIdleMs`（預設 15s，0=一直等）無輸出 → **靜默解阻**：立即返回「仍在後臺執行」+ 已有輸出，同時註冊 `watchOutput` 完成觀察器，命令真正結束後由宿主 `notifyTerminalBashDone` 通知 AI（流式中 sendUserMessage steer / 空閒時 sendCustomMessage nextTurn 排隊不喚醒）
- ③shell 狀態跨呼叫保留（cd/venv/ssh）
- ④後臺化只結束當前等待，控制器、取消訊號與 timeout 持續有效，直到該任務完成。abort_bash、超時或 signal 取消會關閉該 PTY，避免在未知前臺程式狀態下複用 shell；再次呼叫建立新 shell，原 cd/venv 狀態隨取消釋放。
- ⑤pending 和等待繫結本次 nonce；舊任務完成不能清除新任務狀態。PTY 退出/關閉/替換會喚醒等待者，已知退出碼直接返回，不再誤報超時。

開關經 `makeAdaptiveBashTool` 的 `useTerminal` 閉包每次呼叫讀取 → 即時生效（customTools 固定於 runtime 建立，不能在建立時二選一）；`idleMs`/`defaultPersist` 同理從設定讀取。迴歸：`tests/terminal-bash-test.mjs`（直接例項化 + 小閾值注入 + `persist`/`head`/`tail`/一次性/分流用例，零 token 不起 server；win32 未驗證）。

**前端展示與配額**：持久 `ai-bash` 與一次性 `ai-bash-<n>` 都帶 `TerminalInfo.agentBash=true`（該欄位僅區分用途，歸屬由 ownerKind 決定），前端 `TerminalPanel` 把它們從使用者終端標籤裡拆出來，單獨歸到「終端接管 bash」摺疊分組（`term-folder`，可點開/收起）；`ensureSpawnAllowed` 也只按非 agent 終端計數，所以 AI 高頻呼叫 bash 不會頂掉使用者能開的終端名額。

## 統一 terminal 工具與許可權邊界

持久終端只註冊一個 `terminal` 工具，`action` 為 `create/list/close/input/key/read/wait`。舊七工具不再出現在活躍工具列表。`list/read/wait` 為只讀；`create/close/input/key` 會改變程序或輸入狀態。

- 計劃模式、reader 預設和受限子代理保留只讀動作；模型可見 schema 收窄 action 列舉，執行硬閘門仍獨立檢查實際 action。退出只讀模式時恢復原 schema。
- 舊 `terminal_<action>` 審批規則按新工具的實際 action 相容匹配；新 `terminal` 規則可以用 params 匹配 action。舊停用開關保守遷移為停用統一工具，避免升級後放開原先禁止的輸入。
- 輸入換行審批和 `key(Enter)` 審批保留；審批等待返回後再次檢查取消訊號，防止取消後傳送輸入。
- UI 的 `terminal_create/input/...` 是瀏覽器 wire 訊息，與模型工具名獨立。新增 `terminal_attach` 只附著已有 PTY、調整尺寸並回放 retained history，不建立、不重啟；元件掛載只發送 attach。新建和顯式重跑由使用者操作直接傳送。

## 終端歸屬與恢復

`TerminalInfo.ownerKind` 明確 `client` / `conversation`，與 `agentBash` 用途欄位分離。普通 AI 建立的 shell 也屬於 conversation；輸入、resize、關閉、重新命名和輸出均攜帶歸屬，拒絕把同 ID 的另一歸屬終端當作回退目標。使用者終端以當前專案根校驗新建目錄，已有程序的 cwd 與歸屬保持不變。服務端推送的是使用者終端與當前對話終端的完整列表，前端權威對賬並保留退出歷史。會話管理器自己的 `terminal_list` 必須經 `pushTerminals()` 合併，後臺會話的列表變動不直接覆蓋前臺。合併列表及 `ownerKind=client` 的輸出/退出不經過當前對話信封過濾；列表先於新快照到達時保留兩邊會話身份，渲染層僅展示當前會話的行，避免丟掉客戶端 CLI 或把另一個會話的終端顯示進來。

持久邊界是同一服務程序內的 shell 複用與頁面斷線保活，不提供服務重啟後的程序恢復。

## macOS launchd / TCC 問題

macOS 下若服務由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤兒程序），TCC 會把相機/麥克風許可權歸因到 node 本身（無 App Bundle、無 Info.plist）而靜默拒絕——ffmpeg 取流會卡死在取幀。`terminals.ts` 檢測該場景，在客戶端首次建立終端時輸出提示（改 url/檔案源，或在自己已授權的終端裡前臺執行）。

## Windows shell 解析

`terminals.ts` 的 `resolveShell()` 每次建立終端時解析，優先 bash——`PI_WEB_SHELL` 顯式 → `$SHELL` → Git Bash（ProgramFiles）→ busybox 兜底（`~/.pi-web/bin/bash.exe`，`ensure-bash.ts` 無 Git Bash 時自動下載 busybox-w32）→ `$COMSPEC` → powershell。與 SDK bash 工具（Git Bash / PATH 上的 bash）保持一致，避免 PowerShell/bash 混用掛死。

bash 工具本身與 pi CLI 同源：`server/bash-tool.ts` 把 `settings.json` 的 `shellPath`（全域性 agent 目錄 + 專案 `.pi/settings.json`，`SettingsManager.getShellPath()`）透傳給 `createLocalBashOperations`，缺失時才是上面那套 Git Bash / PATH 探測（issue #866）。終端面板不讀該配置——它只認 `PI_WEB_SHELL`，兩者的差異是故意的：終端是給使用者看一眼的可見 shell，bash 工具要跟 CLI 行為對齊。

## 終端與原始碼管理的介面容器（底部面板 / 右欄標籤）

- **佈局是左 / 中 / 右 / 下四塊，全部是 flex 兄弟節點**：左欄、聊天區（`.main`）、右欄（`.panel-drawer.drawer-right`）是同一行的三塊，底部面板（`.bottom-dock`，類名沿用 `.term-drawer`）是 `.app` 裡 `.layout` 之後的全寬一塊。誰變寬變窄都由 flex 自己重排，沒有 `padding-right` 之類的"讓位"補丁——拖動任何一側，中間聊天區會即時重排，不存在中間空一條或面板蓋住正文。
- **終端是底部面板的一個標籤**：宿主標籤 `terminal`（`web/src/components/TerminalPanel.tsx`），外掛用 `bottomdock.tabs` 註冊自己的底部標籤。只有一個標籤時不畫標籤條（`SlotTabs` / `BottomDock` 同一條規則），多個才出現標籤欄。
- **原始碼管理是右欄的一個標籤**：右欄標籤順序為「檔案 / 原始碼管理 / 外掛標籤」（`rightpanel.tabs`）。頂欄 Git = 展開右欄並切到該標籤，再點一次收起右欄；右欄寬度上限 780px，切到原始碼管理時若當前寬度不足 560px 自動加寬（`SCM_DOCK_MIN_W`）。原始碼管理面板自身用 `.scm-view` 作用域，不再依賴 `.git-drawer` 包裹層；窄欄退化為「列表 → 詳情」二級下鑽。
- 事實源：`web/src/components/BottomDock.tsx`（底部面板：高度、摺疊、拖拽把手、`pi-web-ui:bottom-dock-h`、多標籤全掛載）、`web/src/components/RightPanel.tsx`（右欄標籤：`files` / `scm` / 外掛）、`web/src/components/SCMPanel.tsx`（頭部收斂為一行 + Changes/History/Stash 分段檢視 + 底部常駐提交欄 + 分支浮層選單）、`web/src/components/TerminalPanel.tsx`（左右分割槽：左列是常駐命令欄、寬度可拖，右列頂部才是終端 tab 條 + 輸出區；窄屏左列退成蓋住右列的二級頁）、`web/src/drawer.css`（整份進 `@layer drawer`，排在層序末尾）、`web/src/components/SlotTabs.tsx`（"只有一個標籤就不畫標籤條"）。
- 入口統一在 `App.tsx` 的 `handleViewChange` 裡攔截：`terminal` / `git` 不再 `setView`，改為開面板（頂欄 tab、左側 dock、外掛事件都走同一個口子），**同一個按鈕再點一次就是收起**；快捷鍵 `Ctrl+\`` 開/關終端、`Ctrl+Shift+G` 開/關原始碼管理（`Ctrl+G` 被瀏覽器查詢佔用）。窄屏（≤768px）右欄退化為全屏 drawer，原始碼管理走「列表 → 詳情」二級下鑽，不做左右分欄。
- **xterm 例項不因摺疊解除安裝**：摺疊只隱藏輸出區、保留 tab 條（39px），避免重建 xterm 造成緩衝全量重放閃爍；抽屜關閉時 PTY 仍在服務端繼續跑（見上文斷線保活邊界）。
