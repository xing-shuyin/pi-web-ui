import { listPluginTtsProviders } from "./tts-client";
export { getPluginTtsProvider, listPluginTtsProviders, onTtsProvidersChange } from "./tts-client";
/// <reference lib="dom" />
import { registerImageOcrProvider, listImageOcrProviders, type ImageOcrProvider } from "./image-ocr-providers";
import { openImageLightbox, type ImageLightboxTarget } from "./image-lightbox-bridge";

import type { BrowserHostBridge } from "../../browser/contracts";
import type { AppSend } from "./app-globals";
import { getCostCurrencySymbol, registerCostFormatter, setCostCurrencySymbol, type CostFormatter } from "./cost-format";
import { composeToComposer, isComposerReady, type ComposerPayload } from "./composer-bridge";
import { isDesktopShell } from "./desktop";
import type { UiPluginCatalogEntry } from "./types";
import { randomUuid } from "./uuid";

import { requestNewChat } from "./new-chat-request";

const PLUGIN_HOST_GLOBAL = "__piWebUiHost";
export const PLUGIN_HOST_API_VERSION = 18;

export interface PluginHostPickDirectoryOptions {
	initialPath?: string;
	title?: string;
}

export interface PluginHostPickDirectoryResult {
	ok: boolean;
	path?: string;
	canceled?: boolean;
	error?: string;
}

export interface PluginHostPickModelOptions {
	currentModelId?: string | null;
	title?: string;
}

export interface PluginHostPickModelResult {
	ok: boolean;
	modelId?: string;
	name?: string;
	provider?: string;
	canceled?: boolean;
	error?: string;
}

interface PluginHostModelInfo {
	id: string;
	provider: string;
	name?: string;
	vision?: boolean;
	reasoning?: boolean;
}

interface PluginHostStartChatOptions {
	prompt: string;
	newChat?: boolean;
	onResult?: (ok: boolean) => void;
	cwd?: string;
	model?: string;
}

type PluginHostComposeOptions = ComposerPayload;

interface PluginHostOpenSessionOptions {
	cwd?: string;
	folders?: string[];
	roots?: string[];
	prompt?: string;
	newChat?: boolean;
	model?: string;
}

export interface PluginHostSessionInfo {
	id: string;
	title: string;
	cwd: string;
	kind: "running" | "history" | "elsewhere";
	owner?: string;
	conversationId?: string;
	independent?: boolean;
	isStreaming?: boolean;
}

interface PluginHostSessionsApi {
	list(): PluginHostSessionInfo[];
	open(id: string): Promise<PluginHostOpenSessionResult>;
}

type PluginHostOpenSessionResult = { ok: true; sessionId?: string } | { ok: false; error: string };

interface PluginHostReloadCatalogOptions {
	install?: boolean;
	replace?: boolean;
}

type PluginHostReloadCatalogResult =
	| { ok: true; entries?: UiPluginCatalogEntry[]; installed?: { id: string; ok: boolean; error?: string }[] }
	| { ok: false; error: string };

type PluginTopbarActionHandler = (
	itemId: string,
	value?: string,
	target?: { id: string; kind?: string; label?: string },
) => void;

interface PluginHostDomAnchors {
	app: Element | null;
	topbar: Element | null;
	composer: Element | null;
}

interface PluginHostConfirmOptions {
	path: string;
}

interface PluginHostDialogSelectOption {
	label: string;
	description?: string;
}

interface PluginHostDialogSelectOptions {
	title: string;
	options: PluginHostDialogSelectOption[];
	multi?: boolean;
}

interface PluginHostDialogConfirmOptions {
	title: string;
	detail?: string;
}

interface PluginHostDialogInputOptions {
	title: string;
	placeholder?: string;
	initial?: string;
}

interface PluginHostNotifyActionItem {
	id: string;
	label: string;
}

interface PluginHostNotifyActionOptions {
	text: string;
	actions: PluginHostNotifyActionItem[];
}

interface PluginHostSearchResultItem {
	title: string;
	hint?: string;
	action: string;
}

interface PluginHostSearchProvider {
	id: string;
	label: string;
	search: (q: string) => Promise<PluginHostSearchResultItem[]>;
}

interface PluginHostSearchProviderInfo {
	id: string;
	label: string;
}

interface PluginHostComposerAttachment {
	path: string;
	name?: string;
	mode?: "inline" | "reference" | "lines";
	lines?: { start: number; end: number };
}

interface PluginHostComposerHit {
	title: string;
	hint?: string;
	text?: string;
	attachments?: PluginHostComposerAttachment[];
}

interface PluginHostComposerProvider {
	id: string;
	label: string;
	search: (q: string) => Promise<PluginHostComposerHit[]>;
}

interface PluginHostComposerProviderInfo {
	id: string;
	label: string;
}

export interface PluginHostTtsProvider {
	id: string;
	label: string;
	labelEn?: string;
	play: (params: {
		text: string;
		rate: number;
		voiceURI?: string;
		onStart?: () => void;
		onEnd?: () => void;
		onError?: (err: Error) => void;
	}) => () => void;
	getVoices?: () =>
		Promise<{ voiceURI: string; name: string; lang?: string }[]> | { voiceURI: string; name: string; lang?: string }[];
}

export interface PluginHostTtsProviderInfo {
	supportsRate?: boolean;
	id: string;
	label: string;
	labelEn?: string;
}

type PluginHostThemeHandler = (name: string) => void;
type PluginHostLocaleHandler = (locale: string) => void;
type PluginHostViewHandler = (view: string) => void;
type PluginHostShortcutHandler = () => void;

interface PluginHostApi {
	version: number;
	setView(view: string): void;
	startChat(opts: PluginHostStartChatOptions): boolean;
	models: {
		list(): PluginHostModelInfo[];
		active(): string | null;
		onChange(handler: (modelId: string | null) => void): () => void;
	};
	compose(opts: PluginHostComposeOptions): boolean;
	openSession(opts: PluginHostOpenSessionOptions): Promise<PluginHostOpenSessionResult>;
	sessions: PluginHostSessionsApi;
	listProjects(): string[];
	reloadCatalog(source: string, options?: PluginHostReloadCatalogOptions): Promise<PluginHostReloadCatalogResult>;
	onUiAction(name: string, handler: PluginTopbarActionHandler): () => void;
	openModal(id: string): boolean;
	closeModal(): boolean;
	/**
	 * 往宿主内置底栏状态槽（`host:quota` 等）写一段文本：宿主决定位置与样式，
	 * 插件不占自己的 chip。传 `null` 清除。
	 *
	 * `content.render(container)` 可选：给了它，点这段文字时**宿主**弹跟随浮层并把容器交给插件画内容
	 * （定位 / 翻转 / 跟随 / 点外关闭 / 层级全归宿主，v18 起）。
	 */
	setFooterStatus(
		key: string,
		value: {
			text: string;
			tip?: string;
			action?: string;
			pluginId?: string;
			content?: { render(container: HTMLElement): void | (() => void) };
		} | null,
	): boolean;
	onTopbarAction(name: string, handler: PluginTopbarActionHandler): () => void;
	pageCall(opts: PluginHostPageCallOptions): Promise<PluginHostPageResult>;
	pickDirectory(opts?: PluginHostPickDirectoryOptions): Promise<PluginHostPickDirectoryResult>;
	pickModel(opts?: PluginHostPickModelOptions): Promise<PluginHostPickModelResult>;
	dom: {
		anchors(): PluginHostDomAnchors;
	};
	dialogs: {
		select(opts: PluginHostDialogSelectOptions): Promise<{ ok: boolean; selected?: string[]; error?: string }>;
		confirm(opts: PluginHostDialogConfirmOptions): Promise<boolean>;
		input(opts: PluginHostDialogInputOptions): Promise<{ ok: boolean; value?: string }>;
	};
	notifyAction(opts: PluginHostNotifyActionOptions): Promise<string | null>;
	shortcuts: {
		register(shortcut: string, handler: PluginHostShortcutHandler): () => void;
	};
	searchProviders: {
		register(provider: PluginHostSearchProvider): () => void;
		list(): PluginHostSearchProviderInfo[];
	};
	composerProviders: {
		register(provider: PluginHostComposerProvider): () => void;
		list(): PluginHostComposerProviderInfo[];
	};
	ttsProviders: {
		list(): PluginHostTtsProviderInfo[];
	};
	openImagePreview(target: ImageLightboxTarget): boolean;
	imageOcrProviders: {
		register(provider: ImageOcrProvider): () => void;
		list(): { id: string; label: string; labelEn?: string }[];
	};
	onTheme(handler: PluginHostThemeHandler): () => void;
	onLocale(handler: PluginHostLocaleHandler): () => void;
	onViewChange(handler: PluginHostViewHandler): () => void;
	openFileContextMenu?(opts: PluginHostFileContextMenuOptions): void;
	setCostFormatter(formatter: CostFormatter | null): () => void;
	setCostCurrency(symbol: string | null | undefined): void;
	getCostCurrency(): string;
}

interface PluginHostPageCallOptions {
	op: string;
	args?: Record<string, unknown>;
	target?: string;
	timeoutMs?: number;
}

type PluginHostPageResult = { ok: true; result?: unknown } | { ok: false; error: string };

interface PageBridgeLike {
	call(req: { op: string; args?: unknown; to?: string; timeoutMs?: number }): Promise<unknown>;
}

export interface PluginHostFileContextMenuOptions {
	x: number;
	y: number;
	path: string;
	kind?: "file" | "dir" | "list";
	label?: string;
	onHostAction?: (actionId: string, target: { id: string; kind?: string; label?: string }) => void | boolean;
}

interface PluginHostDeps {
	send: AppSend;
	isReady: () => boolean;
	setView: (view: string) => void;
	getCwd: () => string;
	getWorkspaceRoots: () => string[];
	listModels?: () => PluginHostModelInfo[];
	getCurrentModelId?: () => string | null;
	listSessions: () => PluginHostSessionInfo[];
	getConversationId: () => string | null;
	getConversationOwner?: () => string | null;
	isConversationBlank: () => boolean;
	pollMs?: number;
	timeoutMs?: number;
	bridgeWaitMs?: number;
	listProjects?: () => string[];
	grantedPaths?: (pluginId?: string) => string[];
	grantPath?: (path: string, pluginId?: string) => void;
	confirm?: (opts: PluginHostConfirmOptions) => Promise<boolean>;
	dialogConfirm?: (opts: PluginHostDialogConfirmOptions) => Promise<boolean>;
	select?: (opts: PluginHostDialogSelectOptions) => Promise<{ ok: boolean; selected?: string[]; error?: string }>;
	input?: (opts: PluginHostDialogInputOptions) => Promise<{ ok: boolean; value?: string }>;
	notifyAction?: (opts: PluginHostNotifyActionOptions) => Promise<string | null>;
	loadPluginBundle?: (pluginId: string) => Promise<boolean>;
	openModal?: (id: string) => boolean;
	closeModal?: () => void;
	setFooterStatus?: (
		key: string,
		value: {
			text: string;
			tip?: string;
			action?: string;
			pluginId?: string;
			content?: { render(container: HTMLElement): void | (() => void) };
		} | null,
	) => boolean;
	openFileContextMenu?: (opts: PluginHostFileContextMenuOptions) => void;
	pickDirectory?: (opts?: PluginHostPickDirectoryOptions) => Promise<PluginHostPickDirectoryResult>;
	pickModel?: (opts?: PluginHostPickModelOptions) => Promise<PluginHostPickModelResult>;
	catalogTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForPageBridge(timeoutMs = 3000): Promise<PageBridgeLike | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const bridge = (window as unknown as { __piBridge?: PageBridgeLike }).__piBridge;
		if (bridge && typeof bridge.call === "function") return bridge;
		if (Date.now() >= deadline) return null;
		await sleep(100);
	}
}

let startChatGate: Promise<void> = Promise.resolve();
let startChatPending = 0;

export function createPluginHostApi(deps: PluginHostDeps): PluginHostApi {
	const pollMs = Math.max(1, Number(deps.pollMs ?? 100));
	const timeoutMs = Math.max(pollMs, Number(deps.timeoutMs ?? 8000));

	const waitFor = async (ok: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (ok()) return true;
			if (Date.now() >= deadline) return ok();
			await sleep(pollMs);
		}
	};

	const listModels = (): PluginHostModelInfo[] => {
		try {
			const raw = deps.listModels?.() ?? [];
			return Array.isArray(raw) ? [...raw] : [];
		} catch {
			return [];
		}
	};

	const isKnownModel = (model: string): boolean => {
		if (!model) return true;
		try {
			return listModels().some((m) => m && m.id === model);
		} catch {
			return false;
		}
	};

	const applyModel = async (model: string): Promise<void> => {
		if (!model) return;
		deps.send({ type: "set_model", modelId: model });
		if (typeof deps.getCurrentModelId === "function") {
			await waitFor(() => deps.getCurrentModelId?.() === model);
		}
	};

	const run = async (prompt: string, opts: PluginHostStartChatOptions): Promise<boolean> => {
		const cwd = String(opts.cwd ?? "").trim();
		if (cwd && deps.getCwd() !== cwd) {
			if (!deps.send({ type: "set_cwd", path: cwd })) return false;
			if (!(await waitFor(() => deps.getCwd() === cwd))) return false;
		}
		if (!deps.isReady()) return false;
		const sessionId = opts.newChat !== false ? await requestNewChat(deps.send, timeoutMs) : deps.getConversationId();
		if (opts.newChat !== false && sessionId && !(await waitFor(() => deps.getConversationId() === sessionId)))
			return false;
		if (!sessionId || !deps.isReady()) return false;
		const model = String(opts.model ?? "").trim();
		if (model) await applyModel(model);
		if (!deps.isReady() || deps.getConversationId() !== sessionId || (cwd && deps.getCwd() !== cwd)) return false;
		deps.setView("chat");
		return deps.send({ type: "prompt", text: prompt, targetConversationId: sessionId });
	};

	return {
		version: PLUGIN_HOST_API_VERSION,
		setView(view) {
			const v = String(view ?? "").trim();
			if (v) deps.setView(v);
		},
		startChat(opts) {
			const prompt = String(opts?.prompt ?? "").trim();
			if (!prompt) return false;
			if (!deps.isReady()) return false;
			const model = String(opts?.model ?? "").trim();
			if (model && !isKnownModel(model)) return false;
			const exec = async (): Promise<void> => {
				let ok = false;
				try {
					ok = await run(prompt, opts ?? { prompt });
				} finally {
					try {
						opts?.onResult?.(ok);
					} catch {}
				}
			};
			let task: Promise<void>;
			if (startChatPending > 0) {
				task = startChatGate.then(exec);
			} else {
				task = exec();
			}
			startChatPending++;
			startChatGate = task.then(
				() => {
					startChatPending--;
				},
				() => {
					startChatPending--;
				},
			);
			void task.catch(() => {});
			return true;
		},
		models: {
			list: () => listModels(),
			active: () => deps.getCurrentModelId?.() ?? null,
			onChange: (handler: (modelId: string | null) => void) => onModelChange(handler),
		},
		compose(opts) {
			if (!isComposerReady()) return false;
			return composeToComposer({
				text: typeof opts?.text === "string" ? opts.text : undefined,
				attachments: Array.isArray(opts?.attachments) ? opts.attachments : undefined,
			});
		},
		openModal(id) {
			const target = String(id ?? "").trim();
			if (!target || typeof deps.openModal !== "function") return false;
			try {
				return deps.openModal(target);
			} catch {
				return false;
			}
		},
		setFooterStatus(key, value) {
			if (typeof deps.setFooterStatus !== "function") return false;
			try {
				return deps.setFooterStatus(String(key ?? ""), value);
			} catch {
				return false;
			}
		},
		closeModal() {
			if (typeof deps.closeModal !== "function") return true;
			try {
				deps.closeModal();
			} catch {}
			return true;
		},
		async openSession(opts) {
			const caller = pluginApiCaller;
			const folders = Array.isArray(opts?.folders)
				? opts.folders.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
				: [];
			const extra = Array.isArray(opts?.roots)
				? opts.roots.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
				: [];
			const explicit = String(opts?.cwd ?? "").trim();
			const all = [...new Set([...folders, ...extra])];
			const target = explicit || all[0] || "";
			if (!target) return { ok: false, error: "openSession 需要 cwd / folders / roots（绝对路径）" };
			if (!deps.isReady()) return { ok: false, error: "尚未连接到服务器（还没有快照）" };
			const roots = all.filter((p) => p !== target).slice(0, 7);
			const known = new Set([...(deps.listProjects?.() ?? []), ...(deps.grantedPaths?.(caller) ?? [])]);
			for (const p of [target, ...roots]) {
				if (known.has(p)) continue;
				const approved = deps.confirm ? await deps.confirm({ path: p }).catch(() => false) : false;
				if (!approved) return { ok: false, error: `用户拒绝了该目录的访问：${p}` };
				deps.grantPath?.(p, caller);
			}
			if (deps.getCwd() !== target) {
				deps.send({ type: "set_cwd", path: target });
				const arrived = await waitFor(() => deps.getCwd() === target);
				if (!arrived) return { ok: false, error: `切换工作目录失败或超时：${target}` };
			}
			if (roots.length > 0 || deps.getWorkspaceRoots().length > 0) {
				deps.send({ type: "set_workspace_roots", roots });
			}
			let sessionId = deps.getConversationId() ?? undefined;
			if (opts?.newChat !== false) {
				sessionId = (await requestNewChat(deps.send, timeoutMs)) ?? undefined;
				if (!sessionId || !(await waitFor(() => deps.getConversationId() === sessionId)))
					return { ok: false, error: "Conversation creation failed or timed out" };
			}
			const model = String(opts?.model ?? "").trim();
			if (model) {
				if (!isKnownModel(model)) return { ok: false, error: `未知模型：${model}（先调 models.list() 取可用列表）` };
				await applyModel(model);
				if (deps.getConversationId() !== sessionId) return { ok: false, error: "Conversation changed" };
			}
			const prompt = String(opts?.prompt ?? "").trim();
			if (!sessionId || !deps.isReady()) return { ok: false, error: "Conversation unavailable" };
			if (prompt) {
				deps.setView("chat");
				deps.send({ type: "prompt", text: prompt, targetConversationId: sessionId });
			}
			return { ok: true, ...(sessionId ? { sessionId } : {}) };
		},
		sessions: {
			list: () => deps.listSessions(),
			async open(id) {
				const caller = pluginApiCaller;
				const targetId = String(id ?? "").trim();
				if (!targetId) return { ok: false, error: "sessions.open 需要一个会话 id（先调 list）" };
				if (!deps.isReady()) return { ok: false, error: "尚未连接到服务器（还没有快照）" };
				const info = deps.listSessions().find((s) => s.id === targetId);
				if (!info) return { ok: false, error: `找不到会话：${targetId}` };
				if (info.cwd && info.cwd !== deps.getCwd()) {
					const known = new Set([...(deps.listProjects?.() ?? []), ...(deps.grantedPaths?.(caller) ?? [])]);
					if (!known.has(info.cwd)) {
						const approved = deps.confirm ? await deps.confirm({ path: info.cwd }).catch(() => false) : false;
						if (!approved) return { ok: false, error: `用户拒绝了该目录的访问：${info.cwd}` };
						deps.grantPath?.(info.cwd, caller);
					}
					deps.send({ type: "set_cwd", path: info.cwd });
					const arrived = await waitFor(() => deps.getCwd() === info.cwd);
					if (!arrived) return { ok: false, error: `切换工作目录失败或超时：${info.cwd}` };
				}
				const before = deps.getConversationId();
				if (info.kind === "elsewhere" && info.owner) {
					deps.send({
						type: info.independent === false ? "open_shared_conversation" : "take_over_conversation",
						owner: info.owner,
						id: info.conversationId ?? info.id,
					});
					const switched = await waitFor(
						() =>
							deps.getConversationId() === (info.conversationId ?? info.id) &&
							(info.independent !== false || deps.getConversationOwner?.() === info.owner),
					);
					if (!switched) return { ok: false, error: `打开并接入会话超时：${info.title}` };
					return { ok: true, sessionId: deps.getConversationId() ?? undefined };
				}
				if (info.kind === "running") deps.send({ type: "switch_conversation", id: info.id });
				else deps.send({ type: "switch_session", path: info.id });
				const switched = await waitFor(() =>
					info.kind === "running"
						? deps.getConversationId() === info.id && !deps.getConversationOwner?.()
						: deps.getConversationId() !== before,
				);
				if (!switched) return { ok: false, error: `切换会话超时：${info.title}` };
				return { ok: true, sessionId: deps.getConversationId() ?? undefined };
			},
		},
		async reloadCatalog(source, options) {
			const src = String(source ?? "").trim();
			if (!src) return { ok: false, error: "reloadCatalog 需要一个目录来源（http(s) URL 或本地文件路径）" };
			if (!deps.isReady()) return { ok: false, error: "尚未连接到服务器（还没有快照）" };
			const requestId = randomUuid();
			return new Promise<PluginHostReloadCatalogResult>((resolve) => {
				const timer = setTimeout(
					() => {
						pendingCatalogSync.delete(requestId);
						resolve({ ok: false, error: "目录同步超时（服务端未在等待窗口内回执）" });
					},
					Math.max(1000, Number(deps.catalogTimeoutMs ?? 180_000)),
				);
				pendingCatalogSync.set(requestId, (result) => {
					clearTimeout(timer);
					resolve(result);
				});
				deps.send({
					type: "plugin_catalog_sync",
					requestId,
					source: src,
					...(options?.install ? { install: true } : {}),
					...(options?.replace ? { replace: true } : {}),
				});
			});
		},
		onUiAction(name, handler) {
			return registerPluginTopbarAction(pluginScope, String(name ?? "").trim(), handler);
		},
		onTopbarAction(name, handler) {
			return registerPluginTopbarAction(pluginScope, String(name ?? "").trim(), handler);
		},
		async pageCall(opts) {
			const op = String(opts?.op ?? "").trim();
			if (!op) return { ok: false, error: "pageCall 需要一个动作名（op）" };
			const native = (window as unknown as { __piBrowser?: BrowserHostBridge }).__piBrowser;
			if (native?.version === 1 && typeof native.pageCall === "function") {
				try {
					return await native.pageCall({ ...opts, op, timeoutMs: opts.timeoutMs ?? 30000 });
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			}
			if (isDesktopShell()) {
				return {
					ok: false,
					error:
						"此桌面版尚未提供原生浏览器桥；请升级到支持 AI Browser 的桌面版，或在系统浏览器中使用 page-picker 扩展。/ Native browser bridge unavailable; upgrade the desktop app or use page-picker in a regular browser.",
				};
			}
			const bridge = await waitForPageBridge(deps.bridgeWaitMs ?? 3000);
			if (!bridge) {
				return {
					ok: false,
					error: "浏览器扩展的页面桥没就绪：确认已安装并启用 page-picker 扩展、本页地址已绑定，然后刷新本页",
				};
			}
			try {
				const result = await bridge.call({
					op,
					...(opts.args === undefined ? {} : { args: opts.args }),
					...(opts.target ? { to: opts.target } : {}),
					...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
				});
				return result === undefined ? { ok: true } : { ok: true, result };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
		dom: {
			anchors() {
				const q = (name: string): Element | null => {
					try {
						return document.querySelector(`[data-pi-anchor="${name}"]`);
					} catch {
						return null;
					}
				};
				return { app: q("app"), topbar: q("topbar"), composer: q("composer") };
			},
		},
		dialogs: {
			async select(opts) {
				try {
					const inject = deps.select;
					if (typeof inject !== "function") return { ok: false };
					const rawOptions = Array.isArray(opts?.options) ? opts.options : [];
					const res = await inject({
						title: String(opts?.title ?? ""),
						options: rawOptions
							.filter(
								(o: unknown): o is PluginHostDialogSelectOption =>
									typeof o === "object" && o !== null && typeof (o as { label?: unknown }).label === "string",
							)
							.map((o) => ({
								label: String(o.label),
								...(typeof o.description === "string" ? { description: o.description } : {}),
							})),
						...(opts?.multi ? { multi: true } : {}),
					});
					if (!res || typeof res !== "object" || res.ok !== true) {
						const error =
							res && typeof res === "object" && typeof (res as { error?: unknown }).error === "string"
								? { error: (res as { error: string }).error }
								: {};
						return { ok: false, ...error };
					}
					const selected = Array.isArray(res.selected)
						? res.selected.filter((s): s is string => typeof s === "string")
						: [];
					return { ok: true, selected };
				} catch {
					return { ok: false };
				}
			},
			async confirm(opts) {
				const title = String(opts?.title ?? "");
				const detail = typeof opts?.detail === "string" ? opts.detail : "";
				try {
					if (typeof deps.dialogConfirm === "function") {
						try {
							return (await deps.dialogConfirm({ title, ...(detail ? { detail } : {}) })) === true;
						} catch {}
					}
					if (typeof window !== "undefined" && typeof window.confirm === "function") {
						try {
							return window.confirm(detail ? `${title}\n\n${detail}` : title);
						} catch {
							return false;
						}
					}
					return false;
				} catch {
					return false;
				}
			},
			async input(opts) {
				try {
					const inject = deps.input;
					if (typeof inject !== "function") return { ok: false };
					const res = await inject({
						title: String(opts?.title ?? ""),
						...(typeof opts?.placeholder === "string" ? { placeholder: opts.placeholder } : {}),
						...(typeof opts?.initial === "string" ? { initial: opts.initial } : {}),
					});
					if (!res || typeof res !== "object" || res.ok !== true) return { ok: false };
					return typeof res.value === "string" ? { ok: true, value: res.value } : { ok: true };
				} catch {
					return { ok: false };
				}
			},
		},
		async notifyAction(opts) {
			const text = String(opts?.text ?? "");
			const actions = (Array.isArray(opts?.actions) ? opts.actions : []).filter(
				(a): a is PluginHostNotifyActionItem =>
					typeof a === "object" &&
					a !== null &&
					typeof (a as { id?: unknown }).id === "string" &&
					typeof (a as { label?: unknown }).label === "string",
			);
			try {
				if (typeof deps.notifyAction === "function") {
					const picked = await deps.notifyAction({ text, actions });
					return typeof picked === "string" ? picked : null;
				}
			} catch {
				return null;
			}
			try {
				if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
					window.dispatchEvent(new CustomEvent(PLUGIN_TOAST_EVENT, { detail: { text } }));
				}
			} catch {}
			return null;
		},
		shortcuts: {
			register: (shortcut, handler) => registerPluginShortcut(String(shortcut ?? ""), handler),
		},
		searchProviders: {
			register: (provider) => registerPluginSearchProvider(provider),
			list: () => listPluginSearchProviders(),
		},
		composerProviders: {
			register: (provider) => registerPluginComposerProvider(provider),
			list: () => listPluginComposerProviders(),
		},
		ttsProviders: {
			list: () => listPluginTtsProviders(),
		},
		openImagePreview: openImageLightbox,
		imageOcrProviders: {
			register: (provider) => registerImageOcrProvider(provider, pluginScope),
			list: () => listImageOcrProviders().map(({ id, label, labelEn }) => ({ id, label, labelEn })),
		},
		onTheme: (handler) => subscribePluginHostTheme(handler),
		onLocale: (handler) => subscribePluginHostLocale(handler),
		onViewChange: (handler) => subscribePluginHostView(handler),
		listProjects: () => deps.listProjects?.() ?? [],
		pickDirectory: (opts) =>
			deps.pickDirectory ? deps.pickDirectory(opts) : Promise.resolve({ ok: false, canceled: true }),
		pickModel: (opts) => (deps.pickModel ? deps.pickModel(opts) : Promise.resolve({ ok: false, canceled: true })),
		openFileContextMenu: (opts) => deps.openFileContextMenu?.(opts),
		setCostFormatter: (formatter) => registerCostFormatter(formatter),
		setCostCurrency: (symbol) => setCostCurrencySymbol(symbol),
		getCostCurrency: () => getCostCurrencySymbol(),
	};
}

export function installPluginHostApi(api: PluginHostApi | null): void {
	try {
		const w = window as unknown as Record<string, unknown>;
		if (api) w[PLUGIN_HOST_GLOBAL] = api;
		else delete w[PLUGIN_HOST_GLOBAL];
	} catch {}
}

const topbarHandlers = new Map<string, Set<PluginTopbarActionHandler>>();

let pluginScope: string | null = null;

export async function withPluginScopeAsync<T>(pluginId: string | null, fn: () => Promise<T>): Promise<T> {
	const prev = pluginScope;
	pluginScope = pluginId;
	try {
		return await fn();
	} finally {
		pluginScope = prev;
	}
}

let pluginApiCaller: string | undefined = undefined;

function withPluginApiCaller<T>(pluginId: string, fn: () => T): T {
	const prev = pluginApiCaller;
	pluginApiCaller = pluginId;
	try {
		return fn();
	} finally {
		pluginApiCaller = prev;
	}
}

function registerPluginTopbarAction(
	pluginId: string | null,
	name: string,
	handler: PluginTopbarActionHandler,
): () => void {
	if (!name || typeof handler !== "function") return () => {};
	const key = pluginId ? `${pluginId}:${name}` : name;
	let set = topbarHandlers.get(key);
	if (!set) {
		set = new Set();
		topbarHandlers.set(key, set);
	}
	const bucket = set;
	bucket.add(handler);
	return () => {
		bucket.delete(handler);
		if (bucket.size === 0) topbarHandlers.delete(key);
	};
}

export async function triggerPluginUiAction(
	pluginId: string,
	action: string,
	itemId: string,
	opts?: {
		loadBundle?: (pluginId: string) => Promise<boolean>;
		waitMs?: number;
		value?: string;
		target?: { id: string; kind?: string; label?: string };
	},
): Promise<boolean> {
	const fire = (key: string): boolean => {
		const set = topbarHandlers.get(key);
		if (!set || set.size === 0) return false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot：handler 可能在回调里注销自己
		for (const h of [...set]) {
			try {
				withPluginApiCaller(pluginId, () => h(itemId, opts?.value, opts?.target));
			} catch (err) {
				console.error(`[plugin:${pluginId}] 顶栏动作 ${action} 抛错:`, err);
			}
		}
		return true;
	};
	if (fire(`${pluginId}:${action}`) || fire(action)) return true;
	if (opts?.loadBundle) {
		const ok = await opts.loadBundle(pluginId).catch(() => false);
		if (ok) {
			const deadline = Date.now() + Math.max(100, Number(opts.waitMs ?? 1500));
			for (;;) {
				if (fire(`${pluginId}:${action}`) || fire(action)) return true;
				if (Date.now() >= deadline) break;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	}
	return false;
}

const PLUGIN_TOAST_EVENT = "pi-web-ui:toast";

const shortcutHandlers = new Map<string, Set<PluginHostShortcutHandler>>();
let shortcutListenerOn = false;

function parseShortcut(
	raw: string,
): { combo: string; key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } | null {
	const parts = raw
		.split("+")
		.map((p) => p.trim().toLowerCase())
		.filter((p) => p.length > 0);
	if (parts.length === 0) return null;
	let ctrl = false;
	let shift = false;
	let alt = false;
	let meta = false;
	for (const p of parts.slice(0, -1)) {
		if (p === "ctrl" || p === "control") ctrl = true;
		else if (p === "shift") shift = true;
		else if (p === "alt" || p === "option") alt = true;
		else if (p === "meta" || p === "cmd" || p === "command" || p === "win" || p === "super") meta = true;
		else return null;
	}
	const key = parts[parts.length - 1] ?? "";
	if (!key || ["ctrl", "control", "shift", "alt", "option", "meta", "cmd", "command", "win", "super"].includes(key)) {
		return null;
	}
	const combo = `${ctrl ? "ctrl+" : ""}${shift ? "shift+" : ""}${alt ? "alt+" : ""}${meta ? "meta+" : ""}${key}`;
	return { combo, key, ctrl, shift, alt, meta };
}

function isTypingFocus(): boolean {
	try {
		if (typeof document === "undefined") return false;
		const el = document.activeElement as HTMLElement | null;
		if (!el) return false;
		const tag = (el.tagName || "").toUpperCase();
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		if (el.isContentEditable) return true;
		return false;
	} catch {
		return false;
	}
}

function onShortcutKeyDown(e: KeyboardEvent): void {
	try {
		if (isTypingFocus()) return;
		const combo = `${e.ctrlKey ? "ctrl+" : ""}${e.shiftKey ? "shift+" : ""}${e.altKey ? "alt+" : ""}${e.metaKey ? "meta+" : ""}${(e.key ?? "").toLowerCase()}`;
		const set = shortcutHandlers.get(combo);
		if (!set || set.size === 0) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot：handler 可能在回调里注销自己
		for (const h of [...set]) {
			try {
				h();
			} catch (err) {
				console.error("[plugin-host] 快捷键处理器抛错:", err);
			}
		}
	} catch {}
}

function ensureShortcutListener(): void {
	if (shortcutListenerOn) return;
	try {
		if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
		window.addEventListener("keydown", onShortcutKeyDown as EventListener);
		shortcutListenerOn = true;
	} catch {}
}

function maybeDropShortcutListener(): void {
	if (shortcutHandlers.size > 0 || !shortcutListenerOn) return;
	try {
		window.removeEventListener("keydown", onShortcutKeyDown as EventListener);
	} catch {
	} finally {
		shortcutListenerOn = false;
	}
}

function registerPluginShortcut(shortcut: string, handler: PluginHostShortcutHandler): () => void {
	if (typeof handler !== "function") return () => {};
	const parsed = parseShortcut(shortcut);
	if (!parsed) return () => {};
	let set = shortcutHandlers.get(parsed.combo);
	if (!set) {
		set = new Set();
		shortcutHandlers.set(parsed.combo, set);
	}
	const bucket = set;
	bucket.add(handler);
	ensureShortcutListener();
	return () => {
		bucket.delete(handler);
		if (bucket.size === 0) shortcutHandlers.delete(parsed.combo);
		maybeDropShortcutListener();
	};
}

const searchProviderRegistry = new Map<string, PluginHostSearchProvider>();

function registerPluginSearchProvider(provider: PluginHostSearchProvider): () => void {
	const id = String(provider?.id ?? "").trim();
	if (!id || typeof provider?.search !== "function") return () => {};
	const stored: PluginHostSearchProvider = { id, label: String(provider.label ?? id), search: provider.search };
	searchProviderRegistry.set(id, stored);
	return () => {
		if (searchProviderRegistry.get(id) === stored) searchProviderRegistry.delete(id);
	};
}

export function listPluginSearchProviders(): PluginHostSearchProviderInfo[] {
	return [...searchProviderRegistry.values()].map((p) => ({ id: p.id, label: p.label }));
}

const composerProviderRegistry = new Map<string, PluginHostComposerProvider>();

function registerPluginComposerProvider(provider: PluginHostComposerProvider): () => void {
	const id = String(provider?.id ?? "").trim();
	if (!id || typeof provider?.search !== "function") return () => {};
	const stored: PluginHostComposerProvider = { id, label: String(provider.label ?? id), search: provider.search };
	composerProviderRegistry.set(id, stored);
	return () => {
		if (composerProviderRegistry.get(id) === stored) composerProviderRegistry.delete(id);
	};
}

export function listPluginComposerProviders(): PluginHostComposerProviderInfo[] {
	return [...composerProviderRegistry.values()].map((p) => ({ id: p.id, label: p.label }));
}

export function getPluginComposerProvider(id: string): PluginHostComposerProvider | undefined {
	return composerProviderRegistry.get(String(id ?? ""));
}

export function getPluginSearchProvider(id: string): PluginHostSearchProvider | undefined {
	return searchProviderRegistry.get(String(id ?? ""));
}

const themeListeners = new Set<PluginHostThemeHandler>();
const localeListeners = new Set<PluginHostLocaleHandler>();
const viewListeners = new Set<PluginHostViewHandler>();
const modelListeners = new Set<(modelId: string | null) => void>();

function onModelChange(handler: (modelId: string | null) => void): () => void {
	modelListeners.add(handler);
	return () => {
		modelListeners.delete(handler);
	};
}

export function emitPluginHostModel(modelId: string | null): void {
	for (const h of modelListeners) {
		try {
			h(modelId);
		} catch (err) {
			console.error("[plugin-host] onModelChange 处理器抛错:", err);
		}
	}
}

function subscribePluginHostTheme(handler: PluginHostThemeHandler): () => void {
	if (typeof handler !== "function") return () => {};
	themeListeners.add(handler);
	return () => {
		themeListeners.delete(handler);
	};
}

function subscribePluginHostLocale(handler: PluginHostLocaleHandler): () => void {
	if (typeof handler !== "function") return () => {};
	localeListeners.add(handler);
	return () => {
		localeListeners.delete(handler);
	};
}

function subscribePluginHostView(handler: PluginHostViewHandler): () => void {
	if (typeof handler !== "function") return () => {};
	viewListeners.add(handler);
	return () => {
		viewListeners.delete(handler);
	};
}

export function emitPluginHostTheme(name: string): void {
	const n = String(name ?? "");
	for (const h of themeListeners) {
		try {
			h(n);
		} catch (err) {
			console.error("[plugin-host] onTheme 处理器抛错:", err);
		}
	}
}

export function emitPluginHostLocale(locale: string): void {
	const l = String(locale ?? "");
	for (const h of localeListeners) {
		try {
			h(l);
		} catch (err) {
			console.error("[plugin-host] onLocale 处理器抛错:", err);
		}
	}
}

export function emitPluginHostView(view: string): void {
	const v = String(view ?? "");
	for (const h of viewListeners) {
		try {
			h(v);
		} catch (err) {
			console.error("[plugin-host] onViewChange 处理器抛错:", err);
		}
	}
}

type CatalogSyncResolver = (result: PluginHostReloadCatalogResult) => void;
const pendingCatalogSync = new Map<string, CatalogSyncResolver>();

export function resolveCatalogSyncResult(msg: {
	requestId: string;
	ok: boolean;
	error?: string;
	entries?: UiPluginCatalogEntry[];
	installed?: { id: string; ok: boolean; error?: string }[];
}): void {
	const resolve = pendingCatalogSync.get(msg.requestId);
	if (!resolve) return;
	pendingCatalogSync.delete(msg.requestId);
	if (!msg.ok) {
		resolve({ ok: false, error: msg.error ?? "目录同步失败" });
		return;
	}
	resolve({
		ok: true,
		...(msg.entries ? { entries: msg.entries } : {}),
		...(msg.installed ? { installed: msg.installed } : {}),
	});
}
