import { describe, expect, it } from "vitest";
import { modelSessionId } from "../../server/model-session.js";

describe("modelSessionId", () => {
	it("gives every one-shot call its own provider session", () => {
		const first = modelSessionId();
		const second = modelSessionId();
		expect(first).toMatch(/^pi-web-[0-9a-f-]{36}$/);
		expect(first).not.toBe(second);
	});

	it("keeps a stable session for the same multi-turn seed", () => {
		expect(modelSessionId("解释下: x")).toBe(modelSessionId("解释下: x"));
		expect(modelSessionId("解释下: x")).not.toBe(modelSessionId("解释下: y"));
		expect(modelSessionId("解释下: x")).toMatch(/^pi-web-[0-9a-f]{32}$/);
	});
});
