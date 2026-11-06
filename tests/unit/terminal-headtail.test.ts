import { describe, expect, it } from "vitest";
import { applyHeadTail } from "../../server/terminals.js";

describe("applyHeadTail 的语言", () => {
	it("zh 保留中文注记", () => {
		expect(applyHeadTail("a\nb\nc", undefined, 1, "zh")).toBe("…（前 2 行已省略）\nc");
		expect(applyHeadTail("a\nb\nc", 1, undefined, "zh")).toBe("a\n…（后 2 行已省略）");
	});

	it("en 出英文注记；第三语言回落英文", () => {
		expect(applyHeadTail("a\nb\nc", undefined, 1, "en")).toBe("…[2 lines omitted above]…\nc");
		expect(applyHeadTail("a\nb\nc", 1, undefined, "en")).toBe("a\n…[2 lines omitted below]…");
		expect(applyHeadTail("a\nb\nc", undefined, 1, "ja")).toBe("…[2 lines omitted above]…\nc");
	});

	it("缺省 lang = 英文（客户端未上报语言）", () => {
		expect(applyHeadTail("a\nb\nc", 1, undefined)).toBe("a\n…[2 lines omitted below]…");
	});

	it("head + tail 同给：注记行不参与第二次截取", () => {
		expect(applyHeadTail("a\nb\nc\nd\ne", 3, 2, "en")).toBe(
			"…[1 lines omitted above]…\nb\nc\n…[2 lines omitted below]…",
		);
	});
});
