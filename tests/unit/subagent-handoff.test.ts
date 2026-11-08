import { describe, expect, it, vi } from "vitest";
import {
	makeSubagentTools,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentToolHost,
} from "../../server/subagents.js";

function makeMockHost(subagents: Record<string, SubagentSnapshot> = {}): SubagentToolHost {
	return {
		spawnSubagent: vi.fn().mockResolvedValue("sa-target-1234"),
		getSubagent: vi.fn((id: string) => subagents[id]),
		listSubagents: vi.fn(() => Object.values(subagents)),
		steerSubagent: vi.fn().mockResolvedValue(undefined),
		stopSubagent: vi.fn().mockResolvedValue(undefined),
		handoffSubagent: vi.fn().mockResolvedValue(undefined),
		listTemplates: vi.fn(() => []),
		isTemplateUsable: vi.fn(() => true),
		lang: () => "zh",
	};
}

describe("subagent_handoff (Peer-to-Peer Hand-off)", () => {
	it("makeSubagentTools 只注册 conversation 一个工具（subagent 别名已删除）", () => {
		const host = makeMockHost();
		const tools = makeSubagentTools(host, () => "zh", "sa-source-1111");
		expect(tools.map((t) => t.name)).toEqual(["conversation"]);
	});

	it("不能交接给自身，交接给自身时应拒绝并返回错误提示", async () => {
		const host = makeMockHost({
			"sa-self-1111": {
				convId: "sa-self-1111",
				type: "analysis",
				title: "Self",
				prompt: "Do something",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		});
		const tools = makeSubagentTools(host, () => "zh", "sa-self-1111");
		const tool = tools.find((t) => t.name === "conversation")!;

		const result = (await tool.execute(
			"call-1",
			{
				action: "handoff",
				toRunId: "sa-self-1111",
				payload: "My analysis results",
			},
			undefined as any,
			undefined as any,
			{} as any,
		)) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0].text).toContain("不能交接给自身");
		expect(host.handoffSubagent).not.toHaveBeenCalled();
	});

	it("目标子代理不存在时，应返回未找到提示", async () => {
		const host = makeMockHost({});
		const tools = makeSubagentTools(host, () => "zh", "sa-source-1111");
		const tool = tools.find((t) => t.name === "conversation")!;

		const result = (await tool.execute(
			"call-2",
			{
				action: "handoff",
				toRunId: "sa-nonexistent",
				payload: "Some payload",
			},
			undefined as any,
			undefined as any,
			{} as any,
		)) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0].text).toContain("未找到目标子代理");
		expect(host.handoffSubagent).not.toHaveBeenCalled();
	});

	it("正常交接时，调用 host.handoffSubagent 并返回成功信息与 details", async () => {
		const host = makeMockHost({
			"sa-dev-2222": {
				convId: "sa-dev-2222",
				type: "implement",
				title: "Implement",
				prompt: "Write code",
				state: "running",
				streaming: true,
				messageCount: 2,
				output: "",
			},
		});
		const tools = makeSubagentTools(host, () => "zh", "sa-source-1111");
		const tool = tools.find((t) => t.name === "conversation")!;

		const result = (await tool.execute(
			"call-3",
			{
				action: "handoff",
				toRunId: "sa-dev-2222",
				payload: "Architecture design completed. Implement module X.",
			},
			undefined as any,
			undefined as any,
			{} as any,
		)) as {
			content: Array<{ type: string; text: string }>;
			details: { fromRunId: string; toRunId: string; timestamp: number };
		};

		expect(host.handoffSubagent).toHaveBeenCalledWith(
			"sa-source-1111",
			"sa-dev-2222",
			"Architecture design completed. Implement module X.",
		);
		expect(result.content[0].text).toContain("已成功将产物交接给同行子代理");
		expect(result.details.fromRunId).toBe("sa-source-1111");
		expect(result.details.toRunId).toBe("sa-dev-2222");
	});

	it("rejects another project's source identity before looking up or delivering to the target", async () => {
		const host = makeMockHost();
		const tool = makeSubagentTools(host, () => "en", "local-executor")[0];
		await expect(
			tool.execute(
				"spoof",
				{
					action: "handoff",
					fromRunId: "other-project-owner",
					toRunId: "peer",
					payload: "impersonated payload",
				},
				undefined,
				undefined,
				{} as any,
			),
		).rejects.toThrow("source must match");
		expect(host.getSubagent).not.toHaveBeenCalled();
		expect(host.handoffSubagent).not.toHaveBeenCalled();
	});

	it("rejects handoff without a server-resolved caller identity", async () => {
		const host = makeMockHost();
		const tool = makeSubagentTools(host, () => "en")[0];
		await expect(
			tool.execute(
				"unbound",
				{
					action: "handoff",
					fromRunId: "claimed-owner",
					toRunId: "peer",
					payload: "payload",
				},
				undefined,
				undefined,
				{} as any,
			),
		).rejects.toThrow("verified conversation identity");
		expect(host.handoffSubagent).not.toHaveBeenCalled();
	});

	it("owner wrapper uses dynamic identity and rejects stale or foreign sources", async () => {
		const host = makeMockHost();
		let owner = "initial-owner";
		const wrapped = withSubagentOwner(host, owner, () => owner);
		owner = "remapped-owner";
		await expect(wrapped.handoffSubagent("initial-owner", "peer", "payload")).rejects.toThrow("source must match");
		await expect(wrapped.handoffSubagent("other-project-owner", "peer", "payload")).rejects.toThrow(
			"source must match",
		);
		expect(host.handoffSubagent).not.toHaveBeenCalled();
		await wrapped.handoffSubagent("", "peer", "default source");
		await wrapped.handoffSubagent(owner, "peer", "explicit source");
		expect(vi.mocked(host.handoffSubagent).mock.calls).toEqual([
			[owner, "peer", "default source"],
			[owner, "peer", "explicit source"],
		]);
	});

	it("withSubagentOwner 正确传递 ownerId 作为默认来源", async () => {
		const host = makeMockHost();
		const wrapped = withSubagentOwner(host, "conv-owner-root");
		await wrapped.handoffSubagent("", "sa-target-9999", "task payload");
		expect(host.handoffSubagent).toHaveBeenCalledWith("conv-owner-root", "sa-target-9999", "task payload");
	});
});
