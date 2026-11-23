import { describe, expect, it, vi } from "vitest";
import { createGuardedBuiltinTools, GUARDED_BUILTIN_NAMES } from "../../server/core/adapters/tools/guarded.js";

describe("adapters/tools · 内置工具审批闸", () => {
	it("重建同名 bash 工具（名字必须与内置一致才能覆盖）", () => {
		const tools = createGuardedBuiltinTools({
			cwd: "/work",
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "deny" as const })),
		});
		expect(tools.map((t) => t.name)).toEqual(["bash", "write", "edit"]);
		for (const tool of tools) expect(typeof tool.execute).toBe("function");
	});

	it("声明的受闸名字与实现一致", () => {
		expect([...GUARDED_BUILTIN_NAMES]).toEqual(["bash", "write", "edit"]);
	});

	it("描述/参数 schema 沿用 SDK 内置定义（不自己写一份）", () => {
		const tools = createGuardedBuiltinTools({
			cwd: "/work",
			getLang: () => "zh",
			askApproval: vi.fn(async () => ({ decision: "deny" as const })),
		});
		expect(tools[0].description.length).toBeGreaterThan(0);
		expect(tools[0].parameters).toBeTruthy();
	});
});
