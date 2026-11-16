[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 外掛 SDK（starter）

## 統一 TTS 引擎中心

所有語音引擎在服務端通過 `host.tts.registerEngine({ id, label, getVoices, synthesize })` 註冊。宿主提供系統 `builtin` 引擎；外掛解除安裝自動撤銷註冊並取消合成。瀏覽器不再提供 `ttsProviders.register()`。

呼叫方使用 `host.tts.listEngines()`、`await host.tts.listVoices(engineId)`、`await host.tts.synthesize({ text, engine, voice, rate, signal })`，取得 `{ buffer, format }` 音訊。固定語速引擎宣告 `supportsRate: false`。引擎和音色 ID 來自同一個中心目錄，QQ、網頁播報與 AI 工具共享。完整介面、限制和遷移見 [`docs/architecture-tts.md`](../docs/architecture-tts.zh-TW.md)。

## 腳手架：`pi-web-ui plugin create`

不用手拷檔案，一條命令生成最小可跑骨架（`manifest.json` + `index.mjs` + `client/entry.mjs` + `README.md`，SDK 自動拷進 `sdk/` 與 `client/sdk/`）：

```bash
pi-web-ui plugin create my-plugin --template minimal    # 零許可權，可直接啟用
pi-web-ui plugin create my-plugin --template ui-slot    # composer.actions 按鈕 + onUiAction 示例
pi-web-ui plugin create my-plugin --template agent-tool # registerAgentTool 示例
pi-web-ui plugin create my-plugin --template renderer   # view:false + renderers 示例
```

常用選項：`--dir <外掛父目錄>`（預設 `<dataDir>/plugins`，也可用 `--data-dir` 指定資料目錄）、`--force`（目標已存在時覆蓋）。生成後會自動做一次 manifest 基礎校驗 + 生成檔案的 `node --check` + **靜態 import 自檢**，有 warning 會直接列印；生效只需重新整理瀏覽器（或發 `plugins_reload`），未執行則下次啟動生效。

> **客戶端 SDK 必須放在 `client/` 內**：宿主只暴露 `/plugins/<id>/client/*`（`server/plugins.ts` 的 `resolvePluginClientFile`）。越界的相對 import 會讓整個客戶端入口載入失敗。服務端使用 `<plugin>/sdk/`，客戶端使用 `<plugin>/client/sdk/`，新客戶端入口匯入 `./sdk/client.mjs`。
>
> **SDK 0.3.0 按執行環境拆分**：服務端 `sdk/` 包含 `index.mjs`、`client.mjs`、`client-utils.mjs`、`testing.mjs`；客戶端 `client/sdk/` 只複製 `client.mjs` 與 `client-utils.mjs`，並生成僅轉匯出 `./client.mjs` 的相容 `index.mjs`。因此已有客戶端 `./sdk/index.mjs` 匯入仍能工作。客戶端模組及其完整依賴閉包禁止 Node 匯入（包括動態匯入與無 `node:` 字首的內建模組），也不包含 `createMockHost`；測試 Harness 留在 Node 專用 `testing.mjs`。守衛：`tests/unit/plugin-sdk-browser-safe.test.ts`。

---

`@pi-web-ui/plugin-sdk` 是寫外掛的**起手包**，執行時入口及對應型別如下：

| 入口                           | 用途                                                                            | 包子路徑                        |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- |
| `index.mjs` / `index.d.ts`     | 服務端 `definePlugin` 與相容總入口，轉匯出客戶端及測試能力                      | `@pi-web-ui/plugin-sdk`         |
| `client.mjs` / `client.d.ts`   | 瀏覽器 `defineView`、`defineRenderer`、UI 輔助與 `client-utils`                 | `@pi-web-ui/plugin-sdk/client`  |
| `testing.mjs` / `testing.d.ts` | Node 測試用 `createMockHost`，路徑解析直接使用 `node:path` 的 `resolve` / `sep` | `@pi-web-ui/plugin-sdk/testing` |

> 和 `server/plugins.ts` 的全量 `PluginHost` 是**同語義的精簡版**：執行時以宿主實際注入為準，宿主版本見 `PLUGIN_API_VERSION`。SDK 只求“寫得順”，不做執行時 polyfill。

## 怎麼用

1. 優先用腳手架生成。手工 vendor 時，服務端將 `index.mjs`、`client.mjs`、`client-utils.mjs`、`testing.mjs` 拷到 `my-plugin/sdk/`；客戶端只把 `client.mjs`、`client-utils.mjs` 拷到 `my-plugin/client/sdk/`。需要補全時同時保留 SDK 的 `.d.ts` 檔案（型別入口共用 `index.d.ts`）；
2. 服務端入口：

```js
import { definePlugin, selectOptions } from "./sdk/index.mjs";

export default definePlugin({
	async activate(host) {
		const tone = String(host.getSettings().tone ?? "short");
		const off = host.ui.register({
			slot: "composer.actions",
			id: "tone",
			label: "語氣",
			kind: "select",
			action: "my-plugin:tone",
			value: tone,
			options: selectOptions([
				{ value: "short", label: "簡短" },
				{ value: "full", label: "詳細" },
			]),
		});
		// 反啟用時登出（可選，宿主也會統一清理）
		return;
	},
});
```

3. 客戶端檢視（`client/entry.mjs`）：

```js
import { defineView, onUiAction } from "./sdk/client.mjs";

export default defineView({
	mount(el, ctx) {
		const status = document.createElement("div");
		status.textContent = "就緒";
		el.appendChild(status);
		// 動作回撥走宿主橋（client bundle 與宿主同頁，window 直達），
		// 要落盤/跨端再經 ctx.send 發給服務端入口。
		return onUiAction("my-plugin:tone", (itemId, value) => {
			status.textContent = `語氣：${value ?? ""}`;
			ctx.send({ action: "my-plugin:tone", value });
		});
	},
});
```

注意 `select` 的切換值是第二個引數：`onUiAction("my-plugin:tone", (itemId, value) => …)`。

## 本地單測（createMockHost）

外掛作者不用起服務就能測 `activate`：`testing.mjs` 提供 `createMockHost(overrides?)`（僅依賴 Node 內建模組，`node --test` / vitest 均可）：

```js
// my-plugin/index.test.mjs —— 跑法：node --test index.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/testing.mjs";

describe("my-plugin", () => {
	it("activate 註冊 UI + 讀注入的設定", async () => {
		const host = createMockHost({ settings: { tone: "full" } });
		await plugin.activate(host);
		const reg = host.calls.find((c) => c.method === "ui.register");
		assert.ok(reg, "應該調過 host.ui.register");
		assert.equal(reg.args[0].value, "full"); // 讀到的是注入的預設
	});

	it("reset() 清空記錄；emit 模擬客戶端訊息", async () => {
		const host = createMockHost();
		await plugin.activate(host);
		host.reset();
		assert.equal(host.calls.length, 0);
		assert.equal(host.logs.length, 0);
		host.mock.emit("onMessage", { action: "my-plugin:tone" }, "client-1");
	});
});
```

要點：

- `host.calls`：全量呼叫記錄 `{ method, args, seq }`（巢狀按點分路徑，如 `"ui.register"`、`"fs.readText"`；`log`/`storage` 也記；`seq` 為本次視窗內序號）。`host.mock.calls(method?)` 按方法名過濾；`host.logs`：分級條目 `{ level, text }`；`host.reset()` 只清空兩者（settings/handlers/登錄檔這些 fake 狀態保留，要全新狀態就重新 `createMockHost()`，零成本）。
- `overrides.settings` 是 `getSettings()` 返回的預設物件（同一引用）；`host.mock.setSettings(next)` 合併預設，`host.mock.emitSettings(next)` 合併 + 觸發 `onSettingsChanged`（模擬使用者在設定面板儲存）。其餘 `overrides` 鍵整體替換對應方法（`fs`/`ui`/`llm` 等名稱空間傳物件 = 按子鍵合併覆蓋），被覆蓋的方法仍進 `calls` 記錄。
- 無注入回退（與宿主無 provider 時同語義）：`conversations.list/search` 回 `[]`、`get` 回 `null`；`prompt`/`steer`/`abortRun`/`chatWait`/`llm.complete`/`net.fetch`/`bash`/`scm` 回 `{ ok:false, … }`；`requestPermission` 回 `false`；`dialogs.select/input` 回 `{ ok:false }`、`confirm` 回 `false`；`notifyAction` resolve `null`；`schedule()` 只記呼叫不設真定時器（單測不洩漏控制代碼）。兩處刻意差異：`chat()` 未注入時 resolve `{ ok:false }` 而不是 reject（真宿主 reject，由 `chatWait` 包成 `{ ok:false }`）；`fs.read/readPath` 給空 `Uint8Array`。
- 註冊/訂閱類返回登出函式，傳進來的 handler 存進 `host.mock.handlers[method]`，用 `host.mock.emit(method, ...args)` 同步觸發（非同步 handler 用 `await host.mock.emitAsync(...)` 按序 await，返回各返回值）。工具/命令/路由/定時任務的定義體另存進 `host.mock.agentTools/commands/routes/schedules`（活陣列，登出即摘除；工具的 `execute` 可直接調）；`schedule()` 不設真定時器，用 `await host.mock.fireSchedules()` 手動觸發。
- `ui` 是記憶體登錄檔（同 id 覆蓋、單次上限 32 條）：`list()` 真反映 register/update/remove/arrange。
- 腳手架可直接生成這個最小單測：`pi-web-ui plugin create my-plugin --with-test`（生成 `index.test.mjs`，現有模板預設不變）。
- SDK 是靜態複製：`SDK_VERSION` 定義在 `client.mjs`，與 `plugin-sdk/package.json` 的 version 保持一致，總入口也轉匯出該版本。已裝外掛用 `pi-web-ui plugin upgrade-sdk [id]` 按服務端/客戶端各自清單重新整理；升級能識別舊 `index.mjs` 中的版本，保留舊客戶端匯入路徑，補齊缺失檔案及被引用但缺失的 `client/sdk/`，移除客戶端誤拷的 `testing.mjs`，再次執行保持冪等。零 SDK 複製的外掛跳過；每個外掛仍執行 import 自檢。
- 自檢工具：`plugin-sdk/import-check.mjs`（純 ESM、零依賴）掃一個外掛目錄裡的相對 import，報「客戶端越界」與「目標缺失」——`plugin create` 生成後自動跑（隨包裝在 CLI 旁邊）；外掛作者也可以自己對已有外掛跑一遍：
  `node --input-type=module -e "const m = await import('./sdk/import-check.mjs'); console.log(m.checkPluginImports(process.cwd()))"`（從外掛目錄跑）。
- mock 只在 SDK 層：不斷言、不碰 `server/plugins.ts` 執行時。型別見 `index.d.ts` 的 `MockHost` / `MockHostOverrides` / `createMockHost`。

## 本次 P0 新增速覽

| 能力                                                                                             | 服務端                | 檢視                            |
| ------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------- |
| `host.fs.stat/mkdir/append/glob`（+ `*Path` 跨目錄版）                                           | ✅                    | —                               |
| `kind: "select"` + `options` + `value`，`host.ui.update(id, { value })` 重新整理                 | ✅                    | 頂欄/輸入框/訊息工具條已渲染    |
| `when` 肯定形條件（`file.isDir` / `file.isFile` / `session.isRunning` / `message.hasSelection`） | —                     | 右鍵選單現場求值，置灰          |
| `settings` 新增 `secret` 型別（加密存，瀏覽器只見有無）                                          | ✅                    | 設定表單掩碼 + 留空不改         |
| `settings` 的 `select` 支援 `optionsFrom`（宿主現算候選值：`models` / `thinkingLevels`）         | ✅                    | 下拉自動帶「跟隨全域性預設」    |
| `host.llm.complete`（孤立無工具補全，不建對話）                                                  | ✅（要 `llm` 能力族） | —                               |
| `schedule` 持久版（`{id, persistent, catchUp, label}`，落盤+補跑+進後臺面板）                    | ✅                    | —                               |
| `host.requestPermission`（動態授權：net 補主機 / llm 限模型，使用者逐條確認可記住）              | ✅（基礎族須已宣告）  | 確認框 + 設定面板「已授權能力」 |

## 左欄執行條目：`host.leftPanel`（需要能力 `ui`）

把「正在跑的事」登記到左欄「執行的對話」裡，按外掛分組顯示（例如第三方子代理：誰在跑、進度多少）。
**只展示**：不是對話，沒有停止按鈕；點選條目時把 `action` 交給你的瀏覽器 bundle（`host.onUiAction`）。

```js
// 整體替換本外掛的條目；同時作為心跳（ttlMs 內不再呼叫 → 整組自動清空，預設 60s，夾取 5s–1h）
host.leftPanel.setRunning(
	[{ id: "sub-1", title: "程式碼審查", hint: "第 2/5 步", status: "running", icon: "🔍", action: "review:open" }],
	{ ttlMs: 30_000 },
);
host.leftPanel.clear(); // 立即清空
```

`status`：`running`（進行中）/ `done` / `error`；預設 `running`。`id` 在外掛內唯一（重複的後者丟棄）。
上限 50 條；超出、缺 id、非法欄位都會丟棄並進入執行時診斷，不會拋錯。

## 反啟用與清理：`host.effect(label, dispose)`

宿主的每個註冊面（`ui.register` / `registerAgentTool` / `registerCommand` / `route` /
`registerProxy` / `fs.watch` / `schedule` / `registerBackgroundTask` / `events.on` /
`onStats` / `onStreaming` / `onSettingsChanged` …）都返回登出函式，**並且**已經在宿主內部
登記進該外掛的 effect 棧：反啟用（停用、解除安裝、`plugins_reload`）時**逆序回捲**，外掛忘了
呼叫返回的登出函式也不會留下孤兒訂閱/定時器/路由。

你自己建的東西（`setInterval` / `addEventListener` / WebSocket / 自建快取）掛在
`host.effect` 上同樣享受這條保障：

```js
export default definePlugin({
	async activate(host) {
		const timer = setInterval(() => host.log("info", "tick"), 60_000);
		host.effect("my-timer", () => clearInterval(timer));
		// 也可以兩者都寫（冪等：dispose 寫成本身冪等即可）
		const off = host.effect("my-ws", () => ws.close());
	},
});
```

清理拋錯只記一條診斷、不阻斷其它清理；`host.effect` 返回的登出函式與反啟用都會調
`dispose`，所以 `dispose` 請寫成**冪等**的。

完整契約見 `docs/architecture-plugins.md`。
