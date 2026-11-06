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

	private tuiOverlaySeq = 0;
	private activeTuiOverlays = new Map<number, VirtualTuiBridge<unknown>>();

	constructor(emit: (msg: ServerMessage) => void, options: { headless?: boolean } = {}) {
		defineThemeAccessor(this);
		this.headless = options.headless === true;
		this.emit = this.headless ? () => {} : emit;
	}

	static headless(): WebUIContext {
		return new WebUIContext(() => {}, { headless: true });
	}

	setDynamicWidget(key: string, lines: () => string[]): void {
		this.widgets.set(key, { render: () => lines() });
		this.lastLines.delete(key);
		this.push();
	}

	setWidget: ExtensionUIContext["setWidget"] = (key, content, options) => {
		void options;
		if (this.headless) return;
		if (content === undefined) {
			this.widgets.delete(key);
			this.lastLines.delete(key);
			this.push();
			return;
		}
		if (typeof content === "function") {
			let comp: { render?: (w: number) => string[] | undefined; dispose?: () => void } | undefined;
			try {
				comp = content(mockTui as never, mockThemeProxy as never) as typeof comp;
			} catch {
				comp = undefined;
			}
			this.widgets.set(key, {
				render: (w) => comp?.render?.(w),
				dispose: comp?.dispose,
			});
		} else {
			this.widgets.set(key, { render: () => content });
		}
		this.push();
	};

	hasWidgets(): boolean {
		return this.widgets.size > 0;
	}

	refresh(): void {
		let changed = false;
		for (const [key, w] of this.widgets) {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const prev = this.lastLines.get(key);
			if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
				this.lastLines.set(key, lines ?? []);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	private push(): void {
		const widgets = this.snapshot();
		this.emit({ type: "widgets", widgets });
	}

	snapshot(): { key: string; lines: string[] }[] {
		return [...this.widgets.entries()].map(([key, w]) => {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const clean = lines?.map(stripAnsi) ?? undefined;
			this.lastLines.set(key, clean ?? []);
			return { key, lines: clean ?? [] };
		});
	}

	notify = (message: string, type?: "info" | "warning" | "error", messageEn?: string): void => {
		this.emit({ type: "notice", level: type ?? "info", text: message, textEn: messageEn });
	};

	private statuses = new Map<string, string>();

	setStatus = (key: string, text: string | undefined): void => {
		if (text === undefined || text === "") {
			this.statuses.delete(key);
		} else {
			const clean = stripAnsi(text);
			if (clean === "") this.statuses.delete(key);
			else this.statuses.set(key, clean);
		}
		this.pushStatuses();
	};

	private pushStatuses(): void {
		this.emit({
			type: "statuses",
			statuses: [...this.statuses.entries()].map(([k, v]) => ({
				key: k,
				text: v,
			})),
		});
	}

	statusSnapshot(): { key: string; text: string | undefined }[] {
		return [...this.statuses.entries()].map(([k, v]) => ({ key: k, text: v }));
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
