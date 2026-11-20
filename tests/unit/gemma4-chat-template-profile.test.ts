import { describe, expect, it } from "vitest";
import { THINKING_FORMAT_OPTIONS, THINKING_PRESET_PROFILES } from "../../web/src/thinking-levels.js";

describe("Gemma 4 chat-template preset", () => {
	it("uses the generic chat-template format and emits the expected kwargs", () => {
		const profile = THINKING_PRESET_PROFILES.find((item) => item.id === "gemma4-chat-template");

		expect(THINKING_FORMAT_OPTIONS.some((item) => item.value === "chat-template")).toBe(true);
		expect(profile).toBeDefined();
		expect(profile?.thinkingFormat).toBe("chat-template");
		expect(profile?.map).toEqual({
			off: "none",
			low: "low",
			medium: "medium",
			high: "high",
		});
		expect(profile?.chatTemplateKwargs).toEqual({
			enable_thinking: { $var: "thinking.enabled" },
			reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
			preserve_thinking: true,
		});
		expect(JSON.parse(profile?.customExtraBody ?? "{}")).toEqual({
			temperature: 0.8,
			top_k: 64,
			top_p: 0.95,
		});
	});
});
