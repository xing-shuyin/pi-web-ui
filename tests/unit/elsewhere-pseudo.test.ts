import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { AgentService } from "../../server/agent-service.js";
import type { ElsewhereRunning } from "../../server/protocol.js";
import { fakeAgentService, fakeClientSession } from "../helpers/fake-session.js";

describe("ElsewhereRunning pseudo support (#426)", () => {
	it("AgentService.isPseudoClientId 识别 scheduler: 和 plugin: 客户端", () => {
		expect(AgentService.isPseudoClientId("scheduler:task-123")).toBe(true);
		expect(AgentService.isPseudoClientId("plugin:probe-ext")).toBe(true);
		expect(AgentService.isPseudoClientId("c1")).toBe(false);
		expect(AgentService.isPseudoClientId("client-browser-xyz")).toBe(false);
		expect(AgentService.isPseudoClientId("")).toBe(false);
	});

	it("ElsewhereRunning 接受 pseudo 布尔字段", () => {
		const normalRow: ElsewhereRunning = {
			title: "Normal Session",
			cwd: "/proj",
			isStreaming: true,
			owner: "client-abc",
			convId: "c1",
		};
		expect(normalRow.pseudo).toBeUndefined();

		const pseudoRow: ElsewhereRunning = {
			title: "Scheduled Task Session",
			cwd: "/proj",
			isStreaming: true,
			owner: "scheduler:task-1",
			convId: "c2",
			pseudo: true,
		};
		expect(pseudoRow.pseudo).toBe(true);
	});

	it("LeftPanel canTakeover 规则：pseudo 为 true 时必定降级为只读（canTakeover = false）", () => {
		const computeCanTakeover = (c: { owner?: string; convId?: string; pseudo?: boolean }) => {
			const isPseudo = Boolean(c.pseudo);
			return Boolean(c.owner && c.convId) && !isPseudo;
		};

		expect(computeCanTakeover({ owner: "client-a", convId: "c1" })).toBe(true);
		expect(computeCanTakeover({ convId: "c1" })).toBe(false);
		expect(computeCanTakeover({ owner: "client-a" })).toBe(false);
		expect(computeCanTakeover({ owner: "scheduler:task-1", convId: "c1", pseudo: true })).toBe(false);
		expect(computeCanTakeover({ owner: "plugin:sync", convId: "c2", pseudo: true })).toBe(false);
	});

	it("LeftPanel 问卷徽章与右键过户菜单对 pseudo 过滤", () => {
		const showQuestionBadge = (c: { hasQuestion?: boolean; owner?: string; convId?: string; pseudo?: boolean }) => {
			const isPseudo = Boolean(c.pseudo);
			return Boolean(c.hasQuestion && c.owner && c.convId && !isPseudo);
		};

		expect(showQuestionBadge({ hasQuestion: true, owner: "client-a", convId: "c1" })).toBe(true);
		expect(showQuestionBadge({ hasQuestion: true, owner: "scheduler:task-1", convId: "c1", pseudo: true })).toBe(false);

		const isTakeoverMenuVisible = (target: { kind: string; id?: string; owner?: string; pseudo?: boolean }) => {
			const isElsewhere = target.kind === "elsewhere";
			const takeId = target.id;
			return Boolean(isElsewhere && takeId && target.owner && !target.pseudo);
		};

		expect(isTakeoverMenuVisible({ kind: "elsewhere", id: "c1", owner: "client-a" })).toBe(true);
		expect(isTakeoverMenuVisible({ kind: "elsewhere", id: "c1", owner: "scheduler:task-1", pseudo: true })).toBe(false);
	});
});

describe("定时任务对话：直接打开（不走另一处）", () => {
	it("conversationSessionFile 返回转录文件绝对路径（面板/历史按文件直接打开用）", () => {
		const cs = fakeClientSession() as any;
		cs.convs = new Map([["c1", { id: "c1", session: { sessionFile: "/proj/sessions/a.jsonl" } }]]);
		expect(cs.conversationSessionFile("c1")).toBe(resolve("/proj/sessions/a.jsonl"));
		expect(cs.conversationSessionFile("missing")).toBeUndefined();
		cs.convs = new Map([["c1", { id: "c1", session: {} }]]);
		expect(cs.conversationSessionFile("c1")).toBeUndefined();
	});

	it("releaseScheduledConversation：跑完放手可打开；还在跑就拒绝（不给第二个 writer）", async () => {
		const daemon = fakeAgentService() as any;
		daemon.clients = new Map();
		const dismiss = vi.fn().mockResolvedValue(undefined);
		let streaming = false;
		daemon.clients.set("scheduler:t1", {
			getConversation: (id: string) => (id === "c1" ? { session: { isStreaming: streaming } } : undefined),
			dismissConversation: dismiss,
		});

		expect(await daemon.releaseScheduledConversation("scheduler:t1", "c1")).toBe(true);
		expect(dismiss).toHaveBeenCalledWith("c1");

		streaming = true;
		expect(await daemon.releaseScheduledConversation("scheduler:t1", "c1")).toBe(false);

		// 持有方/对话已经不在了：不需要释放，可以直接打开
		expect(await daemon.releaseScheduledConversation("scheduler:gone", "c1")).toBe(true);
		expect(await daemon.releaseScheduledConversation("scheduler:t1", "c9")).toBe(true);
		// 非 scheduler 持有方不归它管
		expect(await daemon.releaseScheduledConversation("client-a", "c1")).toBe(true);
	});
});
