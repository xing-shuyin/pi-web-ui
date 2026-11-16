[English](./mobile-local-engine.en.md) · [简体中文](./mobile-local-engine.md) · **繁體中文**

# 本機引擎：手機版 pi-web-ui 完全獨立執行

> 目標：手機不依賴 PC，APK 內自帶 Linux rootfs + Node + pi-web-ui，本機跑 server 與 pi 引擎，用自家 WebView UI 操作；同時保留現有遙控能力。
> 參考實現：`ccch1mneyyy/dsh-go`（DeepSeek Harness Android 客戶端，Flutter + proot 免 root 路線已在真機驗證）。**只參考架構思路與部署手法，不拷其程式碼**（AGPL-3.0）。

## 定位：第三種連線方式

現有手機端（[`mobile.md`](mobile.zh-TW.md)）是遙控端：本地打包 React UI，連 PC 上的 pi-web-ui，任務在 PC 執行。本篇新增「本機引擎」：

| 模式         | 引擎在哪 | 依賴    | 入口     |
| ------------ | -------- | ------- | -------- |
| 直連 / Hub   | PC       | PC 線上 | 現狀不動 |
| **本機引擎** | 手機內   | 無      | 本篇     |

使用者視角：裝上 APK → 一鍵「安裝執行環境」（解壓 rootfs）→ 填 API Key → 直接用，UI、終端、檔案樹、畫布、外掛與桌面端同一套。

## 架構

```
Capacitor WebView（mobile/src 全量複用）
  └─ http://127.0.0.1:<port>/  ← 同源 + token 換 Cookie
Kotlin 原生層（新增，Capacitor 外掛形式）
  ├─ LocalEnginePlugin        MethodChannel：狀態/安裝/啟停/日誌
  ├─ LocalEngineService       前臺服務，託管 node 程序
  ├─ RuntimeInstaller         解壓 APK 內 rootfs.tgz 到 filesDir/engine/
  └─ proot (libproot.so)      filesDir/engine/node … 免 root 執行
rootfs（Ubuntu 24.04 arm64，APK assets 內分卷）
  ├─ node（22.x LTS，pin 精確版本）
  ├─ npm 全域性：pi-web-ui + @earendil-works/pi-coding-agent
  ├─ git、ca-certificates、tzdata
  └─ node-pty 原生繫結（構建期在 rootfs 內編譯，ABI 與執行期完全一致）
```

啟動鏈：WebView 調 `start` → Service 用 proot 拉起 `node dist/server/index.js`（`PI_WEB_HOST=127.0.0.1`、`PI_WEB_PORT` 隨機、`PI_WEB_TOKEN` 隨機、`PI_WEB_DATA_DIR=filesDir/data/`、`PI_WEB_CWD=filesDir/workspace/`）→ 解析 stdout 拿 `<port>` 與 token → WebView `loadUrl("http://127.0.0.1:<port>/?token=…")`。之後一切走既有協議與快照。

**UI 零重寫**：不用 Flutter 自研聊天介面，直接複用 `web/dist` 構建產物（dsh-go 也把「官方 Web + WebView」做了兜底路線，證明此路可用；我們把這當主線，收益是所有既有 UI 能力與主題免移植）。

## 倉庫策略：同倉庫承載，獨立性落在產物層

程式碼與指令碼收在**本倉庫** `mobile/` 鄰域（與現有 Capacitor 工程同源）：

| 維度              | 同倉庫（選它）                                                                | 獨立倉庫                                                    |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 版本一致性        | CI 從同一次 build 直接打 rootfs，協議 / UI / 引擎 / node-pty 繫結天然同版     | 只能咬 npm 釋出版，升級永遠滯後一拍                         |
| 與現有工程        | 本機模式就是在 `connections` 里加一種 connection，外掛進現有 Capacitor 工程   | 要麼複製整個 Capacitor 工程，要麼另起殼，連線程式碼雙份漂移 |
| git 體積          | rootfs 不進 git：CI 機構建，產物發 Releases                                   | 相同                                                        |
| dsh-go 為什麼獨立 | 上游（DSH 官方）沒有自帶 App 工程可複用，它只能獨立 + 消費官方 npm 包         | 復刻它意味著放棄複用現有工程                                |
| 釋出節奏          | `runtime.json` 的 builtinVersion 就釘 pi-web-ui 版本，tag `vX.Y.Z` 順手出 APK | 上下兩個倉庫的釋出節奏對齊靠人                              |

「完全獨立」的獨立指**產物**：APK 自帶 rootfs、無 PC 可用，不指程式碼庫物理隔離。

何時拆出獨立倉庫（逃逸門）：UI 決定 Flutter 重寫（iOS / 鴻蒙野心成立），或 APK 需要與 npm 完全脫鉤的渠道節奏。那時 `mobile/local-engine/` + 原生外掛目錄整體搬走，改為消費 `pi-web-ui@^x` npm 包（dsh-go 同款方式），唯一要重寫的是現有殼裡的連線膠水。

## 事實源（★=本篇唯一單源）

| 功能                                          | 事實源                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 本機引擎文件（本篇）★                         | `docs/mobile-local-engine.md`                                                                                                |
| Runtime 構建指令碼 ★                          | `mobile/local-engine/runtime/build-runtime.sh`（已建，Linux/CI 用）                                                          |
| Android 原生層 ★                              | `mobile/native/local-engine/`（本地 Capacitor 外掛：TS 橋 + Java 原生層）                                                    |
| 連線入口與三模式                              | `mobile/src/connections.ts` · `mobile/src/connection.ts` · `mobile/src/ConnectionScreen.tsx`                                 |
| 伺服器連線方式 / env 全表                     | [`env-vars.md`](env-vars.zh-TW.md)（`PI_WEB_PORT`/`PI_WEB_HOST`/`PI_WEB_TOKEN`/`PI_WEB_DATA_DIR`/`PI_WEB_CWD`/`PI_WEB_SDK`） |
| 移動端通知與構建                              | [`mobile.md`](mobile.zh-TW.md)                                                                                               |
| 生產形態（dist/server、web/dist、bin 啟動器） | `package.json` scripts · `bin/pi-web-ui.mjs`                                                                                 |

## Runtime 打包（`mobile/local-engine/runtime/`）

輸入全部 pin 版本 + sha256（騰訊/清華映象），產物分卷放 APK assets，解壓時校驗：

1. **Ubuntu 24.04 arm64 base rootfs**（官方 ubuntu-base 壓縮檔）+ `dpkg` 裝 `tzdata ca-certificates git python3 make g++`；x64 構建機經 `qemu-user-static` chroot 組裝。
2. **Node 22.x LTS**（≥22.19.0，見 `engines`）官方 linux-arm64 tar.xz，解進 `/usr/local`。
3. **npm 包**：`pi-web-ui`（釋出包含 `dist/server`、`web/dist`、`bin/`）+ `@earendil-works/pi-coding-agent` 全域性安裝；`PI_WEB_SDK` 指進 rootfs 固定路徑，繞開任何全域性發現邏輯。
4. **node-pty** ^1.1.0 必須隨 rootfs 內 `npm install` 原生編譯（Python + make + g++ 在第 1 步已就位；之後可裁掉構建工具減體積）。
5. **proot** 二進位制以 `libproot.so` 放 jniLibs（`useLegacyPackaging` 解壓到 `nativeLibraryDir` 才可執行）；proot 為 GPL，釋出時在 THIRD_PARTY 附原始碼引用。
6. 產物 `out/arm64-v8a/`：`rootfs.tgz` 分卷 + `runtime.json`（abi、builtinVersion、baseId）。可選 x86_64 flavor 供模擬器。

### 安裝與升級事務

參考 dsh-go 的契約，自實現精簡版：

- 首次安裝或使用者確認「重置」才落整套 rootfs；普通升級不換 rootfs，只按精確路徑替換引擎 waż 工件（node、`node_modules` 釋出包目錄），不擴到 `/usr`、`/opt` 整體。
- `engine.prepare` 落盤 → `engine.upgrade` 原子改名 → 失敗可回滾；啟動遇到半成品事務先恢復再清理，不整根覆蓋。

## Android 原生層設計

MethodChannel `pwu/localengine`，事件流推送狀態：

| 方法             | 行為                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `getStatus`      | `phase: notInstalled/installing/installed/starting/running/stopping/error` + 版本 + baseUrl |
| `install`        | 分卷解壓 + 校驗；進度經事件流                                                               |
| `start` / `stop` | 前臺服務託管；stdout 環形日誌；crash 自動重啟（上限退避）                                   |
| `getLogSnapshot` | 最近 N 行日誌（seq 遞增，重啟不歸零），供引擎日誌頁                                         |

- 資料落點：`rootfs/root/piwebui-data/{data,workspace,pi-agent}`——三份都在「重置執行環境」的保留名單裡（reset 只重建 rootfs）。
  `pi-agent` 通過 `PI_CODING_AGENT_DIR` 顯式指定：pi 預設的 `~/.pi/agent` 住在 rootfs 內部，跟著 rootfs 一起被刪，
  會把 API Key 配置與聊天記錄一起洗掉。

- `targetSdk = 28`（同 Termux 做法，繞開 Android 10+ 私有目錄 `exec` 禁令；本專案分發不走 Google Play，無 28→35 約束）。
- 前臺服務 + 部分喚醒鎖 + 電池最佳化白名單引導頁；通知欄常駐顯示執行狀態。
- ABI 產品風味 `arm64`（真機）/ `x64`（模擬器）。

## App 沙箱與 rename（proot 內的 ENOSYS）

現象：引擎程序能起來，但 `writeAtomicSync`（client-state 等）、`plugin-materialize`（內建外掛物化）等所有 rename 都報
`ENOSYS: function not implemented, rename …`。

根因既不在 proot、也不在 rootfs：

- App 程序帶 zygote 下發的 seccomp 過濾器（`/proc/<pid>/status` 的 `Seccomp_filters: 1`）；同一份 rootfs 用
  `adb shell run-as … proot …`（無 seccomp）跑，`rename` / `renameat` / `renameat2` 全部成功。
- 過濾器讓 `renameat2` 直接返回 ENOSYS；glibc 2.28+ 的 `rename()` 只走 `renameat2`、不做回退（Node 的 `fs.rename*`
  都落到這裡），於是 App 程序內一次 rename 都成功不了 → 引擎起得來也存不住狀態。

對策分兩層，都不去改呼叫點、也不去文本替換 rootfs 裡的 `dist`：

1. **rootfs 內建 C 墊片（主路，覆蓋所有子程序）**：`mobile/local-engine/runtime/rename-preload.c` 編譯成
   `/usr/local/lib/pi-mobile/librename-compat.so`，並在 rootfs 的 `/etc/ld.so.preload` 裡登記 —— guest 內每個
   glibc 程式（node、bash、git、mv）啟動時自動載入，`rename` / `renameat` 改道 `renameat`（它在允許名單裡）。
   proot 自身是 bionic，不讀這個檔案。實測：App 程序內 `rename` 恢復成功，`[rename-compat]` 降級日誌不再出現。
2. **node 側 JS 兜底（舊 rootfs / 墊片缺失時）**：
   `assets/pi-localengine/rename-compat.cjs` 把 `fs.renameSync` / `fs.rename` / `fs.promises.rename` 包一層，
   **只有** ENOSYS（及 ENOTSUP/EOPNOTSUPP）才降級為「複製 + 刪源」，其它錯誤碼原樣丟擲。`LocalEngineService`
   每次啟動把它寫進 `rootfs/root/.pi-mobile/rename-compat.cjs`，以 `node --require` 注入；寫不進去只告警不阻斷。

代價與邊界：

- C 墊片保留了 rename 的真實語義（`renameat` 仍是原子改名）；只有走兜底路徑時才丟原子性（複製 + 刪源）。
- `renameat2` 帶 flag 的語義（`RENAME_NOREPLACE` / `RENAME_EXCHANGE`）沒有 `renameat` 等價物，保持和沙箱一樣的
  ENOSYS 失敗語義，不做假裝支援。
- 舊 rootfs（沒有墊片）啟動時，Service 會在日誌裡明說「終端裡的 git 等子程序可能仍報 ENOSYS」。

## React 連線層（`mobile/src/`）改動

- `connections.ts`/`connection.ts` 增加 `kind: "local"`：僅 `Capacitor.isNativePlatform()`（Android）顯示；。
- `ConnectionScreen.tsx` 增加本機嚮導：安裝執行環境（進度/失敗重試）→ 啟動 → 進入工作區；失敗分支提供「檢視引擎日誌」「重置執行環境」。
- 本機模式不設 JPush 推送：前臺服務常駐，任務完成提醒直接走系統通知（服務自身具備 UI，無需極光）。
- 工作區目錄引導：本機模式預設工作區在應用私有目錄；`PI_WEB_CWD` 一次性寫死，避免使用者誤把 `filesDir` 外路徑當根。

## 伺服器側預期改動（儘量為零）

本機模式 WebView 直接開啟 `127.0.0.1:<port>`，`?token=` 換 Cookie 後全同源：

- `server/index.ts` 已有 loopback 判定（`isLoopbackAddress`/`isLoopbackHost`）與 `mobileCors`/`mobileOriginAuthorized` 通道（`server/mobile-origin.ts`）；同源請求不產生跨 Origin 問題。
- 若真機實測 WebView 初始請求帶異常 Origin（如 `null`），在 `mobile-origin.ts` 登記本機模式專用放行分支即可——改動收斂在這一個檔案。
- 審批門禁、終端 PTY、附件上傳在 loopback 場景語義不變，不做平臺差異分支。

## 分階段計劃與驗收

| 階段                      | 內容                                                                      | 驗收                                                       | 狀態                                     |
| ------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| A. Runtime 冒煙（開發機） | 指令碼產出 arm64 rootfs；qemu 內 `node dist/server/index.js` 拉起         | 本機 curl 首頁 200、`PI_WEB_TOKEN` 生效、node-pty 載入成功 | 指令碼已建，待 CI/qemu 執行              |
| B. Android 殼             | 外掛 + 前臺服務 + 安裝嚮導；WebView 開啟本地服務                          | 真機一鍵安裝→聊天可用                                      | TS 橋 + Java 原生層 + 連線層已接，待真機 |
| C. 能力驗證               | 終端 PTY 蹺蹺板、git 工具、附件、截圖、設定儲存、前臺服務後臺存活 30 分鐘 | 真機全綠；後臺被殺後冷啟自恢復會話                         | 待 B                                     |
| D. 升級與打磨             | 發新執行環境包走升級事務；x86_64 模擬器包                                 | 換版本不破壞使用者資料                                     | 未開始（MVP 用重置代替升級）             |

### MVP 實施狀態

- ✅ 構建指令碼 `build-runtime.sh`：pin 輸入（Ubuntu base / Node 22 / proot + sha256）→ qemu chroot 裝 git/python3/make/g++ → `npm -g` 裝 pi-web-ui 與 pi SDK → node-pty 繫結冒煙 → 100MiB 分卷 + `runtime.json`（每卷 bytes/sha256）→ `--sync-assets` 落外掛 assets。
- ✅ `mobile/native/local-engine/`：`@pi-mobile/native-local-engine` 本地外掛（file: 引用，`capacitor.plugins.json` 自動註冊）。TS 橋 `getStatus/install/start/stop/getLogSnapshot/reset` + `status/logs/progress` 事件；Java 側：EngineState（狀態機 + 2000 行環形日誌，seq 重啟不歸零）、RuntimeInstaller（分卷流式 sha256 → staging → 原子提交，symlink/exec 位還原）、LocalEngineService（前臺服務 + proot/node 程序 + 隨機埠/令牌 + TCP 探測就緒 + 崩潰退避重啟≤3 次）、LocalEnginePlugin（Capacitor 橋）。
- ✅ 連線層：`ConnectionMode` 增 `"local"`；`ensureLocalEngineRunning()` 冪等拉起；ConnectionScreen 三模式（Android 顯示「本機執行」）帶進度/引擎狀態/重置入口；boot 恢復對 local 重新走 ensure 流程（憑據每次啟動重新鑄幣）。
- ⏳ 待辦：CI 跑階段 A 產物 → 真機（arm64）安裝→啟動→聊天/終端/設定驗收；升級事務（階段 D）。

體積預估：rootfs + node + 依賴 ≈ 250–450MB（arm64 單 flavor），均攤到 APK 下載一次；後續升級只發差量引擎工件。

## 風險與對策

| 風險                                                      | 對策                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| node-pty 在 ARM rootfs 編譯失敗                           | 階段 A 前置驗證；備選：rootfs 內預裝 `package.json` 鎖定版本 + 離線 native 模組；終端不可用時可置灰終端面板執行主鏈路 |
| 手機廠商殺後臺                                            | 前臺服務 + 白名單引導；文件教使用者關閉 PiPilot 省電限制                                                              |
| ROM 對 `exec` 私有目錄的策略                              | 維持 targetSdk 28；禁止上架 Play 前貿然提升 targetSdk                                                                 |
| `bin/pi-web-ui.mjs` 在 rootfs 內有桌面假設（frp/homedir） | 啟動繞過 bin 包裝，直接 `node dist/server/index.js`；bin 啟動器作為 PC 形態繼續單源                                   |
| AGPL 邊界                                                 | 不引 dsh-go 程式碼，只複述思路；proot GPL 原始碼引用隨釋出包                                                          |
| 模擬器/小眾 ABI                                           | MVP 只承諾 arm64-v8a；x86_64 flavor 屬可選產物                                                                        |

## 不做的事

- 不重寫聊天 UI（Flutter/RN），不自研 `dsh_client` 式獨立協議客戶端；協議消費繼續走單一 `web/dist`。
- 不動 `server/protocol.ts` 協議；不為本機模式開新 API。
- MVP 不裝 DSH 引擎（後續作為可選層，`docs/dsh-engine.md` 的 file: 克隆隔離不受影響）。
- 不承諾 iOS：路徑與 dsh-go 相同（未來可複用 CI），本期不投入。
