import { describe, expect, it, vi } from "vitest";
import {
	collectSubagentDescendantIds,
	computeWaitCapMs,
	makeSubagentTool,
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	SUBAGENT_ACTIONS,
	type SubagentToolHost,
} from "../../server/subagents.js";
import { MAX_SUBAGENTS, getMaxSubagents } from "../../server/agent-formatters.js";
import { countActiveSubagents, isSubagentActive, toSubagentSnapshot } from "../../server/subagent-helpers.js";
import type { Conversation } from "../../server/agent-service.js";
import { SUBAGENT_TOOL_NAMES } from "../../server/tool-manager.js";

/** 一个假的 host，工具调用不会真正执行会话（只验证走通与参数透传）。 */
function makeHostSpies() {
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (_prompt, type, _cwd) => `sa-${type}-abc`),
		getSubagent: vi.fn(() => undefined),
		listSubagents: vi.fn(() => []),
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		handoffSubagent: vi.fn(async () => {}),
		markSubagentsConsumed: vi.fn(),
		dismissSubagent: vi.fn(async () => ({ ok: true })),
		listTemplates: vi.fn(() => [{ name: "reviewer", description: "只读审查" }]),
		isTemplateUsable: vi.fn((name: string) => name === "reviewer"),
	};
	return host;
}

describe("subagents tools", () => {
	it("computeWaitCapMs 计算阻塞上限（#449）", () => {
		// 默认看门狗 20 分钟 -> 0.8 * 20min = 16 分钟 = 960,000ms
		expect(computeWaitCapMs()).toBe(960_000);
		// 自定义看门狗 100s -> 80,000ms
		expect(computeWaitCapMs(100_000)).toBe(80_000);
		// 看门狗极小 -> 5s 兜底
		expect(computeWaitCapMs(2_000)).toBe(5_000);

		// 环境变量覆盖
		const oldEnv = process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS;
		try {
			process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS = "120";
			expect(computeWaitCapMs(1000_000)).toBe(120_000);
		} finally {
			if (oldEnv === undefined) delete process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS;
			else process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS = oldEnv;
		}
	});

	it("SUBAGENT_TOOL_NAMES 只包含单个 subagent 工具，SUBAGENT_ACTIONS 包含 9 种 action", () => {
		expect(SUBAGENT_TOOL_NAMES).toEqual(["subagent"]);
		expect(SUBAGENT_ACTIONS).toEqual([
			"spawn",
			"get_result",
			"steer",
			"list",
			"stop",
			"wait_all",
			"templates",
			"handoff",
			"dismiss",
		]);
		const host = makeHostSpies();
		const tools = makeSubagentTools(host);
		expect(tools.map((t) => t.name)).toEqual(["subagent"]);
		const [subagent] = tools;
		expect(subagent.description.length).toBeGreaterThan(10);
		expect(subagent.description.length).toBeLessThan(700);
		expect(subagent.parameters).toBeDefined();
	});

	it("缺少 action 或未知 action 时给出明确提示", async () => {
		const host = makeHostSpies();
		const tool = makeSubagentTool(host, () => "zh");
		const r1 = (await tool.execute!("t1", {} as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r1.content[0].text).toContain("缺少 action 参数");

		const r2 = (await tool.execute!("t1", { action: "invalid_act" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r2.content[0].text).toContain("未知 action：invalid_act");
	});

	it("subagent action=spawn 透传 prompt/type/cwd/template/model 给 host", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const ctx = { cwd: "/root/proj" } as never;
		const result = (await subagent.execute!(
			"t1",
			{
				action: "spawn",
				prompt: "调研",
				type: "explore",
				template: "reviewer",
				cwd: "/other",
				model: "anthropic/claude-opus-4-5",
			} as never,
			undefined,
			undefined,
			ctx as never,
		)) as { content: { text: string }[] };
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"调研",
			"explore",
			"/other",
			"reviewer",
			"anthropic/claude-opus-4-5",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ securityMode: "verify" },
		);
		const text = result.content[0].text;
		expect(text).toContain("sa-explore-abc");
		expect(text).toContain("模板：reviewer");
		expect(text).toContain("模型：anthropic/claude-opus-4-5");
	});

	it("subagent action=spawn 缺少 prompt 时报错", async () => {
		const host = makeHostSpies();
		const tool = makeSubagentTool(host, () => "zh");
		const result = (await tool.execute!("t1", { action: "spawn" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(result.content[0].text).toContain("缺少 prompt 参数");
	});

	it("subagent action=spawn 未传 cwd 时用 ctx.cwd；不传 template/model 时按缺省", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host);
		await subagent.execute!("t1", { action: "spawn", prompt: "p" } as never, undefined, undefined, {
			cwd: "/root/proj",
		} as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"p",
			"general",
			"/root/proj",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		);
	});

	it("subagent action=spawn 支持 persist=true 创建普通持久化对话", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "spawn", prompt: "架构重构", persist: true } as never,
			undefined,
			undefined,
			{ cwd: "/root/proj" } as never,
		)) as { content: { text: string }[] };
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"架构重构",
			"general",
			"/root/proj",
			undefined,
			undefined,
			undefined,
			true,
			undefined,
			undefined,
		);
		expect(result.content[0].text).toContain("普通持久化对话已启动");
	});

	it("subagent action=spawn 模板不存在/停用时不启动并提示", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "spawn", prompt: "p", template: "ghost" } as never,
			undefined,
			undefined,
			{ cwd: "/x" } as never,
		)) as { content: { text: string }[] };
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("不可用");
		expect(result.content[0].text).toContain("ghost");
	});

	it("subagent action=spawn 启动失败转返回文本（不直接抛异常）", async () => {
		const host = makeHostSpies();
		(host.spawnSubagent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("子代理数量已达上限（16 个）"));
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!("t1", { action: "spawn", prompt: "p" } as never, undefined, undefined, {
			cwd: "/x",
		} as never)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("启动失败");
		expect(result.content[0].text).toContain("16");
	});

	it("subagent action=get_result 缺少 runId 报参数缺失；未知 runId 提示未找到", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const rMissing = (await subagent.execute!(
			"t1",
			{ action: "get_result" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(rMissing.content[0].text).toContain("缺少 runId 参数");

		const result = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "nope" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("未找到");
	});

	it("subagent action=steer / stop 透传 runId", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-1"
				? {
						convId: "sa-1",
						type: "general",
						title: "t",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
					}
				: undefined,
		);
		const [subagent] = makeSubagentTools(host);
		await subagent.execute!(
			"t1",
			{ action: "steer", runId: "sa-1", message: "改方向" } as never,
			undefined,
			undefined,
			{} as never,
		);
		await subagent.execute!("t1", { action: "stop", runId: "sa-1" } as never, undefined, undefined, {} as never);
		expect(host.steerSubagent).toHaveBeenCalledWith("sa-1", "改方向");
		expect(host.stopSubagent).toHaveBeenCalledWith("sa-1");
	});

	it("subagent action=steer / stop 对未知 runId 报未找到（不谎报成功）", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const r1 = (await subagent.execute!(
			"t1",
			{ action: "steer", runId: "ghost", message: "hi" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(r1.content[0].text).toContain("未找到");
		expect(host.steerSubagent).not.toHaveBeenCalled();

		const r2 = (await subagent.execute!(
			"t1",
			{ action: "stop", runId: "ghost" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(r2.content[0].text).toContain("未找到");
		expect(host.stopSubagent).not.toHaveBeenCalled();
	});

	it("subagent action=list 汇总 host 返回", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-1",
				type: "explore",
				title: "调研",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 3,
				output: "…",
			},
		]);
		const [subagent] = makeSubagentTools(host);
		const result = (await subagent.execute!("t1", { action: "list" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		const text = result.content[0].text;
		expect(text).toContain("sa-1");
		expect(text).toContain("explore");
		expect(text).toContain("running");
	});

	it("subagent action=templates 列出宿主返回的可用模板", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "reviewer", description: "只读审查" },
			{ name: "reporter", description: "报告整理" },
		]);
		const [subagent] = makeSubagentTools(host);
		const result = (await subagent.execute!(
			"t1",
			{ action: "templates" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("reviewer");
		expect(text).toContain("reporter");
		expect(text).toContain("subagent");
	});

	it("subagent action=templates 报出模型与思考强度（空值说「跟随主对话」）", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "thinker", description: "审查", model: "anthropic/claude-opus-4-5", thinkingLevel: "high" },
			{ name: "plain", description: "默认" },
		]);
		const [zh] = makeSubagentTools(host, () => "zh");
		const zhText = (
			(await zh.execute!("t1", { action: "templates" } as never, undefined, undefined, {} as never)) as {
				content: { text: string }[];
			}
		).content[0].text;
		expect(zhText).toContain("思考强度：high");
		expect(zhText).toContain("模型：anthropic/claude-opus-4-5");
		expect(zhText).toContain("跟随主对话模型，跟随主对话思考强度");

		const [en] = makeSubagentTools(host, () => "en");
		const enText = (
			(await en.execute!("t1", { action: "templates" } as never, undefined, undefined, {} as never)) as {
				content: { text: string }[];
			}
		).content[0].text;
		expect(enText).toContain("thinking: high");
		expect(enText).toContain("follows the main conversation thinking level");
	});

	it("subagent action=templates 空清单给出引导文案", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "templates" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("当前没有");
	});

	it("subagent action=get_result 报错子代理明确标出错误文本", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-err",
			type: "general",
			title: "调研",
			prompt: "",
			state: "done",
			streaming: false,
			error: "Error from provider (Console Go): Upstream request failed: [400] Provider returned error",
			messageCount: 2,
			output: "",
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "sa-err" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("error（报错）");
		expect(result.content[0].text).toContain("400");
	});

	it("subagent action=wait_all 等到全部终态后汇总结果（含错误标记）", async () => {
		const host = makeHostSpies();
		const sa1 = {
			convId: "sa-1",
			type: "explore",
			title: "调研 A",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 3,
			output: "结论 A",
		};
		const sa2 = {
			convId: "sa-2",
			type: "review",
			title: "审查 B",
			prompt: "",
			state: "done",
			streaming: false,
			error: "provider 400",
			messageCount: 2,
			output: "",
		};
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (id === "sa-2" ? sa2 : sa1));
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-1", "sa-2"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("全部 2 个子代理已收口");
		expect(result.content[0].text).toContain("结论 A");
		expect(result.content[0].text).toContain("provider 400");
	});

	it("subagent action=wait_all 调用者自身永不计入等待（防 self-wait deadlock）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-self",
				type: "general",
				title: "我自己",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
			{
				convId: "sa-other",
				type: "explore",
				title: "别人",
				prompt: "",
				state: "done",
				streaming: false,
				messageCount: 1,
				output: "已完成",
				parentId: "sa-self",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			(host.listSubagents() as { convId: string }[]).find((x) => x.convId === id),
		);
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-self");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("全部 1 个子代理已收口");
		expect(result.content[0].text).not.toContain("我自己");
		expect(result.content[0].text).toContain("别人");
	});

	it("subagent action=wait_all 排除自身后为空时直接返回（不等超时）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-self",
				type: "general",
				title: "我自己",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		]);
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-self");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("没有需要等待的子代理");
	});

	it("subagent action=wait_all 显式 runIds 里含自身时同样排除", async () => {
		const host = makeHostSpies();
		const other = {
			convId: "sa-other",
			type: "general",
			title: "同伴",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 1,
			output: "ok",
		};
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue(other);
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-self");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-self", "sa-other"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("全部 1 个子代理已收口");
		expect(result.content[0].text).toContain("sa-other");
	});

	it("subagent action=wait_all 长输出留头留尾（结论在尾部不能丢）", async () => {
		const host = makeHostSpies();
		const longLines = [
			"TASK: 重构鉴权模块",
			...Array.from({ length: 100 }, (_, i) => `中间日志 ${i + 1}：处理中…`),
			"VERDICT: 重构成功完成，全量单测通过",
		].join("\n");
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-long",
			type: "implement",
			title: "重构",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 2,
			output: longLines,
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-long"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("TASK: 重构鉴权模块");
		expect(text).toContain("VERDICT: 重构成功完成");
		expect(text).toContain("中间省略");
	});

	it("subagent action=wait_all 短输出原样返回（不加省略标记）", async () => {
		const host = makeHostSpies();
		const shortOutput = "第一行\n第二行\n结论：OK";
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-short",
			type: "review",
			title: "审查",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 2,
			output: shortOutput,
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-short"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain(shortOutput);
		expect(result.content[0].text).not.toContain("省略");
	});

	it("subagent action=wait_all 空 runIds 时等当前全部运行中的子代理", async () => {
		const host = makeHostSpies();
		const runningList = [
			{
				convId: "sa-a",
				type: "explore",
				title: "A",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "done A",
			},
			{
				convId: "sa-b",
				type: "implement",
				title: "B",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(runningList);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			runningList.find((x) => x.convId === id),
		);
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("超时");
		expect(text).toContain("1 个仍在运行");
		expect(text).toContain("sa-b");
	});

	it("subagent action=wait_all 两层嵌套：子代理无参只等后代，不等父级/无关兄弟", async () => {
		const host = makeHostSpies();
		const all = [
			{
				convId: "sa-root",
				type: "explore",
				title: "爷爷",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-uncle",
				type: "explore",
				title: "叔叔",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-root",
			},
			{
				convId: "sa-parent",
				type: "implement",
				title: "父级",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-root",
			},
			{
				convId: "sa-child",
				type: "review",
				title: "孩子",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "孩子完成",
				parentId: "sa-parent",
			},
			{
				convId: "sa-grandchild",
				type: "review",
				title: "孙子",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "孙子完成",
				parentId: "sa-child",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(all);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => all.find((x) => x.convId === id));
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-parent");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("全部 2 个子代理已收口");
		expect(text).toContain("sa-child");
		expect(text).toContain("sa-grand");
		expect(text).not.toContain("sa-root");
		expect(text).not.toContain("sa-uncle");
		expect(text).not.toContain("父级");
	});

	it("subagent action=wait_all 叶子无参等待父级时直接返回空（不等超时）", async () => {
		const host = makeHostSpies();
		const all = [
			{
				convId: "sa-parent",
				type: "implement",
				title: "父级",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-leaf",
				type: "review",
				title: "叶子",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-parent",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(all);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => all.find((x) => x.convId === id));
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-leaf");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("没有需要等待的子代理");
	});

	it("subagent action=wait_all 显式 runIds 含祖先时剔除祖先（不死锁）", async () => {
		const host = makeHostSpies();
		const all = [
			{
				convId: "sa-parent",
				type: "implement",
				title: "父级",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-leaf",
				type: "review",
				title: "叶子",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-parent",
			},
			{
				convId: "sa-other",
				type: "review",
				title: "同辈",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "同辈搞定",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(all);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => all.find((x) => x.convId === id));
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-leaf");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-parent", "sa-other"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("全部 1 个子代理已收口");
		expect(text).toContain("sa-other");
		expect(text).not.toContain("sa-parent");
	});

	it("subagent action=wait_all 动态遵从实时的看门狗时钟（防止看门狗下调后误杀）", async () => {
		const host = makeHostSpies();
		let watchdog = 1_200_000;
		(host as unknown as { getWatchdogTimeoutMs: () => number }).getWatchdogTimeoutMs = () => watchdog;
		const [subagent] = makeSubagentTools(host, () => "zh");
		// 动态调低看门狗：兜底下限 5000ms
		watchdog = 6_000; // computeWaitCapMs: Math.max(4800, 5000) = 5000ms (5s)
		const runningList = [
			{
				convId: "sa-dyn",
				type: "general",
				title: "慢任务",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(runningList);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			runningList.find((x) => x.convId === id),
		);
		const start = Date.now();
		// 传入 timeoutSeconds: 60，应当被 liveCapSeconds (5s) 压制，在 ~5s 超时而非 60s
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 60 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(4900);
		expect(elapsed).toBeLessThan(7000);
		expect(result.content[0].text).toContain("超时");
	}, 10_000);
});

describe("collectSubagentDescendantIds 纯函数", () => {
	it("树状后代收集：含嵌套的嵌套，不含自身，不含无关兄弟", () => {
		const items = [
			{ id: "root", isSubagent: true },
			{ id: "c1", parentId: "root", isSubagent: true },
			{ id: "c2", parentId: "root", isSubagent: true },
			{ id: "gc1", parentId: "c1", isSubagent: true },
			{ id: "other", isSubagent: true },
			{ id: "not-sa", parentId: "root", isSubagent: false },
		];
		const desc = collectSubagentDescendantIds(items, "root");
		expect(desc.sort()).toEqual(["c1", "c2", "gc1"].sort());
	});

	it("parentId 环按 visited 截断，不死循环", () => {
		const items = [
			{ id: "a", parentId: "b", isSubagent: true },
			{ id: "b", parentId: "a", isSubagent: true },
		];
		expect(() => collectSubagentDescendantIds(items, "root")).not.toThrow();
		expect(collectSubagentDescendantIds(items, "root")).toEqual([]);
	});
});

describe("subagentTitle 辅助函数", () => {
	it("取首行并截断 40 字符", () => {
		expect(subagentTitle("短标题")).toBe("短标题");
		expect(subagentTitle("第一行\n第二行")).toBe("第一行");
		expect(subagentTitle("x".repeat(80))).toHaveLength(41);
	});
});

describe("subagents language (issue #91)", () => {
	it("默认英文：未知 runId / 空模板清单返回英文", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const [subagent] = makeSubagentTools(host);
		const r1 = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "nope" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(r1.content[0].text).toContain("not found");

		const r2 = (await subagent.execute!("t1", { action: "templates" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r2.content[0].text).toContain("No subagent templates");
	});

	it("工具 definition 为纯英文（无双语内联）", () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host);
		expect(subagent.description).toContain("subagent");
		expect(subagent.description).not.toMatch(/[\u4e00-\u9fff]/);
	});
});

describe("withSubagentOwner (issue #95)", () => {
	it("包装后 spawn 自动把 ownerId（真正的派发会话）作为父对话传入", async () => {
		const host = makeHostSpies();
		const owned = withSubagentOwner(host, "c1");
		const [subagent] = makeSubagentTools(owned);
		await subagent.execute!("t1", { action: "spawn", prompt: "p" } as never, undefined, undefined, {
			cwd: "/p1",
		} as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"p",
			"general",
			"/p1",
			undefined,
			undefined,
			"c1",
			undefined,
			undefined,
			undefined,
		);
	});

	it("包装不影响其余 host 方法透传", async () => {
		const host = makeHostSpies();
		const owned = withSubagentOwner(host, "c1");
		expect(owned.listTemplates()).toEqual([{ name: "reviewer", description: "只读审查" }]);
		expect(owned.isTemplateUsable("reviewer")).toBe(true);
		expect(owned.isTemplateUsable("ghost")).toBe(false);
	});
});

describe("subagent parent retention", () => {
	it("有存活子代理指向父对话时保留父对话", () => {
		type Conv = { id: string; parentId?: string };
		const convs = new Map<string, Conv>([
			["c1", { id: "c1" }],
			["sa-1", { id: "sa-1", parentId: "c1" }],
		]);
		const hasLiveChild = (id: string) => [...convs.values()].some((child) => child.parentId === id);
		expect(hasLiveChild("c1")).toBe(true);
		convs.delete("sa-1");
		expect(hasLiveChild("c1")).toBe(false);
	});
});

describe("active subagent quota & retention decoupling (issue #589)", () => {
	function makeFakeConv(opts: {
		id: string;
		isSubagent?: boolean;
		isStreaming?: boolean;
		promptInFlight?: boolean;
		stopReason?: string;
	}): Conversation {
		return {
			id: opts.id,
			title: opts.id,
			isSubagent: opts.isSubagent ?? true,
			promptInFlight: opts.promptInFlight ?? false,
			subagentType: "explore",
			subagentPrompt: "task",
			createdAt: 1,
			session: {
				isStreaming: opts.isStreaming ?? false,
				agent: {
					state: {
						messages: opts.stopReason ? [{ role: "assistant", stopReason: opts.stopReason }] : [],
					},
				},
				getSessionStats: () => ({ totalMessages: 2 }),
				getLastAssistantText: () => "done text",
			},
		} as unknown as Conversation;
	}

	it("isSubagentActive 仅将流式中或首轮投递中的子代理计为活跃，已终态子代理与普通对话不占名额", () => {
		const runningSa = makeFakeConv({ id: "sa-run", isSubagent: true, isStreaming: true });
		const bootingSa = makeFakeConv({ id: "sa-boot", isSubagent: true, isStreaming: false, promptInFlight: true });
		const doneSa = makeFakeConv({ id: "sa-done", isSubagent: true, isStreaming: false, stopReason: "end_turn" });
		const canceledSa = makeFakeConv({ id: "sa-cancel", isSubagent: true, isStreaming: false, stopReason: "aborted" });
		const regularRunning = makeFakeConv({ id: "conv-1", isSubagent: false, isStreaming: true });

		expect(isSubagentActive(runningSa)).toBe(true);
		expect(isSubagentActive(bootingSa)).toBe(true);
		expect(isSubagentActive(doneSa)).toBe(false);
		expect(isSubagentActive(canceledSa)).toBe(false);
		expect(isSubagentActive(regularRunning)).toBe(false);

		// 即使存在 20 个已终态子代理保留在左栏，活跃名额只计 running + booting + 在途 spawning
		const finishedBatch = Array.from({ length: 20 }, (_, i) =>
			makeFakeConv({ id: `sa-fin-${i}`, isSubagent: true, isStreaming: false, stopReason: "end_turn" }),
		);
		const all = [...finishedBatch, runningSa, bootingSa, regularRunning];
		expect(countActiveSubagents(all)).toBe(2);
		expect(countActiveSubagents(all, 3)).toBe(5);
	});

	it("toSubagentSnapshot 在首轮 promptInFlight 窗口内保持 running，落定后转为 done/canceled", () => {
		const booting = makeFakeConv({ id: "sa-boot", isSubagent: true, isStreaming: false, promptInFlight: true });
		const snapBoot = toSubagentSnapshot(booting);
		expect(snapBoot.streaming).toBe(true);
		expect(snapBoot.state).toBe("running");

		booting.promptInFlight = false;
		const snapDone = toSubagentSnapshot(booting);
		expect(snapDone.streaming).toBe(false);
		expect(snapDone.state).toBe("done");
	});

	it("getMaxSubagents 默认返回 MAX_SUBAGENTS (16)，支持 PI_WEB_MAX_SUBAGENTS 覆盖", () => {
		const prev = process.env.PI_WEB_MAX_SUBAGENTS;
		try {
			delete process.env.PI_WEB_MAX_SUBAGENTS;
			expect(getMaxSubagents()).toBe(MAX_SUBAGENTS);
			expect(getMaxSubagents()).toBe(16);

			process.env.PI_WEB_MAX_SUBAGENTS = "32";
			expect(getMaxSubagents()).toBe(32);

			process.env.PI_WEB_MAX_SUBAGENTS = "0";
			expect(getMaxSubagents()).toBe(16);

			process.env.PI_WEB_MAX_SUBAGENTS = "invalid";
			expect(getMaxSubagents()).toBe(16);
		} finally {
			if (prev === undefined) delete process.env.PI_WEB_MAX_SUBAGENTS;
			else process.env.PI_WEB_MAX_SUBAGENTS = prev;
		}
	});
});

describe("Issue #713 subagent thinking, notification & information flow", () => {
	it("spawn 支持指定 thinking 与 notifyOnDone 参数", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const res = (await subagent.execute!(
			"t1",
			{
				action: "spawn",
				prompt: "深度排查",
				thinking: "high",
				notifyOnDone: false,
			} as never,
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		)) as { content: { text: string }[]; details: Record<string, unknown> };

		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"深度排查",
			"general",
			"/proj",
			undefined,
			undefined,
			undefined,
			undefined,
			"high",
			false,
		);
		expect(res.content[0].text).toContain("思考强度：high");
		expect(res.content[0].text).toContain("自动通知：已关闭");
		expect(res.details.thinking).toBe("high");
		expect(res.details.notifyOnDone).toBe(false);
	});

	it("spawn 非法思考强度直接拦截并报错", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const res = (await subagent.execute!(
			"t1",
			{
				action: "spawn",
				prompt: "测试",
				thinking: "ultra-huge",
			} as never,
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		)) as { content: { text: string }[] };

		expect(host.spawnSubagent).not.toHaveBeenCalled();
		expect(res.content[0].text).toContain("非法思考强度：ultra-huge");
		expect(res.content[0].text).toContain("可选档位");
	});

	it("get_result 在终态时展示 model与thinking 并标记 markSubagentsConsumed", async () => {
		const host = makeHostSpies();
		(host.getSubagent as any).mockReturnValue({
			convId: "sa-test-1234",
			type: "explore",
			title: "寻找瓶颈",
			prompt: "寻找瓶颈",
			state: "done",
			streaming: false,
			messageCount: 5,
			model: "anthropic/claude-3-7-sonnet",
			thinkingLevel: "high",
			output: "发现问题所在",
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const res = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "sa-test-1234" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };

		expect(res.content[0].text).toContain("anthropic/claude-3-7-sonnet:high");
		expect(host.markSubagentsConsumed).toHaveBeenCalledWith(["sa-test-1234"]);
	});

	it("list 展示子代理实际模型与思考强度", async () => {
		const host = makeHostSpies();
		(host.listSubagents as any).mockReturnValue([
			{
				convId: "sa-1",
				type: "explore",
				title: "任务1",
				prompt: "任务1",
				state: "done",
				streaming: false,
				messageCount: 2,
				model: "openai/gpt-4o",
				thinkingLevel: "low",
				output: "ok",
			},
		]);
		const [subagent] = makeSubagentTools(host, () => "zh");
		const res = (await subagent.execute!("t1", { action: "list" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};

		expect(res.content[0].text).toContain("sa-1 · explore · openai/gpt-4o:low · done");
	});

	it("wait_all 收集终态子代理后标记 markSubagentsConsumed", async () => {
		const host = makeHostSpies();
		(host.getSubagent as any).mockImplementation((id: string) => ({
			convId: id,
			type: "explore",
			title: `Task ${id}`,
			prompt: `Task ${id}`,
			state: "done",
			streaming: false,
			messageCount: 3,
			output: "finished",
		}));
		const [subagent] = makeSubagentTools(host, () => "zh");
		await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-1", "sa-2"] } as never,
			undefined,
			undefined,
			{} as never,
		);

		expect(host.markSubagentsConsumed).toHaveBeenCalledWith(expect.arrayContaining(["sa-1", "sa-2"]));
	});

	describe("subagent(action='dismiss') 回收已结束子代理与安全护栏", () => {
		it("缺少目标参数时报错并指导传参", async () => {
			const host = makeHostSpies();
			const [tool] = makeSubagentTools(host, () => "zh");
			const res = (await tool.execute!("t1", { action: "dismiss" } as never, undefined, undefined, {} as never)) as {
				content: { text: string }[];
			};
			expect(res.content[0].text).toContain("缺少目标参数");
			expect(res.content[0].text).toContain('scope="finished_all"');
		});

		it("引擎未提供 dismissSubagent 实现时返回不支持提示", async () => {
			const host = makeHostSpies();
			delete host.dismissSubagent;
			const [tool] = makeSubagentTools(host, () => "zh");
			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-123" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(res.content[0].text).toContain("当前引擎不支持子代理移出能力");
		});

		it("单个终态子代理成功移出并返回不可逆提示与 get_result 引导", async () => {
			const host = makeHostSpies();
			(host.getSubagent as any).mockReturnValue({
				convId: "sa-done-1",
				type: "explore",
				title: "调研任务",
				prompt: "调研任务",
				state: "done",
				streaming: false,
				messageCount: 5,
				output: "完成",
				parentId: "c1",
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");
			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-done-1" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[]; details: any };

			expect(host.dismissSubagent).toHaveBeenCalledWith("sa-done-1", {
				force: undefined,
				includePersisted: undefined,
			});
			expect(res.content[0].text).toContain("已移出子代理 sa-done-");
			expect(res.content[0].text).toContain("移出后不可逆");
			expect(res.content[0].text).toContain('subagent(action="get_result")');
			expect(res.details.dismissed).toEqual(["sa-done-1"]);
		});

		it("未找到子代理时返回明确错误", async () => {
			const host = makeHostSpies();
			(host.getSubagent as any).mockReturnValue(undefined);
			const [tool] = makeSubagentTools(host, () => "zh", "c1");
			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-missing" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };

			expect(res.content[0].text).toContain("未找到子代理 sa-missi（可能已移出或不存在）");
		});

		it("护栏1：拒绝移出调用者自身与前端当前激活会话", async () => {
			const host = makeHostSpies();
			host.getActiveConversationId = vi.fn(() => "sa-active-viewing");
			(host.getSubagent as any).mockImplementation((id: string) => ({
				convId: id,
				type: "explore",
				title: id,
				prompt: id,
				state: "done",
				streaming: false,
				messageCount: 1,
				output: "ok",
				parentId: "c1",
			}));
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			// 移出当前自身 -> 拒绝
			const resSelf = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "c1" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(resSelf.content[0].text).toContain("不能移出当前会话自身");

			// 移出前端处于 active 打开态的子代理 -> 拒绝
			const resActive = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-active-viewing" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(resActive.content[0].text).toContain("正在前端处于活动打开状态，无法直接移出");
		});

		it("护栏2：运行中子代理无 force 拒绝，带 force=true 强行中止移出", async () => {
			const host = makeHostSpies();
			(host.getSubagent as any).mockReturnValue({
				convId: "sa-running-1",
				type: "explore",
				title: "运行中任务",
				prompt: "运行中任务",
				state: "running",
				streaming: true,
				messageCount: 3,
				output: "running...",
				parentId: "c1",
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			// 无 force -> 拒绝
			const resRefuse = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-running-1" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(resRefuse.content[0].text).toContain("仍在运行中（状态：running）");
			expect(resRefuse.content[0].text).toContain("force=true 强行中止并移出");
			expect(host.dismissSubagent).not.toHaveBeenCalled();

			// 带 force=true -> 成功放行
			const resForce = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-running-1", force: true } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(host.dismissSubagent).toHaveBeenCalledWith("sa-running-1", {
				force: true,
				includePersisted: undefined,
			});
			expect(resForce.content[0].text).toContain("已移出子代理 sa-runni");
		});

		it("护栏3：拒绝跨父移出非本会话派发族谱的子代理", async () => {
			const host = makeHostSpies();
			(host.getSubagent as any).mockImplementation((id: string) => {
				if (id === "sa-stranger") {
					return {
						convId: "sa-stranger",
						type: "explore",
						title: "异族子代理",
						prompt: "异族子代理",
						state: "done",
						streaming: false,
						messageCount: 2,
						output: "done",
						parentId: "c-other-chat",
					};
				}
				if (id === "c-other-chat") {
					return {
						convId: "c-other-chat",
						parentId: undefined,
					};
				}
				return undefined;
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-stranger" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(res.content[0].text).toContain("不属于当前会话的派发族谱（仅允许移出由当前会话派发的子代理）");
			expect(host.dismissSubagent).not.toHaveBeenCalled();
		});

		it("护栏4：持久化子代理无 includePersisted 拒绝，显式指定后允许", async () => {
			const host = makeHostSpies();
			(host.getSubagent as any).mockReturnValue({
				convId: "conv-persisted-1",
				type: "explore",
				title: "持久化对话",
				prompt: "持久化对话",
				state: "done",
				streaming: false,
				messageCount: 5,
				output: "done",
				parentId: "c1",
				persisted: true,
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			// 默认拒绝
			const resDenied = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "conv-persisted-1" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(resDenied.content[0].text).toContain("为持久化会话（已落盘历史）");
			expect(resDenied.content[0].text).toContain("includePersisted=true");
			expect(host.dismissSubagent).not.toHaveBeenCalled();

			// 传入 includePersisted=true -> 放行
			const resAllowed = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "conv-persisted-1", includePersisted: true } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(host.dismissSubagent).toHaveBeenCalledWith("conv-persisted-1", {
				force: undefined,
				includePersisted: true,
			});
			expect(resAllowed.content[0].text).toContain("已移出子代理 conv-per");
		});

		it("护栏5：脏工作树拒绝移出并给出详细改动信息与合并/清理指引", async () => {
			const host = makeHostSpies();
			host.finalizeSubagentWorktree = vi.fn(async () => {});
			(host.getSubagent as any).mockReturnValue({
				convId: "sa-dirty-wt",
				type: "explore",
				title: "改动任务",
				prompt: "改动任务",
				state: "done",
				streaming: false,
				messageCount: 4,
				output: "done",
				parentId: "c1",
				worktree: {
					path: "/repo/.worktrees/sa-dirty-wt",
					branch: "subagent/sa-dirty-wt",
					cleanedUp: false,
					isDirty: true,
					uncommittedCount: 3,
					aheadCount: 2,
				},
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-dirty-wt" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };
			expect(host.finalizeSubagentWorktree).toHaveBeenCalledWith("sa-dirty-wt");
			expect(res.content[0].text).toContain("工作树存在未合并改动，无法移出（静默移出会丢失代码）");
			expect(res.content[0].text).toContain("路径：/repo/.worktrees/sa-dirty-wt");
			expect(res.content[0].text).toContain("分支：subagent/sa-dirty-wt");
			expect(res.content[0].text).toContain("未提交改动：3 个文件，领先提交：2 个");
			expect(res.content[0].text).toContain("git merge subagent/sa-dirty-wt");
			expect(res.content[0].text).toContain('worktree(action="remove"');
			expect(host.dismissSubagent).not.toHaveBeenCalled();
		});

		it("批量移出：runIds 支持多目标且深度优先排序（子级先于父级移出）", async () => {
			const host = makeHostSpies();
			const calls: string[] = [];
			(host.dismissSubagent as any).mockImplementation(async (id: string) => {
				calls.push(id);
				return { ok: true };
			});
			(host.getSubagent as any).mockImplementation((id: string) => {
				if (id === "sa-parent") {
					return {
						convId: "sa-parent",
						type: "general",
						title: "父任务",
						prompt: "父任务",
						state: "done",
						streaming: false,
						messageCount: 2,
						output: "ok",
						parentId: "c1",
					};
				}
				if (id === "sa-child") {
					return {
						convId: "sa-child",
						type: "general",
						title: "子任务",
						prompt: "子任务",
						state: "done",
						streaming: false,
						messageCount: 2,
						output: "ok",
						parentId: "sa-parent",
					};
				}
				return undefined;
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runIds: ["sa-parent", "sa-child"] } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[]; details: any };

			expect(calls).toEqual(["sa-child", "sa-parent"]);
			expect(res.content[0].text).toContain("已成功移出 2 个子代理");
			expect(res.details.dismissed).toEqual(["sa-child", "sa-parent"]);
		});

		it("批量移出：scope='finished_all' 自动搜集本族已结束子代理", async () => {
			const host = makeHostSpies();
			const list = [
				{
					convId: "sa-done-1",
					type: "explore",
					title: "任务1",
					prompt: "任务1",
					state: "done",
					streaming: false,
					messageCount: 2,
					output: "ok",
					parentId: "c1",
				},
				{
					convId: "sa-done-2",
					type: "explore",
					title: "任务2",
					prompt: "任务2",
					state: "done",
					streaming: false,
					messageCount: 2,
					output: "ok",
					parentId: "c1",
				},
				{
					convId: "sa-running-3",
					type: "explore",
					title: "任务3仍在跑",
					prompt: "任务3",
					state: "running",
					streaming: true,
					messageCount: 2,
					output: "running",
					parentId: "c1",
				},
			];
			(host.listSubagents as any).mockReturnValue(list);
			(host.getSubagent as any).mockImplementation((id: string) => list.find((s) => s.convId === id));

			const [tool] = makeSubagentTools(host, () => "zh", "c1");
			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", scope: "finished_all" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[]; details: any };

			expect(host.dismissSubagent).toHaveBeenCalledWith("sa-done-1", {
				force: undefined,
				includePersisted: undefined,
			});
			expect(host.dismissSubagent).toHaveBeenCalledWith("sa-done-2", {
				force: undefined,
				includePersisted: undefined,
			});
			expect(host.dismissSubagent).not.toHaveBeenCalledWith("sa-running-3", expect.anything());
			expect(res.content[0].text).toContain("已成功移出 2 个子代理");
		});

		it("批量移出：scope='finished_all' 当无任何可移出子代理时返回空提示", async () => {
			const host = makeHostSpies();
			(host.listSubagents as any).mockReturnValue([]);
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", scope: "finished_all" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] };

			expect(res.content[0].text).toContain("没有可移出的已结束子代理");
			expect(host.dismissSubagent).not.toHaveBeenCalled();
		});

		it("过户改名后通过旧 id 移出子代理：host 透传旧 id 且正确回收", async () => {
			const host = makeHostSpies();
			(host.getSubagent as any).mockImplementation((id: string) => {
				if (id === "sa-old-123" || id === "sa-renamed-456") {
					return {
						convId: "sa-renamed-456",
						type: "explore",
						title: "过户任务",
						prompt: "过户任务",
						state: "done",
						streaming: false,
						messageCount: 3,
						output: "ok",
						parentId: "c1",
					};
				}
				return undefined;
			});
			const [tool] = makeSubagentTools(host, () => "zh", "c1");

			const res = (await tool.execute!(
				"t1",
				{ action: "dismiss", runId: "sa-old-123" } as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[]; details: any };

			expect(host.dismissSubagent).toHaveBeenCalledWith("sa-old-123", {
				force: undefined,
				includePersisted: undefined,
			});
			expect(res.content[0].text).toContain("已移出子代理 sa-old-1");
			expect(res.details.dismissed).toEqual(["sa-old-123"]);
		});
	});
});
