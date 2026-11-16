[English](./development.en.md) · [简体中文](./development.md) · **繁體中文**

# 開發工作流

## 官方供應商

普通安裝及便攜版共用模型管理的官方 API 快速配置入口，協議、端點、地區與維護邊界見 [官方供應商接入](official-providers.zh-TW.md)。

## 提示詞模板命令

模板編輯器可設定可選命令（例如 `/pr`），正文用 `{{input}}` 標記引數插入位置。傳送 `/pr 798` 時，輸入框將所有佔位符替換為 `798` 後傳送；無佔位符則將引數追加到正文末尾。支援多行引數，不遞迴展開；已有系統、擴充套件、技能和外掛命令優先，同名模板命令不接管它們。

自定義模板、內建覆蓋和移出標記儲存在服務端 `<dataDir>/prompt-templates.json`，通過已鑑權的 `/api/prompt-templates` 讀取與逐條修改，原子提交成功後才更新介面。切回瀏覽器視窗時重新整理列表。舊 `localStorage` 模板自動遷移，服務端同 ID 條目優先，遷移成功後刪除瀏覽器舊資料；失敗時保留並顯示錯誤。

## 上下文用量明細

頂欄、底欄與側欄的上下文徽標均可點選展開明細，顯示已用比例、分類佔用條和剩餘空間。再次點選、點選外部或按 Esc 關閉；滾動只更新定位，切換對話或引擎會關閉面板。面板通過 `useFloatingPanel` 定位並 Portal 到 `body`，適配淺色、深色主題及窄屏。

pi 引擎在 `stats.contextUsage.categories` 中提供分類估算：系統提示詞、記憶檔案、工具、技能、工具呼叫與結果、訊息、其他。基礎開銷沿用設定面板的實際模板、覆蓋、停用項和工具 schema；訊息按當前模型上下文估算，不讀取瀏覽器分頁轉錄。分類隨 250ms 統計快取更新，並按權威總用量分配整數 token，差額歸入「其他」，不改變原有總量與壓縮判定。分類是會話內容估算，不是供應商返回的實際請求分類；請求檢視中的精確去重、證據外接及擴充套件轉換可能改變佔比，按總量校準不能使各分類變成精確計費資料。訊息快取只複用最後一條之前的穩定字首，末條在 SDK 非同步擴充套件替換後須重新估算。只提供總量的引擎顯示已用和剩餘空間。配置軟上限時，面板與徽標使用相同分母，並另外列出軟上限和模型容量。

## 常用命令

```bash
npm run dev          # 並行：node --watch --import tsx 後端(:8788，dev:server 指令碼，cross-env 固定 PI_WEB_PORT=8788，
#                     避開全域性 pi-web-ui 的預設 :8787) + vite 前端(:5173，代理 /ws 到 :8788)。
#                     注意：不要用 `tsx watch` 起後端——它在 Windows 下、stdio 為管道（concurrently 的 spawn 方式）
#                     時會靜默掛死（tsx 上游 bug），改用 Node 原生 --watch。
npm run dev:totp     # 本地 TOTP 測試站（http://127.0.0.1:8791，測內建瀏覽器「TOTP 驗證器」的掃碼/自動匹配/填碼，見下文「TOTP 測試站」）
npm run typecheck    # 雙端 tsc --noEmit（提交前必跑）
npm run check:protocol  # 守護協議單源 shim 機制（CI 必跑）
npm run ci:local     # 本地按 ci.yml 逐條復刻 CI 門禁（見下文「本地復刻 CI」；--profile static 秒級）
npm run hooks:install # 裝 pre-push 鉤子（預設跑 ci:local 的 static 檔）
npm run format       # prettier 全倉庫格式化（.prettierrc.json：tabs + 寬 120；提交前必跑）
npm run format:check # 只檢查不改寫（CI 跑這個）
npm run build        # build:web (vite) + build:server (tsc) + build:dsh-runtime + build:mermaid-vendor + build:runtrace-vendor
npm start            # 跑編譯產物 dist/server/index.js（生產）
npm test             # Vitest 快池（快慢分層見下文「兩個池」，≈180s）
npm run test:changed # 開發迴路：只跑受 Git 改動影響的檔案（改葉子模組時幾秒~幾十秒）
npm run test:integration # 重型整合池：真 git / 真子程序 / 真 Hub（≈170s）
npm run test:all     # 兩池都跑（提交前/CI 的完整門禁）
npm run test:smoke   # 零 token 協議冒煙聚合跑器（tests/run-smoke.mjs，82 個自包含測試；--core 只跑 PR 快檢子集；--no-build 跳過套件前的構建）
npm run test:freeze  # 凍結/重連回歸測試（Playwright，需要本機 chromium headless）
```

Electron 相關依賴（`electron` / `electron-builder` 的二進位制）走 npmmirror：打包命令（`desktop:dist`、`desktop:portable*`）已由 `scripts/run-electron-builder.mjs` 自動注入 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（預設值見 `scripts/lib/electron-mirror.mjs`）。這些映象**禁止**寫進 `.npmrc`——npm 11 會對自定義鍵告警，npm 12 起不再透傳。首次 `npm install` 要下載 Electron 二進位制，國內網路請先自帶 `ELECTRON_MIRROR` 環境變數。

## 更新本地桌面 app（macOS）

改完瀏覽器/服務端程式碼，要讓 `/Applications/pi-web-ui-desktop.app` 用上新包：

```bash
npm run build && npm run build:desktop
node scripts/run-electron-builder.mjs -c desktop/electron-builder.yml --dir   # 只出 release/mac-arm64/*.app
node scripts/update-local-app.mjs --dry-run   # 體檢：產物在不在、已裝的是不是同一份
node scripts/update-local-app.mjs            # 退出 app → 備份 → 替換 → 重新開啟
```

- 安裝包用 `--dir` 就夠，不必走 `desktop:dist`（那會額外做 dmg + zip，幾分鐘起步）。
- 指令碼冪等：已裝包與產物指紋一致就直接退出；有鎖/有別的例項在跑也退出。
- 備份只留一份（`/tmp/pi-web-ui-desktop.app.bak`），替換失敗自動回滾；日誌追加到 `/tmp/pi-app-update.log`。
- **不要**把它掛到 `launchctl`/守護程序下：launchd 會在指令碼退出後重新拉起，形成「退出 app → 替換 → 重開」的無限迴圈（真實踩過）。要延後用 `--delay 30` 或 `nohup … &`，日誌裡不要用 `>` 截斷。
- 會話服務端跑在 app 裡（`:8790` 那個子程序），所以替換會中斷當前對話的執行，歷史已落盤、重開後繼續。

## 命令執行防卡死

兩條入口，職責不重疊：

| 場景                                   | 用哪個                                                 | 為什麼                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 產品內（任意使用者專案）跑長駐服務     | `bash({ background: true })`（`server/job-runner.ts`） | 程序掛在 server 裡，prompt 立刻返回 job id + 日誌路徑，頂欄「後臺任務」面板可見可停；不依賴 `scripts/`，npm / 桌面安裝版天然可用 |
| 原始碼倉庫 / CI / 人工終端跑一次性命令 | `scripts/safe-exec.mjs`                                | 呼叫方不常駐，靠 `--detach` 守護程序 + jobfile 三件套（`.pid`/`.state.json`/`.cursor`）託管                                      |

`background: true` 的 timeout 語義與前臺**故意不同**（`server/bash-timeout.ts` 分兩條歸一）：前臺預設 120s、上限 3600s；後臺預設 / 傳 0 = **不限**，顯式正數才計時（上限 7 天，僅防手滑）。所以起 FastAPI 這類服務不會被“預設 120s”殺掉。日誌落 `<dataDir>/jobs/<id>-<slug>.log`，任務結束（正常退出 / 超時 / 空閒 / 被停 / 起不來）會發一條通知，有對話歸屬時還會補一條系統訊息。

`scripts/safe-exec.mjs` 是跨平臺（Windows / macOS / Linux）的命令執行器，給 AI、CI 和人工終端共用。它治的是五類掛死：子程序 **stdin 接到空裝置**（互動確認、pager、REPL 一律讀到 EOF）、**硬超時 + 空閒超時**（連續 N 秒無任何輸出判靜默卡死）、**殺整棵程序樹**（`server/process-utils.ts` 的 `killPidTree` 為單源：Win `taskkill /T /F`，Posix `kill(-pgid)`）、**原始輸出先落盤只回顯尾部**、**跨平臺輪詢**（`--wait` 在 Node 裡計時，不拼 `sleep` / `&&` / `$?`）。

```bash
node scripts/safe-exec.mjs --timeout 60 -- npx vitest run tests/unit/foo.test.ts   # 短任務：單測/lint/typecheck
node scripts/safe-exec.mjs --timeout 600 --log .safe-exec/build.log -- npm run build # 長構建：必帶 --log
node scripts/safe-exec.mjs --detach --timeout 1800 --idle-timeout 300 -- npm run build # >3 分鐘：託管，立即返回
node scripts/safe-exec.mjs --wait .safe-exec/20260101T000000-npm-run-build.pid --wait-sec 10 --json  # 輪詢
node scripts/safe-exec.mjs --status .safe-exec/20260101T000000-npm-run-build.pid --json              # 立即查
node scripts/safe-exec.mjs --kill .safe-exec/20260101T000000-npm-run-build.pid                      # 終止
```

`--detach` 起的是 **detached 守護程序**（內部模式 `--supervise`）：它自己每秒巡檢空閒時長與總時長並強殺，**不依賴 AI 來輪詢**——AI 崩了、終端關了，到點照樣清場。父程序只寫 job 規格就退出，**不持有日誌控制代碼**（Windows 上正是這一步帶來 `EBUSY` 和退出掛住）。Job 三件套：`.pid`（規格，一次性寫）、`.state.json`（狀態/終態）、`.cursor`（增量游標，供 `--wait` 只回新輸出）。

狀態機：`RUNNING` / `SUCCESS` / `FAILED` / `TIMEOUT` / `IDLE_TIMEOUT` / `KILLED` / `ENOENT` / `ABORTED`（守護程序被外部殺掉，或看門狗 8s 寬限後子程序仍未死 → 終態也可能是 `ABORTED`，先 `--kill` 再重跑）/ `UNKNOWN`。`--json` 輸出 `status` / `exitCode` / `reason` / `elapsedSec` / `idleSec` / `childAlive` / `terminal` / `orphanAlive` / `pipesForced` / `newOutput` / `next`（`next` 就是下一條該跑的命令）。

`--status` 是**只讀觀測者**（只算增量、不推進 `.cursor`），`--wait` 才是消費者（推進游標）：前者可以隨手反覆調，不會偷走主迴圈的輸出。子程序已退出但孫程序仍持有輸出管道時，`--wait` 會先等 1.5s 排空，隨後強拆管道並自行結算，標 `pipesForced: true`（舊實現會一直等到硬超時）。

退出碼約定：`0` 成功、`124` 硬超時或空閒超時（**不許原樣重試**，先讀日誌定位卡點再改分檔）、`127` 命令不存在、`2` 用法錯誤，其餘透傳真實退出碼。日誌預設落 `.safe-exec/`（已 gitignore），可用 `--log` 指定。`--stream` 把輸出即時 echo 到終端（給人看），預設只落盤 + 尾部 40 行。`--idle-timeout` 預設關閉：構建/型別檢查本來就可能長時間安靜，只有確認「正常執行必有心跳輸出」的任務才開。

`--kill` 先殺子程序樹（Posix 的 `-pid` 只對程序組組長有效），再收守護程序；只有子 PID 還沒釋出時才退化為單殺守護程序並明確告警。`ABORTED` 且子程序仍活的任務不會被當成「已結束」跳過，`--kill` 會繼續清場並把終態改寫成 `KILLED`。

Windows 上 `npx` / `npm` / `pnpm` / `yarn` 是 `.cmd` 墊片，直接 `spawn` 會 ENOENT：執行器會按 `PATHEXT` 解析，只有命中 `.cmd` / `.bat` 才轉 cmd.exe（相對路徑自動還原成反斜槓絕對路徑），其餘命令保持直連 spawn，不經 shell。

時限分檔：單測/lint/typecheck 60 秒、全量構建 600 秒、預計 >3 分鐘一律 `--detach` 託管；AI 的單次 bash 呼叫另有 pi 工具層 `timeout` 引數與會話看門狗兜底，三者不重疊也不互相替代。

**不要再手寫 `timeout 60s` / `nohup ... &` / `ps -p` / `sleep 5` 字首**：Windows 上 `timeout` 是「等待按鍵 N 秒」的 `timeout.exe`（語義正好相反），`nohup`、`ps -p`、`sleep` 的 cmd / PowerShell / bash 語法各不相同；空裝置也不是一個名字（`/dev/null` vs `NUL`），`$?` 三元語法同樣不通用。跨平臺只能由 Node 包裝器統一：等待用 `--wait`，查狀態用 `--status --json`，終止用 `--kill`。

`--shell` 只在命令必須整行交給 shell 時用（`--shell "<整行命令>"`，必要時配 `--shell-bin`）。`--shell-bin auto` 在 Windows 下優先探測真 Git Bash（`C:\Program Files\Git\bin\bash.exe`），類 Unix 用 `bash -c`，因此 `cd /e/pi-web-ui && ...` 這類 POSIX 路徑才不會被 `cmd.exe` 認錯磁碟機代號；直譯器也可以是 `powershell` / `pwsh`（走 `-NoProfile -NonInteractive -Command`）。

## CI

GitHub Actions ubuntu-latest（`.github/workflows/ci.yml`，push/PR → main 觸發）拆成四個並行 job：

| job           | 內容                                                                                                                            | 說明                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `checks`      | `format:check → lint → check:protocol → i18n:check → typecheck → build → 外掛 bundle 未漂移 → build:extension → pack:extension` | 全部秒級步驟，合成一個 job 避免反覆裝依賴                                                                             |
| `unit`        | `vitest run --shard=i/8`（i=1..8）                                                                                              | 單測 1047 檔案 / 12000+ 條，單機要 6.5 分鐘，是整個流程的瓶頸，分片後壁鍾降到約 1/8；`fail-fast: false`，一片紅不連坐 |
| `integration` | `npm run test:integration`                                                                                                      | 重型池（真 git / 真子程序 / 真 Hub）本來就是序列跑更穩                                                                |
| `smoke`       | `node tests/run-smoke.mjs`                                                                                                      | PR 走 `--core`、push main 走全量，邏輯未變                                                                            |

`unit` 與 `integration` 各自跑 `npm run build:server`（`tests/unit/atomic-file-generated.test.ts` 的逐位元組比對需要 dist 在場）。`unit` 還要裝 mobile 依賴（`npm --prefix mobile ci`）：`mobile-connections` / `mobile-push-controller` / `mobile-app` 三條用例 import `mobile/src/*`，缺 `@capacitor/core`、`@pi-mobile/native-local-engine` 會直接 `Cannot find package`。fork 數不再寫死 8：`tests/lib/suite-partition.mjs` 的 `FAST_MAX_WORKERS` 按實際核數收口（`min(8, 核數)`）—— GitHub 的 runner 只有 4 vCPU，8 個 fork 搶 4 個核時並行係數只有 1.66×。片數取 8 而不是 4：每個 job 有 ~50s 固定開銷（裝依賴 + `build:server`），4 片時單測壁鐘 ~110s、固定開銷 ~50s；8 片把單測壓到 ~55s，再往上只攤薄固定開銷。瀏覽器型用例的預算統一走 `tests/lib/chrome.mjs` 的 `BROWSER_TEST_TIMEOUT_MS`（60s，與 `vitest.config.ts` 的 `testTimeout` 對齊）：4 vCPU runner 上 4 個 fork 同時冷啟 Chrome，寫死 20s 會假紅。

同一分支的新推送會取消上一輪在跑的檢查（`concurrency` + `cancel-in-progress`，只在 PR 上生效），連續 push 時不再排隊跑過期提交。

冒煙清單（tests/run-smoke.mjs 的 ALL，82 個）只收**自包含、零 token、跨平臺**的測試；attach 型（需外部 server）、需真模型、平臺相關的指令碼不進 CI，本地手動跑（分類見 run-smoke.mjs 頭部註釋）。

冒煙分層（CI 提速）：PR 跑 `--core` 快檢子集（CORE，協議/安全/外掛接線代表，2~4 分鐘），push main + 每日 nightly（北京時間午夜）跑全量；`--retry-once` 讓首輪失敗重跑一次（標 FLAKY，重跑還掛才算真失敗）。新測試預設進 ALL，跑得快（<20s）且穩才進 CORE（有 ALL↔CORE 同步守衛）。

`dist/` 由跑器在開跑前**序列構建一次**（CI 已在 Build 步驟構建過，可用 `--no-build` 跳過）。用例側一律走 `tests/lib/ensure-build.mjs`，**不要**自己 `execSync("npm run build")`：預設 4 worker 並行下，一個用例重寫 `dist/` 時另一個正在 `spawn dist/server/index.js`，會出「測試外掛沒被啟用」之類與被測邏輯無關的假紅。

### 本地復刻 CI（`npm run ci:local`）

本地綠 ≠ 遠端綠，多數時候不是環境玄學，而是**本地根本沒跑 CI 跑的東西**（2026-11 的 6 次 main 紅裡，4 次掛在 `Protocol smoke tests (full)`——它 PR 不跑、本地也不跑，只能在 main 上發現）。`npm run ci:local` 按 `.github/workflows/ci.yml` 的步驟與順序逐條復刻，每步經 `scripts/safe-exec.mjs`（硬超時 + 殺程序樹），日誌落 `.safe-exec/`：

| 檔位                                  | 覆蓋                                                                               | 量級     |
| ------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| `--profile static`（pre-push 預設檔） | format:check → lint → check:protocol → i18n:check → typecheck（含 mobile）         | 1~3 分鐘 |
| `--profile pr`                        | 靜態 + build + 外掛 bundle 重建 diff + 擴充套件打包 + vitest 兩池 + smoke `--core` | ≈10 分鐘 |
| `--profile full`（預設檔）            | 上面全部 + smoke 全量（push main 才跑的那一步）                                    | ≈16 分鐘 |

`--only <id>` / `--from <id>` 斷點重跑，`--list` 看步驟與 id，`--install` 先 `npm ci`（會重灌 node_modules，慢）。

開跑前會列印「本地 ≠ CI 的已知偏差」：Node 大版本（CI 用 22）、非 Linux 平臺（大小寫敏感 import / 許可權 / PTY）、工作區髒（CI 只看已提交內容）、改了 `web/src/i18n/messages/` 卻沒生成 12 個語言包。這幾項 `ci:local` 治不了，只能靠容器或 CI 兜底——別把本地綠當萬無一失。

鉤子：`npm run hooks:install` 裝 `pre-push`（預設跑 static 檔；`CI_LOCAL_PROFILE=pr|full git push` 加嚴，`SKIP_CI_LOCAL=1 git push` 跳過），`npm run hooks:install -- --uninstall|--list` 管理。鉤子原始檔在 `scripts/git-hooks/`，不用 `core.hooksPath`（避免靜默蓋掉別人已裝的鉤子）。

## 前端構建更新與舊頁面

`web/vite.config.ts` 不清空整個輸出目錄；`web/build-assets.ts` 在構建成功後保留當前與上一輪的 assets，並清理更早的檔案，避免已開啟頁面在首次開啟檔案預覽、設定等面板時請求已刪除的懶載入模組。`.build-assets.json` 記錄當前一輪資源；首次遷移時把已有 assets 作為上一輪保留。完整替換安裝目錄仍可能失去舊資源。

`web/src/chunk-recovery.ts` 統一處理 Vite preload 錯誤與根錯誤邊界中的模組載入失敗，通過 sessionStorage 記錄恢復次數：同一構建最多自動重新整理一次，跨構建至少間隔一分鐘；持久錯誤或儲存不可用時保留手動重試介面，避免迴圈重新整理。一般應用異常不會觸發自動重新整理。

## TOTP 測試站（內建瀏覽器「TOTP 驗證器」）

`npm run dev:totp`（`dev/totp-demo.mjs`，僅迴環地址，無第三方依賴）起一個本地 2FA 站，用來跑通瀏覽器的完整鏈路：**掃碼繫結 → 按 origin 自動匹配 → 一鍵填碼 → 服務端校驗**。

- `/setup/demo`：二維碼頁（`totp.scan` 截當前標籤頁找碼，所以碼要在視口內）；同源的登入頁才能自動匹配。
- `/login/demo`：標準登入頁，驗證碼框 `autocomplete="one-time-code"`（`fillTotpCode` 的第一優先順序）。
- `/login-cells/demo`：6 個 `maxlength=1` 格子（逐格填碼路徑）。
- `/login-plain/demo`：無任何 otp/code 提示的單框（需先點輸入框再填，測兜底路徑）。
- `/api/code/:key`、`/api/account/:key`：當前碼 / 金鑰 + otpauth URI，方便 curl 對答案或手工匯入。
- 三個賬號分別覆蓋 `SHA1/6位/30s`、`SHA256`、`8位/60s`，用於確認 otpauth 引數解析；金鑰每次啟動隨機（`PI_TOTP_SECRET` 可固定 demo 賬號）。

## 編碼約定

- **縮排用 Tab**；前端元件小寫檔名（`copy-button.tsx` 例外）；程式碼註釋中英混寫，UI 文案預設中文。
- **服務端語言包**：`serverStrings` 的 `{name}` 必須對應 `pick()` 第五個引數 `vars` 的鍵名（如 `{ count: rows.length }` 對應 `{count}`），不能直接照抄英文模板表示式。翻譯須保留操作指引、命令字面量及拼接邊界換行；改動後用實際語言包驗證插值結果，鍵對齊檢查不覆蓋這些問題。
- **i18n**：所有使用者可見字串走 `useT()`；改 `i18n.tsx` 必須同時給 `zh`/`en` 兩個內建 locale 各加一個 key（`en` 的型別是 `Record<keyof typeof zh, string>`，漏一個會編譯報錯，這是特性不是 bug）。另外 `locales/*.json` 的 12 個可下載語言包（de/es/fr/it/ja/ko/pt/ru/tr/zh-Hant/zh-HK/zh-TW）也要同步加 key 且順序與 `zh` 一致——`tests/unit/locales.test.ts` 鎖這條對齊。繁中系語言包不手改：跑 `node --import tsx scripts/zh-tw-locale/build-all.mjs .`（詳見 `scripts/zh-tw-locale/README.md`）一鍵從簡中整份重新生成。
- **通知文案**：服務端 notice 寫中文 `text` + 英文 `textEn`（客戶端按 locale 二選一；中英雙語欄位，見 `ChatInput` 的 `description`/`descriptionEn` 先例）。發給模型的提示保持中文。
- **樣式**：全部在 `styles.css`，按 `/* ---- 元件名 ---- */` 分割槽；顏色用 CSS 變數（`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--amber`、`--green`、`--red`）。新寫/改名變數前先確認它**真有定義**：引用未定義的自定義屬性按規範是 guaranteed-invalid，整條宣告在計算值階段失效（不帶 fallback 的 `background` 直接沒背景、`box-shadow` 連投影一起丟；帶 fallback 的靜默用硬編碼值 → 淺色主題下是深色塊）。`tests/unit/css-tokens.test.ts` 靜態體檢全倉 `var()` 引用，新增變數後跑一次。
- 檔案列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `files-service.ts` 頂部維護（分平臺兩套）。
- **lint（oxlint）**：`npm run lint` 必須零警告；`lint:fix` 只修機械項。`.oxlintrc.json` 關掉的三條是故意：`no-control-regex`（檔名清洗正則）、`unicorn/no-new-array` 與 `typescript/no-this-alias`（oxlint 忽略行內 disable 註釋，改寫法反而傷可讀性）。廣播迴圈的 `[...set]` 複製是故意的（處理器可能在 emit 中途退訂），行內有註釋，別“最佳化”掉。
- **工具提示詞（發給模型的工具定義）三處職責嚴格分開**：`description` = 做什麼 + 副作用/邊界；`promptSnippet` = 觸發條件（進系統提示詞 `Available tools` 列表，渲染為 `- name: snippet`，所以不寫工具名字首，≤80c）；`promptGuidelines` = 何時用 / 順序 / 禁止 / 跨工具路由。**同一條資訊只說一遍**：snippet 不復述 description、guideline 不復述 description、引數說明不復述主描述；同一個 schema 塊（如 SSH 憑據、連線/庫引數）被多個工具用時抽共享常量（所有工具 schema 同時在上下文裡，重複就是純浪費）。操作語法參考類工具（`patch-tool`）的 op 表是唯一文件位，不拆。守衛 `tests/unit/tool-prompt-hygiene.test.ts`（CI 必跑）：純英文 + 長度上限 + snippet 字首/複述檢測 + 同文件同義重複檢測。
- **兩種實現共用一套提示詞時必須單源**：同一個工具有多條執行路徑（如 bash 的原生/終端/分流）時，模型看的定義只應來自一個模組（`server/tool-prompts.ts`），分流器只覆蓋 `execute`。被覆蓋的那份仍會被無意識地維護——它永遠不傳送，只會漂移。
- 新增協議訊息 → 只改 server/protocol.ts（見 `docs/architecture-core.md`「協議單源」），再在兩端 dispatch/onmessage switch 各加分支。
- **宿主提供的包只能宣告在 `peerDependencies`（`"*"`）**：pi 擴充套件載入器（`resource-loader.js` 的 `collectExtensionPackageWarnings`）只掃 `dependencies` —— 命中 `@earendil-works/pi-coding-agent` / `typebox` 就警告「裝下的巢狀副本會繞開擴充套件載入器、搞出重複執行時模組」。本包同時是「pi 擴充套件」與「獨立服務端/CLI」，服務端子程序真的要這兩個包（`server/` 下 typebox 20+ 處引用、SDK 遍佈全倉），`PI_WEB_SDK=bundled` 也需要自帶副本 → 它們落在 `optionalDependencies`（npm 預設照裝，載入器不看這個欄位；見 `package.json`）。守衛：`tests/unit/extension-host-packages.test.ts`（誰搬回 `dependencies` 就紅）。

## 文件約定：AGENTS.md 只做索引

`AGENTS.md` 是「關鍵功能 → 事實原始檔 → 文件」的對映表，**不承載細則**（細則寫進對應 `docs/`）；`docs/README.md` 是文件總索引（每份文件的主題、權重 ★★★/★★/★/○ 與「按場景閱讀路線」）。新增做法：

1. 細則寫進 `docs/agent-rules.md`（協議/工具提示詞/UI 樣式/執行態紅線）或對應主題文件；
2. 在 `docs/README.md` 對應權重組補一行，並在 `AGENTS.md` 的對映表補一行（功能 / 事實原始檔 / 文件連結），必要時在 §3 紅線表補一行 + 守衛測試名；
3. 跑 `npx vitest run tests/unit/agents-md.test.ts tests/unit/docs-index.test.ts`：前者守衛 `AGENTS.md` 體量（≤150 行 / ≤20KB）、`docs/` 連結與錨點存活、關鍵文件仍在索引中、§3 點名的守衛測試檔案存在、對映裡點名的原始檔存在；後者守衛 `docs/README.md` 覆蓋全部 `docs/*.md`、連結與錨點存活、每份文件都登記在帶權重的分組裡。

歷史上它曾因把裝置中心/群組、畫布、環境變數全表、UI 紅線抄成正文而脹到 51KB / 281 行，每個會話都在為細則付費且細節逐漸與 `docs/` 走樣，故改為索引形態（全文備份 `AGENTS.md.bak`）。

## 斜槓命令目錄

服務端 `pushSlashCommands()` 收集當前活動會話的擴充套件命令（`session.extensionRunner.getRegisteredCommands()`）+ 模板（`promptTemplates`）+ 技能（`resourceLoader.getSkills()` → `skill:<name>`）加上 11 個內建命令（NATIVE_COMMANDS：/new /name /model /compact /cwd /thinking /resume /reload /help /copy /pi-web-ui:quit），經 `slash_commands` 訊息推送（attach / set_cwd / new_chat / switch_conversation / switch_session / get_commands 時重新整理）；內建命令在 `prompt()` 裡攔截（`execNativeCommand`，含 /model 模糊匹配、/thinking 中英別名、`/reload` 調 `session.reload()` 重新發現擴充套件/技能/模板後重推目錄），其餘透傳 SDK（SDK 會展開擴充套件/技能/模板命令）。

注意 SDK 的 `getSkills()` 返回的是會話建立時的記憶體快照——刪除/新增 skill 檔案後必須 `/reload`（或 /new / 切專案重建 runtime）才生效。改動時保持 `NATIVE_COMMANDS` 與 `execNativeCommand()` 同步。迴歸：`slash-commands-test.mjs`。

## 驗證清單

1. `npm run typecheck` 零錯誤
2. 涉及 UI → `npm run dev` 手動過一遍互動
3. 涉及 ws 協議 → `tests/` 下有現成指令碼可參照：先跑 `npm run test:smoke`（自包含協議測試全量），單個用 `node tests/xxx-test.mjs`（需先 `npm run build`；瀏覽器 E2E 需要本機 Chrome，路徑由 `tests/lib/chrome.mjs` 逐平臺探測，`PI_WEB_CHROME` 可覆蓋）

## 測試規範

### 測試價值與精簡

- **行為測試接到生產程式碼**：呼叫真實匯出、渲染真實元件或執行生產閉包；測試內複製演算法再驗證副本不算生產行為覆蓋。型別宣告、引數解構、區域性變數名不單獨立 case。
- **原始碼守衛保留明確職責**：架構、安全、資源契約，以及暫時缺少行為驗證的已知迴歸可以靜態檢查；同一約束集中到一個守衛，避免跨檔案重複檢查同一段原始碼。
- **刪除重複項先核對替代關係**：生產路徑、輸入範圍和約束強度須被保留測試覆蓋；解析器還須保留有效樣本數斷言，避免全部跳過後假通過。不同邊界仍需獨立覆蓋，不能只為減少 case 數合併。
- **複用只讀輸入，隔離可變狀態**：同套件掃描原始碼一次，昂貴基礎 fixture 可以複製到每例獨立目錄；Git 的 `.git`、索引、瀏覽器 context 等可變資源不跨用例共享。保留 Vitest 預設模組隔離。

`tests/unit/` 是歷史目錄名，裡面還包含倉庫掃描、真實 Git/CLI 與 Chromium 測試，不能都按「毫秒級純函式」估算成本。最佳化先減少重複掃描、程序啟動和過大的匯入鏈，再用定向報告比較耗時；全量 CI 門禁保持覆蓋。

### 全域性 vs 本地

使用者日常可能正用**全域性安裝**的 `pi-web-ui`（`npm root -g` 下的 `pi-web-ui`，預設埠 `8787`）跑著對話/工作。開發改造物件永遠是**本地倉庫**（clone 下來的 pi-web-ui 目錄）。使用者會在自己測試時手動關閉全域性 dev、切到本地。

**絕對不要殺全域性程序/佔 8787**：禁止 `pkill -f "dist/server/index.js"`——它會命中全域性 server（埠 8787），把使用者正在用的會話打斷。清理只針對**自己啟動的測試 server**。

### 單測併發與瀏覽器等待

`vitest.config.ts` 將 worker 上限設為 4，避免全量測試中的 Chrome、檔案掃描與子程序爭用 runner 資源。瀏覽器啟動預算應獨立於業務斷言；跨 frame 的訊息、URL 或 DOM 更新須等待對應可觀察狀態，不以另一個非同步事件完成代替目標狀態已更新。

### 隔離埠

每個 `*-test.mjs` 用獨立埠（≥8900，避開 8787/5173/3300），並在啟動 server 前先 `lsof -ti :PORT -sTCP:LISTEN` 確認空閒；若被佔，改埠而非硬殺。

### 精確清理自己起的程序

spawn 後記錄 `server.pid`，測試收尾（含異常 catch 路徑）用 `process.kill(pid, 'SIGTERM')` 只殺自己啟動的。多開幾個 server 時用各自 PID 逐個殺，別用寬泛模式匹配。

### data-dir 隔離

測試 server 設 `PI_WEB_DATA_DIR` 為 `mkdtempSync(tmpdir…)`，`PI_WEB_CWD` 指本地倉庫——避免汙染真實 user data / client-state / session。

### 自包含 vs 外部依賴

能進 `tests/run-smoke.mjs` 清單的測試必須**自起 server + 自清理**；不進清單的分兩類（原因寫在 run-smoke.mjs 頭部註釋）：

- ①attach 型需外部已執行 server——ws-session-test / file-upload-test / image-paste-test / commands-test(8791) / edit-reask-test / projects-test
- ②需真模型——goal-abort-test / goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test / tool-status-test（title-jsonl-test 已修復可本地跑；win32 下 terminal-smoke / restart-handoff 自動跳過）

### 需要真模型/走審查調研的（goal-*, wizard）

會真實呼叫 LLM、耗 token 且依賴本機模型（opencode-go 可能慢/卡）——寫測試時區分「協議冒煙（無 token，如 goal-test/goal-prefs 的 set/clear 輪序）」和「live（真呼叫）」兩類，避免誤以為功能壞。

### 驗證項

本地迭代先執行與變更相關的 `npx vitest run <測試檔案>`；涉及協議時執行 `npm run check:protocol` 和對應 `tests/*-test.mjs`，涉及真實 UI 互動時再跑相關瀏覽器測試。測試 server 使用隔離埠與獨立 data-dir；Chromium 由 `tests/lib/chrome.mjs` 逐平臺探測，`PI_WEB_CHROME` 可覆蓋。提交前按 `AGENTS.md` 完成改動檔案格式化、`npm run typecheck` 和相關單測；全量 `npm test` 與分層 `test:smoke` 繼續由 CI 執行，共享基礎設施變更時本地也應跑相應全量套件。

### 測試耗時觀測（慢在哪）

`vitest.config.ts` 的 `silent: true` 會吞掉預設 reporter 的 per-file 行，全量跑十幾分鍾卻看不到任何耗時。因此配了 `tests/lib/test-timing-reporter.mjs`：每條用例一行「結束時刻 + 耗時」，收尾再打「最慢檔案 Top10 / 最慢用例 Top20」。

```bash
npm test                              # 預設 PI_TEST_TIMING=all，逐條列印
PI_TEST_TIMING=slow npm test          # 只打 ≥1s 的用例（PI_TEST_SLOW_MS 可改閾值）
PI_TEST_TIMING=off npm test           # 只留收尾小結
npx vitest run --reporter=json --outputFile=<tmp>/timing.json   # 事後逐用例複用
```

本地實測基線（Windows 12C/24T，1028 個檔案 / ≈12.5k 用例）：牆鍾 ≈705s，用例累計 ≈1955s，並行係數 2.78×。**約 75% 的時間集中在 6 個真實整合檔案**（`device-hub-artifact-integration` / `device-local-integration` / `device-hub-integration` / `task-workspace` / `canvas-workspace` / `device-center-runtime-code-artifact`），它們真跑 git 子程序與 Hub HTTP；這些檔案單跑最慢用例 17–52s，4 worker 滿載下會被拉長約 2.3×。

兩條據此定的規矩：① **重整合用例的超時預算寫 90s**（與 `task-workspace` 對齊），別寫 20–30s——那是零餘量，滿載時穩態假紅，且每條假紅要白燒 30s；② 同一檔案內的用例是序列的，把幾百秒的重活拆成多個檔案比調 worker 數更有效。

### 兩個池：預設快池 + 重型整合池

單選那個數字（`maxWorkers`）救不了這個套件：**重型池**從 4 抬到 8，同一條用例從 30s 膨脹到 83s、其餘撞 60s/90s 預算，併發上去反而更慢且假紅；而**快池**恰好相反，它卡在 1023 次 fork 上，worker 越多越快。所以按成本分層，清單單源在 [`tests/lib/suite-partition.mjs`](../tests/lib/suite-partition.mjs)（判據：實測 ≥60s）：

| 池           | 入口                       | 內容                                          | 預算                         |
| ------------ | -------------------------- | --------------------------------------------- | ---------------------------- |
| 快池（預設） | `npm test`                 | 除下表之外的全部單測（1023 檔案 / 12.4k 條）  | 8 worker · 60s（實測 ≈186s） |
| 重型整合     | `npm run test:integration` | 6 個真 git / 真子程序 / 真 Hub 檔案（111 條） | 4 worker · 90s（實測 ≈470s） |
| 全量         | `npm run test:all`         | 兩個都跑                                      | —                            |

`PI_TEST_ALL=1 npx vitest run` 也能一次跑完全部；CI 的 `Unit tests` 與 `Integration tests` 兩步分別跑兩個池（`tests/unit/test-suite-partition.test.ts` 守衛「兩邊拼起來必須等於 `tests/unit/**` 全集」，防止某個檔案被 exclude 後再也沒人跑）。重檔案新增時往清單里加一行即可。

### 測試家族速查

| 測試組                 | 說明                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **goal 家族**          | `goal-test`=協議冒煙；`goal-prefs-test`=偏好持久化；`goal-pill-test`=GoalBar UI；`goal-rounds-test`=最大輪數輸入；`goal-autostart-test`=自動觸發生成；`goal-abort-test`=Stop 清除 goal；`goal-wizard-test`=問卷收斂；`goal-wizard-cancel-test`=調研取消/超時；`goal-review-loop-test`=鎖定+無限輪數審查迴圈（需真模型）                                                                                             |
| **settings 家族**      | `settings-test.mjs`（埠 8931）：設定面板協議冒煙——settings_state 推送 / get_settings / set_settings / save_preset / apply_preset / delete_preset / 重連持久化                                                                                                                                                                                                                                                       |
| **global-search 家族** | `global-search-test.mjs`（埠 8962）=search_files 協議冒煙；`global-search-ui-test.mjs`（埠 8963）=真 Chrome headless UI 測試                                                                                                                                                                                                                                                                                        |
| **scm 家族**           | `scm-features-test.mjs`=SCM v2 功能協議測試（懶載入 history / 遠端分支 / git-dir watcher）；`scm-test.mjs`=SCM 面板 E2E（真 Chrome headless）                                                                                                                                                                                                                                                                       |
| **其他**               | `lazy-window-test.mjs`=訊息列表惰性視窗化 E2E；`terminal-bash-test.mjs`=終端接管 bash 迴歸；`quiesce-test.mjs`（埠 8911）=安全加固冒煙；`fetch-models-test.mjs`（埠 8955）=模型列表自動獲取；`clone-provider-test.mjs`（埠 8965）=內建供應商複製；`model-config-ui-test.mjs`=模型管理 UI（真 Chrome）；`vision-bridge-test.mjs`（埠 8945）=視覺橋端到端；`vision-bridge-ui-test.mjs`=視覺橋設定面板 UI（真 Chrome） |

**Playwright 指令碼**：Chrome 路徑不再寫死——`tests/lib/chrome.mjs` 逐平臺探測（`PI_WEB_CHROME` 可覆蓋）。跨平臺兩條硬規則：① 腳本里取倉庫根用 `fileURLToPath(new URL("..", import.meta.url))`，`URL.pathname` 在 Windows 上是 `/E:/...`，`spawn` 的 cwd/指令碼引數都會 ENOENT；② 服務端程序清理在 win32 用 `tests/lib/port-utils.mjs` 的 `freePort(port)`（Windows 沒有負數 PID 的程序組，`process.kill(-pid)` 靜默失敗會留下監聽程序）。

**測試腳本里禁止在 try 塊內直接 `process.exit`**：`process.exit` 會跳過 `finally`，spawn 的 server 永遠不會被殺 → 每次執行洩漏一個程序，下次跑同埠測試報 "port busy — abort"（steer-queue-smoke 踩過，已修：設 ok 標誌 + finally 裡殺程序並等埠釋放再 exit）。
