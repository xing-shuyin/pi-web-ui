import { describe, expect, it } from "vitest";
import { appendConstraints, buildPlatformConstraints } from "../../server/platform-constraints.js";
import { PLAN_MODE_SYSTEM_PROMPT, buildPlanModePrompt } from "../../server/plan-mode.js";
import { DELEGATION_SYSTEM_PROMPT } from "../../server/delegate-mode.js";

/**
 * 平台/模式约束（沙盒 / 远程 / 计划 / 审查者）当前只在 persona hook 出口落地。
 * 这里锁的是「选中哪几段、顺序如何、计划优先」——落点本身由 prompt-render-parse-guard 守。
 */
describe("buildPlatformConstraints — 约束选中与顺序", () => {
	it("普通会话：没有任何平台/模式约束", () => {
		expect(buildPlatformConstraints({})).toEqual([]);
	});

	it("沙盒：说明隔离目录与来源，禁止碰源目录", () => {
		const [text] = buildPlatformConstraints({
			sandbox: { name: "sandbox-1", path: "/tmp/sb", sourcePath: "/repo" },
		});
		expect(text).toContain("Sandbox Isolation Mode");
		expect(text).toContain("/tmp/sb");
		expect(text).toContain('NEVER read from or modify "/repo"');
	});

	it("远程工作区：带上 host 与远程目录说明", () => {
		const [text] = buildPlatformConstraints({ remoteCwd: "pi-remote://u@host:22/workspace/app" });
		expect(text).toContain("REMOTE SSH workspace");
		expect(text).toContain("/workspace/app");
	});

	it("计划模式：用设置里的模式与自定义文本（replace 只留自定义）", () => {
		expect(buildPlatformConstraints({ planMode: true })[0]).toBe(PLAN_MODE_SYSTEM_PROMPT);
		const replaced = buildPlatformConstraints({
			planMode: true,
			planPrompt: { mode: "replace", custom: "MY PLAN RULES" },
		});
		expect(replaced).toEqual(["MY PLAN RULES"]);
		const appended = buildPlatformConstraints({
			planMode: true,
			planPrompt: { mode: "append", custom: "MY PLAN RULES" },
		});
		expect(appended[0]).toBe(buildPlanModePrompt("append", "MY PLAN RULES"));
		expect(appended[0]).toContain("MY PLAN RULES");
	});

	it("审查者模式：计划模式同时开着时计划优先（不叠加审查者段）", () => {
		expect(buildPlatformConstraints({ delegateMode: true })).toEqual([DELEGATION_SYSTEM_PROMPT]);
		expect(buildPlatformConstraints({ planMode: true, delegateMode: true })).toEqual([PLAN_MODE_SYSTEM_PROMPT]);
	});

	it("顺序固定：沙盒 → 远程 → 计划", () => {
		const out = buildPlatformConstraints({
			sandbox: { name: "s", path: "/tmp/s" },
			remoteCwd: "pi-remote://u@h:22/w",
			planMode: true,
		});
		expect(out).toHaveLength(3);
		expect(out[0]).toContain("Sandbox Isolation Mode");
		expect(out[1]).toContain("REMOTE SSH workspace");
		expect(out[2]).toBe(PLAN_MODE_SYSTEM_PROMPT);
	});
});

describe("appendConstraints — 出口追加", () => {
	it("空约束零改动（不给等值文本制造 diff）", () => {
		expect(appendConstraints("PROMPT", [])).toBe("PROMPT");
		expect(appendConstraints("PROMPT", ["   "])).toBe("PROMPT");
	});

	it("非空约束追加到末尾，空行分隔，不重复正文", () => {
		expect(appendConstraints("PROMPT\n\n", ["A", "B\n"])).toBe("PROMPT\n\nA\n\nB");
		expect(appendConstraints("PROMPT", [DELEGATION_SYSTEM_PROMPT])).toBe(`PROMPT\n\n${DELEGATION_SYSTEM_PROMPT}`);
	});
});
