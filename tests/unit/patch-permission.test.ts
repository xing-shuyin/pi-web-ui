import { describe, expect, it, vi } from "vitest";
import { wrapPatchToolWithPermission } from "../../server/tool-guards.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalRule } from "../../server/approval-rules.js";

const CWD = process.platform === "win32" ? "C:\\ws\\proj" : "/ws/proj";

function makeBaseTool() {
	const execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "patch applied" }],
	}));
	return { tool: { name: "patch", execute } as unknown as ToolDefinition, execute };
}

function wrap(
	tool: ToolDefinition,
	opts: {
		permission?: string;
		roots?: string[];
		askApproval?: Parameters<typeof wrapPatchToolWithPermission>[5];
		rules?: ApprovalRule[];
	},
) {
	return wrapPatchToolWithPermission(
		tool,
		CWD,
		() => opts.permission ?? "workspace-write-never",
		() => (opts.roots ?? []).map((r) => `${CWD}${r}`),
		() => "zh" as const,
		opts.askApproval,
		() => "conv-1",
		opts.rules === undefined ? undefined : () => opts.rules as ApprovalRule[],
	);
}

async function run(tool: ToolDefinition, patch: string) {
	const res = (await (tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("call-1", {
		patch,
	})) as { isError?: boolean; content?: Array<{ text?: string }> };
	return res;
}

const PATCH_OUTSIDE = "[../outside/evil.txt]\nPUT 1.=1:\n+x\n";
const PATCH_MV_OUTSIDE = "[src/a.ts#abcd]\nMV ../moved/a.ts\nPUT 1.=1:\n+x\n";
const PATCH_NORMAL = "[src/a.ts#abcd]\nPUT 1.=1:\n+x\n";

describe("wrapPatchToolWithPermission", () => {
	it("read-only：整体拒绝，不触达基底执行体", async () => {
		const { tool, execute } = makeBaseTool();
		const res = await run(wrap(tool, { permission: "read-only" }), PATCH_NORMAL);
		expect(res.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("workspace-write-never：段头越界路径被拒并点名", async () => {
		const { tool, execute } = makeBaseTool();
		const res = await run(wrap(tool, {}), PATCH_OUTSIDE);
		expect(res.isError).toBe(true);
		expect(res.content?.[0]?.text).toContain("../outside/evil.txt");
		expect(execute).not.toHaveBeenCalled();
	});

	it("workspace-write-never：MV 目标越界同样被拒", async () => {
		const { tool, execute } = makeBaseTool();
		const res = await run(wrap(tool, {}), PATCH_MV_OUTSIDE);
		expect(res.isError).toBe(true);
		expect(res.content?.[0]?.text).toContain("../moved/a.ts");
		expect(execute).not.toHaveBeenCalled();
	});

	it("工作区内正常补丁直接执行", async () => {
		const { tool, execute } = makeBaseTool();
		const res = await run(wrap(tool, {}), PATCH_NORMAL);
		expect(res.isError).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("默认规则命中 .env → 触发 askApproval；用户拒绝 → 不执行", async () => {
		const { tool, execute } = makeBaseTool();
		const ask = vi.fn(async (_id: string, _name: string) => ({ decision: "deny" as const }));
		const res = await run(
			wrap(tool, { permission: "danger-full-access", askApproval: ask }),
			"[.env#abcd]\nPUT 1.=1:\n+x\n",
		);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(ask.mock.calls[0][1]).toBe("patch");
		expect(res.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("自定义 deny 规则（tools 含 patch, field path）→ 直接阻断", async () => {
		const { tool, execute } = makeBaseTool();
		const denyRule: ApprovalRule = {
			id: "custom.test",
			enabled: true,
			tools: ["patch"],
			field: "path",
			match: "contains",
			value: "secret.txt",
			action: "deny",
			label: "test",
			labelEn: "test",
		};
		const ask = vi.fn(async (_id: string, _name: string) => ({ decision: "approve" as const }));
		const res = await run(
			wrap(tool, { permission: "danger-full-access", askApproval: ask, rules: [denyRule] }),
			"[config/secret.txt]\nPUT 1.=1:\n+x\n",
		);
		expect(res.isError).toBe(true);
		expect(ask).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("审批通过 → 执行基底", async () => {
		const { tool, execute } = makeBaseTool();
		const ask = vi.fn(async (_id: string, _name: string) => ({ decision: "approve" as const }));
		const res = await run(
			wrap(tool, { permission: "danger-full-access", askApproval: ask }),
			"[.env#abcd]\nPUT 1.=1:\n+x\n",
		);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(res.isError).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("空补丁/解析失败不拦截（交引擎报错）", async () => {
		const { tool, execute } = makeBaseTool();
		const res = await run(wrap(tool, { permission: "read-only" }), "");
		expect(res.isError).toBe(true);
		const res2 = await run(wrap(tool, {}), "not a valid patch");
		expect(res2.isError).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
