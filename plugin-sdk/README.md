# 插件 SDK（starter）

## 脚手架：`pi-web-ui plugin create`

不用手拷文件，一条命令生成最小可跑骨架（`manifest.json` + `index.mjs` + `client/entry.mjs` + `README.md`，SDK 自动拷进 `sdk/` 与 `client/sdk/`）：

```bash
pi-web-ui plugin create my-plugin --template minimal    # 零权限，可直接激活
pi-web-ui plugin create my-plugin --template ui-slot    # composer.actions 按钮 + onUiAction 示例
pi-web-ui plugin create my-plugin --template agent-tool # registerAgentTool 示例
pi-web-ui plugin create my-plugin --template renderer   # view:false + renderers 示例
```

常用选项：`--dir <插件父目录>`（默认 `<dataDir>/plugins`，也可用 `--data-dir` 指定数据目录）、`--force`（目标已存在时覆盖）。生成后会自动做一次 manifest 基础校验 + 生成文件的 `node --check` + **静态 import 自检**，有 warning 会直接打印；生效只需刷新浏览器（或发 `plugins_reload`），未运行则下次启动生效。

> **客户端 SDK 必须放在 `client/` 内**：宿主只暴露 `/plugins/<id>/client/*`（`server/plugins.ts` 的 `resolvePluginClientFile`）。越界的相对 import 会让整个客户端入口加载失败。服务端使用 `<plugin>/sdk/`，客户端使用 `<plugin>/client/sdk/`，新客户端入口导入 `./sdk/client.mjs`。
>
> **SDK 0.3.0 按运行环境拆分**：服务端 `sdk/` 包含 `index.mjs`、`client.mjs`、`client-utils.mjs`、`testing.mjs`；客户端 `client/sdk/` 只复制 `client.mjs` 与 `client-utils.mjs`，并生成仅转导出 `./client.mjs` 的兼容 `index.mjs`。因此已有客户端 `./sdk/index.mjs` 导入仍能工作。客户端模块及其完整依赖闭包禁止 Node 导入（包括动态导入与无 `node:` 前缀的内置模块），也不包含 `createMockHost`；测试 Harness 留在 Node 专用 `testing.mjs`。守卫：`tests/unit/plugin-sdk-browser-safe.test.ts`。

---

`@pi-web-ui/plugin-sdk` 是写插件的**起手包**，运行时入口及对应类型如下：

| 入口                           | 用途                                                                            | 包子路径                        |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- |
| `index.mjs` / `index.d.ts`     | 服务端 `definePlugin` 与兼容总入口，转导出客户端及测试能力                      | `@pi-web-ui/plugin-sdk`         |
| `client.mjs` / `client.d.ts`   | 浏览器 `defineView`、`defineRenderer`、UI 辅助与 `client-utils`                 | `@pi-web-ui/plugin-sdk/client`  |
| `testing.mjs` / `testing.d.ts` | Node 测试用 `createMockHost`，路径解析直接使用 `node:path` 的 `resolve` / `sep` | `@pi-web-ui/plugin-sdk/testing` |

> 和 `server/plugins.ts` 的全量 `PluginHost` 是**同语义的精简版**：运行时以宿主实际注入为准，宿主版本见 `PLUGIN_API_VERSION`。SDK 只求“写得顺”，不做运行时 polyfill。

## 怎么用

1. 优先用脚手架生成。手工 vendor 时，服务端将 `index.mjs`、`client.mjs`、`client-utils.mjs`、`testing.mjs` 拷到 `my-plugin/sdk/`；客户端只把 `client.mjs`、`client-utils.mjs` 拷到 `my-plugin/client/sdk/`。需要补全时同时保留 SDK 的 `.d.ts` 文件（类型入口共用 `index.d.ts`）；
2. 服务端入口：

```js
import { definePlugin, selectOptions } from "./sdk/index.mjs";

export default definePlugin({
	async activate(host) {
		const tone = String(host.getSettings().tone ?? "short");
		const off = host.ui.register({
			slot: "composer.actions",
			id: "tone",
			label: "语气",
			kind: "select",
			action: "my-plugin:tone",
			value: tone,
			options: selectOptions([
				{ value: "short", label: "简短" },
				{ value: "full", label: "详细" },
			]),
		});
		// 反激活时注销（可选，宿主也会统一清理）
		return;
	},
});
```

3. 客户端视图（`client/entry.mjs`）：

```js
import { defineView, onUiAction } from "./sdk/client.mjs";

export default defineView({
	mount(el, ctx) {
		const status = document.createElement("div");
		status.textContent = "就绪";
		el.appendChild(status);
		// 动作回调走宿主桥（client bundle 与宿主同页，window 直达），
		// 要落盘/跨端再经 ctx.send 发给服务端入口。
		return onUiAction("my-plugin:tone", (itemId, value) => {
			status.textContent = `语气：${value ?? ""}`;
			ctx.send({ action: "my-plugin:tone", value });
		});
	},
});
```

注意 `select` 的切换值是第二个参数：`onUiAction("my-plugin:tone", (itemId, value) => …)`。

## 本地单测（createMockHost）

插件作者不用起服务就能测 `activate`：`testing.mjs` 提供 `createMockHost(overrides?)`（仅依赖 Node 内置模块，`node --test` / vitest 均可）：

```js
// my-plugin/index.test.mjs —— 跑法：node --test index.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/testing.mjs";

describe("my-plugin", () => {
	it("activate 注册 UI + 读注入的设置", async () => {
		const host = createMockHost({ settings: { tone: "full" } });
		await plugin.activate(host);
		const reg = host.calls.find((c) => c.method === "ui.register");
		assert.ok(reg, "应该调过 host.ui.register");
		assert.equal(reg.args[0].value, "full"); // 读到的是注入的预设
	});

	it("reset() 清空记录；emit 模拟客户端消息", async () => {
		const host = createMockHost();
		await plugin.activate(host);
		host.reset();
		assert.equal(host.calls.length, 0);
		assert.equal(host.logs.length, 0);
		host.mock.emit("onMessage", { action: "my-plugin:tone" }, "client-1");
	});
});
```

要点：

- `host.calls`：全量调用记录 `{ method, args, seq }`（嵌套按点分路径，如 `"ui.register"`、`"fs.readText"`；`log`/`storage` 也记；`seq` 为本次窗口内序号）。`host.mock.calls(method?)` 按方法名过滤；`host.logs`：分级条目 `{ level, text }`；`host.reset()` 只清空两者（settings/handlers/注册表这些 fake 状态保留，要全新状态就重新 `createMockHost()`，零成本）。
- `overrides.settings` 是 `getSettings()` 返回的预设对象（同一引用）；`host.mock.setSettings(next)` 合并预设，`host.mock.emitSettings(next)` 合并 + 触发 `onSettingsChanged`（模拟用户在设置面板保存）。其余 `overrides` 键整体替换对应方法（`fs`/`ui`/`llm` 等命名空间传对象 = 按子键合并覆盖），被覆盖的方法仍进 `calls` 记录。
- 无注入回退（与宿主无 provider 时同语义）：`conversations.list/search` 回 `[]`、`get` 回 `null`；`prompt`/`steer`/`abortRun`/`chatWait`/`llm.complete`/`net.fetch`/`bash`/`scm` 回 `{ ok:false, … }`；`requestPermission` 回 `false`；`dialogs.select/input` 回 `{ ok:false }`、`confirm` 回 `false`；`notifyAction` resolve `null`；`schedule()` 只记调用不设真定时器（单测不泄漏句柄）。两处刻意差异：`chat()` 未注入时 resolve `{ ok:false }` 而不是 reject（真宿主 reject，由 `chatWait` 包成 `{ ok:false }`）；`fs.read/readPath` 给空 `Uint8Array`。
- 注册/订阅类返回注销函数，传进来的 handler 存进 `host.mock.handlers[method]`，用 `host.mock.emit(method, ...args)` 同步触发（异步 handler 用 `await host.mock.emitAsync(...)` 按序 await，返回各返回值）。工具/命令/路由/定时任务的定义体另存进 `host.mock.agentTools/commands/routes/schedules`（活数组，注销即摘除；工具的 `execute` 可直接调）；`schedule()` 不设真定时器，用 `await host.mock.fireSchedules()` 手动触发。
- `ui` 是内存注册表（同 id 覆盖、单次上限 32 条）：`list()` 真反映 register/update/remove/arrange。
- 脚手架可直接生成这个最小单测：`pi-web-ui plugin create my-plugin --with-test`（生成 `index.test.mjs`，现有模板默认不变）。
- SDK 是静态拷贝：`SDK_VERSION` 定义在 `client.mjs`，与 `plugin-sdk/package.json` 的 version 保持一致，总入口也转导出该版本。已装插件用 `pi-web-ui plugin upgrade-sdk [id]` 按服务端/客户端各自清单刷新；升级能识别旧 `index.mjs` 中的版本，保留旧客户端导入路径，补齐缺失文件及被引用但缺失的 `client/sdk/`，移除客户端误拷的 `testing.mjs`，再次执行保持幂等。零 SDK 拷贝的插件跳过；每个插件仍执行 import 自检。
- 自检工具：`plugin-sdk/import-check.mjs`（纯 ESM、零依赖）扫一个插件目录里的相对 import，报「客户端越界」与「目标缺失」——`plugin create` 生成后自动跑（随包装在 CLI 旁边）；插件作者也可以自己对已有插件跑一遍：
  `node --input-type=module -e "const m = await import('./sdk/import-check.mjs'); console.log(m.checkPluginImports(process.cwd()))"`（从插件目录跑）。
- mock 只在 SDK 层：不断言、不碰 `server/plugins.ts` 运行时。类型见 `index.d.ts` 的 `MockHost` / `MockHostOverrides` / `createMockHost`。

## 本次 P0 新增速览

| 能力                                                                                             | 服务端                | 视图                            |
| ------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------- |
| `host.fs.stat/mkdir/append/glob`（+ `*Path` 跨目录版）                                           | ✅                    | —                               |
| `kind: "select"` + `options` + `value`，`host.ui.update(id, { value })` 刷新                     | ✅                    | 顶栏/输入框/消息工具条已渲染    |
| `when` 肯定形条件（`file.isDir` / `file.isFile` / `session.isRunning` / `message.hasSelection`） | —                     | 右键菜单现场求值，置灰          |
| `settings` 新增 `secret` 类型（加密存，浏览器只见有无）                                          | ✅                    | 设置表单掩码 + 留空不改         |
| `settings` 的 `select` 支持 `optionsFrom`（宿主现算候选值：`models` / `thinkingLevels`）         | ✅                    | 下拉自动带「跟随全局默认」      |
| `host.llm.complete`（孤立无工具补全，不建对话）                                                  | ✅（要 `llm` 能力族） | —                               |
| `schedule` 持久版（`{id, persistent, catchUp, label}`，落盘+补跑+进后台面板）                    | ✅                    | —                               |
| `host.requestPermission`（动态授权：net 补主机 / llm 限模型，用户逐条确认可记住）                | ✅（基础族须已声明）  | 确认框 + 设置面板「已授权能力」 |

## 左栏运行条目：`host.leftPanel`（需要能力 `ui`）

把「正在跑的事」登记到左栏「运行的对话」里，按插件分组显示（例如第三方子代理：谁在跑、进度多少）。
**只展示**：不是对话，没有停止按钮；点击条目时把 `action` 交给你的浏览器 bundle（`host.onUiAction`）。

```js
// 整体替换本插件的条目；同时作为心跳（ttlMs 内不再调用 → 整组自动清空，缺省 60s，夹取 5s–1h）
host.leftPanel.setRunning(
	[{ id: "sub-1", title: "代码审查", hint: "第 2/5 步", status: "running", icon: "🔍", action: "review:open" }],
	{ ttlMs: 30_000 },
);
host.leftPanel.clear(); // 立即清空
```

`status`：`running`（进行中）/ `done` / `error`；缺省 `running`。`id` 在插件内唯一（重复的后者丢弃）。
上限 50 条；超出、缺 id、非法字段都会丢弃并进入运行时诊断，不会抛错。

## 反激活与清理：`host.effect(label, dispose)`

宿主的每个注册面（`ui.register` / `registerAgentTool` / `registerCommand` / `route` /
`registerProxy` / `fs.watch` / `schedule` / `registerBackgroundTask` / `events.on` /
`onStats` / `onStreaming` / `onSettingsChanged` …）都返回注销函数，**并且**已经在宿主内部
登记进该插件的 effect 栈：反激活（禁用、卸载、`plugins_reload`）时**逆序回卷**，插件忘了
调用返回的注销函数也不会留下孤儿订阅/定时器/路由。

你自己建的东西（`setInterval` / `addEventListener` / WebSocket / 自建缓存）挂在
`host.effect` 上同样享受这条保障：

```js
export default definePlugin({
	async activate(host) {
		const timer = setInterval(() => host.log("info", "tick"), 60_000);
		host.effect("my-timer", () => clearInterval(timer));
		// 也可以两者都写（幂等：dispose 写成本身幂等即可）
		const off = host.effect("my-ws", () => ws.close());
	},
});
```

清理抛错只记一条诊断、不阻断其它清理；`host.effect` 返回的注销函数与反激活都会调
`dispose`，所以 `dispose` 请写成**幂等**的。

完整契约见 `docs/architecture-plugins.md`。
