import { describe, expect, it } from "vitest";
import type { TurnCapableSession } from "../../packages/keel/src/contracts/session.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import { TurnRunner } from "../../packages/keel/src/domains/turns/index.js";
import { createGoalRunSinks } from "../../packages/keel/src/domains/goals/index.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";

/**
 * 目标运行的组合层（`createGoalRunSinks`）真的在动内核的那几件东西：
 * 子对话只注册不激活、喂轮走 `TurnRunner`（收尾事件真发）、拆子对话会关会话 + 退役 + 出注册表。
 */
describe("目标运行 sinks 与内核的组合", () => {
	function makeHarness() {
		const registry = new ConversationRegistry<Conversation>();
		const parent = new Conversation({ id: "c-1", clientId: "c1", cwd: "/work", kind: "user", createdAt: 1 });
		registry.add(parent);
		registry.activate("c-1");
		const settled: [string, string][] = [];
		const turns = new TurnRunner({
			clock: { now: () => 7, after: () => () => {} },
			events: { onTurnSettled: (conversationId, outcome) => void settled.push([conversationId, outcome]) },
		});
		const closed: string[] = [];
		const opened = new Set<string>();
		// 喂轮只认 `contracts/session` 的窄面，`sendUserMessage` 是 feed 层的 SDK 细节（假体按需补上）。
		const session = {
			dispose: () => {},
			sendUserMessage: async () => {},
			getLastAssistantText: () => "ok",
			setModel: async () => {},
		} as unknown as TurnCapableSession;
		const sessions = {
			ensure: async (conv: Conversation) => {
				opened.add(conv.id);
				return { session };
			},
			get: (id: string) => (opened.has(id) ? { session } : undefined),
			close: (id: string) => void closed.push(id),
		};
		const sent: ServerMessage[] = [];
		let flushes = 0;
		const planCalls: string[] = [];
		let conversationPushes = 0;
		const sinks = createGoalRunSinks({
			runtime: {
				clientId: "c1",
				registry,
				turns,
				publisher: { request: () => void (flushes += 1) },
				cwd: "/work",
				activeConversationId: () => registry.activeId() || undefined,
				pushConversations: () => void (conversationPushes += 1),
			},
			sessions,
			resolveModel: async () => ({ id: "m" }),
			emit: (msg) => void sent.push(msg),
			isDisposed: () => false,
			getLang: () => "zh",
			setPlan: (conversationId) => void planCalls.push(conversationId),
		});
		return {
			registry,
			turns,
			sinks,
			settled,
			closed,
			sent,
			planCalls,
			flushCount: () => flushes,
			conversationPushes: () => conversationPushes,
		};
	}

	it("开子对话只注册不激活：主对话仍是当前对话，执行对话是落盘对话（kind=user）且带 parent", () => {
		const h = makeHarness();
		const child = h.sinks.openChild({ parentId: "c-1", title: "执行", cwd: "/work" });
		expect(h.registry.activeId()).toBe("c-1");
		// 老实现给执行体开的是 `persist: true` 的普通对话（`isSubagent = !persist`）：
		// 微标 / 连带关闭 / 限额都不该落到目标执行对话上。
		expect(h.registry.get(child.id)).toMatchObject({ meta: { kind: "user", parentId: "c-1", cwd: "/work" } });
		expect(h.sinks.hasChild(child.id)).toBe(true);
		expect(h.sinks.conversationCwd(child.id)).toBe("/work");
	});

	it("喂一轮走 TurnRunner：收尾事件真的发出来，读得到最后一段助手文本", async () => {
		const h = makeHarness();
		const child = h.sinks.openChild({ parentId: "c-1", title: "执行", cwd: "/work" });
		await h.sinks.runTurn(child.id, "做这一轮");
		expect(h.settled).toEqual([[child.id, "done"]]);
		expect(h.sinks.lastAssistantText(child.id)).toBe("ok");
		expect(h.turns.isStreaming(child.id)).toBe(false);
	});

	it("拆子对话：关会话 + 退役 + 出注册表（清目标后不留子会话）", () => {
		const h = makeHarness();
		const child = h.sinks.openChild({ parentId: "c-1", title: "审查", cwd: "/work" });
		h.sinks.closeChild(child.id);
		expect(h.closed).toContain(child.id);
		expect(h.registry.get(child.id)).toBeUndefined();
		expect(h.sinks.hasChild(child.id)).toBe(false);
	});

	it("开 / 拆子对话各推一帧 conversations：左栏行不能靠运气出帧", () => {
		const h = makeHarness();
		const child = h.sinks.openChild({ parentId: "c-1", title: "执行", cwd: "/work" });
		expect(h.conversationPushes()).toBe(1);
		h.sinks.closeChild(child.id);
		// 出注册表还不算完：不推这一帧，客户端会一直挂着已经拆掉的执行对话。
		expect(h.conversationPushes()).toBe(2);
	});

	it("计划写口 / 帧出口 / 模型写入都是内核侧真对象（不是空壳）", async () => {
		const h = makeHarness();
		const child = h.sinks.openChild({ parentId: "c-1", title: "调研", cwd: "/work" });
		h.sinks.flushSnapshot();
		await h.sinks.setModel(child.id, "prov", "m1");
		h.sinks.setPlan?.("c-1", [{ id: "a", title: "A", status: "pending" }]);
		expect(h.flushCount()).toBe(1);
		expect(h.planCalls).toEqual(["c-1"]);
		// 会话被开出来才可能换模型（懒开的子对话在这里被 ensure）。
		expect(h.sinks.lastAssistantText(child.id)).toBe("ok");
	});
});
