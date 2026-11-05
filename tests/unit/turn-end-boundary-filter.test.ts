import { describe, expect, it } from "vitest";
import { isAbortedTurnBoundaryError } from "../../server/agent-service.js";

describe("isAbortedTurnBoundaryError (issue #411 / upstream earendil-works/pi#10149)", () => {
	it("准确识别由中止回合触发的 turn_end 边界扩展伪错误", () => {
		expect(
			isAbortedTurnBoundaryError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			}),
		).toBe(true);

		expect(
			isAbortedTurnBoundaryError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "some other boundary message",
			}),
		).toBe(true);

		expect(
			isAbortedTurnBoundaryError({
				error: "Error: turn_end could not resolve the persisted assistant entry ID",
			}),
		).toBe(true);
	});

	it("正常扩展错误不应被误判或吞掉", () => {
		expect(
			isAbortedTurnBoundaryError({
				extensionPath: "/path/to/my-ext.js",
				event: "turn_end",
				error: "SyntaxError in extension handler",
			}),
		).toBe(false);

		expect(
			isAbortedTurnBoundaryError({
				extensionPath: "<boundary>",
				event: "turn_start",
				error: "other error",
			}),
		).toBe(false);

		expect(isAbortedTurnBoundaryError(null)).toBe(false);
		expect(isAbortedTurnBoundaryError(undefined)).toBe(false);
		expect(isAbortedTurnBoundaryError("string error")).toBe(false);
	});
});
