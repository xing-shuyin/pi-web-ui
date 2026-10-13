/**
 * pi-web-ui 插件 SDK 类型（starter，自包含，不引用 server/ 目录）。
 * 与 server/plugins.ts 的 PluginHost 同语义的精简版：写插件时抄 autocomplete 用，
 * 运行时以宿主实际注入为准（宿主 API 版本见 PLUGIN_API_VERSION）。
 */

export type PluginPermissionFamily =
	| "fs"
	| "fs:read"
	| "fs:write"
	| "ui"
	| "tools"
	| "http"
	| "chat"
	| "net"
	| "llm"
	| "dom"
	| "dom:anchor"
	| "notify"
	| "storage"
	| "secrets";

export interface WsEntry {
	name: string;
	type: "file" | "dir";
}

export interface WsStat extends WsEntry {
	/** 字节数（目录为 0）。 */
	size: number;
	/** 修改时间毫秒时间戳。 */
	mtime: number;
}

export interface UiSelectOption {
	value: string;
	label?: string;
	labelEn?: string;
}

export type UiItemKind =
	"view" | "action" | "badge" | "menu" | "page" | "organizer" | "divider" | "toggle" | "input" | "progress" | "select";

export interface UiContribution {
	id: string;
	slot?: string;
	label: string;
	labelEn?: string;
	icon?: string;
	hint?: string;
	hintEn?: string;
	kind?: UiItemKind;
	children?: UiContribution[];
	order?: number;
	align?: "start" | "center" | "end";
	group?: string;
	hidden?: boolean;
	action?: string;
	view?: string;
	when?: string[];
	badge?: string;
	checked?: boolean;
	value?: string;
	progress?: number;
	options?: UiSelectOption[];
}

export interface PluginAgentTool {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

export interface PluginCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** host.requestPermission：运行时申请能力范围（net 补主机，llm 限模型作用域）。
 *  基础族必须已声明；用户逐条确认（可记住），无浏览器/拒绝一律 false。 */
export interface PluginPermissionRequest {
	family: "net" | "llm";
	hosts?: string[];
	models?: string[];
	reason?: string;
}
/** host.schedule：定时任务（毫秒间隔或 5 字段 cron）。persistent 落盘，重启后重调即重建。 */
export interface PluginHostScheduleOptions {
	/** 持久任务的稳定 id（必填且合法，重启后靠它重建；每次 activate 都要重调）。 */
	id?: string;
	/** 重启不丢（声明 + lastRun 落盘；停止=删声明）。持久任务毫秒底线 60s。 */
	persistent?: boolean;
	/** 重启发现漏跑："skip"（缺省）跳过，"once" 补跑一次（15s 缓冲）。 */
	catchUp?: "skip" | "once";
	/** 后台面板显示名（缺省 id）。 */
	label?: string;
}

/** host.fs：工作区相对方法 + 跨目录 *Path 方法（后者需用户授权）。 */
export interface PluginHostFs {
	list(relDir?: string): Promise<WsEntry[]>;
	read(relPath: string): Promise<Buffer>;
	readText(relPath: string, maxBytes?: number): Promise<string>;
	write(relPath: string, data: string | Uint8Array): Promise<void>;
	remove(relPath: string): Promise<void>;
	stat(relPath: string): Promise<WsStat>;
	mkdir(relDir: string): Promise<void>;
	append(relPath: string, data: string | Uint8Array): Promise<void>;
	glob(pattern: string, relDir?: string): Promise<string[]>;
	requestAccess(dir: string, reason?: string): Promise<boolean>;
	authorizedDirs(): string[];
	listPath(absDir: string): Promise<WsEntry[]>;
	readPath(absPath: string): Promise<Buffer>;
	readTextPath(absPath: string, maxBytes?: number): Promise<string>;
	writePath(absPath: string, data: string | Uint8Array): Promise<void>;
	removePath(absPath: string): Promise<void>;
	statPath(absPath: string): Promise<WsStat>;
	mkdirPath(absDir: string): Promise<void>;
	appendPath(absPath: string, data: string | Uint8Array): Promise<void>;
	globPath(absDir: string, pattern: string): Promise<string[]>;
	watch(relPath: string, handler: (ev: { type: string; path: string }) => void): () => void;
}

/** host.ui：运行时 UI 条目管理（manifest "ui" 是声明式基线）。 */
export interface PluginHostUi {
	register(items: unknown[] | unknown): () => void;
	update(id: string, patch: Record<string, unknown>): void;
	remove(id: string): void;
	arrange(ops: unknown[] | unknown): void;
	list(): { items: UiContribution[]; arrange: unknown[] };
}

/** host.llm.complete：孤立无工具的一次性补全（不建对话、不进历史）。
 *  需要 manifest.permissions 含 "llm"（花用户自己的模型额度）。 */
export interface PluginHostLlm {
	complete(req: { prompt: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number }): Promise<{
		ok: boolean;
		text?: string;
		model?: string;
		usage?: { input: number; output: number };
		error?: string;
	}>;
}

/** 工具拦截守卫看到的 pre 请求（只对 bash/read 生效，全量见 server/plugin-tool-guard.ts）。 */
export interface ToolGuardPreRequest {
	toolName: "bash" | "read";
	params: unknown;
	conversationId?: string;
}

/** 工具 pre 决策：allow 放行 / deny 拒绝 / ask 待确认（暂按拒绝执行）。 */
export type ToolGuardPreDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string; reasonEn?: string }
	| { decision: "ask"; reason?: string; reasonEn?: string };

/** 插件服务端入口拿到的宿主接口（精简：全量见 server/plugins.ts PluginHost）。 */
export interface PluginHost {
	broadcast(payload: unknown): void;
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	/** 注册客户端上行消息处理器（RPC 模式）：回调提供 (msg, reply)，调用 reply(payload) 可直接向来源客户端回包。 */
	onClientMessage(handler: (msg: unknown, reply: (payload: unknown) => void) => void | Promise<void>): () => void;
	sendTo(clientId: string, payload: unknown): void;
	onAttach(handler: (clientId: string) => void): () => void;
	onToolEvent(handler: (ev: unknown) => void): () => void;
	/** 注册工具 pre 拦截守卫（只对 bash/read 生效；要 "tools" 能力）。 */
	onToolPre(
		handler: (req: ToolGuardPreRequest) => ToolGuardPreDecision | void | Promise<ToolGuardPreDecision | void>,
	): () => void;
	/** 注册工具 post 编辑守卫（只对 bash/read 生效；要 "tools" 能力）。 */
	onToolPost(handler: (req: unknown) => unknown): () => void;
	onRunEvent(handler: (ev: unknown) => void): () => void;
	/** 读对话快照。传 `{clientId}` = 该标签页正在看的对话；不传 = 最近活跃的非子代理会话。 */
	getActiveConversation(options?: { clientId?: string; fallback?: "latest-non-subagent" }): unknown;
	onConversationChanged(handler: () => void): () => void;
	/** 订阅模型切换成功（回调带 clientId / conversationId / model / isSubagent… 的快照）。 */
	onClientModelChanged(handler: (snap: unknown) => void): () => void;
	registerAgentTool(tool: PluginAgentTool): () => void;
	/** 注册一个供 AI 调用的工具（单参数 execute(args) 兼容接口，内部适配并转调 registerAgentTool）。 */
	registerTool(tool: {
		name: string;
		description: string;
		label?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters?: Record<string, unknown>;
		execute(args: Record<string, unknown>): Promise<unknown>;
	}): () => void;
	dir: string;
	dataDir: string;
	readonly cwd: string;
	onCwdChange(handler: (cwd: string) => void): () => void;
	registerCommand(cmd: PluginCommandDef): () => void;
	/** 挂载 HTTP 路由（实际暴露为 /plugins-api/<id><path>；要 "http" 能力；返回注销函数）。 */
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: unknown, res: unknown) => void,
	): () => void;
	/** 注册通用反向代理前缀（子路径去前缀透传到 127.0.0.1:port；要 "http" 能力；返回注销函数）。 */
	registerProxy(prefix: string, target: number | { port: number; host?: string }): () => void;
	ui: PluginHostUi;
	llm: PluginHostLlm;
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
		getAll(): Record<string, string>;
	};
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	fs: PluginHostFs;
	schedule(spec: string | number, fn: () => void, opts?: PluginHostScheduleOptions): () => void;
	requestPermission(req: PluginPermissionRequest): Promise<boolean>;
	getSettings(): Record<string, unknown>;
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	/** 分级运行时日志：host.log(level?, ...args)（level 缺省 "info"）。
	 *  首参是 "debug"|"info"|"warn"|"error" 之一即当级别，老写法的
	 *  host.log(...args) 照旧按 info 走。全部进宿主内存环形缓冲（每插件最近
	 *  200 条，单条截断 500 字符，不落盘）；error 级同时走 console.error。
	 *  用户在设置面板“界面插件”页点某插件的“日志”按需查看（级别过滤 + 清空）。 */
	log(level?: "debug" | "info" | "warn" | "error", ...args: unknown[]): void;
	/** 登记一条**自建**的可逆副作用（自建 setInterval / event 监听 / WebSocket…）：
	 *  返回的注销函数与插件反激活**都会**调 dispose。宿主自己的每个注册面已在内部
	 *  走同一个 effect 栈，这里只用于「宿主管不到的那些」—— 挂进来就不怕漏注销
	 *  （热重载后定时器叠加、监听器堆积都是这个漏法的症状）。dispose 请写成幂等的。 */
	effect(label: string, dispose: () => void): () => void;
	/** 无头调用：把外部通道文本投给 agent（要 "chat" 能力；宿主未接 chatProvider
	 *  时 reject（由 chatWait 包成 {ok:false}，插件侧用 chatWait 更省心）。 */
	chat(req: { text: string; accountId?: string }): Promise<{
		ok: boolean;
		conversationId?: string;
		error?: string;
	}>;
	/** 等待无头调用的运行结束（默认 120s 超时；无注入/超时/失败一律回 {ok:false}，绝不抛错）。 */
	chatWait(
		req: { text: string; accountId?: string },
		opts?: { timeoutMs?: number },
	): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	/** 对话读写：无注入时 list/search 回 []、get 回 null，绝不抛错。 */
	conversations: {
		list(): Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
		get(id: string): unknown;
		search(
			query: string,
			limit?: number,
		): Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
	};
	/** 向指定对话发一条用户消息（无注入回 {ok:false}，绝不抛错）。 */
	prompt(
		conversationId: string,
		req: { text: string; attachments?: Array<{ path: string; mode?: string }> },
	): Promise<{ ok: boolean; error?: string }>;
	/** 插队指定对话的当前运行（无注入回 {ok:false}，绝不抛错）。 */
	steer(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
	/** 中止指定对话的运行（无注入回 {ok:false}，绝不抛错）。 */
	abortRun(conversationId: string): Promise<{ ok: boolean; error?: string }>;
	/** 项目组装：在已授权目录里建目录/clone 仓库/写文件（失败回 {ok:false,error}，不留半成品）。 */
	project: {
		create(spec: { dir: string; [key: string]: unknown }): Promise<{
			ok: boolean;
			dir: string;
			log: string[];
			error?: string;
		}>;
	};
	/** P3：左栏「运行的对话」里的插件运行条目（仅展示，需要能力 "ui"）。setRunning 整体替换本插件的
	 *  条目，同时作为心跳：超过 ttlMs（缺省 60 秒，夹取 5 秒–1 小时）没有再次调用就整组自动清空；
	 *  clear() 立即清空；反激活时自动清空。item.action 点击时交给本插件浏览器 bundle 的 onUiAction。 */
	leftPanel: {
		setRunning(
			items: Array<{
				id: string;
				title: string;
				hint?: string;
				status?: "running" | "done" | "error";
				icon?: string;
				action?: string;
			}>,
			opts?: { ttlMs?: number },
		): void;
		clear(): void;
	};
	/** 常驻后台任务（顶栏「后台任务」面板；返回 update/unregister）。 */
	registerBackgroundTask(task: { id: string; label: string; stop?: () => void; status?: string }): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	/** 插件可见的模型列表（无注入回 []）。 */
	models: {
		list(): Array<{ id: string; [key: string]: unknown }> | Promise<Array<{ id: string; [key: string]: unknown }>>;
	};
	/** MCP 服务器检测与便捷安装接口（list/check 只读免权限；install 要 "tools"；promptInstall 要 "chat" 或 "tools"）。 */
	mcp: {
		list(): Promise<Array<{ name: string; scope: "global" | "project"; status: string; [key: string]: unknown }>>;
		check(query: string): Promise<{
			installed: boolean;
			running: boolean;
			enabled: boolean;
			server: Record<string, unknown> | null;
			matches: Array<Record<string, unknown>>;
			tools: Array<{ name: string; description?: string }>;
		}>;
		install(spec: {
			name?: string;
			package?: string;
			command?: string;
			args?: string[];
			cwd?: string;
			env?: Record<string, string>;
			url?: string;
			headers?: Record<string, string>;
			type?: "stdio" | "http" | "streamable-http";
			timeout?: number;
			description?: string;
			scope?: "global" | "project";
			enabled?: boolean;
		}): Promise<{
			ok: boolean;
			name?: string;
			scope?: "global" | "project";
			status?: string;
			tools?: Array<{ name: string; description?: string }>;
			server?: Record<string, unknown>;
			error?: string;
		}>;
		promptInstall(
			target: string | Record<string, unknown>,
			opts?: { conversationId?: string; scope?: "global" | "project" },
		): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	};
	/** 会话统计 / 流式增量订阅（返回注销函数）。 */
	onStats(handler: (s: unknown) => void): () => void;
	onStreaming(handler: (ev: { conversationId?: string; delta: string }) => void): () => void;
	/** 出站网络（要 "net" 能力 + 主机白名单；失败一律 {ok:false,error}，绝不抛错）。 */
	net: {
		fetch(
			url: string,
			init?: { method?: string; body?: string; headers?: Record<string, string> },
		): Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
	};
	/** 插件间事件总线（emit 回填 from；on 返回取消函数）。 */
	events: {
		emit(topic: string, payload?: unknown): void;
		on(topic: string, handler: (ev: unknown) => void): () => void;
	};
	/** 只读 git 查询（失败回 {ok:false,error} 对象而非抛错）。 */
	scm: {
		status(): Promise<unknown>;
		log(path?: string, limit?: number): Promise<unknown>;
	};
	/** 受限 shell（cwd 缺省当前工作区；默认超时 60s；要 "tools" 能力）。 */
	bash(
		cmd: string,
		opts?: { cwd?: string; timeoutMs?: number },
	): Promise<{
		ok: boolean;
		output: string;
		exitCode?: number;
		error?: string;
	}>;
}

/** 插件服务端入口形状（activate 必填，deactivate 可选）。 */
export interface PluginModule {
	activate(host: PluginHost): void | Promise<void>;
	deactivate?: () => void;
}

/** 插件宿主动作桥（window.__piWebUiHost，client bundle 用）。版本号见 PLUGIN_HOST_API_VERSION。 */
export interface PluginHostBridge {
	version: number;
	setView(view: string): void;
	/** 打开一个 `modal.dialog` 槽位的条目（全局 id `<pluginId>:<itemId>`；
	 *  不存在/被隐藏返回 false，同一时刻只开一个）。 */
	openModal(id: string): boolean;
	/** 关掉当前弹窗（幂等）。 */
	closeModal(): boolean;
	onUiAction(action: string, handler: (itemId: string, value?: string) => void): () => void;
}

/** 插件视图入口形状（client/entry.mjs 默认导出）。 */
export interface PluginViewModule {
	mount(el: HTMLElement, ctx: PluginViewContext): void | (() => void);
	cleanup?: () => void;
	renderers?: Record<string, (code: string, ctx: PluginViewContext) => HTMLElement | null>;
}

/** 视图 ctx（窄通道：只依赖 send/onData；动作回调走 window.__piWebUiHost.onUiAction，见 sdk onUiAction）。 */
export interface PluginViewContext {
	send(payload: unknown): void;
	onData(handler: (payload: unknown) => void): () => void;
}

export declare function definePlugin(def: PluginModule): PluginModule;
export declare function defineView(view: PluginViewModule): PluginViewModule;
export declare function defineRenderer(
	renderers: Record<string, (code: string, ctx: PluginViewContext) => HTMLElement | null>,
): Pick<PluginViewModule, "renderers">;
export declare function actionHandler(
	map: Record<string, (value?: string) => void>,
): (itemId: string, value?: string) => void;
export declare function onUiAction(action: string, handler: (itemId: string, value?: string) => void): () => void;
export declare function getSetting<T>(host: PluginHost, key: string, fallback: T): T;
export declare function selectOptions(list: Array<string | UiSelectOption>): UiSelectOption[];

/** SDK 版本（与 plugin-sdk/package.json 的 version 保持一致，单测锁定）。 */
export declare const SDK_VERSION: string;

/** createMockHost 的一条调用记录（method 如 "ui.register"、"fs.readText"；log 也记）。 */
export interface MockHostCall {
	method: string;
	args: unknown[];
	/** 本次记录窗口内的序号（0 起；reset() 后新记录重新从 0 开始）。 */
	seq: number;
}

/** createMockHost 的一条分级日志（log 被 overrides 整体替换时不再写这里）。 */
export interface MockHostLogEntry {
	level: "debug" | "info" | "warn" | "error";
	text: string;
}

/** createMockHost(overrides?)：settings/cwd/dir/dataDir 是专用键；命名空间键
 *  （fs/ui/llm/conversations/scm/net/events/models/storage/secrets/project/dialogs/
 *  shortcuts/searchProviders/composerProviders）传对象 = 按子键合并覆盖；其余键整体
 *  替换对应方法（仍进 calls 记录）。`calls`/`logs`/`mock`/`reset` 不可覆盖。 */
export interface MockHostOverrides {
	settings?: Record<string, unknown>;
	cwd?: string;
	dir?: string;
	dataDir?: string;
	[key: string]: unknown;
}

/** mock 命名空间：handlers 活视图 + emit/emitAsync/setSettings/emitSettings 驱动器
 *  + calls 过滤 + 注册表活视图（agentTools/commands/routes/schedules）+ fireSchedules。 */
export interface MockHostControls {
	/** 方法名 → 已注册 handler 数组（活引用，与注销函数联动）。 */
	handlers: Record<string, Array<(...args: any[]) => unknown>>;
	/** 主动触发某订阅方法的 handlers（错误直接抛给测试，不吞）。 */
	emit(method: string, ...args: unknown[]): void;
	/** 异步版：按注册顺序依次 await，返回各 handler 返回值（抛错即 reject，不吞）。 */
	emitAsync(method: string, ...args: unknown[]): Promise<unknown[]>;
	/** 按方法名过滤调用记录（不传即全部拷贝）。 */
	calls(method?: string): MockHostCall[];
	/** 合并 settings 预设（返回同一引用，getSettings() 读到的就是它）。 */
	setSettings(next: Record<string, unknown>): Record<string, unknown>;
	/** 合并预设 + 触发 onSettingsChanged（模拟用户在设置面板保存）。 */
	emitSettings(next?: Record<string, unknown>): Record<string, unknown>;
	/** 已注册的 Agent 工具定义（活数组，注销即摘除；工具的 execute 可直接调）。 */
	agentTools: Array<PluginAgentTool>;
	/** 已注册的斜杠命令定义（活数组，注销即摘除）。 */
	commands: Array<PluginCommandDef>;
	/** 已挂载的路由表（活数组，注销即摘除）。 */
	routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown) => void }>;
	/** 已注册的代理前缀（活数组，注销即摘除）。 */
	proxies: Array<{ prefix: string; target: number | { port: number; host?: string } }>;
	/** 已登记的定时任务（活数组 {spec, fn, opts}；schedule() 不设真定时器，注销即摘除）。 */
	schedules: Array<{ spec: string | number; fn: () => void; opts?: PluginHostScheduleOptions }>;
	/** 依次触发全部已登记的定时回调（返回各回调返回值；抛错即 reject）。 */
	fireSchedules(): Promise<unknown[]>;
}

/** 浏览器桥兼容（client 侧逻辑单测也能用同一个 mock）：无注入回退语义。 */
export interface MockHostDialogs {
	select(opts: { title?: string; options?: unknown; [key: string]: unknown }): Promise<{
		ok: boolean;
		selected?: string[];
		error?: string;
	}>;
	confirm(opts: { title?: string; text?: string; [key: string]: unknown }): Promise<boolean>;
	input(opts: { title?: string; [key: string]: unknown }): Promise<{ ok: boolean; value?: string }>;
}

/** createMockHost 返回的 mock host（PluginHost 全量 + harness 字段 + 桥兼容）。 */
export interface MockHost extends PluginHost {
	/** 全量调用记录（{method, args}，含 log/storage 等）。 */
	calls: MockHostCall[];
	/** 分级日志条目。 */
	logs: MockHostLogEntry[];
	/** 测试驱动器（handlers/emit/setSettings/emitSettings）。 */
	mock: MockHostControls;
	/** 清空 calls + logs（原地；settings/handlers/注册表这些 fake 状态保留，
	 *  要全新状态就重新 createMockHost()）。 */
	reset(): void;
	dialogs: MockHostDialogs;
	notifyAction(opts: { text: string; actions: Array<{ id: string; label: string }> }): Promise<string | null>;
	shortcuts: {
		register(shortcut: string, handler: () => void): () => void;
	};
	searchProviders: {
		register(provider: {
			id: string;
			label: string;
			search: (q: string) => Promise<Array<{ title: string; hint?: string; action: string }>>;
		}): () => void;
		list(): Array<{ id: string; label: string }>;
	};
	composerProviders: {
		register(provider: {
			id: string;
			label: string;
			search: (q: string) => Promise<Array<{ title: string; hint?: string; text?: string }>>;
		}): () => void;
		list(): Array<{ id: string; label: string }>;
	};
}

export declare function createMockHost(overrides?: MockHostOverrides): MockHost;

/** 安全 HTML 实体转义。 */
export declare function esc(s: unknown): string;

/** 安全取用 window.__piWebUiHost 宿主桥接 API。 */
export declare function hostApi(): any;

/** 获取插件服务端路由的统一根路径。 */
export declare function apiBase(pluginId: string): string;

/** 格式化字节大小为人类可读字符串（B / KB / MB / GB）。 */
export declare function formatBytes(bytes: number | unknown, decimals?: number): string;

/** 为异步操作施加超时限制。 */
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg?: string): Promise<T>;

/** 生成随机 UUID。 */
export declare function uuid(): string;

/** 归一化相对路径（反斜杠转斜杠、去除首尾多余斜杠与 "./"）。 */
export declare function normalizeRel(p: string): string;
