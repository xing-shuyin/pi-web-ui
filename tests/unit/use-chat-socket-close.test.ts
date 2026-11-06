import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../web/src/use-chat.ts", import.meta.url), "utf8");
const begin = source.indexOf("ws.onclose = () => {");
const end = source.indexOf("ws.onerror =", begin);
const installClose = source.slice(begin, end);

function fixture(current: "same" | "newer" | "none", alive = true) {
	const ws: { onclose?: () => void } = {};
	const newer = {};
	const context = {
		ws,
		wsRef: { current: current === "same" ? ws : current === "newer" ? newer : null },
		bridgeRef: { current: { clear: vi.fn() } },
		aliveRef: { current: alive },
		dispatch: vi.fn(),
		retryRef: { current: 0 },
		timerRef: { current: null },
		setTimeout: vi.fn(() => 42),
		connect: vi.fn(),
	};
	runInNewContext(installClose, context);
	return context;
}

describe("socket close ownership", () => {
	it("a delayed old close leaves the new socket and shared terminal bridge intact", () => {
		const c = fixture("newer");
		const owner = c.wsRef.current;
		c.ws.onclose!();
		expect(c.wsRef.current).toBe(owner);
		expect(c.bridgeRef.current.clear).not.toHaveBeenCalled();
		expect(c.dispatch).not.toHaveBeenCalled();
		expect(c.setTimeout).not.toHaveBeenCalled();
	});

	it("the current socket clears the bridge and schedules one reconnect", () => {
		const c = fixture("same");
		c.ws.onclose!();
		c.ws.onclose!();
		expect(c.wsRef.current).toBeNull();
		expect(c.bridgeRef.current.clear).toHaveBeenCalledTimes(1);
		expect(c.dispatch).toHaveBeenCalledWith({ type: "status", status: "closed" });
		expect(c.setTimeout).toHaveBeenCalledTimes(1);
	});

	it("a disposed socket does not touch shared state or reconnect", () => {
		const c = fixture("none", false);
		c.ws.onclose!();
		expect(c.bridgeRef.current.clear).not.toHaveBeenCalled();
		expect(c.setTimeout).not.toHaveBeenCalled();
	});
});
