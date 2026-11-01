import { describe, expect, it } from "vitest";
import { boundTaskReport, TASK_REPORT_BYTES } from "../../server/device-center/task-report.js";

describe("group task report excerpts", () => {
	it("preserves short reports exactly", () => {
		expect(boundTaskReport("完成\nchecks passed")).toBe("完成\nchecks passed");
	});
	it("keeps final conclusions as well as opening context within the byte budget", () => {
		const report =
			"Opening task context\n" + "工具输出🙂中文\n".repeat(4000) + "\nFinal result: tests failed; do not merge.";
		const excerpt = boundTaskReport(report);
		expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(TASK_REPORT_BYTES);
		expect(excerpt).toContain("Opening task context");
		expect(excerpt).toContain("Final result: tests failed; do not merge.");
		expect(excerpt).toContain(`${Buffer.byteLength(report)} original UTF-8 bytes`);
		expect(excerpt).not.toContain("\ufffd");
	});
	it("retains valid UTF-8 for every boundary offset", () => {
		for (let offset = 0; offset < 16; offset++) {
			const report = "x".repeat(offset) + "🙂中é".repeat(300);
			const excerpt = boundTaskReport(report, 256);
			expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(256);
			expect(excerpt).not.toContain("\ufffd");
		}
	});
});
