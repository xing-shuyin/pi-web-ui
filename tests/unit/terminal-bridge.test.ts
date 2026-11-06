import { describe, expect, it, vi } from "vitest";
import { isClientTerminalStream, makeTerminalBridge } from "../../web/src/terminal-bridge";

function display() {
	let text = "";
	return {
		write: vi.fn((data: string) => {
			text += data;
		}),
		reset: vi.fn(() => {
			text = "";
		}),
		dispose: vi.fn(),
		get text() {
			return text;
		},
	};
}

describe("terminal history bridge", () => {
	it("keeps client streams and merged lists outside the conversation envelope gate", () => {
		expect(isClientTerminalStream({ type: "terminal_list" })).toBe(true);
		for (const type of ["terminal_output", "terminal_exit"]) {
			expect(isClientTerminalStream({ type, ownerKind: "client" })).toBe(true);
			expect(isClientTerminalStream({ type, ownerKind: "conversation" })).toBe(false);
			expect(isClientTerminalStream({ type })).toBe(false);
		}
		expect(isClientTerminalStream({ type: "message_delta" })).toBe(false);
	});
	it("replaces mounted displays on repeated replay and appends subsequent live output", () => {
		const bridge = makeTerminalBridge();
		const first = display();
		const second = display();
		bridge.register("a", "user", first);
		bridge.register("a", "user", second);
		bridge.write("a", "user", "old");
		bridge.write("a", "user", "old", true);
		bridge.write("a", "user", "old", true);
		bridge.write("a", "user", "new");
		expect(first.text).toBe("oldnew");
		expect(second.text).toBe("oldnew");
		bridge.write("a", "user", "", true);
		expect(first.text).toBe("");
	});

	it("does not reset or replay into an in-flight SCM parser sharing a terminal", () => {
		const bridge = makeTerminalBridge();
		let pending = "";
		const parser = {
			write: vi.fn((data: string) => {
				pending += data;
			}),
			dispose: vi.fn(),
		};
		const screen = display();
		bridge.register("a", "scm", parser);
		bridge.register("a", "scm", screen);
		bridge.write("a", "scm", "BEGIN\npartial");
		bridge.write("a", "scm", "OLD_END\nBEGIN\npartial", true);
		bridge.write("a", "scm", " result\nEND");
		expect(pending).toBe("BEGIN\npartial result\nEND");
		expect(parser.write).toHaveBeenCalledTimes(2);
		expect(parser.dispose).not.toHaveBeenCalled();
		expect(screen.text).toBe("OLD_END\nBEGIN\npartial result\nEND");
	});

	it("replaces unmounted history, supports every later subscriber and remount", () => {
		const bridge = makeTerminalBridge();
		bridge.write("a", "user", "stale");
		bridge.write("a", "user", "history", true);
		bridge.write("a", "user", "+live");
		const first = display();
		const unregister = bridge.register("a", "user", first);
		const second = display();
		bridge.register("a", "user", second);
		expect(first.text).toBe("history+live");
		expect(second.text).toBe("history+live");
		unregister();
		bridge.write("a", "user", "+next");
		const remount = display();
		bridge.register("a", "user", remount);
		expect(remount.text).toBe("history+live+next");
		expect(first.text).toBe("history+live");
	});

	it("routes user terminals across conversation switches and replaces fallback buffers", () => {
		const bridge = makeTerminalBridge();
		bridge.write("a", "user", "stale");
		bridge.write("b", "user", "history", true);
		const screen = display();
		bridge.register("c", "user", screen);
		expect(screen.text).toBe("history");
		bridge.write("b", "user", "history", true);
		bridge.write("a", "user", "+live");
		expect(screen.text).toBe("history+live");
	});

	it("prefers exact legacy conversation writers over legacy terminal-id fallback", () => {
		const bridge = makeTerminalBridge();
		const exact = display();
		const other = display();
		bridge.register("a", "same", exact);
		bridge.register("b", "same", other);
		bridge.write("a", "same", "one", true);
		expect(exact.text).toBe("one");
		expect(other.text).toBe("");
	});

	it("never falls back from explicit owners to legacy or another conversation", () => {
		const bridge = makeTerminalBridge();
		const legacy = display();
		const other = display();
		bridge.register("a", "same", legacy);
		bridge.register("b", "same", other, "conversation");
		bridge.write("a", "same", "private", true, "conversation");
		expect(legacy.text).toBe("");
		expect(other.text).toBe("");
		const client = display();
		bridge.register("a", "same", client, "client");
		expect(client.text).toBe("");
	});

	it("preserves mounted writers across reconnect while dropping stale buffered data", () => {
		const bridge = makeTerminalBridge();
		const screen = display();
		bridge.register("a", "user", screen);
		bridge.write("a", "user", "before");
		bridge.clear();
		const fresh = display();
		bridge.register("a", "user", fresh);
		expect(fresh.text).toBe("");
		bridge.write("b", "user", "before", true);
		bridge.write("b", "user", "+after");
		expect(screen.text).toBe("before+after");
		expect(fresh.text).toBe("before+after");
	});

	it("caps history even for oversized individual frames and isolates failing writers", () => {
		const bridge = makeTerminalBridge();
		bridge.register("a", "user", {
			write: () => {
				throw new Error("stale");
			},
			dispose() {},
		});
		bridge.write("a", "user", "x".repeat(210_000), true);
		const screen = display();
		bridge.register("a", "user", screen);
		expect(screen.text.length).toBe(200_000);
		bridge.write("a", "user", "tail");
		expect(screen.text.endsWith("tail")).toBe(true);
	});
});
