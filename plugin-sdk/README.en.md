**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Plugin SDK (starter)

## Unified TTS engine center

All voice engines register on the server through `host.tts.registerEngine({ id, label, getVoices, synthesize })`. The host provides the system `builtin` engine; uninstalling a plugin automatically revokes its registration and cancels synthesis. Browsers no longer offer `ttsProviders.register()`.

Callers use `host.tts.listEngines()`, `await host.tts.listVoices(engineId)` and `await host.tts.synthesize({ text, engine, voice, rate, signal })` to get `{ buffer, format }` audio. Fixed-rate engines declare `supportsRate: false`. Engine and voice IDs come from one central catalog, shared by QQ, web playback and AI tools. Full interface, limits and migration: [`docs/architecture-tts.md`](../docs/architecture-tts.en.md).

## Scaffolding: `pi-web-ui plugin create`

No hand-copying files: one command generates a minimal runnable skeleton (`manifest.json` + `index.mjs` + `client/entry.mjs` + `README.md`, with the SDK copied into `sdk/` and `client/sdk/`):

```bash
pi-web-ui plugin create my-plugin --template minimal    # 零权限，可直接激活
pi-web-ui plugin create my-plugin --template ui-slot    # composer.actions 按钮 + onUiAction 示例
pi-web-ui plugin create my-plugin --template agent-tool # registerAgentTool 示例
pi-web-ui plugin create my-plugin --template renderer   # view:false + renderers 示例
```

Common options: `--dir <插件父目录>` (defaults to `<dataDir>/plugins`; `--data-dir` also selects the data directory), `--force` (overwrite when the target exists). Generation then runs a basic manifest check + `node --check` on the generated files + a **static import self-check**, printing any warnings; activation only needs a browser refresh (or a `plugins_reload` message), and when the server is not running it takes effect on the next start.

> **The client SDK must live inside `client/`**: the host only exposes `/plugins/<id>/client/*` (`resolvePluginClientFile` in `server/plugins.ts`). A relative import that escapes that boundary fails the entire client entry load. The server side uses `<plugin>/sdk/`, the client side uses `<plugin>/client/sdk/`, and new client entries import `./sdk/client.mjs`.
>
> **SDK 0.3.0 is split by runtime**: server-side `sdk/` contains `index.mjs`, `client.mjs`, `client-utils.mjs` and `testing.mjs`; client-side `client/sdk/` copies only `client.mjs` and `client-utils.mjs` and generates a compatibility `index.mjs` that only re-exports `./client.mjs`. Existing client imports of `./sdk/index.mjs` therefore keep working. Client modules and their full dependency closure must not import Node (including dynamic imports and built-in modules without the `node:` prefix), and must not contain `createMockHost`; the test harness stays in the Node-only `testing.mjs`. Guard test: `tests/unit/plugin-sdk-browser-safe.test.ts`.

---

`@pi-web-ui/plugin-sdk` is the **starter kit** for writing plugins; runtime entries and their types:

| Entry                          | Purpose                                                                                                   | Package subpath                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `index.mjs` / `index.d.ts`     | Server `definePlugin` plus the compatibility umbrella entry, re-exporting client and testing capabilities | `@pi-web-ui/plugin-sdk`         |
| `client.mjs` / `client.d.ts`   | Browser `defineView`, `defineRenderer`, UI helpers and `client-utils`                                     | `@pi-web-ui/plugin-sdk/client`  |
| `testing.mjs` / `testing.d.ts` | `createMockHost` for Node tests; path resolution uses `resolve` / `sep` from `node:path` directly         | `@pi-web-ui/plugin-sdk/testing` |

> A **semantically identical, slimmed-down version** of the full `PluginHost` in `server/plugins.ts`: at runtime whatever the host actually injects is authoritative, and the host version is `PLUGIN_API_VERSION`. The SDK only aims to be pleasant to write against; it polyfills nothing at runtime.

## How to use

1. Prefer generating with the scaffolder. When vendoring by hand, copy `index.mjs`, `client.mjs`, `client-utils.mjs` and `testing.mjs` into `my-plugin/sdk/` on the server side; on the client side copy only `client.mjs` and `client-utils.mjs` into `my-plugin/client/sdk/`. If you want completion support, also keep the SDK's `.d.ts` files (the type entry is the shared `index.d.ts`);
2. Server entry:

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
		// unregister on deactivate (optional; the host also cleans up uniformly)
		return;
	},
});
```

3. Client view (`client/entry.mjs`):

```js
import { defineView, onUiAction } from "./sdk/client.mjs";

export default defineView({
	mount(el, ctx) {
		const status = document.createElement("div");
		status.textContent = "就绪";
		el.appendChild(status);
		// Action callbacks go through the host bridge (the client bundle shares the page with the host, window is direct),
		// for persistence/cross-device, send to the server entry through ctx.send.
		return onUiAction("my-plugin:tone", (itemId, value) => {
			status.textContent = `语气：${value ?? ""}`;
			ctx.send({ action: "my-plugin:tone", value });
		});
	},
});
```

Note that `select`'s change value is the second argument: `onUiAction("my-plugin:tone", (itemId, value) => …)`.

## Local unit tests (createMockHost)

Plugin authors can test `activate` without starting a server: `testing.mjs` provides `createMockHost(overrides?)` (depends only on Node built-ins; works with `node --test` / vitest):

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
		assert.equal(reg.args[0].value, "full"); // reads back the injected preset
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

Key points:

- `host.calls`: full call log of `{ method, args, seq }` (nested calls use dotted paths such as `"ui.register"`, `"fs.readText"`; `log`/`storage` are recorded too; `seq` is the sequence number within this window). `host.mock.calls(method?)` filters by method name; `host.logs`: level-tagged entries `{ level, text }`; `host.reset()` clears only those two (the fake state — settings/handlers/registries — stays; for a completely fresh state call `createMockHost()` again, at zero cost).
- `overrides.settings` is the preset object returned by `getSettings()` (same reference); `host.mock.setSettings(next)` merges the preset, `host.mock.emitSettings(next)` merges + fires `onSettingsChanged` (simulating a user saving in the settings panel). Other `overrides` keys replace the whole method (passing an object for a namespace such as `fs`/`ui`/`llm` = merge-override per subkey); overridden methods are still recorded in `calls`.
- Fallbacks with no injection (same semantics as a host with no provider): `conversations.list/search` return `[]` and `get` returns `null`; `prompt`/`steer`/`abortRun`/`chatWait`/`llm.complete`/`net.fetch`/`bash`/`scm` return `{ ok:false, … }`; `requestPermission` returns `false`; `dialogs.select/input` return `{ ok:false }` and `confirm` returns `false`; `notifyAction` resolves `null`; `schedule()` only records the call and sets no real timer (unit tests leak no handles). Two deliberate differences: without injection `chat()` resolves `{ ok:false }` instead of rejecting (the real host rejects; `chatWait` wraps it into `{ ok:false }`); `fs.read/readPath` hand back an empty `Uint8Array`.
- Register/subscribe APIs return an unsubscribe function; the handler you pass is stored in `host.mock.handlers[method]` and fired synchronously with `host.mock.emit(method, ...args)` (for async handlers use `await host.mock.emitAsync(...)`, which awaits in order and returns each return value). Tool/command/route/schedule definition bodies are also stored in `host.mock.agentTools/commands/routes/schedules` (live arrays, removed on unsubscribe; a tool's `execute` can be called directly); `schedule()` sets no real timer — trigger it manually with `await host.mock.fireSchedules()`.
- `ui` is an in-memory registry (same id overwrites, 32 entries per call max): `list()` faithfully reflects register/update/remove/arrange.
- The scaffolder can generate this minimal unit test directly: `pi-web-ui plugin create my-plugin --with-test` (generates `index.test.mjs`; existing templates stay unchanged by default).
- The SDK is a static copy: `SDK_VERSION` is defined in `client.mjs` and kept in sync with the `version` in `plugin-sdk/package.json`; the umbrella entry re-exports that version too. For installed plugins, `pi-web-ui plugin upgrade-sdk [id]` refreshes per the server/client manifests; the upgrade detects the version in an old `index.mjs`, keeps old client import paths, fills in missing files and missing-but-referenced `client/sdk/`, removes a `testing.mjs` mistakenly copied to the client, and stays idempotent on repeat runs. Plugins with zero SDK copies are skipped; every plugin still gets the import self-check.
- Self-check tool: `plugin-sdk/import-check.mjs` (pure ESM, zero dependencies) scans a plugin directory for relative imports and reports "client boundary escape" and "missing target" — `plugin create` runs it automatically after generation (it ships alongside the CLI); plugin authors can also run it over existing plugins:
  `node --input-type=module -e "const m = await import('./sdk/import-check.mjs'); console.log(m.checkPluginImports(process.cwd()))"` (run from the plugin directory).
- The mock exists only at the SDK layer: it asserts nothing and never touches the `server/plugins.ts` runtime. Types: `MockHost` / `MockHostOverrides` / `createMockHost` in `index.d.ts`.

## What this P0 adds at a glance

| Capability                                                                                                                           | Server                                    | View                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `host.fs.stat/mkdir/append/glob` (+ the `*Path` cross-directory variants)                                                            | ✅                                        | —                                                                                |
| `kind: "select"` + `options` + `value`, refreshed by `host.ui.update(id, { value })`                                                 | ✅                                        | Already rendered in the top bar/composer/message toolbar                         |
| `when` affirmative conditions (`file.isDir` / `file.isFile` / `session.isRunning` / `message.hasSelection`)                          | —                                         | Evaluated live in the context menu, greyed out                                   |
| `settings` gains a `secret` type (stored encrypted, the browser only sees presence)                                                  | ✅                                        | Masked in the settings form + leave blank to keep unchanged                      |
| `settings` `select` supports `optionsFrom` (the host computes candidates now: `models` / `thinkingLevels`)                           | ✅                                        | Dropdown auto-carries 「跟随全局默认」(Follow global default)                    |
| `host.llm.complete` (isolated tool-free completion, creates no conversation)                                                         | ✅ (needs the `llm` capability family)    | —                                                                                |
| Persistent `schedule` (`{id, persistent, catchUp, label}`, persisted + catch-up + shown in the background panel)                     | ✅                                        | —                                                                                |
| `host.requestPermission` (dynamic authorization: net adds hosts / llm restricts models, per-item confirmation the user can remember) | ✅ (base family must already be declared) | Confirmation dialog + 「已授权能力」(Granted capabilities) in the settings panel |

## Left panel running entries: `host.leftPanel` (requires the `ui` capability)

Register "things that are running" into the left panel's 「运行的对话」(Running conversations), grouped by plugin (for example a third-party subagent: who is running, how far along).
**Display only**: not a conversation, no stop button; clicking an entry hands its `action` to your browser bundle (`host.onUiAction`).

```js
// Replace this plugin's whole entry set; also acts as a heartbeat (no call within ttlMs → the group is cleared automatically; default 60s, clamped to 5s–1h)
host.leftPanel.setRunning(
	[{ id: "sub-1", title: "代码审查", hint: "第 2/5 步", status: "running", icon: "🔍", action: "review:open" }],
	{ ttlMs: 30_000 },
);
host.leftPanel.clear(); // clear immediately
```

`status`: `running` (in progress) / `done` / `error`; defaults to `running`. `id` must be unique within the plugin (later duplicates are dropped).
Cap 50 entries; overflow, a missing id and invalid fields are all dropped and reported to runtime diagnostics — nothing throws.

## Deactivation and cleanup: `host.effect(label, dispose)`

Every registration surface of the host (`ui.register` / `registerAgentTool` / `registerCommand` / `route` /
`registerProxy` / `fs.watch` / `schedule` / `registerBackgroundTask` / `events.on` /
`onStats` / `onStreaming` / `onSettingsChanged` …) returns an unsubscribe function **and** is already registered on the
plugin's effect stack inside the host: on deactivation (disable, uninstall, `plugins_reload`) they roll back **in reverse
order**, so a plugin that forgets to call the returned unsubscribe function still leaves no orphaned subscriptions/timers/routes.

Things you build yourself (`setInterval` / `addEventListener` / WebSocket / your own caches) hung on
`host.effect` get the same guarantee:

```js
export default definePlugin({
	async activate(host) {
		const timer = setInterval(() => host.log("info", "tick"), 60_000);
		host.effect("my-timer", () => clearInterval(timer));
		// you can also write both (idempotent: just make dispose idempotent itself)
		const off = host.effect("my-ws", () => ws.close());
	},
});
```

A cleanup that throws only records one diagnostic and does not block other cleanups; both the unsubscribe
function returned by `host.effect` and deactivation call `dispose`, so write `dispose` to be **idempotent**.

Full contract: `docs/architecture-plugins.md`.
