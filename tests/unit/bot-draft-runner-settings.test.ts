/**
 * 起草器必须**每次现取**设置里的模型与思考强度（用户在设置 →「智能体」里改完就生效）。
 *
 * 这里用假的 runtime 盯两层：
 * 1. 指定的模型排在候选首位，`reasoning` 跟着设置走（`off` 不传）；
 * 2. 两次起草之间改设置 → 第二次用的是新值（不是启动时那一份快照）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/quick-ask.js", () => ({ createQuickAskRuntime: vi.fn() }));

const { createBotDraftRunner } = await import("../../server/bot-draft-runner");
const { createQuickAskRuntime } = await import("../../server/quick-ask.js");

const DRAFT_JSON = JSON.stringify({
	name: "视频剪辑助手",
	description: "把长视频剪成短视频",
	systemPrompt: "You cut videos.",
	tools: [],
	rationale: "smallest set",
});

type Model = { provider: string; id: string };

function fakeRuntime(available: Model[], calls: { model: Model; reasoning?: string }[]) {
	const completeSimple = vi.fn(async (model: Model, _ctx: unknown, options: { reasoning?: string }) => {
		calls.push(options.reasoning ? { model, reasoning: options.reasoning } : { model });
		return { stopReason: "stop", content: [{ type: "text", text: DRAFT_JSON }] };
	});
	return {
		getModel: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
		getAvailable: async () => available,
		completeSimple,
	};
}

function runnerFor(settings: () => { model?: string; thinking?: string }) {
	const calls: { model: Model; reasoning?: string }[] = [];
	const available: Model[] = [
		{ provider: "opencode-go", id: "cat-jam-free" },
		{ provider: "opencode-go", id: "glm-5.3-flash" },
	];
	vi.mocked(createQuickAskRuntime).mockResolvedValue(fakeRuntime(available, calls) as never);
	const runner = createBotDraftRunner({
		agentDir: "/tmp/agent",
		cwd: "/tmp/work",
		allowedTools: new Set<string>(),
		model: () => settings().model,
		thinking: () => settings().thinking as never,
		create: async (input) => ({ ...input, id: "draft-1", createdAt: Date.now(), createdBy: "model" }) as never,
	});
	return { runner, calls };
}

beforeEach(() => vi.mocked(createQuickAskRuntime).mockReset());

describe("起草器读取设置", () => {
	it("设置里的模型优先，思考强度作为 reasoning 传下去", async () => {
		const { runner, calls } = runnerFor(() => ({ model: "opencode-go/glm-5.3-flash", thinking: "high" }));
		await runner("做个剪视频的 Bot");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ model: { provider: "opencode-go", id: "glm-5.3-flash" }, reasoning: "high" });
	});

	it("思考强度 off 时不传 reasoning（别让 provider 白开思考）", async () => {
		const { runner, calls } = runnerFor(() => ({ thinking: "off" }));
		await runner("做个剪视频的 Bot");
		expect(calls[0].reasoning).toBeUndefined();
	});

	it("未指定模型时回落到可用列表首位", async () => {
		const { runner, calls } = runnerFor(() => ({}));
		await runner("做个剪视频的 Bot");
		expect(calls[0].model).toEqual({ provider: "opencode-go", id: "cat-jam-free" });
	});

	it("两次起草之间改设置立即生效（不是启动快照）", async () => {
		let settings: { model?: string; thinking?: string } = { model: "opencode-go/glm-5.3-flash", thinking: "low" };
		const { runner, calls } = runnerFor(() => settings);
		await runner("第一次");
		settings = { model: "opencode-go/cat-jam-free", thinking: "xhigh" };
		await runner("第二次");
		expect(calls.map((call) => [call.model.id, call.reasoning])).toEqual([
			["glm-5.3-flash", "low"],
			["cat-jam-free", "xhigh"],
		]);
	});
});
