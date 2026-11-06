import { describe, expect, it } from "vitest";
import { AgentService } from "../../server/agent-service.js";
import type { ElsewhereRunning } from "../../server/protocol.js";

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
