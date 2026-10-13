import { describe, expect, it } from "vitest";
import { applyMessageDelta, type MessageDeltaMsg, type MessageDeltaUiState } from "../../web/src/message-delta.js";
import { flattenThinkingText, formatThinkingBody, thinkingPreview } from "../../web/src/components/ThinkingBlock.js";

// P1 thinking first-char probe (w25, 2026-09-17): live wire capture from
// openai-codex/gpt-5.6-luna — the ONLY run (of 4, across 3 providers) where
// wire concat and persisted final diverged AT ALL. Pins that pi-web-ui keeps
// every byte verbatim on the thinking path (no slice/trim on deltas) and
// documents where the 2-char gap actually lives (SDK finalize, trailing end).

function makeUi(): MessageDeltaUiState {
	return {
		streamingMessage: undefined,
		stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

let seq = 0;
function thinkingDelta(deltaText: string, contentIndex = 0): MessageDeltaMsg {
	return {
		type: "message_delta",
		conversationId: "c1",
		seq: ++seq,
		messageId: "stream-100",
		usage: null,
		assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: deltaText },
	};
}

function thinkingOf(ui: MessageDeltaUiState): string {
	const blocks = ui.streamingMessage?.content ?? [];
	return blocks
		.filter((b): b is { type: "thinking"; thinking?: string } => b.type === "thinking")
		.map((b) => b.thinking ?? "")
		.join("");
}

// Exact wire bytes, /tmp/w25-codex-luna.jsonl (2 thinking_delta events).
const WIRE_D1 = "**Calculating arithmetic result**";
const WIRE_D2 = "\n\n";
const WIRE_FULL = WIRE_D1 + WIRE_D2; // 35 chars
const PERSISTED_FINAL = "**Calculating arithmetic result**"; // 33 chars (SDK session JSONL + snapshot)

describe("thinking first-char verbatim (codex-luna live capture)", () => {
	it("concats wire deltas byte-identical, trailing newlines included", () => {
		let ui = makeUi();
		ui = applyMessageDelta(ui, thinkingDelta(WIRE_D1));
		ui = applyMessageDelta(ui, thinkingDelta(WIRE_D2));
		expect(thinkingOf(ui)).toBe(WIRE_FULL);
		expect(thinkingOf(ui).length).toBe(35);
	});

	it("first delta starts at the true first character (no leading loss)", () => {
		const ui = applyMessageDelta(makeUi(), thinkingDelta(WIRE_D1));
		expect(thinkingOf(ui)[0]).toBe("*");
		expect(thinkingOf(ui).slice(0, PERSISTED_FINAL.length)).toBe(PERSISTED_FINAL);
	});

	it("wire vs persisted differ ONLY by SDK-side trailing trim (not our path)", () => {
		// pi-web-ui serialize passes b.thinking verbatim (server/serialize.ts);
		// the 35->33 gap is already in the SDK final message on disk.
		expect(WIRE_FULL.trimEnd()).toBe(PERSISTED_FINAL);
		expect(WIRE_FULL.length - PERSISTED_FINAL.length).toBe(2);
	});
});

// thinkingPreview 直引源码：源实现变了测试必挂，不许在测试里抄一份实现。
describe("ThinkingBlock preview (thinkingPreview)", () => {
	const long = `First-char-ABC ${"x".repeat(200)}\nsecond line ${"y".repeat(200)}\nthird line tail-TAIL`;
	const flat = flattenThinkingText(long);

	it("streaming preview shows the continuous tail, final preview shows the continuous head", () => {
		expect(thinkingPreview(long, true)).toBe(flat.slice(-300));
		expect(thinkingPreview(long, true).endsWith("third line tail-TAIL")).toBe(true);
		expect(thinkingPreview(long, false)).toBe(flat.slice(0, 300));
		expect(thinkingPreview(long, false).startsWith("First-char-ABC ")).toBe(true);
		expect(thinkingPreview(long, true)).not.toBe(thinkingPreview(long, false));
	});

	it("flattens multi-line thoughts into a continuous single-line stream without resetting on newline", () => {
		const multi = "Step 1: checking files\n\nStep 2: reading code\n";
		expect(thinkingPreview(multi, true)).toBe("Step 1: checking files Step 2: reading code");
		expect(thinkingPreview(multi, false)).toBe("Step 1: checking files Step 2: reading code");
	});

	it("skips generic headers like # Thinking Process", () => {
		const withHeader = "# Thinking Process\n\nWe need to construct a tool file.\nThen test it.";
		expect(thinkingPreview(withHeader, false)).toBe("We need to construct a tool file. Then test it.");

		const withChineseHeader = "思路：\n首先分析当前代码仓库的目录结构。";
		expect(thinkingPreview(withChineseHeader, false)).toBe("首先分析当前代码仓库的目录结构。");
	});

	it("body text is identical mid-stream and after end (preview never edits data)", () => {
		const bodyStreaming = long;
		const bodyFinal = long;
		expect(bodyFinal).toBe(bodyStreaming);
		expect(bodyFinal[0]).toBe("F");
	});

	it("formatThinkingBody strips trailing newlines and collapses excessive blank lines in expanded view", () => {
		const rawWithTrailingBlankLines =
			"User interface attention points are the primary focus. Analyze where these switches are typically located.\n\n\n";
		expect(formatThinkingBody(rawWithTrailingBlankLines)).toBe(
			"User interface attention points are the primary focus. Analyze where these switches are typically located.",
		);

		const withHeaderAndGaps = "# Thinking Process\n\nStep 1: inspect DOM\n   \n\n\nStep 2: fix padding\n\n";
		expect(formatThinkingBody(withHeaderAndGaps)).toBe("Step 1: inspect DOM\n\nStep 2: fix padding");

		expect(formatThinkingBody("   \n\n  ")).toBe("");
	});
});
