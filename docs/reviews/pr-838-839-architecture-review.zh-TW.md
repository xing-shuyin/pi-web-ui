[English](./pr-838-839-architecture-review.en.md) · [简体中文](./pr-838-839-architecture-review.md) · **繁體中文**

# PR #838 / #839 技術審查與架構演進建議

審查物件：[PR #838](https://github.com/xing-shuyin/pi-web-ui/pull/838)，合併提交 `9df07225e4a30b7979d9ffb2a8a9e071b25e4b55`；[PR #839](https://github.com/xing-shuyin/pi-web-ui/pull/839)，合併提交 `d5ee3b203659758652d063d2070423cb4638c15a`。結論以這些提交為準，未將當前工作區的其他改動計入 PR。

**結論：#838 是有效的止血修復，但路徑相容層不適合作為 SDK 的長期邊界；#839 打通了一個有限入口，尚未建立統一的自動壓縮擴充套件契約。優先修復可觀測的功能缺口，再分別收斂到按執行態釋出的外掛 SDK、由 Pi SDK 統一擁有的壓縮生命週期。**

兩個 PR 暴露了相似問題：執行態、觸發來源等本應由介面表達的資訊，分別通過“讓所有入口都相容瀏覽器”和“讓字串攜帶控制訊號”間接表達。長期演進應使這些資訊顯式化，同時保留小而清楚的相容層。

## 1. 已確認的問題與嚴重程度

| 優先順序 | 問題                                            | 影響與歸屬                                                                                                    |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| P1       | #839 的 `set_settings` 分發白名單沒有轉發新欄位 | 客戶端傳送合法的 `autoCompactionInstructions` 會被靜默丟棄；協議宣告與實際行為不一致。屬於該 PR 的整合缺口。  |
| P2       | #839 只給宿主空閒軟上限路徑傳指令               | 工具呼叫間隙的 SDK 閾值壓縮、溢位恢復仍沒有該指令；依賴暗號的擴充套件不能統一接管自動壓縮。屬於能力覆蓋限制。 |
| P2       | #838 的 mock 路徑語義偏離原生 Node              | 部分合法路徑被拒絕或被改寫；影響測試 Harness 的可信度。不能據此推斷生產宿主存在路徑越界漏洞。                 |
| P2       | `upgrade-sdk` 只檢查第一份副本的版本            | 服務端 SDK 最新、客戶端 SDK 舊且檔案齊全時，可能誤報已最新，阻礙 #838 修復落地。屬於存量問題。                |
| P2       | 客戶端只對入口 URL 加 epoch/retry 引數          | 相對依賴的 URL 不變，熱過載可能繼續使用舊 SDK，失敗依賴也可能繼續命中模組快取。屬於存量模組圖釋出問題。       |

此外，多擴充套件摘要競爭、錯誤回退、執行時結果校驗和提交一致性，是引入正式 Provider 前必須補齊的 SDK 契約；它們並非 #839 新增的問題。

### 1.1 #839 的設定訊息確實丟欄位

[合併後的 `handleSettingsMessage`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/dispatch-domain-handlers.ts#L701) 手工構造傳給 `setSettings` 的物件。`softCapTokens`、`softCapByModel` 位於第 758–759 行，新欄位沒有被加入。另一方面，[協議](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/protocol.ts#L1839) 已接受它，[設定服務](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/settings-service.ts#L1053) 也實現了寫入。

在合併提交的臨時快照中執行實際 `handleSettingsMessage`，傳入 `{ type: "set_settings", autoCompactionInstructions: "[[auto]]" }`：函式返回 `true`，`setSettings` 被呼叫，但引數沒有 `autoCompactionInstructions`。這解釋了為什麼欄位型別、持久化和預設單測都正確，正常 Web 訊息入口仍不能設定該值。

修復需補分發對映，並同步宿主 `setSettings` 的引數宣告。迴歸測試應穿過真實訊息分發、設定服務和重新整理後的設定快照，驗證寫入、清空以及歸一化行為。新增的復現只證明了分發層的丟欄位，尚未執行完整持久化往返。

### 1.2 #838 的路徑迴歸

[新的 `resolvePath`](https://github.com/xing-shuyin/pi-web-ui/blob/9df07225e4a30b7979d9ffb2a8a9e071b25e4b55/plugin-sdk/index.mjs#L71) 對所有輸入執行反斜槓替換，並使用自定義的絕對路徑與路徑風格識別。直接載入該提交的 SDK，得到以下結果：

| cwd / 輸入                                  | 原生 Node 的預期語義               | 新 mock 的實際結果     |
| ------------------------------------------- | ---------------------------------- | ---------------------- |
| POSIX `/work/proj` / `a\b`                  | `/work/proj/a\b`，反斜槓是檔名字元 | `/work/proj/a/b`       |
| Windows `C:\work\proj` / `\work\proj\a.txt` | `C:\work\proj\a.txt`               | HTTP 403               |
| Windows `C:\work\proj` / `C:a.txt`          | `C:\work\proj\a.txt`               | `C:\work\proj\C:a.txt` |
| Windows 當前程序、cwd 為 `.` / `a.txt`      | 相對當前程序目錄的絕對路徑         | HTTP 403               |

前兩列分別用 `path.posix.resolve`、`path.win32.resolve` 對照。生產宿主仍使用 Node 路徑處理，因此這是新增的 **mock 合同迴歸**。根路徑、UNC、`.` / `..` 的現有測試不能證明完整相容 Node，繼續補齊這些規則也會逐步變成維護一個路徑庫。

如果確實需要跨平臺虛擬檔案系統，應明確它自己的路徑語法，並讓消費者主動選擇；不要讓一個測試替身悄悄改變生產 API 的語義。

## 2. #838：按執行態切分發布邊界

### 2.1 當前修復的價值與侷限

移除頂層 `node:path` 確實解決了瀏覽器連結模組圖時的硬失敗。原生 ESM 必須先解析靜態依賴，呼叫方只使用 `defineView` 並不能避免解析同一入口裡的 Node 依賴；無構建流程的瀏覽器執行時也不存在可依賴的 tree-shaking。

但為讓服務端測試工具留在統一入口而重寫路徑演算法，是以語義成本換取入口相容。`createMockHost` 預設屬於測試執行態，不應成為客戶端 SDK 的傳遞依賴。

這不意味著測試 Harness 永遠只能在 Node 中執行。瀏覽器元件測試可以需要 mock，但應使用明確的客戶端測試入口及能力集合。當前模擬整個服務端 Host、包含工作區路徑和二進位制讀取語義的 Harness，更適合 Node 測試入口。

### 2.2 建議的釋出結構

```text
plugin-sdk/
  core/
    definitions.mjs          # 純定義及校驗，不依賴 Node 或 DOM 全域性
    shared-types.d.ts        # 真正跨執行態的資料契約
  client.mjs                 # defineView / defineRenderer / onUiAction / 客戶端工具
  client.d.mts               # 瀏覽器型別，不引入 Buffer、fs 或 Express
  server.mjs                 # definePlugin / 服務端輔助函式
  server.d.mts               # PluginHost、路由及 Node 型別
  testing.mjs                # createMockHost，使用原生 node:path
  testing.d.mts
  client-utils.mjs           # 現有相容入口，逐步轉為內部模組或子路徑轉發
  index.mjs                  # 有期限的舊 API 相容入口
  index.d.mts
  package.json
  sdk-manifest.json          # 各執行態檔案閉包、版本及內容摘要
```

`core` 只共享穩定且實際複用的東西，不應重新變成一個聚合全部能力的大入口。`server.mjs` 可以保持輕量；按執行態分層並不要求每個服務端檔案都引入 Node。

打包消費者使用顯式子路徑：

```json
{
	"exports": {
		"./client": { "types": "./client.d.mts", "default": "./client.mjs" },
		"./server": { "types": "./server.d.mts", "default": "./server.mjs" },
		"./testing": { "types": "./testing.d.mts", "default": "./testing.mjs" }
	}
}
```

這裡的 `./client` 是建議的新版完整客戶端入口。**當前 `./client` 只指向 `client-utils.mjs`，不能直接把腳手架 import 改成它，否則會缺少 `defineView` 等現有能力。** 應先完善匯出和相容測試，再改生成模板。

條件匯出可作為打包工具的便利能力，但不應承擔主要邊界。腳手架產生的 `./sdk/index.mjs` 是相對 URL，瀏覽器不會為它解析 SDK 的 `package.json#exports`。相對路徑直接匯入 `.mjs` 時，宣告檔案也應有相應的 `.d.mts`，不能只依賴包級 `types`。

### 2.3 定向複製與向後相容

新腳手架應生成明確的執行態入口：

```js
// client/entry.mjs
import { defineView } from "./sdk/client.mjs";

// 服務端入口
import { definePlugin } from "./sdk/server.mjs";

// Node 測試
import { createMockHost } from "../sdk/testing.mjs";
```

複製邏輯以釋出清單為單源，客戶端只獲得 `client.mjs` 的執行時依賴閉包及客戶端宣告，服務端及開發測試目錄獲得各自清單。不要繼續以“兩個固定檔案複製到兩處”代表 SDK 釋出。

相容遷移可分兩步：

1. 在次版本中新增三個入口，完整保留舊匯入方式和同步 `createMockHost` 簽名；新模板、文件和測試立即改用新入口。舊瀏覽器可達的 `index.mjs` 必須保持其整個靜態依賴圖瀏覽器可載入，不能靜態轉發到 Node `testing.mjs`。因此舊純實現可以暫留為隔離的 legacy shim，標註棄用並修復已知迴歸。
2. 在明確的主版本中移除舊入口的測試匯出，使 Node mock 迴歸原生路徑庫。若生成按角色的 `sdk/index.mjs` 相容轉發檔案，應明確它們支援的舊 API 集合，不要讓同一匯入在兩端默默暴露不同的完整契約。

不能為了刪除 50 行相容程式碼，把同步 API 改成 `async`，或者讓舊瀏覽器入口重新連結 Node 模組；這會重建原故障。

升級器應逐副本檢查版本和檔案摘要，並先寫臨時目錄、檢查後替換。[當前僅核對 `dirs[0]` 版本](https://github.com/xing-shuyin/pi-web-ui/blob/9df07225e4a30b7979d9ffb2a8a9e071b25e4b55/bin/pi-web-ui.mjs#L3619) 的邏輯應優先修復。相容層完成前，普通舊外掛升級仍必須能拿到 #838 的修復。

### 2.4 檢驗真實產物及型別邊界

新增 browser-safe 測試有價值，但其正則掃描不能等同瀏覽器驗證：它主要檢查靜態 `node:` 匯入，可能漏掉同一行前面有語句的 import、裸 `path` / `fs` 模組，以及執行時依賴問題；倉庫中的依賴存在也不能證明腳手架確實複製了它。

長期只需保留三類有實際價值的檢查：

- 用 CLI 真正生成外掛，再從生成目錄啟動隔離 HTTP 服務，在 Chrome 中匯入客戶端入口並執行最小 mount；檢查錯誤和依賴網路請求。測試埠與資料目錄遵循倉庫約束。
- 客戶端、服務端、測試入口分別做宣告型別檢查。客戶端使用 DOM + 標準 ES 庫且不自動注入 Node types；服務端使用 Node 型別；增加匯出存在性檢查，避免 JS 有函式而宣告沒有。
- 檢查釋出清單及客戶端依賴閉包，明確禁止 Node builtin 和未提供解析策略的裸包依賴。

存量宣告中存在 `Promise<Buffer>` 與 mock 返回 `Uint8Array` 的差別，客戶端工具也有宣告覆蓋債務。應在分入口時一起明確二進位制返回契約，而不是僅移動 `.mjs` 檔案。

## 3. #839：把摘要焦點與擴充套件選擇分開

### 3.1 設定欄位本身並非原罪

如果產品確實允許使用者設定“自動摘要優先保留決策和待辦”，將附加指令持久化、傳給 UI，並允許預設分享，都是合理的功能。遵循現有約定把協議從 43 升至 44，也不是架構問題。

問題在於同一個字串同時表示兩種不同東西：

- 面向模型的人類指令，例如“保留所有未完成事項”；
- 面向程式的控制訊號，例如“選用某個擴充套件生成摘要”。

後一種用途會讓擴充套件安裝狀態、字串精確值、全域性設定和預設匯入共同決定執行行為。使用者編輯、空白歸一化或截斷可能改變選擇；相同文本可能在手動壓縮中出現；多個擴充套件可能約定衝突。擴充套件未安裝或拋錯時，標記還可能被當作普通摘要指令傳給預設模型。它不具有許可權或身份憑據的意義。

因此應保留有產品價值的 `instructions`，讓 Provider ID 和觸發來源擁有自己的欄位及型別。若 Provider 由擴充套件本地配置決定，並不需要進入 Web 協議；若使用者要在 UI 中選擇 Provider，協議與預設中有顯式 ID 則完全合理，但匯入預設不能隱式安裝擴充套件或授予額外能力。

### 3.2 實際有多種壓縮來源

| 來源                   | 現有路徑                        | 擴充套件看到的 reason | #839 新欄位是否傳入 |
| ---------------------- | ------------------------------- | --------------------- | ------------------- |
| 使用者手動 `/compact`  | `session.compact(使用者指令)`   | `manual`              | 否                  |
| AI `compact_context`   | `session.compact(工具指令)`     | `manual`              | 否                  |
| 宿主空閒軟上限         | `session.compact(設定中的指令)` | `manual`              | 是                  |
| SDK 在回合間隙檢查閾值 | `_autoCompact("threshold", …)`  | `threshold`           | 否                  |
| SDK 上下文溢位恢復     | `_autoCompact("overflow", …)`   | `overflow`            | 否                  |

宿主通過 `reserveTokens = W - C` 將軟上限注入 SDK，因此“宿主空閒軟上限”和“輪內 SDK 閾值”可能由同一產品策略觸發，卻給擴充套件兩套不同資訊。

[#839 的新增呼叫點](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/agent-service.ts#L9321) 可以解決一條路徑，不能代表統一的自動壓縮接管。已有 `reason: threshold/overflow` 已經有型別價值，最小的根本改進是讓宿主觸發也帶正確、顯式的來源，並讓所有路徑經過同一個生命週期。

### 3.3 先修公開請求契約，再按需求增加 Provider

不必立即在宿主再建立一個與 Pi SDK 平行的外掛匯流排。如果當前只有一個摘要擴充套件，首先補齊 SDK 的請求和事件後設資料，繼續用已有 hook 就足以解除暗號依賴。多提供者選擇、配置和隔離有明確需求時，再升級為序號產生器制。

建議由 **Pi coding-agent SDK** 擁有以下管線：

```text
規範化請求並預佔 operation
  → prepare（選切點、計算 token、固定歷史版本）
  → 選擇唯一 provider
  → 生成摘要或明確選擇預設生成器
  → 結果校驗
  → 宿主保留資訊裝飾
  → 最終校驗及原子提交
  → 更新上下文投影併發送事件
```

宿主負責何時請求壓縮、產品設定、模型策略、證據保留及 UI 快照。SDK 負責它實際擁有的會話狀態、歷史切點、取消和提交。這樣使用者手動、工具呼叫、空閒檢查、輪內閾值和溢位恢復都可以複用同一實現。

以下是建議中的型別形態，**並非當前已經存在的 SDK API**：

```ts
type CompactionCause =
	| { kind: "manual"; initiator: "user" | "agent" | "api" }
	| { kind: "threshold"; policy: "host-soft-cap" | "sdk" }
	| { kind: "overflow" };

interface CompactionRequest {
	requestId: string;
	sessionId: string;
	cause: CompactionCause;
	willRetry: boolean;
	instructions?: string; // 只表達摘要內容偏好
	providerId?: string; // 來自當前會話的生效配置
}

type ProviderResult =
	| { decision: "summary"; summary: string; details?: JsonValue; usage?: Usage }
	| { decision: "use-default" }
	| { decision: "cancel"; message?: string };

interface CompactionProvider {
	id: string; // 擴充套件名稱空間內的穩定 ID
	label: string;
	generate(
		request: Readonly<CompactionRequest>,
		input: Readonly<PreparedCompactionInput>,
		context: CompactionProviderContext, // 含 signal、受約束模型呼叫及日誌能力
	): Promise<ProviderResult>;
}

// 擬議的 Pi ExtensionAPI
pi.registerCompactionProvider(provider);

// 新呼叫過載；compact(string | undefined) 保持原有含義
await session.compact({
	cause: { kind: "threshold", policy: "host-soft-cap" },
	instructions: policy.instructions,
	providerId: policy.providerId,
});
```

請求、Provider 選擇及必要的配置在開始時繫結穩定會話身份，不在跨 `await` 後讀取活動會話。`PreparedCompactionInput` 暴露規範化的待摘要內容、先前摘要及保留資訊；不要預設暴露可隨意變更 SessionManager 的宿主物件。

### 3.4 Provider 必須解決的契約

**唯一選擇。** 每個請求先確定一個生成 Provider。重複 ID 在註冊時拒絕；選擇順序可設為會話顯式配置、宿主預設、SDK 預設。配置的 Provider 不存在時返回明確的 unavailable 狀態，不能把它的 ID 當成摘要文本，也不能依賴載入順序。顯式 `use-default` 代表主動讓渡。

**錯誤和取消。** `cancel`、超時、執行異常、Provider 不存在以及結果無效應是可區分結果。執行錯誤預設應顯式失敗；確實需要自動回退時，由宿主策略指定可回退的錯誤類別，並記錄實際使用的 Provider。溢位恢復還應保留原本的 `willRetry` 語義。取消後要避免立即再次觸發相同壓縮的忙迴圈。

**截斷所有權。** 普通 Provider 只生成摘要及附屬資訊。`firstKeptEntryId`、`tokensBefore` 和分支有效性由 SDK 計算。當前舊 hook 允許擴充套件返回這些欄位，應作為 legacy 能力保留並驗證；高階保留策略可以通過顯式介面提出候選策略，由 SDK 重新 prepare 和校驗。這樣既允許專用記憶策略，也避免普通摘要器意外決定丟棄哪些歷史。

**執行時校驗。** TypeScript 不會校驗外部 `.mjs` 擴充套件。SDK 應驗證摘要型別、完整性和合理大小，details 的 JSON 形狀及倉庫 64KB 邊界、usage 數值、切點與當前分支的關係。預設生成器對模型錯誤或截斷的檢查，也應成為 Provider 的統一完成性要求。

**會話一致性。** operation 必須在第一個 `await` 前預佔，取消控制器區域性持有，finally 只釋放自己的 operation；提交前核對 session/branch/history revision。Provider 內遞迴壓縮同一會話應明確拒絕，或通過顯式延遲機制處理。不能允許 Provider 一邊等待當前壓縮完成、一邊成為阻止它完成的回撥。

**能力和預算。** 提供取消訊號、受約束模型呼叫、超時與輸出預算；需要額外工具或外部資料的 Provider 應顯式宣告能力。擴充套件上下文可以靈活，但不應預設把可重入的 `session.compact()` 當成生成介面交給它。

### 3.5 當前 SDK hook 不能直接視為 Provider 登錄檔

精確檢查了 `@earendil-works/pi-coding-agent@1.1.0` 的釋出包，相關實現與本地依賴一致。其 [`ExtensionRunner.emit`](https://unpkg.com/@earendil-works/pi-coding-agent@1.1.0/dist/core/extensions/runner.js) 會順序執行各 handler：

- 後一個 truthy 結果整體替換前一個結果，`{}` 也可能抹掉前一個擴充套件的摘要。
- `cancel` 提前結束分發。
- handler 拋錯會報告擴充套件錯誤並繼續，最終可能落到預設摘要。

這適合作為需要相容的舊事件語義，不能支撐“只有一個提供者、失敗是否回退可預測”的新契約。新增 Provider 管線不能同時執行舊摘要器和新摘要器、最後再比誰返回了內容。建議新 Provider 選中時跳過 legacy 摘要生成；未配置時維持舊語義；診斷明確報告實際路徑。觀察與保留策略 hook 可以單獨執行。

也不要混淆兩套外掛體系：`plugin-sdk` 的 `PluginHost` 面向 Web UI 外掛；`session_before_compact` 屬於 Pi SDK 擴充套件的 `ExtensionAPI`。在前者增加一個同名方法不會讓後者自動具備 Provider 能力。如未來允許 Web 外掛註冊服務端 Provider，需要通過帶穩定會話身份的宿主介面卡接入同一 SDK 登錄檔，並說明生命週期和許可權。

## 4. 其他值得一併修正的架構盲區

### 4.1 證據保留不能只裝飾預設生成器

當前 [`installCompactionInstructions`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/compaction-instructions.ts#L41) 包裝 SDK 私有的 `_runDefaultCompaction`，並校驗它的引數個數。它改寫預設生成的指令、附加證據索引。

它不會在 `session_before_compact` 之前改寫暗號。另一方面，擴充套件返回 `{ compaction }` 後，SDK 跳過預設生成器，因此依賴這個 wrapper 的證據索引保留也會被跳過。

如果證據索引是 pi-web-ui 的恢復能力，應把它放到所有生成器之後、提交之前的宿主保留資訊階段；否則 Provider 接管摘要就可能連帶接管了它不該負責的系統不變數。裝飾階段應冪等，並計入最終摘要預算。

### 4.2 一個 `reserveTokens` 承擔了兩種預算

宿主用 `reserveTokens = W - C` 控制觸發閾值；SDK 預設摘要生成又用 reserveTokens 推導摘要輸出上限，並受模型 maxTokens 限制。因此調低輸入軟上限，可能間接抬高允許生成的摘要長度。這不是 #839 引入的問題，但新 Provider 不應繼續繼承這個耦合。

公開策略應分別表達 `triggerTokens`、`keepRecentTokens`、`maxSummaryTokens`。Provider 用摘要預算，不應從閾值差額推導它。先加獨立摘要預算，再用公開閾值策略替代對 `getCompactionSettings` 的執行時覆蓋。

### 4.3 單次同步提交不等於持久化事務

SDK 當前手動壓縮在首次 `await abort()` 前沒有預佔專用 operation；擴充套件結果也直接提供切點和 token 資訊。併發或重入需要 SDK 層保障，單靠宿主呼叫前檢查是否 streaming 不夠。

另一個存量邊界是 SessionManager 先修改記憶體模組目、索引和 leaf，再持久化；寫盤失敗可能使記憶體、磁碟和 agent 投影不同步。正式壓縮提交應定義持久化失敗時的回滾或恢復，並讓 append 返回確切條目 ID。當前按摘要文本 `find` 已儲存條目的方式還可能命中舊的同文摘要，Provider 更容易重複生成固定格式文本。

overflow 恢復還有一個需要明確的邊界：SDK 在進入自動壓縮前，可能已通過 context edits 省略失敗的 assistant/tool 訊息。因此取消壓縮或 Provider 失敗，並不天然表示上下文完全未變。新契約應明確這些編輯是獨立提交的恢復動作，或將它們納入同一次候選投影並在成功時提交。

這些問題應通過 SDK 的故障注入、併發和取消測試收斂，無需在 pi-web-ui 再複製一套 SessionManager。

### 4.4 熱過載需要版本化整個模組圖

[`pluginEntryUrl`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/web/src/plugin-loader.ts#L243) 只修改 `entry.mjs?e=...&r=...`。入口中的 `./sdk/index.mjs` 解析後沒有這些引數，因此舊依賴仍在瀏覽器模組表裡；停用 HTTP 快取不能清掉當前頁面的 ESM 模組表。

隔離 Node 原生 ESM 復現中，先載入入口 `?e=1`、修改依賴內容、再載入入口 `?e=2`，兩次仍讀到舊依賴的值 `1`。這是 ESM URL 身份的機制驗證，未聲稱跑過真實瀏覽器熱升級端到端測試。

建議按構建修訂釋出完整、不可變的模組圖，例如 `/plugins/<id>/client-assets/<revision>/entry.mjs`，相對依賴自然繼承 revision 路徑。伺服器必須真正儲存並提供對應 revision 的產物，不能讓所有 revision 都對映到可變的當前檔案。較小實現也可以在構建時打包為內容雜湊資源。升級完成後讓 UI 載入新 revision，並清理舊例項的註冊與資源。

### 4.5 配置鏈路重複，型別檢查沒有驗證“欄位真的到達”

本次漏轉發不是欄位型別錯誤，而是多個手寫投影之間缺少覆蓋約束。`preset-fields` 已有部分後設資料，可以在其上逐步建立按用途宣告的欄位登錄檔：normalize、預設值、持久化、Web 可寫、UI 可讀、預設可分享分別顯式宣告。

可以生成投影和做編譯期覆蓋檢查，但**不能把所有持久化欄位自動加入分享或 Web 寫入白名單**。安全上的允許列表仍要顯式，只是由一份可檢查的後設資料驅動。配合少量貫穿 dispatch→settings→snapshot 的契約測試，比繼續堆原始碼字串測試更有價值。

## 5. 建議的分階段路線

| 階段              | 具體交付                                                                                                   | 相容性和完成判據                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A：立即修復       | 補 `set_settings` 欄位鏈路；修正已確認 mock 路徑迴歸；升級器檢查每個副本；文件明確當前僅 idle 路徑帶新指令 | 現有外掛繼續工作；訊息寫入、清空、重啟恢復均可驗證；客戶端舊副本能被升級。             |
| B：SDK 執行態邊界 | 新增 client/server/testing 入口和獨立宣告；釋出清單；更新腳手架及示例；保留 legacy 入口                    | CLI 生成產物在 Chrome 真正載入；客戶端型別無需 Node；舊匯入相容測試通過。              |
| C：最小壓縮契約   | 上游 SDK 提供帶來源的 compact 請求；統一所有自動路徑；獨立摘要預算；開放提交前宿主保留資訊介面             | 無暗號也能區分 user/agent/host/SDK；手動焦點指令保留；證據索引在擴充套件摘要下仍保留。 |
| D：按需 Provider  | 會話範圍註冊與顯式選擇；結果驗證；錯誤/取消/回退契約；序列化及提交一致性                                   | 重複 ID、缺失 Provider、併發、取消、重入、模型截斷及持久化失敗均有明確結果。           |
| E：收斂相容層     | 遷移舊 hook 與暗號配置；移除私有 method/settings wrapper；版本化外掛模組圖；逐步引入配置後設資料投影       | 宣告最低 SDK 能力並可診斷降級；無雙重摘要；主版本再刪除舊入口和過渡程式碼。            |

C 可以先於 D 獨立交付，不必等待完整 Provider 系統。B 與 C 也可以並行，二者分屬不同 SDK 契約。

遷移時不能猜測任意 `autoCompactionInstructions` 是否暗號：保留其原有文字含義；只有已知擴充套件宣告的舊標記才可精確遷移，並在配置版本中記錄。過渡期只允許一個摘要生成路徑，避免新舊機制同時呼叫模型。

宿主應按能力檢測新 SDK API，並宣告最低支援版本，不能只依賴寬範圍依賴或私有函式的引數個數。舊 SDK 可以保留有限、明確的 legacy 適配模式；診斷應能看到它的覆蓋範圍。

建議以五個規模可控的後續 PR 推進：先修訊息分發與副本升級；再拆執行態釋出；上游補請求來源和統一生命週期；按實際需求引入 Provider 及一致性保障；最後移除適配層並修正模組圖版本管理。

## 6. 驗證與審查邊界

在 `d5ee3b2` 的獨立臨時完整快照中，用現有依賴執行：

- `plugin-sdk-browser-safe.test.ts`
- `plugin-host-primitives.test.ts`
- `auto-compaction-instructions.test.ts`
- `preset-share.test.ts`

結果：**4 個測試檔案、90 個測試全部通過。** 臨時快照執行完已刪除，未修改當前工作區原始碼。

另在獨立快照中增加並執行了一個行為復現測試，證實真實 `handleSettingsMessage` 接受訊息但不轉發新欄位；直接載入 #838 合併提交的 SDK，實測了表中四個路徑差異；用臨時檔案實測了 ESM 入口 epoch 不重新整理依賴的問題。

已核驗鎖定的 SDK `1.1.0` 釋出包相關原始碼與本地依賴一致。未執行全倉測試、真實瀏覽器腳手架載入或生產壓縮端到端測試；未以“現有單測全綠”替代這些驗證，也未把建議中的新 API 當成現有功能。

本次只新增本審查文件。架構方案均為建議，未修改業務實現、釋出 SDK 或調整執行中配置。
