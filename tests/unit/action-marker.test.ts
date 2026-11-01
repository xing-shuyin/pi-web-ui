import { describe, expect, it } from "vitest";
import { actionMarker, suggestMarker, initActionState } from "../../server/markers/builtins/action.js";
import { MarkerService, type MarkerHost } from "../../server/marker-service.js";
import type { ClientStateStore, MarkerSettings } from "../../server/client-state.js";
import type { MarkerContext, ParsedToken } from "../../server/markers/marker.js";

function makeContext(conversationId = "conv-test"): MarkerContext {
	return {
		conversationId,
		notify: () => {},
		renameConversation: () => {},
	};
}

describe("actionMarker 单元测试", () => {
	it("初始化状态为空", () => {
		const state = initActionState();
		expect(state.actions).toEqual([]);
		expect(state.nextId).toBe(1);
	});

	it("添加快捷建议操作：基础文本", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "suggest",
			args: ["继续下一步"],
			kwargs: {},
			raw: "[[action:suggest:继续下一步]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(true);
		expect(state.actions.length).toBe(1);
		expect(state.actions[0].label).toBe("继续下一步");
		expect(state.actions[0].prompt).toBe("继续下一步");
	});

	it("支持区分 label 与 prompt", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "suggest",
			args: ["继续"],
			kwargs: { prompt: "请继续实施下一阶段计划" },
			raw: "[[action:suggest:继续,prompt=请继续实施下一阶段计划]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(true);
		expect(state.actions[0].label).toBe("继续");
		expect(state.actions[0].prompt).toBe("请继续实施下一阶段计划");
	});

	it("支持 kwargs 格式 (label=..., prompt=...)", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "suggest",
			args: [],
			kwargs: { label: "运行测试", prompt: "npm run test:smoke" },
			raw: "[[action:suggest:label=运行测试,prompt=npm run test:smoke]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(true);
		expect(state.actions[0].label).toBe("运行测试");
		expect(state.actions[0].prompt).toBe("npm run test:smoke");
	});

	it("支持逗号连接的参数文本", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "suggest",
			args: ["是", "请继续执行"],
			kwargs: {},
			raw: "[[action:suggest:是,请继续执行]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(true);
		expect(state.actions[0].label).toBe("是,请继续执行");
		expect(state.actions[0].prompt).toBe("是,请继续执行");
	});

	it("清空操作", async () => {
		const state = initActionState();
		const ctx = makeContext();
		state.actions.push({ id: "act-1", label: "A", prompt: "A" });
		const token: ParsedToken = {
			tool: "action",
			op: "clear",
			args: ["all"],
			kwargs: {},
			raw: "[[action:clear:all]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(true);
		expect(state.actions).toEqual([]);
	});

	it("防重复添加相同 label 与 prompt", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "suggest",
			args: ["重复操作"],
			kwargs: {},
			raw: "[[action:suggest:重复操作]]",
		};
		await actionMarker.apply(token, ctx, state, "zh");
		await actionMarker.apply(token, ctx, state, "zh");
		expect(state.actions.length).toBe(1);
	});

	it("最多保留 8 个操作（超限淘汰最旧的）", async () => {
		const state = initActionState();
		const ctx = makeContext();
		for (let i = 1; i <= 10; i++) {
			await actionMarker.apply(
				{
					tool: "action",
					op: "suggest",
					args: [`操作-${i}`],
					kwargs: {},
					raw: `[[action:suggest:操作-${i}]]`,
				},
				ctx,
				state,
				"zh",
			);
		}
		expect(state.actions.length).toBe(8);
		expect(state.actions[0].label).toBe("操作-3");
		expect(state.actions[7].label).toBe("操作-10");
	});

	it("空文本时报错", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "suggest",
			args: [],
			kwargs: {},
			raw: "[[action:suggest:]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(false);
		expect(res.error).toBeDefined();
	});

	it("未知操作时报错", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "action",
			op: "unknown_op",
			args: ["测试"],
			kwargs: {},
			raw: "[[action:unknown_op:测试]]",
		};
		const res = await actionMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(false);
		expect(res.error).toContain("unknown");
	});

	it("overlay 生成", () => {
		const state = initActionState();
		expect(actionMarker.overlay!(state, makeContext())).toBeUndefined();
		state.actions.push({ id: "act-1", label: "继续", prompt: "继续" });
		state.actions.push({ id: "act-2", label: "重试", prompt: "重试执行当前任务" });
		const ov = actionMarker.overlay!(state, makeContext());
		expect(ov).toBeDefined();
		expect(ov?.tool).toBe("action");
		expect(ov?.lines.length).toBe(3);
		expect(ov?.lines[1]).toContain("[继续]");
		expect(ov?.lines[2]).toContain("[重试] -> 重试执行当前任务");
	});

	it("suggest 别名与 action 保持一致", async () => {
		const state = initActionState();
		const ctx = makeContext();
		const token: ParsedToken = {
			tool: "suggest",
			op: "next",
			args: ["建议下一步"],
			kwargs: {},
			raw: "[[suggest:next:建议下一步]]",
		};
		const res = await suggestMarker.apply(token, ctx, state, "zh");
		expect(res.applied).toBe(true);
		expect(state.actions.length).toBe(1);
		expect(state.actions[0].label).toBe("建议下一步");
	});

	it("多语言 guidance", () => {
		const zh = actionMarker.getGuidance!("zh");
		const en = actionMarker.getGuidance!("en");
		expect(zh.join("\n")).toMatch(/[\u4e00-\u9fff]/);
		expect(en.join("\n")).not.toMatch(/[\u4e00-\u9fff]/);
	});
});

describe("MarkerService 建议操作集成测试", () => {
	function createService(settings: MarkerSettings = { markersEnabled: true, disabledMarkers: [] }) {
		let currentSettings = { ...settings };
		let actionsChanged = 0;
		const host = {
			clientId: "client-test",
			stateStore: {
				getMarkerSettings: () => currentSettings,
				saveMarkerSettings: (_id: string, s: MarkerSettings) => {
					currentSettings = { ...s };
				},
			} as unknown as ClientStateStore,
			emit: () => {},
			isDisposed: () => false,
			getActiveConversationId: () => "conv-1",
			getSessionManager: () => undefined,
			renameConversation: () => {},
			refreshMarkers: () => {},
			onActionsChange: () => {
				actionsChanged++;
			},
			lang: () => "zh" as const,
		} satisfies MarkerHost;

		const svc = new MarkerService(host);
		return { svc, getActionsChanged: () => actionsChanged };
	}

	it("解析处理 assistant 文本中的建议操作", async () => {
		const { svc, getActionsChanged } = createService();
		const text = "任务已完成，请问是否继续下一步？\n[[action:suggest:是，请继续]]\n[[action:suggest:否，稍后再说]]";
		await svc.handleAssistantText("conv-1", text);

		const actions = svc.getActionSuggestions("conv-1");
		expect(actions).toBeDefined();
		expect(actions?.length).toBe(2);
		expect(actions?.[0].label).toBe("是，请继续");
		expect(actions?.[1].label).toBe("否，稍后再说");
		expect(getActionsChanged()).toBeGreaterThan(0);
	});

	it("支持 clearActions 清理操作", async () => {
		const { svc } = createService();
		const text = "[[action:suggest:选项一]]";
		await svc.handleAssistantText("conv-1", text);
		expect(svc.getActionSuggestions("conv-1")?.length).toBe(1);

		svc.clearActions("conv-1");
		expect(svc.getActionSuggestions("conv-1")).toBeNull();
	});

	it("禁用 action 时返回 null", async () => {
		const { svc } = createService({ markersEnabled: true, disabledMarkers: ["action"] });
		const text = "[[action:suggest:测试]]";
		await svc.handleAssistantText("conv-1", text);
		expect(svc.getActionSuggestions("conv-1")).toBeNull();
	});

	it("全局禁用标记时返回 null", async () => {
		const { svc } = createService({ markersEnabled: false, disabledMarkers: [] });
		const text = "[[action:suggest:测试]]";
		await svc.handleAssistantText("conv-1", text);
		expect(svc.getActionSuggestions("conv-1")).toBeNull();
	});

	it("buildGuidance 为精简纯英文且不重复注入别名", () => {
		const { svc } = createService();
		const guidance = svc.buildGuidance();
		// 1. 系统提示词统一为纯英文（即便宿主语言是 zh）
		expect(guidance).not.toMatch(/[\u4e00-\u9fff]/);
		// 2. 别名 suggest 不得重复注入，action 条目只出现 1 次
		const actionEntryMatches = guidance.match(/- Suggest action buttons:/g);
		expect(actionEntryMatches?.length).toBe(1);
		// 3. 包含一个标记一个按钮与多个独立标记的强指引
		expect(guidance).toContain("one marker per button");
		expect(guidance).toContain("NEVER join options in one marker");
	});

	it("handleAssistantText 执行完毕后 chains 自动清理归零（自洁无泄漏）", async () => {
		const { svc } = createService();
		const text = "[[action:suggest:自洁测试]]";
		const p = svc.handleAssistantText("conv-leak-test", text);
		// 执行期间存在链
		const chains = (svc as unknown as { chains: Map<string, Promise<void>> }).chains;
		expect(chains.has("conv-leak-test")).toBe(true);
		await p;
		// 执行完毕后自动清理，保持零内存驻留
		expect(chains.has("conv-leak-test")).toBe(false);

		// clearConversation 显式清理验证
		chains.set("conv-manual", Promise.resolve());
		expect(chains.has("conv-manual")).toBe(true);
		svc.clearConversation("conv-manual");
		expect(chains.has("conv-manual")).toBe(false);
	});
});
