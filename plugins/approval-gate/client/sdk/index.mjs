export const SDK_VERSION = "0.1.0";

export function definePlugin(def) {
	if (!def || typeof def !== "object") throw new Error("[sdk] definePlugin 需要一个对象");
	if (typeof def.activate !== "function") throw new Error("[sdk] 插件缺 activate(host) 方法");
	if (def.deactivate !== undefined && typeof def.deactivate !== "function") {
		throw new Error("[sdk] deactivate 必须是函数");
	}
	return def;
}

export function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[sdk] defineView 需要一个对象");
	if (typeof view.mount !== "function") throw new Error("[sdk] 视图缺 mount(el, ctx) 方法");
	if (view.cleanup !== undefined && typeof view.cleanup !== "function") {
		throw new Error("[sdk] cleanup 必须是函数");
	}
	return view;
}

export function defineRenderer(renderers) {
	if (!renderers || typeof renderers !== "object") throw new Error("[sdk] defineRenderer 需要 { lang: fn } 对象");
	for (const [lang, fn] of Object.entries(renderers)) {
		if (typeof fn !== "function") throw new Error(`[sdk] renderer "${lang}" 不是函数`);
	}
	return { renderers };
}

export function actionHandler(map) {
	if (!map || typeof map !== "object") throw new Error("[sdk] actionHandler 需要 { action: fn } 对象");
	return (itemId, value) => {
		const fn = map[itemId];
		if (typeof fn === "function") return fn(value);
	};
}

export function onUiAction(action, handler) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return bridge.onUiAction(action, handler);
	} catch {}
	return () => {};
}

export function getSetting(host, key, fallback) {
	try {
		const v = host?.getSettings?.()?.[key];
		return v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

export function selectOptions(list) {
	return (Array.isArray(list) ? list : [])
		.map((x) => (typeof x === "string" ? { value: x, label: x } : x))
		.filter((x) => x && typeof x.value === "string" && x.value)
		.slice(0, 32);
}

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
			} catch {}
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
	const uiItems = new Map();
	const uiArrangeOps = [];
	let uiAutoId = 0;
	const agentToolStore = [];
	const commandStore = [];
	const routeStore = [];
	const proxyStore = [];
	const scheduleStore = [];
	const effectStore = [];
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
		dir: typeof overrides.dir === "string" ? overrides.dir : "/mock-workspace/.mock-plugin",
		dataDir: typeof overrides.dataDir === "string" ? overrides.dataDir : "/mock-data",
		cwd: typeof overrides.cwd === "string" ? overrides.cwd : "/mock-workspace",
		onCwdChange: sub("onCwdChange"),
		registerCommand: (cmd) => remember(commandStore, cmd),
		ui: {
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
			all: () => Object.fromEntries(storeMap),
		},
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
		effect: (label, dispose) => {
			const entry = { label, dispose };
			return remember(effectStore, entry);
		},
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
		calls,
		logs,
		mock: {
			get handlers() {
				const out = {};
				for (const [k, v] of handlerMap) out[k] = v;
				return out;
			},
			emit: (method, ...args) => {
				for (const h of [...(handlerMap.get(method) ?? [])]) h(...args);
			},
			emitAsync: async (method, ...args) => {
				const out = [];
				for (const h of [...(handlerMap.get(method) ?? [])]) out.push(await h(...args));
				return out;
			},
			calls: (method) => (method === undefined ? [...calls] : calls.filter((c) => c.method === method)),
			setSettings: (next) => {
				if (isPlainObject(next)) Object.assign(settingsState, next);
				return settingsState;
			},
			emitSettings: (next) => {
				if (isPlainObject(next)) Object.assign(settingsState, next);
				for (const h of [...(handlerMap.get("onSettingsChanged") ?? [])]) h(settingsState);
				return settingsState;
			},
			get agentTools() {
				return agentToolStore;
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
			fireSchedules: () => Promise.all(scheduleStore.map((s) => s.fn())),
		},
		reset: () => {
			calls.length = 0;
			logs.length = 0;
		},
	};

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

export * from "./client-utils.mjs";
