import {
	initTheme,
	Theme,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import type { ServerMessage } from "./protocol.js";
import { VirtualTuiBridge } from "./virtual-tui.js";

// Ensure global theme is initialized so extensions calling getSettingsListTheme(),
// getMarkdownTheme(), or touching global `theme` proxy don't throw.
try {
	initTheme("dark", false);
} catch {}

const WIDGET_WIDTH = 80;

const ANSI_RE = /\[[0-9:;<=>?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

export const mockThemeProxy = new Proxy(
	{
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		dim: (text: string) => text,
		getThinkingBorderColor: (_level: string) => (text: string) => text,
		getBashModeBorderColor: () => (text: string) => text,
	},
	{
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			return (...args: unknown[]) => {
				const text = args[args.length - 1];
				return typeof text === "string" ? text : "";
			};
		},
	},
) as unknown as Theme;

const mockTui = new Proxy(
	{
		requestRender: () => {},
		render: () => {},
	},
	{
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			return () => {};
		},
	},
);

interface WidgetEntry {
	render: (width: number) => string[] | undefined;
	dispose?: () => void;
	/** 原始 key（快照下发给前端的那个名字）。 */
	key: string;
	/** 归属会话：null = 全局（内置 markers 这种渲染时自己读当前会话的组件）。 */
	convId: string | null;
}

interface StatusEntry {
	text: string;
	convId: string | null;
}

/** 同一 key 在不同会话里是不同条目，内部 id 用会话前缀区分。 */
function entryId(convId: string | null, key: string): string {
	return `${convId ?? "\u0000global"}\u0000${key}`;
}

function defineThemeAccessor(context: object): void {
	Object.defineProperty(context, "theme", {
		get(): Theme {
			const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
			const current = (globalThis as Record<symbol, unknown>)[key];
			return (current as Theme) ?? mockThemeProxy;
		},
		enumerable: true,
		configurable: true,
	});
}

export class WebUIContext {
	declare readonly theme: Theme;
	private widgets = new Map<string, WidgetEntry>();
	private lastLines = new Map<string, string[]>();
	private emit: (msg: ServerMessage) => void;
	private headless: boolean;
	/** 当前（浏览器正在看的）对话：编辑器 / widget 快照只发这个会话的。 */
	private activeConversationId: () => string | null;
	/** 会话是否还活着：用来在轮询里清掉已关闭对话遗留的 widget（否则跨会话条目只增不减）。 */
	private isConversationAlive: (convId: string) => boolean;
	/**
	 * 前端最后一次被告知的会话（widgets / statuses 任一路推送都会更新）。
	 * 上一次「看过」的会话。切换会话时必须强推一次（哪怕新会话没有任何 widget，
	 * 否则前端会把上一个会话的清单继续挂在面板上）；undefined = 还没跑过第一次 refresh，
	 * 那一次不发消息（启动时 attachSink 会发完整快照，别在空上下文上制造噪音）。
	 */
	private lastSeenConv: string | null | undefined = undefined;

	private tuiOverlaySeq = 0;
	private activeTuiOverlays = new Map<number, VirtualTuiBridge<unknown>>();

	constructor(
		emit: (msg: ServerMessage) => void,
		options: {
			headless?: boolean;
			activeConversationId?: () => string | null;
			isConversationAlive?: (convId: string) => boolean;
		} = {},
	) {
		defineThemeAccessor(this);
		this.headless = options.headless === true;
		this.activeConversationId = options.activeConversationId ?? (() => null);
		this.isConversationAlive = options.isConversationAlive ?? (() => true);
		this.emit = this.headless ? () => {} : emit;
	}

	static headless(): WebUIContext {
		return new WebUIContext(() => {}, { headless: true });
	}

	/** 当前会话 id（空串 = 还没有会话）。 */
	private activeConversation(): string | null {
		const id = this.activeConversationId();
		return id ? id : null;
	}

	/**
	 * 给某个对话的扩展用的 UI 门面：`setWidget` / `setStatus` 打上会话归属，
	 * 快照只发当前会话的（加全局的），切会话不会把上一个会话的 widget 留在面板里。
	 *
	 * 必须是 **own 属性覆盖**而不是 Proxy：SDK 拿到 uiContext 就 `{...ui}` 复制一遍再交给扩展
	 * （`core/extensions/runner.js` 的 `wrapUIPromptContext`），Proxy 的拦截在 spread 后会丢。
	 */
	forConversation(convId: string): ExtensionUIContext {
		return {
			...this,
			setWidget: ((key: string, content: unknown, options?: unknown) =>
				this.mountWidget(convId, key, content, options)) as ExtensionUIContext["setWidget"],
			setStatus: ((key: string, text: string | undefined) =>
				this.mountStatus(convId, key, text)) as ExtensionUIContext["setStatus"],
		} as unknown as ExtensionUIContext;
	}

	/** 内置 widget（markers）：全局条目，每个会话都显示，内容由渲染时自己读当前会话。 */
	setDynamicWidget(key: string, lines: () => string[]): void {
		this.widgets.set(entryId(null, key), { key, convId: null, render: () => lines() });
		this.lastLines.delete(entryId(null, key));
		this.push();
	}

	/**
	 * 根 context 上的 setWidget：扩展通过 `bindExtensions({uiContext})` 之外的路子（如目标向导
	 * 直接拿宿主实例）调用时，归属到**当前会话**。绝不能当全局条目 —— 那正是「上一个对话的清单
	 * 留在面板里」的来源。
	 */
	setWidget: ExtensionUIContext["setWidget"] = (key, content, options) => {
		this.mountWidget(this.activeConversation(), key, content, options);
	};

	private mountWidget(convId: string | null, key: string, content: unknown, options?: unknown): void {
		void options;
		if (this.headless) return;
		const id = entryId(convId, key);
		if (content === undefined) {
			this.widgets.get(id)?.dispose?.();
			this.widgets.delete(id);
			this.lastLines.delete(id);
			this.push();
			return;
		}
		if (typeof content === "function") {
			let comp: { render?: (w: number) => string[] | undefined; dispose?: () => void } | undefined;
			try {
				comp = (content as (tui: unknown, theme: unknown) => unknown)(
					mockTui as never,
					mockThemeProxy as never,
				) as typeof comp;
			} catch {
				comp = undefined;
			}
			this.widgets.get(id)?.dispose?.();
			this.widgets.set(id, { key, convId, render: (w) => comp?.render?.(w), dispose: comp?.dispose });
		} else {
			this.widgets.get(id)?.dispose?.();
			this.widgets.set(id, { key, convId, render: () => content as string[] });
		}
		this.push();
	}

	private mountStatus(convId: string | null, key: string, text: string | undefined): void {
		const id = entryId(convId, key);
		if (text === undefined || text === "") {
			this.statuses.delete(id);
		} else {
			const clean = stripAnsi(text);
			if (clean === "") this.statuses.delete(id);
			else this.statuses.set(id, { text: clean, convId });
		}
		this.pushStatuses();
	}

	/** 只留下当前会话的条目 + 全局条目（别的会话的 widget 不该出现在这一屏）。 */
	private visible<T extends { convId: string | null }>(entries: [string, T][], active: string | null): [string, T][] {
		return entries.filter(([, entry]) => entry.convId === null || entry.convId === active);
	}

	hasWidgets(): boolean {
		return this.widgets.size > 0;
	}

	/**
	 * 2s 轮询 / 切换会话 / 事件后都会调这里：
	 * · 当前会话变了 → 必须推一次（切到没有 widget 的会话也要把面板清空）；
	 * · 顺手清掉已关闭会话遗留的条目（只在有 widget 时才轮询，代价可忽略）。
	 */
	refresh(): void {
		this.pruneClosedConversations();
		const active = this.activeConversation();
		const switched = this.lastSeenConv !== undefined && this.lastSeenConv !== active;
		this.lastSeenConv = active;
		if (switched) {
			// widget 与 status 是两块独立的推送（前端各自一个 state），切换会话两样都得重推一遍
			this.push();
			this.pushStatuses();
			return;
		}
		let changed = false;
		for (const [id, w] of this.visible([...this.widgets.entries()], active)) {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const prev = this.lastLines.get(id);
			if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
				this.lastLines.set(id, lines ?? []);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	private pruneClosedConversations(): void {
		const deadWidgets: string[] = [];
		for (const [id, entry] of this.widgets) {
			if (entry.convId !== null && !this.isConversationAlive(entry.convId)) deadWidgets.push(id);
		}
		for (const id of deadWidgets) {
			try {
				this.widgets.get(id)?.dispose?.();
			} catch {}
			this.widgets.delete(id);
			this.lastLines.delete(id);
		}
		const deadStatuses: string[] = [];
		for (const [id, entry] of this.statuses) {
			if (entry.convId !== null && !this.isConversationAlive(entry.convId)) deadStatuses.push(id);
		}
		for (const id of deadStatuses) this.statuses.delete(id);
	}

	private push(): void {
		this.lastSeenConv = this.activeConversation();
		this.emit({ type: "widgets", widgets: this.snapshot() });
	}

	snapshot(): { key: string; lines: string[] }[] {
		const active = this.activeConversation();
		return this.visible([...this.widgets.entries()], active).map(([id, w]) => {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const clean = lines?.map(stripAnsi) ?? undefined;
			this.lastLines.set(id, clean ?? []);
			return { key: w.key, lines: clean ?? [] };
		});
	}

	notify = (message: string, type?: "info" | "warning" | "error", messageEn?: string): void => {
		this.emit({ type: "notice", level: type ?? "info", text: message, textEn: messageEn });
	};

	private statuses = new Map<string, StatusEntry>();

	setStatus = (key: string, text: string | undefined): void => {
		this.mountStatus(this.activeConversation(), key, text);
	};

	private pushStatuses(): void {
		const active = this.activeConversation();
		// 推送过 statuses 也算「前端看到的是这个会话」，否则切会话时 first-switch 判定会漏一次
		this.lastSeenConv = active;
		this.emit({
			type: "statuses",
			statuses: this.visible([...this.statuses.entries()], active).map(([id, v]) => ({
				key: id.slice(id.lastIndexOf("\u0000") + 1),
				text: v.text,
			})),
		});
	}

	statusSnapshot(): { key: string; text: string | undefined }[] {
		const active = this.activeConversation();
		return this.visible([...this.statuses.entries()], active).map(([id, v]) => ({
			key: id.slice(id.lastIndexOf("\u0000") + 1),
			text: v.text,
		}));
	}

	private dialogSeq = 0;
	private pendingDialogs = new Map<number, (value: string | boolean | null) => void>();

	select = (
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions & { code?: { content: string; language?: string; hasRisk?: boolean } },
	): Promise<string | undefined> =>
		this.openDialog("select", title, [options], opts?.code) as Promise<string | undefined>;
	confirm = (
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions & { code?: { content: string; language?: string; hasRisk?: boolean } },
	): Promise<boolean> => this.openDialog("confirm", title, [message], opts?.code) as Promise<boolean>;
	input = (
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions & { code?: { content: string; language?: string; hasRisk?: boolean } },
	): Promise<string | undefined> =>
		this.openDialog("input", title, [placeholder ?? ""], opts?.code) as Promise<string | undefined>;

	private openDialog(
		kind: "select" | "confirm" | "input",
		title: string,
		args: unknown[],
		code?: { content: string; language?: string; hasRisk?: boolean },
	): Promise<string | boolean | null> {
		if (this.headless) return Promise.resolve(null);
		return new Promise((resolve) => {
			const id = ++this.dialogSeq;
			this.pendingDialogs.set(id, resolve);
			this.emit({ type: "dialog", id, kind, title, args, ...(code ? { code } : {}) });
		});
	}

	resolveDialog(id: number, value: string | boolean | null): void {
		const resolve = this.pendingDialogs.get(id);
		if (resolve) {
			this.pendingDialogs.delete(id);
			resolve(value);
			this.emit({ type: "dialog_closed", id });
		}
	}

	cancelPendingDialogs(): void {
		for (const [id, resolve] of this.pendingDialogs) {
			this.pendingDialogs.delete(id);
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
	}

	custom = async <T>(
		factory: (
			tui: any,
			theme: Theme,
			keybindings: any,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> => {
		if (this.headless) {
			options?.onHandle?.({
				hide: () => {},
				setHidden: () => {},
				isHidden: () => false,
				focus: () => {},
				unfocus: () => {},
				isFocused: () => false,
				getBounds: () => undefined,
			});
			return Promise.resolve(undefined as unknown as T);
		}

		const id = ++this.tuiOverlaySeq;
		const bridge = new VirtualTuiBridge<T>({
			id,
			onRender: (ansi) => {
				this.emit({ type: "tui_overlay_render", id, ansi });
			},
			onClose: () => {
				this.activeTuiOverlays.delete(id);
				this.emit({ type: "tui_overlay_close", id });
			},
		});

		this.activeTuiOverlays.set(id, bridge as VirtualTuiBridge<unknown>);
		if (options?.onHandle) {
			options.onHandle(bridge.createOverlayHandle());
		}

		try {
			const compResult = factory(bridge.createTuiFacade(), this.theme, bridge.keybindings, (result) =>
				bridge.done(result),
			);
			const comp = compResult instanceof Promise ? await compResult : compResult;
			if (comp) {
				bridge.setComponent(comp);
			}
			if (!bridge.isClosed) {
				this.emit({
					type: "tui_overlay_open",
					id,
					cols: bridge.cols,
					rows: bridge.rows,
					initialAnsi: bridge.getInitialAnsi(),
				});
			}
		} catch (err) {
			bridge.fail(err);
		}

		return bridge.promise;
	};

	handleTuiOverlayInput(id: number, data: string): void {
		const bridge = this.activeTuiOverlays.get(id);
		bridge?.feedInput(data);
	}

	handleTuiOverlayResize(id: number, cols: number, rows: number): void {
		const bridge = this.activeTuiOverlays.get(id);
		bridge?.resize(cols, rows);
	}

	handleTuiOverlayCancel(id: number): void {
		const bridge = this.activeTuiOverlays.get(id);
		bridge?.cancel();
	}

	onTerminalInput = (): (() => void) => () => {};
	setWorkingMessage = (): void => {};
	setWorkingVisible = (): void => {};
	setWorkingIndicator = (): void => {};
	setHiddenThinkingLabel = (): void => {};
	setFooter = (): void => {};
	setHeader = (): void => {};
	setTitle = (): void => {};
	pasteToEditor = (): void => {};
	setEditorText = (): void => {};
	getEditorText = (): string => "";
	editor = async (): Promise<string | undefined> => undefined;
	addAutocompleteProvider = (): void => {};
	setEditorComponent = (): void => {};
	getEditorComponent = (): undefined => undefined;
	getAllThemes = (): { name: string; path: string | undefined }[] => [];
	getTheme = (_name: string): Theme | undefined => undefined;
	setTheme = (themeOrName: string | Theme): { success: boolean; error?: string } => {
		try {
			const name = typeof themeOrName === "string" ? themeOrName : themeOrName.name;
			if (name) {
				initTheme(name, false);
				return { success: true };
			}
			return { success: false, error: "Theme name missing" };
		} catch (err) {
			return { success: false, error: (err as Error).message };
		}
	};
	getToolsExpanded = (): boolean => false;
	setToolsExpanded = (): void => {};

	dispose(): void {
		for (const w of this.widgets.values()) {
			try {
				w.dispose?.();
			} catch {}
		}
		this.widgets.clear();
		this.lastLines.clear();
		for (const [id, resolve] of this.pendingDialogs) {
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
		this.pendingDialogs.clear();
		for (const bridge of this.activeTuiOverlays.values()) {
			bridge.cancel();
		}
		this.activeTuiOverlays.clear();
	}
}
