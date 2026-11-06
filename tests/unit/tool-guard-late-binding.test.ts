import { describe, expect, it, vi } from "vitest";
import { makeLateToolGuard, withToolGuard, type ToolGuardHook } from "../../server/agent-service.js";

const allowVerdict = { verdict: { decision: "allow" as const } };

function fakeTool() {
	return {
		name: "bash",
		label: "bash",
		description: "test",
		parameters: { type: "object", properties: {} },
		execute: vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] })),
	};
}

describe("makeLateToolGuard", () => {
	it("调用时才解析真正的守卫（赋值晚于建定义也没问题）", async () => {
		let guard: ToolGuardHook | undefined;
		const late = makeLateToolGuard(() => guard);
		const inner = fakeTool();
		const tool = withToolGuard(inner as never, {
			toolName: "bash",
			guard: late,
			getLang: () => "zh",
		}) as unknown as { execute: (id: string, params: unknown) => Promise<unknown> };

		await tool.execute("c1", { command: "npm run build" });
		expect(inner.execute).toHaveBeenCalledTimes(1);

		const pre = vi.fn(async () => ({ verdict: { decision: "deny" as const }, pluginId: "pm2-manager" }));
		guard = { pre, post: async () => undefined };
		const out = (await tool.execute("c2", { command: "npm run dev &" })) as {
			content?: Array<{ text?: string }>;
		};
		expect(pre).toHaveBeenCalledTimes(1);
		expect(inner.execute).toHaveBeenCalledTimes(1);
		const text = out?.content?.map((c) => c.text ?? "").join("\n") ?? "";
		expect(text).toContain("pm2-manager");
		expect(text).toContain("拒绝");
	});

	it("未注入守卫时逐字等价于直通（allow / 无 post 编辑）", async () => {
		const late = makeLateToolGuard(() => undefined);
		expect(await late.pre({ toolName: "bash", params: {} }, "zh")).toEqual(allowVerdict);
		expect(await late.post({ toolName: "bash", params: {}, result: {} }, "zh")).toBeUndefined();
	});

	it("每次调用都重新取守卫（reload 后换成新实例也生效）", async () => {
		const a = vi.fn(async () => allowVerdict);
		const b = vi.fn(async () => allowVerdict);
		let current: ToolGuardHook | undefined = { pre: a, post: async () => undefined };
		const late = makeLateToolGuard(() => current);
		await late.pre({ toolName: "bash", params: {} }, "en");
		current = { pre: b, post: async () => undefined };
		await late.pre({ toolName: "bash", params: {} }, "en");
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});
});
