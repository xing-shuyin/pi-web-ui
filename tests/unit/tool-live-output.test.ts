import { describe, expect, it } from "vitest";

function resolveLiveOutput(
	prevText: string,
	action: { delta: string; mode?: "append" | "replace" },
	maxLiveOutput = 200_000,
): string {
	let text: string;
	if (action.mode === "replace") {
		text = action.delta;
	} else if (prevText.length > 0 && action.delta.startsWith(prevText)) {
		text = action.delta;
	} else {
		text = prevText + action.delta;
	}

	return text.length > maxLiveOutput
		? `…[LIVE_OMIT:${text.length - maxLiveOutput}]…\n` + text.slice(text.length - maxLiveOutput)
		: text;
}

describe("live tool output resolving (issue #782)", () => {
	it("replaces output completely when mode is replace", () => {
		const out1 = resolveLiveOutput("", { delta: "tick 1\n", mode: "replace" });
		expect(out1).toBe("tick 1\n");

		const out2 = resolveLiveOutput(out1, { delta: "tick 1\ntick 2\n", mode: "replace" });
		expect(out2).toBe("tick 1\ntick 2\n");

		const out3 = resolveLiveOutput(out2, { delta: "tick 1\ntick 2\ntick 3\n", mode: "replace" });
		expect(out3).toBe("tick 1\ntick 2\ntick 3\n");
	});

	it("self-heals when cumulative snapshots arrive without mode=replace", () => {
		const out1 = resolveLiveOutput("", { delta: "tick 1\n" });
		expect(out1).toBe("tick 1\n");

		const out2 = resolveLiveOutput(out1, { delta: "tick 1\ntick 2\n" });
		expect(out2).toBe("tick 1\ntick 2\n");

		const out3 = resolveLiveOutput(out2, { delta: "tick 1\ntick 2\ntick 3\n" });
		expect(out3).toBe("tick 1\ntick 2\ntick 3\n");
	});

	it("accumulates normally for genuine incremental deltas (append mode or non-prefix)", () => {
		const out1 = resolveLiveOutput("", { delta: "chunk1 " });
		expect(out1).toBe("chunk1 ");

		const out2 = resolveLiveOutput(out1, { delta: "chunk2 " });
		expect(out2).toBe("chunk1 chunk2 ");

		const out3 = resolveLiveOutput(out2, { delta: "chunk3", mode: "append" });
		expect(out3).toBe("chunk1 chunk2 chunk3");
	});

	it("caps at maxLiveOutput keeping tail", () => {
		const bigDelta = "A".repeat(100);
		const capped = resolveLiveOutput("", { delta: bigDelta, mode: "replace" }, 50);
		expect(capped).toBe("…[LIVE_OMIT:50]…\n" + "A".repeat(50));
	});
});
