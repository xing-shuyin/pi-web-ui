export interface TtsVoice {
	id: string;
	label: string;
	lang?: string;
}

export interface TtsRequest {
	text: string;
	engine?: string;
	voice?: string;
	rate?: number;
	signal?: AbortSignal;
}

export interface TtsAudio {
	buffer: Uint8Array;
	format: "wav" | "mp3" | "aac" | "ogg" | "pcm" | "silk";
	sampleRate?: number;
	durationMs?: number;
}

export interface TtsEngine {
	supportsRate?: boolean;
	id: string;
	label: string;
	labelEn?: string;
	getVoices(options: { signal: AbortSignal }): Promise<TtsVoice[]> | TtsVoice[];
	synthesize(request: TtsRequest & { signal: AbortSignal }): Promise<TtsAudio>;
}

export interface TtsEngineInfo {
	supportsRate?: boolean;
	id: string;
	label: string;
	labelEn?: string;
}

export interface TtsClient {
	listEngines(): TtsEngineInfo[];
	listVoices(engine: string, options?: { signal?: AbortSignal }): Promise<TtsVoice[]>;
	synthesize(request: TtsRequest): Promise<TtsAudio>;
}

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
	size: number;
	mtime: number;
}

export interface UiSelectOption {
	value: string;
	label?: string;
	labelEn?: string;
}

export interface PluginMarkerDef<State = unknown> {
	name: string;
	label?: string;
	guidance: string[];
	getGuidance?: (lang: "zh" | "en") => string[];
	apply: (token: any, ctx: any, state: State, lang?: any) => Promise<any> | any;
	overlay?: (state: State, ctx: any) => any;
	init?: () => State;
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

export interface PluginPermissionRequest {
	family: "net" | "llm";
	hosts?: string[];
	models?: string[];
	reason?: string;
}
export interface PluginHostScheduleOptions {
	id?: string;
	persistent?: boolean;
	catchUp?: "skip" | "once";
	label?: string;
}

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

export interface PluginHostUi {
	register(items: unknown[] | unknown): () => void;
	update(id: string, patch: Record<string, unknown>): void;
	remove(id: string): void;
	arrange(ops: unknown[] | unknown): void;
	list(): { items: UiContribution[]; arrange: unknown[] };
}

export interface PluginHostLlm {
	complete(req: { prompt: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number }): Promise<{
		ok: boolean;
		text?: string;
		model?: string;
		usage?: { input: number; output: number };
		error?: string;
	}>;
}

export interface ToolGuardPreRequest {
	toolName: "bash" | "read";
	params: unknown;
	conversationId?: string;
}

export type ToolGuardPreDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string; reasonEn?: string }
	| { decision: "ask"; reason?: string; reasonEn?: string };

export interface PluginChatAttachment {
	path: string;
	mode?: "reference" | "inline";
	name?: string;
	mimeType?: string;
	imageData?: string;
	fileData?: string;
}

export interface PluginChatRequest {
	text: string;
	accountId?: string;
	conversationId?: string;
	cwd?: string;
	model?: string;
	thinkingLevel?: string;
	attachments?: PluginChatAttachment[];
}

export interface PluginWorkItem {
	id: string;
	accountId: string;
	roomId: string;
	provider: string;
	channelId: string;
	threadId: string;
	authorId: string;
	title: string;
	text: string;
	status: "open" | "running" | "waiting" | "blocked" | "completed" | "cancelled";
	authorized: boolean;
	manualAuthorized: boolean;
	pendingAuthorization?: boolean;
	latestEvent?: { id: string; kind?: string; text: string; author: { id: string; name?: string }; authorized: boolean };
	revision: number;
	taskIds: string[];
	createdAt: number;
	updatedAt: number;
	[key: string]: unknown;
}
export interface PluginWorkItemDelivery {
	id: string;
	leaseToken: string;
	workItemId: string;
	provider: string;
	channelId: string;
	threadId: string;
	text: string;
	[key: string]: unknown;
}
export interface PluginWorkItems {
	rooms(): Promise<{ id: string; name?: string }[]>;
	ingest(input: {
		provider: string;
		channelId: string;
		threadId: string;
		eventId: string;
		title: string;
		text: string;
		authorId: string;
		kind?: string;
		roomId: string;
		mode: "observe" | "auto";
		authorized: boolean;
	}): Promise<PluginWorkItem>;
	list(options?: { roomId?: string }): Promise<PluginWorkItem[]>;
	get(id: string): Promise<PluginWorkItem | undefined>;
	update(
		id: string,
		patch: { status?: "open" | "blocked" | "completed"; authorized?: boolean },
	): Promise<PluginWorkItem>;
	claimDelivery(options: { provider: string; limit?: number }): Promise<PluginWorkItemDelivery[]>;
	completeDelivery(id: string, result: { leaseToken: string; externalId?: string }): Promise<void>;
	failDelivery(id: string, result: { leaseToken: string; error: string }): Promise<void>;
}

export interface PluginHost {
	workItems: PluginWorkItems;
	broadcast(payload: unknown): void;
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onClientMessage(handler: (msg: unknown, reply: (payload: unknown) => void) => void | Promise<void>): () => void;
	sendTo(clientId: string, payload: unknown): void;
	onAttach(handler: (clientId: string) => void): () => void;
	onToolEvent(handler: (ev: unknown) => void): () => void;
	onToolPre(
		handler: (req: ToolGuardPreRequest) => ToolGuardPreDecision | void | Promise<ToolGuardPreDecision | void>,
	): () => void;
	onToolPost(handler: (req: unknown) => unknown): () => void;
	onRunEvent(handler: (ev: unknown) => void): () => void;
	getActiveConversation(options?: { clientId?: string; fallback?: "latest-non-subagent" }): unknown;
	onConversationChanged(handler: () => void): () => void;
	onClientModelChanged(handler: (snap: unknown) => void): () => void;
	registerAgentTool(tool: PluginAgentTool): () => void;
	registerMarker<State = unknown>(marker: any): () => void;
	registerTool(tool: {
		name: string;
		description: string;
		label?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters?: Record<string, unknown>;
		execute(args: Record<string, unknown>): Promise<unknown>;
	}): () => void;
	registerMarker<State = unknown>(marker: PluginMarkerDef<State>): () => void;
	dir: string;
	dataDir: string;
	readonly cwd: string;
	onCwdChange(handler: (cwd: string) => void): () => void;
	registerCommand(cmd: PluginCommandDef): () => void;
	execCommand?(
		name: string,
		args: string,
		context?: { clientId?: string },
	): Promise<{ ok: boolean; result?: string; error?: string }>;
	getPluginCommands?(): PluginCommandDef[];
	listProjects?(): string[];
	pickDirectory?(opts?: {
		initialPath?: string;
		title?: string;
	}): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
	pickModel?(opts?: {
		currentModelId?: string | null;
		title?: string;
	}): Promise<{ ok: boolean; modelId?: string; name?: string; provider?: string; canceled?: boolean; error?: string }>;
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: unknown, res: unknown) => void,
	): () => void;
	registerProxy(prefix: string, target: number | { port: number; host?: string }): () => void;
	ui: PluginHostUi;
	llm: PluginHostLlm;
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		has(key: string): boolean;
		keys(): string[];
		clear(preserveSettings?: boolean): void;
		all(): Record<string, unknown>;
	};
	services: {
		provide<T>(name: string, service: T): () => void;
		get<T>(name: string): T | undefined;
		has(name: string): boolean;
		list(): Array<{ name: string; pluginId: string }>;
		on<T>(name: string, handler: (service: T | undefined) => void): () => void;
	};
	provide<T>(name: string, service: T): () => void;
	get<T>(name: string): T | undefined;
	onService<T>(name: string, handler: (service: T | undefined) => void): () => void;
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
		getAll(): Record<string, string>;
	};
	tts: TtsClient & { registerEngine(engine: TtsEngine): () => void };
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	fs: PluginHostFs;
	schedule(spec: string | number, fn: () => void, opts?: PluginHostScheduleOptions): () => void;
	assets: {
		ensure(spec: any, opts?: any): Promise<{ ok: boolean; ready?: boolean; error?: string; path?: string }>;
		status(spec: any): { ready: boolean; downloading?: boolean; error?: string };
	};
	requestPermission(req: PluginPermissionRequest): Promise<boolean>;
	getSettings(): Record<string, unknown>;
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	log(level?: "debug" | "info" | "warn" | "error", ...args: unknown[]): void;
	effect(label: string, dispose: () => void): () => void;
	resolveInWorkspace(relOrAbsPath: string): string;
	fetch(input: string | URL | Request, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
	assets: {
		ensure(
			spec: {
				id: string;
				targetDir: string;
				urls: string[];
				sha256?: string;
				testFile?: string;
				size?: number;
				description?: string;
			},
			opts?: {
				onProgress?: (progress: { downloaded: number; total: number; percent: number; url: string }) => void;
				timeoutMs?: number;
			},
		): Promise<{ ok: boolean; targetDir: string; cached?: boolean; sha256?: string; error?: string }>;
		status(spec: {
			id: string;
			targetDir: string;
			urls: string[];
			sha256?: string;
			testFile?: string;
			size?: number;
			description?: string;
		}): {
			ready: boolean;
			downloading: boolean;
			progress: number;
			downloaded: number;
			total: number;
			error: string | null;
		};
	};
	chat(req: PluginChatRequest): Promise<{
		ok?: boolean;
		conversationId: string;
		clientId: string;
		runId?: string;
	}>;
	chatWait(
		req: PluginChatRequest,
		opts?: { timeoutMs?: number },
	): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	conversations: {
		list(): Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
		get(id: string): unknown;
		search(
			query: string,
			limit?: number,
		): Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
	};
	prompt(
		conversationId: string,
		req: { text: string; attachments?: Array<{ path: string; mode?: string }> },
	): Promise<{ ok: boolean; error?: string }>;
	steer(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
	abortRun(conversationId: string): Promise<{ ok: boolean; error?: string }>;
	project: {
		create(spec: { dir: string; [key: string]: unknown }): Promise<{
			ok: boolean;
			dir: string;
			log: string[];
			error?: string;
		}>;
	};
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
	registerBackgroundTask(task: {
		id: string;
		label: string;
		stop?: () => void;
		status?: string;
		check?: () =>
			boolean | { alive: boolean; status?: string } | Promise<boolean | { alive: boolean; status?: string }>;
		intervalMs?: number;
		maxFailures?: number;
		onDead?: (reason?: string) => void;
	}): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	models: {
		list(): Array<{ id: string; [key: string]: unknown }> | Promise<Array<{ id: string; [key: string]: unknown }>>;
	};
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
	onStats(handler: (s: unknown) => void): () => void;
	onStreaming(handler: (ev: { conversationId?: string; delta: string }) => void): () => void;
	net: {
		fetch(
			url: string,
			init?: { method?: string; body?: string; headers?: Record<string, string> },
		): Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
	};
	events: {
		emit(topic: string, payload?: unknown): void;
		on(topic: string, handler: (ev: unknown) => void): () => void;
	};
	scm: {
		status(): Promise<unknown>;
		log(path?: string, limit?: number): Promise<unknown>;
	};
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

export interface PluginModule {
	activate(host: PluginHost): void | Promise<void>;
	deactivate?: () => void;
}

export interface PluginHostBridge {
	version: number;
	openImagePreview(target: {
		src: string;
		alt?: string;
		onSaveAnnotation?: (dataUrl: string) => void | Promise<void>;
		actions?: { id: string; label: string; onSelect: () => unknown; closeOnSelect?: boolean }[];
	}): boolean;
	imageOcrProviders: {
		register(provider: {
			id: string;
			label: string;
			labelEn?: string;
			recognize(request: {
				src: string;
				signal: AbortSignal;
				onProgress: (progress: number) => void;
			}): Promise<{ text: string }>;
		}): () => void;
		list(): { id: string; label: string; labelEn?: string }[];
	};
	setView(view: string): void;
	openModal(id: string): boolean;
	closeModal(): boolean;
	onUiAction(action: string, handler: (itemId: string, value?: string) => void): () => void;
}

export interface PluginViewModule {
	mount(el: HTMLElement, ctx: PluginViewContext): void | (() => void);
	cleanup?: () => void;
	renderers?: Record<string, (code: string, ctx: PluginViewContext) => HTMLElement | null>;
}

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

export declare const SDK_VERSION: string;

export interface MockHostCall {
	method: string;
	args: unknown[];
	seq: number;
}

export interface MockHostLogEntry {
	level: "debug" | "info" | "warn" | "error";
	text: string;
}

export interface MockHostOverrides {
	settings?: Record<string, unknown>;
	cwd?: string;
	dir?: string;
	dataDir?: string;
	[key: string]: unknown;
}

export interface MockHostControls {
	handlers: Record<string, Array<(...args: any[]) => unknown>>;
	emit(method: string, ...args: unknown[]): void;
	emitAsync(method: string, ...args: unknown[]): Promise<unknown[]>;
	calls(method?: string): MockHostCall[];
	setSettings(next: Record<string, unknown>): Record<string, unknown>;
	emitSettings(next?: Record<string, unknown>): Record<string, unknown>;
	agentTools: Array<PluginAgentTool>;
	markers: Array<PluginMarkerDef<unknown>>;
	commands: Array<PluginCommandDef>;
	routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown) => void }>;
	proxies: Array<{ prefix: string; target: number | { port: number; host?: string } }>;
	schedules: Array<{ spec: string | number; fn: () => void; opts?: PluginHostScheduleOptions }>;
	fireSchedules(): Promise<unknown[]>;
}

export interface MockHostDialogs {
	select(opts: {
		title?: string;
		options?: unknown;
		code?: { content: string; language?: string; hasRisk?: boolean };
		[key: string]: unknown;
	}): Promise<{
		ok: boolean;
		selected?: string[];
		error?: string;
	}>;
	confirm(opts: {
		title?: string;
		text?: string;
		code?: { content: string; language?: string; hasRisk?: boolean };
		[key: string]: unknown;
	}): Promise<boolean>;
	input(opts: {
		title?: string;
		code?: { content: string; language?: string; hasRisk?: boolean };
		[key: string]: unknown;
	}): Promise<{ ok: boolean; value?: string }>;
}

export interface MockHost extends PluginHost {
	calls: MockHostCall[];
	logs: MockHostLogEntry[];
	mock: MockHostControls;
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

export declare function esc(s: unknown): string;

export declare function hostApi(): any;

export declare function apiBase(pluginId: string): string;

export declare function formatBytes(bytes: number | unknown, decimals?: number): string;

export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg?: string): Promise<T>;

export declare function uuid(): string;

export declare function normalizeRel(p: string): string;

export declare function attachShadowRoot(hostEl: HTMLElement, customCss?: string): ShadowRoot | HTMLElement;

export declare function mountIsolated(
	container: HTMLElement,
	mountFn: (root: HTMLElement) => void | (() => void),
	customCss?: string,
): () => void;

export declare function safeSliceIndex(value: string, limit: number): number;

export declare function chunkMarkdownText(text: string, limit?: number): string[];
