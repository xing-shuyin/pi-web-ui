/** Node-only plugin test harness. */
import { resolve, sep } from "node:path";

/**
 * createMockHost(overrides?) —— 插件本地单测 harness（使用 Node 原生路径解析，node:test / vitest 均可）。
 *
 * 返回与服务端 PluginHost 同语义的精简版可断言 mock：
 *
 *   import { describe, it } from "node:test";
 *   import assert from "node:assert/strict";
 *   import plugin from "./index.mjs";
 *   import { createMockHost } from "./sdk/testing.mjs";
 *
 *   const host = createMockHost({ settings: { tone: "full" } });
 *   await plugin.activate(host);
 *   assert.ok(host.calls.some((c) => c.method === "ui.register"));
 *
 * 约定：
 * - `host.calls`：每次 host 方法调用都记一条 `{ method, args, seq }`（嵌套按点分路径，
 *   如 `"ui.register"`、`"fs.readText"`、`"conversations.list"`；`log` 也记；
 *   `seq` 为本次记录窗口内的序号）。`host.mock.calls(method?)` 按方法名过滤（不传即全部）。
 * - `host.logs`：`host.log(level?, ...args)` 的分级条目 `{ level, text }`
 *  （首参是 debug|info|warn|error 之一即当级别，否则按 info；text 拼后截断 500 字符；
 *   error 级同时走 console.error，与宿主一致）。
 * - 注册/订阅类（onMessage/onAttach/onToolEvent/onRunEvent/onConversationChanged/
 *   onCwdChange/onSettingsChanged/onStats/onStreaming/events.on/fs.watch/ui.register/
 *   registerAgentTool/registerCommand/route/schedule/shortcuts.register/…）返回注销函数；
 *   传进来的 handler 按方法名存进 `host.mock.handlers[method]`，测试里用
 *   `host.mock.emit(method, ...args)` 主动触发（如模拟客户端上行消息；
 *   fs.watch(path, handler)/events.on(topic, handler)/shortcuts.register(key, handler)
 *   这类回调在第二参，照样存）。工具/命令/路由/定时任务的定义体另存进
 *   `host.mock.agentTools/commands/routes/schedules`（活数组，注销即摘除；
 *   工具的 execute 可直接调），定时回调不自动跑，用
 *   `await host.mock.fireSchedules()` 手动触发。`host.mock.emit` 是同步直调
 *   （异步 handler 用 `await host.mock.emitAsync(method, ...args)` 按序 await，
 *   返回各 handler 返回值；抛错即 reject，与同步版一致不吞错）。
 * - 无注入回退（与宿主无 provider/无注入时同语义）：conversations.list/search 回 []、
 *   get 回 null；prompt/steer/abortRun/chatWait/llm.complete/net.fetch/bash/scm 回
 *   `{ ok:false, ... }`；requestPermission 回 false；dialogs.select/input 回 `{ ok:false }`、
 *   confirm 回 false；notifyAction resolve null；models/searchProviders/composerProviders
 *   的 list 回 []；getActiveConversation 回 null；project.create 回 `{ ok:false }`。
 *   与真宿主的两处刻意差异（测试友好）：`chat()` 未注入时 resolve `{ ok:false }`
 *   而不是 reject（真宿主 reject，由 chatWait 包成 `{ ok:false }`）；`schedule()` 只记
 *   调用不设真定时器（单测不泄漏句柄）。`fs.read/readPath` 给空 Uint8Array
 *  （浏览器侧 import 本文件也安全，不碰 node:Buffer）。
 * - `storage`/`secrets` 是内存实现（get/set/delete/all、set/get/has/delete/list，照样进
 *   calls 记录）；`ensureDeps` 回 true；`ui.list()` 回 `{ items: [], arrange: [] }`。
 * - `overrides.settings` 是 getSettings() 返回的预设对象（同一引用，直接改即模拟变化；
 *   或走 `host.mock.setSettings(next)` 合并、`host.mock.emitSettings(next)` 合并 + 触发
 *   onSettingsChanged）。`overrides.cwd/dir/dataDir` 改标量；其余键整体替换对应方法
 *   （命名空间键如 `fs`/`ui`/`llm` 传对象 = 按子键合并覆盖）。被覆盖的方法**仍进**
 *   calls 记录（`log` 被覆盖时除外：logs 只由默认实现写）。
 * - `ui` 是内存注册表（同 id 覆盖、上限 32 条，off 只摘除本次注册的 id）：
 *   `list()` 真反映 register/update/remove/arrange，不再是固定空快照。
 * - `host.reset()` 只清空 calls + logs（原地清空，引用保持有效；settings/handlers/
 *   注册表这些 fake 状态保留——要全新状态就重新 createMockHost()，零成本）。
 * - `calls`/`logs`/`mock`/`reset` 是 harness 自身字段，不可被 overrides 覆盖（传了直接抛错）。
 * - 浏览器桥兼容：附带 `dialogs`/`notifyAction`/`shortcuts`/`searchProviders`/
 *   `composerProviders` 无注入回退实现，client 侧逻辑也能用同一个 mock 测。
 *
 * mock 只在 SDK 层：不断言、不碰 server/plugins.ts 运行时，只求“插件作者本地能跑”。
 */
export function createMockHost(overrides) {
	if (overrides === undefined || overrides === null) overrides = {};
	if (typeof overrides !== "object" || Array.isArray(overrides)) {
		throw new Error("[sdk] createMockHost 需要一个对象（或不传）");
	}
	const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
	const noop = () => {};
	const freshOff = () => () => {};
	const okFalse = (what) => ({ ok: false, error: `mock：未注入 ${what}` });

	const calls = [];
	const logs = [];
	const settingsState = { ...(isPlainObject(overrides.settings) ? overrides.settings : {}) };
	const handlerMap = new Map();
	const handlersOf = (method) => {
		let arr = handlerMap.get(method);
		if (!arr) {
			arr = [];
			handlerMap.set(method, arr);
		}
		return arr;
	};
	// 订阅类：存 handler + 返回注销函数（调用本身由外层统一记进 calls）。
	// handler 缺省取首参；fs.watch(path, handler) / events.on(topic, handler) /
	// shortcuts.register(key, handler) 这类回调在第二参，用 sub(method, 1)。
	const sub =
		(method, argIndex = 0) =>
		(...args) => {
			const handler = args[argIndex];
			if (typeof handler === "function") handlersOf(method).push(handler);
			let done = false;
			return () => {
				if (done) return;
				done = true;
				const arr = handlersOf(method);
				const i = arr.indexOf(handler);
				if (i >= 0) arr.splice(i, 1);
			};
		};
	const logImpl = (levelOrArg, ...args) => {
		const levels = ["debug", "info", "warn", "error"];
		const level = levels.includes(levelOrArg) ? levelOrArg : "info";
		const parts = levels.includes(levelOrArg) ? args : [levelOrArg, ...args];
		const text = parts
			.map((x) => {
				if (typeof x === "string") return x;
				try {
					return JSON.stringify(x) ?? String(x);
				} catch {
					return String(x);
				}
			})
			.join(" ")
			.slice(0, 500);
		logs.push({ level, text });
		if (level === "error") {
			try {
				console.error("[mock-host]", text);
			} catch {
				/* 打印失败不影响单测 */
			}
		}
	};
	const statImpl = (p) => ({
		name:
			String(p ?? "")
				.split(/[\\/]/)
				.filter(Boolean)
				.pop() ?? "",
		type: "file",
		size: 0,
		mtime: 0,
	});
	const storeMap = new Map();
	const secretMap = new Map();
	// fake 状态（reset() 不动它们；要全新状态就重新 createMockHost()）：
	const uiItems = new Map();
	const uiArrangeOps = [];
	let uiAutoId = 0;
	const agentToolStore = [];
	const markerStore = [];
	const commandStore = [];
	const routeStore = [];
	const proxyStore = [];
	const scheduleStore = [];
	const effectStore = [];
	const serviceMap = new Map();
	const serviceListeners = new Map();
	// 注册类：存定义体 + 返回只摘除本次注册的注销函数（与宿主同语义）。
	const remember = (store, entry) => {
		if (entry !== undefined) store.push(entry);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const i = store.indexOf(entry);
			if (i >= 0) store.splice(i, 1);
		};
	};

	const host = {
		broadcast: noop,
		notify: noop,
		onMessage: sub("onMessage"),
		sendTo: noop,
		onAttach: sub("onAttach"),
		onToolEvent: sub("onToolEvent"),
		onToolPre: sub("onToolPre"),
		onToolPost: sub("onToolPost"),
		onRunEvent: sub("onRunEvent"),
		getActiveConversation: () => null,
		onClientModelChanged: sub("onClientModelChanged"),
		chat: async () => okFalse("chatProvider（无头调用未接入）"),
		chatWait: async () => ({ ok: false, error: "mock：未注入 chatProvider（不等 run_end）" }),
		llm: {
			complete: async () => okFalse("llmProvider（LLM 直调未接入）"),
		},
		requestPermission: async () => false,
		conversations: {
			list: () => [],
			get: () => null,
			search: () => [],
		},
		prompt: async () => okFalse("conversationWriter（对话写入未接入）"),
		steer: async () => okFalse("runSteerer（运行插队未接入）"),
		abortRun: async () => okFalse("runAborter（运行中止未接入）"),
		onConversationChanged: sub("onConversationChanged"),
		registerAgentTool: (tool) => remember(agentToolStore, tool),
		registerMarker: (marker) => remember(markerStore, marker),
		dir: typeof overrides.dir === "string" ? overrides.dir : "/mock-workspace/.mock-plugin",
		dataDir: typeof overrides.dataDir === "string" ? overrides.dataDir : "/mock-data",
		cwd: typeof overrides.cwd === "string" ? overrides.cwd : "/mock-workspace",
		onCwdChange: sub("onCwdChange"),
		registerCommand: (cmd) => remember(commandStore, cmd),
		execCommand: async (name, args, context) => {
			const cmd = [...commandStore.values()].find((c) => c.name === name);
			if (!cmd) return { ok: false, error: `Command /${name} not found` };
			try {
				const res = await cmd.run(args, context);
				return { ok: true, result: typeof res === "string" ? res : "" };
			} catch (err) {
				return { ok: false, error: err?.message ?? String(err) };
			}
		},
		getPluginCommands: () => [...commandStore.values()],
		listProjects: () => ["/mock-workspace", "/mock-project-2"],
		pickDirectory: async (opts) => ({ ok: true, path: opts?.initialPath || "/mock-workspace" }),
		pickModel: async (opts) => ({ ok: true, modelId: opts?.currentModelId || "mock/test-model" }),
		ui: {
			// 内存注册表（同 id 覆盖、上限 32 条，与宿主合并语义同口径的精简版）：
			// list() 真反映 register/update/remove，off() 只摘除本次注册的 id。
			register: (items) => {
				const list = Array.isArray(items) ? items : [items];
				const added = [];
				for (const raw of list.slice(0, 32)) {
					const id = raw && typeof raw.id === "string" && raw.id ? raw.id : `mock-${++uiAutoId}`;
					uiItems.set(id, isPlainObject(raw) ? { ...raw, id } : { id });
					added.push(id);
				}
				let done = false;
				return () => {
					if (done) return;
					done = true;
					for (const id of added) uiItems.delete(id);
				};
			},
			update: (id, patch) => {
				if (!uiItems.has(id) || !isPlainObject(patch)) return;
				uiItems.set(id, { ...uiItems.get(id), ...patch, id });
			},
			remove: (id) => {
				uiItems.delete(id);
			},
			arrange: (ops) => {
				const list = Array.isArray(ops) ? ops : [ops];
				uiArrangeOps.push(...list);
			},
			list: () => ({ items: [...uiItems.values()], arrange: [...uiArrangeOps] }),
		},
		storage: {
			get: (key, fallback) => (storeMap.has(key) ? storeMap.get(key) : fallback),
			set: (key, value) => {
				storeMap.set(key, value);
			},
			delete: (key) => {
				storeMap.delete(key);
			},
			has: (key) => storeMap.has(key),
			keys: () => [...storeMap.keys()],
			clear: () => {
				storeMap.clear();
			},
			all: () => Object.fromEntries(storeMap),
		},
		services: {
			provide: (name, service) => {
				serviceMap.set(name, service);
				const listeners = serviceListeners.get(name);
				if (listeners) {
					for (const fn of listeners) {
						try {
							fn(service);
						} catch {}
					}
				}
				return () => {
					if (serviceMap.get(name) === service) {
						serviceMap.delete(name);
						const currListeners = serviceListeners.get(name);
						if (currListeners) {
							for (const fn of currListeners) {
								try {
									fn(undefined);
								} catch {}
							}
						}
					}
				};
			},
			get: (name) => serviceMap.get(name),
			has: (name) => serviceMap.has(name),
			list: () => [...serviceMap.keys()].map((k) => ({ name: k, pluginId: "mock" })),
			on: (name, handler) => {
				let listeners = serviceListeners.get(name);
				if (!listeners) {
					listeners = new Set();
					serviceListeners.set(name, listeners);
				}
				listeners.add(handler);
				if (serviceMap.has(name)) {
					try {
						handler(serviceMap.get(name));
					} catch {}
				}
				return () => {
					listeners.delete(handler);
				};
			},
		},
		provide: (name, service) => host.services.provide(name, service),
		get: (name) => host.services.get(name),
		onService: (name, handler) => host.services.on(name, handler),
		secrets: {
			set: (name, value) => {
				secretMap.set(name, value);
			},
			get: (name) => secretMap.get(name),
			has: (name) => secretMap.has(name),
			delete: (name) => {
				secretMap.delete(name);
			},
			list: () => [...secretMap.keys()],
		},
		ensureDeps: async () => true,
		route: (method, path, handler) =>
			remember(routeStore, {
				method: String(method ?? "GET").toUpperCase(),
				path: String(path ?? "/"),
				handler,
			}),
		registerProxy: (prefix, target) =>
			remember(proxyStore, {
				prefix: String(prefix ?? "/"),
				target: typeof target === "number" ? { port: target, host: "127.0.0.1" } : target,
			}),
		fs: {
			list: async () => [],
			read: async () => new Uint8Array(0),
			readText: async () => "",
			write: async () => {},
			remove: async () => {},
			stat: async (p) => statImpl(p),
			mkdir: async () => {},
			append: async () => {},
			glob: async () => [],
			requestAccess: async () => false,
			authorizedDirs: () => [],
			listPath: async () => [],
			readPath: async () => new Uint8Array(0),
			readTextPath: async () => "",
			writePath: async () => {},
			removePath: async () => {},
			statPath: async (p) => statImpl(p),
			mkdirPath: async () => {},
			appendPath: async () => {},
			globPath: async () => [],
			watch: sub("fs.watch", 1),
		},
		project: {
			create: async () => ({ ok: false, error: "mock：未实现 project.create", log: [], dir: "" }),
		},
		registerBackgroundTask: () => ({ update: noop, unregister: noop }),
		leftPanel: {
			setRunning: noop,
			clear: noop,
		},
		getSettings: () => settingsState,
		onSettingsChanged: sub("onSettingsChanged"),
		scm: {
			status: async () => okFalse("scm（只读 git 未接入）"),
			log: async () => okFalse("scm（只读 git 未接入）"),
		},
		bash: async () => ({ ok: false, output: "", error: "mock：未注入 bash" }),
		// 只记调用不设真定时器（单测不泄漏句柄）；回调存进 mock.schedules，
		// 测试里用 await host.mock.fireSchedules() 手动触发。
		schedule: (spec, fn, opts) => remember(scheduleStore, { spec, fn, opts }),
		models: {
			list: () => [],
		},
		mcp: {
			list: async () => [],
			check: async () => ({
				installed: false,
				running: false,
				enabled: false,
				server: null,
				matches: [],
				tools: [],
			}),
			install: async () => okFalse("mcp.install（MCP 安装未接入）"),
			promptInstall: async () => okFalse("mcp.promptInstall（对话通道未接入）"),
		},
		onStats: sub("onStats"),
		onStreaming: sub("onStreaming"),
		net: {
			fetch: async () => okFalse("net（出站网络未接入）"),
		},
		events: {
			emit: noop,
			on: sub("events.on", 1),
		},
		log: logImpl,
		// effect 栈：mock 里只记调用 + 返回可撤函数（真实宿主在反激活时逆序回卷）。
		// 单测里测试 dispose 真跑的写法：拿到 off() 后调它，或断言 host.calls 里有 effect。
		effect: (label, dispose) => {
			const entry = { label, dispose };
			return remember(effectStore, entry);
		},
		resolveInWorkspace: (relOrAbsPath) => {
			const cwdValue = typeof overrides.cwd === "string" ? overrides.cwd : "/mock-workspace";
			const target = resolve(cwdValue, String(relOrAbsPath ?? ""));
			const root = resolve(cwdValue, ".");
			const rootPrefix = root.endsWith(sep) ? root : root + sep;
			if (target !== root && !target.startsWith(rootPrefix)) {
				const err = new Error("路径超出工作区范围");
				err.statusCode = 403;
				throw err;
			}
			return target;
		},
		fetch: async (input, init) => {
			record("fetch", [input, init]);
			return fetch(input, init);
		},
		assets: {
			ensure: async (spec, opts) => {
				record("assets.ensure", [spec, opts]);
				return { ok: true, targetDir: spec?.targetDir ?? "artifacts", cached: true };
			},
			status: (spec) => {
				record("assets.status", [spec]);
				return { ready: true, downloading: false, progress: 100, downloaded: 0, total: 0, error: null };
			},
		},
		// 浏览器桥兼容（client 侧逻辑单测也能用同一个 mock）：无注入回退语义。
		dialogs: {
			select: async () => ({ ok: false }),
			confirm: async () => false,
			input: async () => ({ ok: false }),
		},
		notifyAction: async () => null,
		shortcuts: {
			register: sub("shortcuts.register", 1),
		},
		searchProviders: {
			register: freshOff,
			list: () => [],
		},
		composerProviders: {
			register: freshOff,
			list: () => [],
		},
		assets: {
			ensure: async (spec, opts) => {
				record("assets.ensure", [spec, opts]);
				return { ok: true, ready: true, path: spec?.targetDir || "" };
			},
			status: (spec) => {
				record("assets.status", [spec]);
				return { ready: true, downloading: false };
			},
		},
		calls,
		logs,
		mock: {
			// 活视图：方法名 → 已注册 handler 数组（与注销函数联动）。
			get handlers() {
				const out = {};
				for (const [k, v] of handlerMap) out[k] = v;
				return out;
			},
			// 主动触发某订阅方法的 handlers（错误直接抛给测试，不吞）。
			emit: (method, ...args) => {
				for (const h of [...(handlerMap.get(method) ?? [])]) h(...args);
			},
			// 异步版：按注册顺序依次 await，返回各 handler 返回值（抛错即 reject，不吞）。
			emitAsync: async (method, ...args) => {
				const out = [];
				for (const h of [...(handlerMap.get(method) ?? [])]) out.push(await h(...args));
				return out;
			},
			// 按方法名过滤调用记录（不传即全部拷贝）。
			calls: (method) => (method === undefined ? [...calls] : calls.filter((c) => c.method === method)),
			// 合并预设（返回同一引用，getSettings() 读到的就是它）。
			setSettings: (next) => {
				if (isPlainObject(next)) Object.assign(settingsState, next);
				return settingsState;
			},
			// 合并预设 + 触发 onSettingsChanged（模拟用户在设置面板保存）。
			emitSettings: (next) => {
				if (isPlainObject(next)) Object.assign(settingsState, next);
				for (const h of [...(handlerMap.get("onSettingsChanged") ?? [])]) h(settingsState);
				return settingsState;
			},
			// fake 状态活视图（注册表；注销即摘除；reset() 不动它们）。
			get agentTools() {
				return agentToolStore;
			},
			get markers() {
				return markerStore;
			},
			get commands() {
				return commandStore;
			},
			get routes() {
				return routeStore;
			},
			get proxies() {
				return proxyStore;
			},
			get schedules() {
				return scheduleStore;
			},
			// 依次触发全部已登记的定时回调（返回各回调返回值；抛错即 reject）。
			fireSchedules: () => Promise.all(scheduleStore.map((s) => s.fn())),
		},
		reset: () => {
			calls.length = 0;
			logs.length = 0;
		},
	};

	// overrides：settings/cwd/dir/dataDir 已处理；其余键整体替换对应方法
	// （命名空间键 fs/ui/llm/… 传对象 = 按子键合并覆盖）。替换后的方法仍进 calls 记录。
	const namespaces = [
		"llm",
		"conversations",
		"ui",
		"leftPanel",
		"storage",
		"secrets",
		"fs",
		"project",
		"scm",
		"models",
		"mcp",
		"net",
		"events",
		"dialogs",
		"shortcuts",
		"searchProviders",
		"composerProviders",
		"assets",
	];
	for (const [key, value] of Object.entries(overrides)) {
		if (key === "settings" || key === "cwd" || key === "dir" || key === "dataDir") continue;
		if (key === "calls" || key === "logs" || key === "mock" || key === "reset") {
			throw new Error(`[sdk] createMockHost 不能覆盖 "${key}"（harness 自身字段）`);
		}
		if (namespaces.includes(key) && isPlainObject(value) && isPlainObject(host[key])) {
			Object.assign(host[key], value);
		} else {
			host[key] = value;
		}
	}
	// 记录层：所有 host 方法（mock/reset 除外）先记 calls 再委托。
	const record =
		(method, fn) =>
		(...args) => {
			calls.push({ method, args, seq: calls.length });
			return fn(...args);
		};
	for (const [key, value] of Object.entries(host)) {
		if (key === "calls" || key === "logs" || key === "mock" || key === "reset") continue;
		if (typeof value === "function") {
			host[key] = record(key, value);
		} else if (namespaces.includes(key) && isPlainObject(value)) {
			for (const [sk, fn] of Object.entries(value)) {
				if (typeof fn === "function") value[sk] = record(`${key}.${sk}`, fn);
			}
		}
	}
	return host;
}
