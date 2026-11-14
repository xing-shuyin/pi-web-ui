import { describe, expect, it } from "vitest";
import { DEFAULT_APPROVAL_RULES } from "../../server/approval-default-rules.js";
import { PHONE_APPROVAL_GROUPS, PHONE_CONTROL_OPS, PHONE_OPS, PHONE_READ_OPS } from "../../server/phone-tool.js";
import { checkDangerousToolCall } from "../../server/tool-approval.js";

const CWD = process.cwd();

function phoneCheck(op: string) {
	return checkDangerousToolCall(
		"phone",
		{ op, x: 10, y: 20, text: "hello", packageName: "com.example.app" },
		CWD,
		[],
		DEFAULT_APPROVAL_RULES,
	);
}

describe("phone op 分级（#902：读屏档与操控档）", () => {
	it("读写两档覆盖全部 op 且互不重叠", () => {
		const all = new Set([...PHONE_READ_OPS, ...PHONE_CONTROL_OPS]);
		expect([...all].sort()).toEqual([...PHONE_OPS].sort());
		expect(new Set(PHONE_READ_OPS).size).toBe(PHONE_READ_OPS.length);
		expect(new Set(PHONE_CONTROL_OPS).size).toBe(PHONE_CONTROL_OPS.length);
		for (const op of PHONE_READ_OPS) expect(PHONE_CONTROL_OPS).not.toContain(op);
	});

	it("操控档包含全部高危 op（逐操作审批的分档依据）", () => {
		for (const op of ["tap", "long_press", "swipe", "input", "key", "launch"] as const) {
			expect(PHONE_CONTROL_OPS).toContain(op);
		}
		expect(PHONE_READ_OPS).toContain("screenshot");
	});

	it("审批分档恰好覆盖操控档，且不碰读屏档", () => {
		const grouped = PHONE_APPROVAL_GROUPS.flatMap((g) => [...g.ops]);
		expect([...grouped].sort()).toEqual([...PHONE_CONTROL_OPS].sort());
		for (const op of PHONE_READ_OPS) expect(grouped).not.toContain(op);
		expect(new Set(PHONE_APPROVAL_GROUPS.map((g) => g.id)).size).toBe(PHONE_APPROVAL_GROUPS.length);
	});
});

describe("phone 逐操作审批（#902：控制档 ask / 读屏档放行）", () => {
	it("读屏档不触发审批", () => {
		for (const op of PHONE_READ_OPS) {
			expect(phoneCheck(op).dangerous, op).toBe(false);
		}
	});

	it("操控档每个 op 都命中对应的审批分档", () => {
		for (const group of PHONE_APPROVAL_GROUPS) {
			for (const op of group.ops) {
				const res = phoneCheck(op);
				expect(res.dangerous, op).toBe(true);
				expect(res.denied, op).toBe(false);
				expect(res.category?.id, op).toBe(group.id);
			}
		}
	});

	it("每个分档都有可独立开关的内置规则", () => {
		for (const group of PHONE_APPROVAL_GROUPS) {
			const rule = DEFAULT_APPROVAL_RULES.find((r) => r.categoryId === group.id);
			expect(rule, group.id).toBeDefined();
			expect(rule?.builtin, group.id).toBe(true);
			expect(rule?.action, group.id).toBe("ask");
			expect(rule?.enabled, group.id).toBe(true);
			expect(rule?.tools, group.id).toEqual(["phone"]);
		}
	});

	it("改大小写或加空白都躲不过分档匹配", () => {
		expect(phoneCheck("INPUT").dangerous).toBe(true);
		expect(phoneCheck("  launch  ").dangerous).toBe(true);
	});

	it("分档规则停用后该档放行（读屏/操控可分别收口）", () => {
		const withoutInput = DEFAULT_APPROVAL_RULES.map((r) =>
			r.categoryId === "phone.input" ? { ...r, enabled: false } : r,
		);
		const res = checkDangerousToolCall("phone", { op: "input", text: "hi" }, CWD, [], withoutInput);
		expect(res.dangerous).toBe(false);
		const stillAsking = checkDangerousToolCall("phone", { op: "launch", packageName: "com.x" }, CWD, [], withoutInput);
		expect(stillAsking.dangerous).toBe(true);
	});
});
