import { describe, expect, it } from "vitest";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	formatAnsiScreen,
	extractCursorPosition,
	VirtualTerminal,
	VirtualTuiBridge,
} from "../../server/virtual-tui.js";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("TUI Theme and Affordances (Issue #588)", () => {
	it("global theme is initialized so getSettingsListTheme() does not throw", () => {
		// In Issue #588, calling getSettingsListTheme() threw 'Theme not initialized. Call initTheme() first.'
		expect(() => getSettingsListTheme()).not.toThrow();
		const listTheme = getSettingsListTheme();
		expect(listTheme).toBeDefined();
		expect(typeof listTheme.cursor).toBe("string");
		expect(typeof listTheme.label).toBe("function");
	});

	it("WebUIContext.theme provides color and formatting helpers", () => {
		const ui = new WebUIContext(() => {});
		expect(ui.theme).toBeDefined();
		expect(typeof ui.theme.fg).toBe("function");
		const colored = ui.theme.fg("accent", "test");
		expect(typeof colored).toBe("string");
		expect(colored.length).toBeGreaterThan(0);
	});

	it("WebUIContext provides theme query and list methods", () => {
		const ui = new WebUIContext(() => {});
		const themes = ui.getAllThemes();
		expect(Array.isArray(themes)).toBe(true);
	});
});

describe("VirtualTerminal & ANSI Screen Formatting", () => {
	it("extracts CURSOR_MARKER and accurately computes cursor position", () => {
		const lines = ["Line 1", `Line 2 with ${CURSOR_MARKER}cursor`, "Line 3"];
		const pos = extractCursorPosition(lines);
		expect(pos).toEqual({ row: 1, col: 12 });
		// Marker should be stripped from the line
		expect(lines[1]).toBe("Line 2 with cursor");
	});

	it("returns null when no CURSOR_MARKER is present", () => {
		const lines = ["Line 1", "Line 2"];
		const pos = extractCursorPosition(lines);
		expect(pos).toBeNull();
	});

	it("formatAnsiScreen produces ANSI frame with cursor positioning", () => {
		const lines = ["Hello", `World${CURSOR_MARKER}`];
		const ansi = formatAnsiScreen(lines, 80, 24);
		expect(ansi).toContain("\x1b[H\x1b[?25l");
		expect(ansi).toContain("Hello\x1b[K");
		expect(ansi).toContain("World\x1b[K");
		// Hardware cursor restored to row 2, col 5
		expect(ansi).toContain("\x1b[2;6H\x1b[?25h");
	});

	it("VirtualTerminal records writes and handles resize/input", () => {
		const term = new VirtualTerminal(40, 20);
		expect(term.columns).toBe(40);
		expect(term.rows).toBe(20);

		term.write("data-1");
		term.write("data-2");
		expect(term.takeDirectWrites()).toBe("data-1data-2");
		expect(term.takeDirectWrites()).toBe("");

		let resized = false;
		let inputReceived = "";
		term.start(
			(data) => {
				inputReceived = data;
			},
			() => {
				resized = true;
			},
		);

		term.resize(60, 30);
		expect(term.columns).toBe(60);
		expect(term.rows).toBe(30);
		expect(resized).toBe(true);

		term.feedInput("hello");
		expect(inputReceived).toBe("hello");
	});
});

describe("VirtualTuiBridge", () => {
	it("drives component render and lifecycle to done", async () => {
		const renders: string[] = [];
		let closed = false;

		const bridge = new VirtualTuiBridge<string>({
			id: 1,
			title: "Test Component",
			onRender: (ansi) => renders.push(ansi),
			onClose: () => {
				closed = true;
			},
		});

		let disposed = false;
		let receivedInput = "";

		bridge.setComponent({
			render: (_width) => ["Frame 1", "Active"],
			handleInput: (data) => {
				receivedInput = data;
			},
			invalidate: () => {},
			dispose: () => {
				disposed = true;
			},
		});

		// Initial render
		expect(bridge.getInitialAnsi()).toContain("Frame 1");

		// Feed input
		bridge.feedInput("\x1b[A");
		expect(receivedInput).toBe("\x1b[A");

		// Trigger render
		bridge.renderNow();
		expect(renders.length).toBeGreaterThan(0);
		expect(renders[0]).toContain("Frame 1");

		// Finish
		bridge.done("result-val");
		expect(closed).toBe(true);
		expect(disposed).toBe(true);
		await expect(bridge.promise).resolves.toBe("result-val");
	});

	it("supports cancel() and OverlayHandle", async () => {
		let closed = false;
		const bridge = new VirtualTuiBridge<void>({
			id: 2,
			onRender: () => {},
			onClose: () => {
				closed = true;
			},
		});

		const handle = bridge.createOverlayHandle();
		expect(handle.isFocused()).toBe(true);

		handle.hide();
		expect(closed).toBe(true);
		await expect(bridge.promise).resolves.toBeUndefined();
	});
});

describe("WebUIContext.custom (Universal TUI Bridge)", () => {
	it("headless mode resolves immediately without hanging and invokes onHandle", async () => {
		const ui = WebUIContext.headless();
		let handleGiven = false;

		const promise = ui.custom(
			(_tui, _theme, _kb, _done) => {
				// Component factory: in headless mode, this should never be stuck waiting for input
				return {
					render: () => ["headless"],
					invalidate: () => {},
				};
			},
			{
				onHandle: (handle) => {
					handleGiven = true;
					expect(typeof handle.hide).toBe("function");
				},
			},
		);

		// Must resolve promptly (no hang)
		const res = await promise;
		expect(res).toBeUndefined();
		expect(handleGiven).toBe(true);
	});

	it("interactive mode opens overlay, renders, accepts input, and resolves on done", async () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));

		let doneCallback: ((res: number) => void) | undefined;
		let inputData = "";

		const customPromise = ui.custom<number>((tui, theme, kb, done) => {
			doneCallback = done;
			expect(tui).toBeDefined();
			expect(theme).toBeDefined();
			expect(kb).toBeDefined();

			return {
				render: (_width) => ["Line A", "Line B"],
				handleInput: (data) => {
					inputData = data;
				},
				invalidate: () => {},
			};
		});

		// Check that tui_overlay_open was emitted
		const openMsg = msgs.find((m) => m.type === "tui_overlay_open");
		expect(openMsg).toBeDefined();
		if (openMsg && openMsg.type === "tui_overlay_open") {
			expect(openMsg.id).toBe(1);
			expect(openMsg.cols).toBe(80);
			expect(openMsg.initialAnsi).toContain("Line A");

			// Simulate user keyboard input from web client
			ui.handleTuiOverlayInput(openMsg.id, "q");
			expect(inputData).toBe("q");

			// Simulate user resize
			ui.handleTuiOverlayResize(openMsg.id, 100, 30);

			// Complete the interaction
			doneCallback?.(42);
		}

		const result = await customPromise;
		expect(result).toBe(42);

		// Check that tui_overlay_close was emitted
		const closeMsg = msgs.find((m) => m.type === "tui_overlay_close");
		expect(closeMsg).toBeDefined();
	});

	it("interactive mode handles cancellation cleanly", async () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));

		let disposed = false;
		const customPromise = ui.custom((_tui, _theme, _kb, _done) => {
			return {
				render: () => ["Pending"],
				invalidate: () => {},
				dispose: () => {
					disposed = true;
				},
			};
		});

		const openMsg = msgs.find((m) => m.type === "tui_overlay_open");
		expect(openMsg).toBeDefined();
		if (openMsg && openMsg.type === "tui_overlay_open") {
			// Simulate user closing / canceling modal
			ui.handleTuiOverlayCancel(openMsg.id);
		}

		const res = await customPromise;
		expect(res).toBeUndefined();
		expect(disposed).toBe(true);

		const closeMsg = msgs.find((m) => m.type === "tui_overlay_close");
		expect(closeMsg).toBeDefined();
	});
});
