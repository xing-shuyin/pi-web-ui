import { describe, expect, it } from "vitest";
import { PHONE_CONTROL_OPS, PHONE_OPS, PHONE_READ_OPS } from "../../server/phone-tool.js";

describe("phone op 分级（#902：读屏档与操控档）", () => {
	it("读写两档覆盖全部 op 且互不重叠", () => {
		const all = new Set([...PHONE_READ_OPS, ...PHONE_CONTROL_OPS]);
		expect([...all].sort()).toEqual([...PHONE_OPS].sort());
		expect(new Set(PHONE_READ_OPS).size).toBe(PHONE_READ_OPS.length);
		expect(new Set(PHONE_CONTROL_OPS).size).toBe(PHONE_CONTROL_OPS.length);
		for (const op of PHONE_READ_OPS) expect(PHONE_CONTROL_OPS).not.toContain(op);
	});

	it("操控档包含全部高危 op（逐操作审批 UI 落地前的管控依据）", () => {
		for (const op of ["tap", "long_press", "swipe", "input", "key", "launch"] as const) {
			expect(PHONE_CONTROL_OPS).toContain(op);
		}
		expect(PHONE_READ_OPS).toContain("screenshot");
	});
});
