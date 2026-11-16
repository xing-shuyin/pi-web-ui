[English](./test-performance-audit.en.md) · [简体中文](./test-performance-audit.md) · **繁體中文**

# 單測效能審計：現狀、已改、待解（供外部評審）

> 目的：把這個套件「為什麼慢、慢在哪、試過什麼、還卡在哪」一次性擺清楚，便於外部給出思路。
> 所有數字都是本機實測（非估算），復現命令見文末。寫於 v0.119.0 階段。

## 0. TL;DR

- 套件規模：`tests/unit/` **1029 個檔案 / 12,480 條用例**，純 `node` 環境 + `pool: "forks"`。
- 改之前全量：**牆鍾 704s**，用例累計 1955s，11 條假紅（真因是超時預算零餘量）。
- 現在（全部實測、全綠）：
  - **預設 `npm test`（快池 1023 檔案 / 12.4k 條）：182s**（原 704s，**3.9×**）。
  - **`npm run test:integration`（重型 6 檔案 / 111 條）：牆鍾 135.2s、用例累計 443s**（原 1064s，**−58%**）。
  - 兩個池合計 ≈318s（原 704s）。
- 兩個真正生效的槓桿（都不是“少跑用例”）：
  1. **分層**：快池 8 worker / 重型池 4 worker，各自預算。worker 數對兩個池的效應完全相反（見 §2.2、§2.3）。
  2. **產品側 `git()` 的兩層快取**：filter 探測（每次呼叫多跑一個子程序）+ 倉庫身份查詢（`--show-toplevel` 等 82 次/管線），
     合計把管線內 git 子程序從 462 → 約 106，重型池兩輪共砍 58%（見 §3.1、§3.1.1）。
- 剩下的硬成本（已量化、未改）：每條驗證命令 ~2.7s 的 PowerShell 主管程序冷啟動；快池 44% 時間在 ESM 模組圖求值（`isolate:false` 能吃掉 36%，但會引入順序依賴，見 §3.2）。
- 歷史疑點已閉環：那“3 次呼叫 16.7s”已定位並降到 **11.1s**，機制見 §3.1。

## 1. 環境與測量方法

| 項              | 值                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OS / CPU / RAM  | Windows，12 物理核 / 24 邏輯核，32GB                                                                                                   |
| Node            | v25.9.0（`engines.node >= 22.19`）                                                                                                     |
| 測試框架        | vitest 5.0.1 + vite 8 + tsx，`pool: "forks"`，`isolate` 預設（true）                                                                   |
| 計時來源        | `npx vitest run --reporter=json --outputFile=<tmp>/x.json`，用 `testResults[].startTime/endTime` 與 `assertionResults[].duration` 彙總 |
| 牆鍾 / 用例累計 | 牆鍾 = 最早 startTime 到最晚 endTime；用例累計 = 各檔案 duration 之和                                                                  |
| 「並行係數」    | 用例累計 ÷ 牆鍾。4 worker 下上限 4.0；明顯小於 worker 數就說明時間花在 fork / 空轉上                                                   |

逐條用例耗時觀察器：`tests/lib/test-timing-reporter.mjs`（本次新增，見 §3），每條用例打「結束時刻 + 耗時」。

## 2. 現狀數字

### 2.1 全量（改動前後）

|                                     | 檔案 | 用例   | 牆鍾                       | 用例累計 | 並行係數  | 失敗            |
| ----------------------------------- | ---- | ------ | -------------------------- | -------- | --------- | --------------- |
| 改動前、4 worker                    | 1028 | 12,479 | **704s**                   | 1955s    | 2.78      | 11 條（5 檔案） |
| 修超時預算/清理競態後、4 worker     | 1028 | 12,487 | **559s**                   | 1512s    | 2.70      | 0               |
| 分層後：快池 8 worker               | 1023 | 12,383 | **172–186s**               | 502–530s | 2.70–3.08 | 0               |
| 分層後：重型池 4 worker（最佳化前） | 6    | 111    | ≈320s（按 1064s/3.3 估算） | 1064s    | 3.32      | 0               |
| **加 git 探測快取後：重型池**       | 6    | 111    | **167.6s**                 | 557s     | 3.32      | 0               |
| **加 git 探測快取後：快池**         | 1023 | 12,384 | **182.4s**                 | 484s     | 2.65      | 0               |

### 2.2 快池 worker 掃描（同一份程式碼、同一批 1023 檔案）

| maxWorkers | 牆鍾     | 用例累計 | 並行係數 | 結果                                                                                  |
| ---------- | -------- | -------- | -------- | ------------------------------------------------------------------------------------- |
| 4          | 280s     | 409s     | 1.46     | 綠                                                                                    |
| 8          | **186s** | 502s     | 2.70     | 綠（當前預設）                                                                        |
| 12         | 172s     | 777s     | 4.51     | 1 條假紅：`canvas-scheduler` 內部 `vi.waitFor({timeout:15_000})` 被 12 路爭搶拖過預算 |

注意用例累計隨 worker 數上升（409 → 502 → 777s）：這是真實的爭搶膨脹，說明機器在 8 之後已接近飽和。

同一批檔案上試過的其他「複用」變體（詳細分析見 §3.2）：

| 變體                                              | 牆鍾                                          | 結果                        |
| ------------------------------------------------- | --------------------------------------------- | --------------------------- |
| `--isolate=false`（複用模組圖）                   | 117.3s（40 條失敗）/ 隔離 7 檔案後 >340s 自旋 | 否決（見 §3.2）             |
| `experimental.fsModuleCache`（複用編譯產物）冷/熱 | 187.5s / 189.9s                               | 無收益（transform 只佔 3%） |

### 2.3 重型池（6 個檔案，4 worker 穩態）

| 檔案                                          | 用例 | 耗時 | 單條最慢 |
| --------------------------------------------- | ---- | ---- | -------- |
| `device-hub-artifact-integration.test.ts`     | 30   | 304s | 34.2s    |
| `device-local-integration.test.ts`            | 22   | 280s | 32.6s    |
| `device-hub-integration.test.ts`              | 18   | 218s | 35.3s    |
| `task-workspace.test.ts`                      | 13   | 122s | ≈40s     |
| `canvas-workspace.test.ts`                    | 11   | 77s  | 21.2s    |
| `device-center-runtime-code-artifact.test.ts` | 17   | 63s  | 15.2s    |

重型池 worker 掃描：**4 是上限**。抬到 8 worker 時同一條用例從 30s 膨脹到 **83s**，另有 4 條撞 60s/90s 預算報超時（不是功能壞）。

## 3. 已經改了什麼（本次提交範圍）

| 檔案                                              | 改動                                                                                        | 理由                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/test-timing-reporter.mjs`（新增）      | 逐條用例列印「結束時刻 + 耗時」，收尾打最慢檔案/最慢用例 Top；`PI_TEST_TIMING=all/slow/off` | `vitest.config.ts` 裡 `silent: true` + `onConsoleLog: () => false` 把預設 reporter 的 per-file 行全吞了，全量跑 12 分鐘零輸出，無法定位慢點 |
| `vitest.config.ts`                                | 接上 reporter；按 `suite-partition.mjs` 排除重型檔案；`PI_TEST_ALL=1` 可一次跑全            | 快慢分層                                                                                                                                    |
| `vitest.integration.config.ts`（新增）            | 重型池專用配置：`include: HEAVY_SUITE`、4 worker、90s 預算                                  | 重型檔案在同一池裡會互相拖慢                                                                                                                |
| `tests/lib/suite-partition.mjs`（新增）           | 重型清單 + 兩個池的 worker/預算常量（單源）                                                 | 避免配置與守衛各寫一份                                                                                                                      |
| `tests/unit/test-suite-partition.test.ts`（新增） | 守衛：重型清單存在且不重複、**兩池並集 == `tests/unit/**` 全集**、CI 兩個池都跑             | 防止「被 exclude 後再也沒人跑」                                                                                                             |
| `package.json`                                    | `test:integration`、`test:all`                                                              | 入口                                                                                                                                        |
| `.github/workflows/ci.yml`                        | `Unit tests` 後再跑 `npm run test:integration`                                              | CI 不丟覆蓋                                                                                                                                 |
| 6 個重型測試檔案                                  | 超時預算 20–30s → 90s（依據寫在檔案註釋裡）；`EBUSY` 清理加 `maxRetries/retryDelay`         | 原預算零餘量 → 滿載必假紅，且每條假紅白燒 30s（11 條共燒 367s = 當時總時間的 18.8%）                                                        |
| `tests/unit/canvas-scheduler.test.ts`             | 內部 `vi.waitFor` 15s → 30s                                                                 | 與 90s 用例預算不匹配                                                                                                                       |
| `docs/development.md`                             | 新增「測試耗時觀測」「兩個池」兩節                                                          | 規則落文件                                                                                                                                  |

假紅根因（已驗證）：這 6 個檔案單跑最慢 19.2s / 滿載 31s+，撞 30s 牆；`device-hub-integration` 單跑 127s 全綠、並行 290s 且 3 條超時 —— **純負載敏感，不是功能迴歸**。

### 3.1 產品側架構最佳化：`git()` 的 filter 探測快取（本輪最大收益）

用 `performance.now()` + child_process 攔截做了分層計時（管道拆準備/驗證/確認三段）：

```
[probe] prepare 953ms   verify 6199ms   confirm 7051ms
[probe] spawns=463  spawnMs=14486  (git ×462 = 11.8s，powershell.exe ×1 = 2.7s)
[probe] git exec(測試自己跑的 16 次)=505ms   store.transact ×7=25ms
```

結論：一條 3 呼叫管線裡 **462 次 git 子程序**，根因是 `server/workspace-handle.ts` 的 `git()`
**每次邏輯呼叫都先跑一遍 `git config --get-regexp ^filter\..*` 探測**（為了中和惡意 clean/smudge filter），
即「一次邏輯呼叫 = 兩個子程序」。

改法：按**倉庫配置檔案指紋**（`config` / `config.worktree` 的 path+mtime+size，含 linked worktree 的
`commondir` 解析）快取要透傳的 `-c` 引數。任何不確定都**不快取、退回每次探測**：找不到 `.git`、
配置裡有 `include`/`includeIf`（外部檔案指紋不可靠）、stat/read 失敗、快取超 64 條。
捕獲「中途新增 filter」的迴歸測試：`tests/unit/workspace-handle.test.ts` 的
「refreshes the filter-override cache when repo config changes mid-session」。

效果（同機、同配置、4 worker，全部綠）：

| 檔案                                  | 最佳化前  | 最佳化後          | 變化 |
| ------------------------------------- | --------- | ----------------- | ---- |
| `device-hub-artifact-integration`     | 304s      | **167s**          | −45% |
| `device-local-integration`            | 280s      | **154s**          | −45% |
| `device-hub-integration`              | 218s      | **108s**          | −50% |
| `task-workspace`                      | 122s      | **60s**           | −51% |
| `canvas-workspace`                    | 77s       | **37s**           | −52% |
| `device-center-runtime-code-artifact` | 63s       | **31s**           | −51% |
| 合計 / 重型池牆鍾                     | 1064s / — | **557s / 167.6s** | −48% |

單條最貴用例（`completes full pipeline`）單跑從 **16.7s → 11.1s**。

#### 3.1.1 第二輪：倉庫身份查詢快取（管線裡 82/188 次是同三個查詢）

快取掉 filter 探測後再測，`workspace-handle.git()` 仍被呼叫 188 次/管線，其中：

```
41x  rev-parse --path-format=absolute --git-common-dir
25x  rev-parse --show-toplevel
16x  rev-parse --absolute-git-dir        ← 這三項合計 82 次，全是對「目錄」恆定的查詢
16x  branch --show-current     16x  rev-parse HEAD     16x  status --porcelain --untracked-files=all
```

於是按同一指紋機制快取這幾個查詢（命中 **77/82**）。三條踩坑都寫進了程式碼註釋：

1. 模式表要算上 argv 裡的 `rev-parse` 字首 —— 第一版漏了，快取一次都沒命中，還被誤判成「無收益」；
2. key 要帶 **cwd** —— 主倉與其工作樹共享 config（指紋相同），但 `--show-toplevel` 各自不同，漏 cwd 會串值；
3. 指紋要含 **`.git` 指標文本 + commondir 文本** —— `task-workspace` 的「工作樹指標替換」用例會把 `.git` 換成指向主倉，
   漏了指標內容就會命中舊快取、繞過身份校驗（這條是被重型用例抓到的真迴歸）。

效果（同機、4 worker，全綠）：重型池 **167.6s → 135.2s**（用例累計 557s → 443s）。

| 檔案                                  | filter 快取後 | + 身份查詢快取 |
| ------------------------------------- | ------------- | -------------- |
| `device-hub-artifact-integration`     | 167s          | **135s**       |
| `device-local-integration`            | 154s          | **122s**       |
| `device-hub-integration`              | 108s          | **96s**        |
| `task-workspace`                      | 60s           | **42s**        |
| `canvas-workspace`                    | 37s           | **26s**        |
| `device-center-runtime-code-artifact` | 31s           | **22s**        |

### 3.2 「複用」類最佳化：四個方向已逐個實測

快池的 182s 到底花在哪，vitest 自己就給了分賬：`tests 44% / import 44% / environment 8% / transform 3%`。
據此把四種「複用資源」的想法都跑了一遍：

| 複用物件                  | 做法                                           | 實測                                                                                                                  | 結論                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 編譯產物（transform）     | `experimental.fsModuleCache: true`，跑兩次對比 | 冷 187.5s / 熱 **189.9s**                                                                                             | **無效**。transform 只佔 3%，快取它等於沒省                                                                                                                                                                                                                        |
| 模組圖（ESM 求值）        | `--isolate=false`（worker 內複用模組圖）       | 首測 **117.3s**（−36%）但 **40 條失敗**；把這 7 個檔案排除後再測：**>340s 未結束、單 worker 燒 315s CPU（疑似自旋）** | **否決**。`mcp-manager`/`engine-cli`/`shared-state-persistence`/`file-integrity`/`file-transfer-routes`/`native-cli-lifecycle`/`plugin-removal` 的 mock/env/單例串到了別的檔案；即便隔離它們仍會自旋。isolate:false 讓整輪變成「依賴檔案順序」，確定性倒退，不採用 |
| 子程序（git）             | 快取 `git config` filter 探測（**已合入**）    | 重型池 1064s → **557s**                                                                                               | ✅ 價效比最高（見 §3.1）                                                                                                                                                                                                                                           |
| 子程序（PowerShell 主管） | 未改：每個驗證命令一個 PowerShell 主管程序     | 單次冷啟動 **2.7s**，佔整合管線端到端 ≈18%                                                                            | 最大剩餘固定成本。要複用就得改warm 主管（常駐 named pipe），屬獨立改造                                                                                                                                                                                             |

還有兩個“複用”經估算**不值得做**：

- **共享模板倉**（beforeAll 建一次，逐用例 `fs.cp`）：實測 `fs.cp` 5 次 143ms、`git init+commit` 6 次 186ms，
  → 每條只能省 ≈0.15s，111 條共 ≈17s（佔重型池 3%），不值重構風險。
- **合併小測試檔案**（減少 fork）：`≤40 行` 的 53 個檔案全並了也只省 ≈43 次 fork ≈ 4s 牆鍾。

因此快池要想再賺那 36%，只能回到 `isolate:false`；而它的前提是把上面 7 個“有狀態”檔案
拆成獨立隔離池——等價於維護一張“狀態黑名單”，需要你拍板是否接受這份脆弱性。

### 3.3 快池的下一個真槓桿：78 個檔案各花 ~2s 載入 agent-service

用兩個探針檔案量化（同一環境、vitest 內計時）：

| 探針                                                    | Duration                                | 說明                                          |
| ------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| 只 `import { ClientSession } from server/agent-service` | **3.00s**（import 52% + transform 47%） | 載入 `agent-service.ts` → pi SDK 的整張模組圖 |
| 空用例                                                  | **123ms**                               | 基線                                          |

- `tests/unit/` 有 **78 個檔案**在執行期 import `server/agent-service.js`（只有 1 個是 `import type`）；
- 其中 63 個通過 `tests/helpers/fake-session.ts` 進來，而該 helper 只用 `ClientSession.prototype` 做 `Object.create` 與 accessor 判定——**為了一個原型物件付整張 SDK 圖的代價**；
- 量級：78 × ≈2s ≈ **150s CPU**（快池用例累計才 ~484s）。

**建議做法（未執行，需協調）**：把 `ClientSession` 抽到輕模組 `server/client-session.ts`，`agent-service.ts` re-export；
`fake-session.ts` 改從輕模組取原型。語義零變化，預計 **快池 −25~30%**。
未動手的原因：`server/agent-service.ts` 正被並行會話修改，同文件改動會互相踩。

### 3.4 又試並否決的三條（省得後人重走）

| 想法                                                                                      | 實測                                                                                               | 結論                                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 抽出 `server/client-session.ts`，讓 `fake-session.ts` 不再 import agent-service           | 63 個 fake-session 消費者裡 **52 個自己也 import agent-service**，只有 **11 個**能受益（≈22s CPU） | 棄：收益配不上跨模組重構                      |
| 預編譯 supervisor 的 C# 成 DLL（`Add-Type -Path`）躲開現場編譯                            | `powershell -NoProfile -Command 1` = **1.18s**（程序啟動）；`Add-Type -TypeDefinition` 只 **73ms** | 棄：那 2.7s 是 PS 冷啟動 + 命令本身，不是編譯 |
| 按指紋快取倉庫身份查詢（`--show-toplevel` / `--git-common-dir` / `--show-object-format`） | 單測三次中位數 11.1s → **11.7s**（落在噪聲內）                                                     | 棄：未證明收益，不合並複雜度                  |

順帶把管線剩餘的 git 呼叫歸屬量清了（一條 `prepare→verify→confirm`，經 `workspace-handle.git()` 共 **188 次**）：

```
82x rev-parse(純 flag)   16x rev-parse HEAD   16x branch   16x status   12x ls-files
 8x config                6x cat-file          6x read-tree 6x hash-object
 6x update-index          6x write-tree        2x rev-list  …（另有 PowerShell 1x = 2.7s）
```

也就是說：快取掉 filter 探測後，剩下的是**管線自己反覆查倉庫狀態**（rev-parse/branch/status/ls-files 共 126 次）。
要再砍只能把這些查詢在呼叫方合併（如一次 `rev-parse` 同時取 toplevel/format），屬產品側重構，收益估計 10–15%。

### 3.5 已定位但未改的其餘成本

- 驗證階段每個命令都通過 **PowerShell 主管程序**跑（`server/device-center/local-verification.ts`
  的 named-pipe + `-EncodedCommand`）——Windows 上冷啟動實測 **2.7s/命令**。這是取消/停止語義
  的實現基礎，要改得快先得換主管機制，屬獨立改造。
- `server/process-utils.ts` 的 `snapshotProcessTree` / `lookupProcessCommandLine` 用 `Get-CimInstance`
  （WMI）拿程序表，單次也是秒級；目前只在 `bg-servers` 與排查路徑上，不在整合管線主路徑。

## 4. 已排除的假設（別再往這些方向試）

| 假設                                         | 實測                                                                | 結論                      |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| 腳手架建倉太慢（git init/config/commit/add） | 6 次 git 子程序共 **186ms**；單次 git ≈30ms                         | 否                        |
| fixture 複用能大幅提速                       | 一條只需要 0.3s 的用例（含完整 beforeEach + Hub 啟動）= **504ms**   | 收益 ~0.3s/條，不解決問題 |
| 測試裡有大量 `sleep`/固定等待                | 6 個重型檔案裡 `setTimeout` 級等待只有 2–3 處（10s 級的取消類用例） | 否                        |
| 偽計時器被誤用                               | 全倉 78 個檔案用 `vi.useFakeTimers`，但重型 6 檔案基本不用          | 否                        |
| 提高 worker 數就行                           | 快池 4→8 有效（280→186s）；重型池 4→8 **變慢且假紅**                | 分池才行                  |
| `silent` 只是輸出問題                        | 是輸出問題的同時，也掩蓋了「每條用例 15–35s」這個事實               | 已修                      |

## 5. 結論與仍開放的點

### 已閉環（本輪已答）

| 原疑點                     | 答案                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1：3 次呼叫為何 16.7s     | 不是 `store.transact`（7 次共 **25ms**）、也不是測試自己的 git（16 次 505ms）。是**產品 `git()` 每次呼叫多跑一次 `git config` 濾波探測**：一條管線 462 次 git 子程序（11.8s）+ 1 次 PowerShell 主管（2.7s）。已在產品側按配置指紋快取修復 → 同一條用例 **16.7s → 11.1s**，重型池 −48% |
| Q2：快池 fork 開銷怎麼根治 | 分賬實測為 `tests 44% / import 44% / environment 8% / transform 3%`。所以 `fsModuleCache`（快取 transform）**無效**；`isolate:false`（複用模組圖）**有效 −36% 但引入順序依賴**；把 worker 從 4 抬到 8 是當前最優折中                                                                  |
| 砍用例能不能提速           | 能，但只值 ≈60s（§5）。重型池的 557s 是真實工作，刪用例是最後手段                                                                                                                                                                                                                     |

### 仍開放（需要拍板/需要獨立改造）

1. ~~抽出 `client-session.ts`~~ —— 已量過否掉：只有 11 個檔案能受益（見 §3.4）。
2. **PowerShell 主管程序常駐化**：每條驗證命令 2.7s 冷啟動 ≈ 整合管線端到端 18%。改成 warm 主管
   （程序複用 + 常駐 named pipe）能拿回大頭，但屬取消/停止語義的獨立改造，風險在產品側不在測試側。
3. **重型檔案的真並行**：併發上限實測 4–5 路（8 路即破預算）。要再快只能把 218–304s 的序列鏈拆成多檔案，
   但拆檔案不減少總工作量，收益取決於負載均衡，**預計 ≤10%**；優先順序低於上面兩條。

## 6. 復現命令

```bash
# 逐條耗時（預設 all；slow=只打 ≥1s；off=只留小結）
npm test
PI_TEST_TIMING=slow npm test

# 快池 / 重型池 / 全量
npx vitest run                       # 快池（8 worker，按 suite-partition 排除重型）
npm run test:integration             # 重型池（4 worker，90s 預算）
npm run test:all                     # 兩個都跑
PI_TEST_ALL=1 npx vitest run         # 一次跑全（不分池）

# worker 掃描
npx vitest run --maxWorkers=4|8|12

# 機器可讀的逐用例計時
npx vitest run --reporter=json --outputFile=<tmp>/timing.json

# 單條用例探針（重型檔案裡最貴的那條）
npx vitest run tests/unit/device-hub-integration.test.ts -t "completes full pipeline"
```

## 7. 關鍵原始碼位置

| 位置                                                    | 作用                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `vitest.config.ts` / `vitest.integration.config.ts`     | 兩個池的配置（worker 數、超時、reporter、exclude/include）                       |
| `tests/lib/suite-partition.mjs`                         | 重型清單與兩個池的常量（單源）                                                   |
| `tests/lib/test-timing-reporter.mjs`                    | 逐條用例計時 reporter                                                            |
| `tests/unit/test-suite-partition.test.ts`               | 分層守衛（兩池並集 == 全集）                                                     |
| `server/device-center/store.ts`                         | `transact()` / `persist()`：全量 `structuredClone` + WAL + index 重寫（Q1 嫌疑） |
| `server/device-center/hub-transaction-log.ts`           | WAL append（每次 `open`）                                                        |
| `server/device-center/device-integration.ts`（1159 行） | 真 git 物化 / 真命令驗證的執行體                                                 |
| `docs/development.md` §「測試耗時觀測」「兩個池」       | 現行的耗時觀測與分層規則                                                         |
