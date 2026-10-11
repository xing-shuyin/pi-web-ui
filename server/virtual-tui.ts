import {
	CURSOR_MARKER,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type Terminal,
} from "@earendil-works/pi-tui";

export { CURSOR_MARKER };

/**
 * Extract CURSOR_MARKER from rendered lines, calculate row and visual column,
 * and strip the marker from lines. Returns cursor position if found.
 */
export function extractCursorPosition(lines: string[]): { row: number; col: number } | null {
	for (let row = 0; row < lines.length; row++) {
		const line = lines[row];
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex !== -1) {
			const beforeMarker = line.slice(0, markerIndex);
			const col = visibleWidth(beforeMarker);
			lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
			return { row, col };
		}
	}
	return null;
}

/**
 * Format rendered component lines into a flicker-free ANSI screen frame for xterm.js.
 * \x1b[H resets cursor to top-left, \x1b[?25l hides cursor during paint,
 * \x1b[K clears line trail, \x1b[J clears below content,
 * and hardware cursor is restored if CURSOR_MARKER was emitted.
 */
export function formatAnsiScreen(rawLines: string[], _cols: number, _rows?: number): string {
	const lines = [...rawLines];
	const cursor = extractCursorPosition(lines);

	// Move cursor to (1,1), hide cursor during line updates, clear each line tail,
	// and clear any remaining lines below viewport.
	let out = "\x1b[H\x1b[?25l";
	out += lines.map((l) => l + "\x1b[K").join("\r\n");
	out += "\x1b[J";

	if (cursor) {
		out += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
	} else {
		out += "\x1b[?25l";
	}
	return out;
}

/**
 * Minimal in-memory Terminal interface for driving TUI components without an OS PTY.
 */
export class VirtualTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;

	private onInputCb?: (data: string) => void;
	private onResizeCb?: () => void;
	private directWrites: string[] = [];
	private onWriteCb?: (data: string) => void;

	constructor(cols = 80, rows = 24, onWrite?: (data: string) => void) {
		this.columns = cols;
		this.rows = rows;
		this.onWriteCb = onWrite;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInputCb = onInput;
		this.onResizeCb = onResize;
	}

	stop(): void {}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.directWrites.push(data);
		this.onWriteCb?.(data);
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	feedInput(data: string): void {
		this.onInputCb?.(data);
	}

	resize(cols: number, rows: number): void {
		if (this.columns === cols && this.rows === rows) return;
		this.columns = cols;
		this.rows = rows;
		this.onResizeCb?.();
	}

	takeDirectWrites(): string {
		const out = this.directWrites.join("");
		this.directWrites = [];
		return out;
	}
}

export interface VirtualTuiBridgeOptions {
	id: number;
	cols?: number;
	rows?: number;
	title?: string;
	onRender: (ansi: string) => void;
	onClose: () => void;
}

/**
 * Bridges a single `ctx.ui.custom()` component to the web client via WebSocket.
 */
export class VirtualTuiBridge<T = unknown> {
	readonly id: number;
	readonly title?: string;
	readonly terminal: VirtualTerminal;
	readonly keybindings: KeybindingsManager;

	private component?: Component & { dispose?(): void };
	private closed = false;
	private onRenderCb: (ansi: string) => void;
	private onCloseCb: () => void;
	private resolvePromise!: (result: T) => void;
	private rejectPromise!: (err: unknown) => void;
	readonly promise: Promise<T>;
	private renderScheduled = false;

	constructor(options: VirtualTuiBridgeOptions) {
		this.id = options.id;
		this.title = options.title;
		this.onRenderCb = options.onRender;
		this.onCloseCb = options.onClose;
		this.terminal = new VirtualTerminal(options.cols ?? 80, options.rows ?? 24, (data) => {
			if (!this.closed) {
				this.onRenderCb(data);
			}
		});
		this.keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		this.promise = new Promise<T>((resolve, reject) => {
			this.resolvePromise = resolve;
			this.rejectPromise = reject;
		});
	}

	get cols(): number {
		return this.terminal.columns;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Create the TUI facade expected by ExtensionUIContext.custom() factories. */
	createTuiFacade() {
		return {
			terminal: this.terminal,
			mode: "fullscreen" as const,
			requestRender: () => this.requestRender(),
			renderNow: () => this.renderNow(),
			setFocus: (_comp: Component | null) => {},
			getFocusedComponent: () => this.component ?? null,
			showOverlay: (_comp: Component, _opts?: OverlayOptions): OverlayHandle => this.createOverlayHandle(),
			hideOverlay: () => {},
			hasOverlay: () => false,
			invalidate: () => this.component?.invalidate?.(),
			stop: () => this.terminal.stop(),
			start: () => {},
		};
	}

	/** Create OverlayHandle passed to options.onHandle */
	createOverlayHandle(): OverlayHandle {
		return {
			hide: () => this.cancel(),
			setHidden: () => {},
			isHidden: () => false,
			focus: () => {},
			unfocus: () => {},
			isFocused: () => true,
			getBounds: () => ({
				row: 0,
				col: 0,
				width: this.terminal.columns,
				height: this.terminal.rows,
			}),
		};
	}

	setComponent(comp: Component & { dispose?(): void }): void {
		this.component = comp;
	}

	renderNow(): void {
		if (this.closed) return;
		this.renderScheduled = false;
		if (!this.component) return;
		try {
			const lines = this.component.render(this.terminal.columns);
			const ansi = formatAnsiScreen(lines, this.terminal.columns, this.terminal.rows);
			this.onRenderCb(ansi);
		} catch (err) {
			// Best-effort render error protection
			console.error("[virtual-tui] Component render error:", err);
		}
	}

	requestRender(): void {
		if (this.closed || this.renderScheduled) return;
		this.renderScheduled = true;
		queueMicrotask(() => {
			if (this.renderScheduled) {
				this.renderNow();
			}
		});
	}

	getInitialAnsi(): string {
		if (!this.component) return "";
		try {
			const lines = this.component.render(this.terminal.columns);
			return formatAnsiScreen(lines, this.terminal.columns, this.terminal.rows);
		} catch {
			return "";
		}
	}

	feedInput(data: string): void {
		if (this.closed) return;
		try {
			this.component?.handleInput?.(data);
			this.terminal.feedInput(data);
			this.requestRender();
		} catch (err) {
			console.error("[virtual-tui] Component input error:", err);
		}
	}

	resize(cols: number, rows: number): void {
		if (this.closed) return;
		this.terminal.resize(cols, rows);
		this.component?.invalidate?.();
		this.requestRender();
	}

	done(result: T): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.component?.dispose?.();
		} catch {
			// ignore dispose errors
		}
		this.onCloseCb();
		this.resolvePromise(result);
	}

	cancel(): void {
		if (this.closed) return;
		this.done(undefined as unknown as T);
	}

	fail(err: unknown): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.component?.dispose?.();
		} catch {
			// ignore dispose errors
		}
		this.onCloseCb();
		this.rejectPromise(err);
	}
}
