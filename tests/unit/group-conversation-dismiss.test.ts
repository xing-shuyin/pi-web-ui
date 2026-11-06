import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";
import { fakeAgentService, fakeClientSession } from "../helpers/fake-session.js";

function makeBotBinding() {
	return registerBotExecution({
		id: "test-bot",
		revision: 1,
		enabled: true,
		cwd: resolve("test-bot-cwd"),
		tools: ["read"],
		skills: [],
		mcpServers: [],
	} as any);
}

describe("Group / Device-Task conversation dismissal", () => {
	it("detach 释放已停止的 device-task 客户端时，必须触发 pokeExternalRunning 刷新 elsewhere 列表", () => {
		const task = makeBotBinding();
		const sink = vi.fn();
		const sinks = new Set<unknown>([sink]);
		const cs = fakeClientSession({
			detachSink: vi.fn((s: unknown) => sinks.delete(s)),
			sinkCount: () => sinks.size,
			dispose: vi.fn(async () => {}),
		});
		const service = fakeAgentService({
			clients: new Map([[task.clientId, cs]]),
			pokeExternalRunning: vi.fn(),
		}) as any;

		task.release();
		service.detach(task.clientId, sink);

		expect(service.clients.has(task.clientId)).toBe(false);
		expect(cs.dispose).toHaveBeenCalledOnce();
		expect(service.pokeExternalRunning).toHaveBeenCalledWith(task.clientId);
	});

	it("dismissConversation 能跨客户端定位并关闭由 device-task 持有的群组对话", async () => {
		const task = makeBotBinding();
		const conv = { id: "c1", title: "跨设备环境信息检测与对比", cwd: "/test" };
		const notices: any[] = [];
		const requesterCs = fakeClientSession({
			getConversation: vi.fn(() => undefined),
			sendNotice: vi.fn((n) => notices.push(n)),
		});
		const botCs = fakeClientSession({
			getConversation: vi.fn((id) => (id === "c1" ? conv : undefined)),
			conversationStreaming: vi.fn(() => false),
			abortConversation: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
			sinkCount: () => 1,
		});

		const service = fakeAgentService({
			clients: new Map([
				["browser-client", requesterCs],
				[task.clientId, botCs],
			]),
			pokeExternalRunning: vi.fn(),
		}) as any;

		const ok = await service.dismissConversation("browser-client", {
			id: "c1",
			force: true,
			owner: task.clientId,
		});

		expect(ok).toBe(true);
		expect(service.clients.has(task.clientId)).toBe(false);
		expect(botCs.dispose).toHaveBeenCalledOnce();
		expect(service.pokeExternalRunning).toHaveBeenCalledWith(task.clientId);
		expect(notices.some((n) => n.text?.includes("已关闭并移出对话"))).toBe(true);

		task.release();
	});

	it("dismissConversation 在任务运行中未带 force 时提示用户，带 force 时强制中止并关闭", async () => {
		const task = makeBotBinding();
		const conv = { id: "c1", title: "跨平台任务脚本交付与审计闭环", cwd: "/test" };
		const notices: any[] = [];
		const requesterCs = fakeClientSession({
			getConversation: vi.fn(() => undefined),
			sendNotice: vi.fn((n) => notices.push(n)),
		});
		const botCs = fakeClientSession({
			getConversation: vi.fn((id) => (id === "c1" ? conv : undefined)),
			conversationStreaming: vi.fn(() => true),
			abortConversation: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
			sinkCount: () => 1,
		});

		const service = fakeAgentService({
			clients: new Map([
				["browser-client", requesterCs],
				[task.clientId, botCs],
			]),
			pokeExternalRunning: vi.fn(),
		}) as any;

		const res1 = await service.dismissConversation("browser-client", {
			id: "c1",
			force: false,
		});
		expect(res1).toBe(false);
		expect(botCs.abortConversation).not.toHaveBeenCalled();
		expect(service.clients.has(task.clientId)).toBe(true);
		expect(notices.some((n) => n.text?.includes("仍在运行中"))).toBe(true);

		const res2 = await service.dismissConversation("browser-client", {
			id: "c1",
			force: true,
		});
		expect(res2).toBe(true);
		expect(botCs.abortConversation).toHaveBeenCalledWith(conv);
		expect(service.clients.has(task.clientId)).toBe(false);
		expect(botCs.dispose).toHaveBeenCalledOnce();
		expect(service.pokeExternalRunning).toHaveBeenCalledWith(task.clientId);

		task.release();
	});

	it("LeftPanel 针对 elsewhere 会话行暴露 host:conv-force-dismiss 菜单项", () => {
		const computeMenuEntries = (target: { kind: string; id?: string; owner?: string; pseudo?: boolean }) => {
			const scopeId = target.kind === "running" ? target.id : undefined;
			const isElsewhere = target.kind === "elsewhere";
			const takeId = scopeId ?? (isElsewhere ? target.id || undefined : undefined);
			const armedTarget = scopeId ?? (isElsewhere ? takeId : undefined);

			const rawEntries: { id: string; source: string; label: string; hidden?: boolean }[] = [
				{ id: "host:conv-dismiss-subagents", source: "host", label: "关闭已完成子代理" },
				{ id: "host:conv-force-dismiss", source: "host", label: "强行关闭" },
			];

			return rawEntries
				.map((entry) => {
					if (isElsewhere && entry.id === "host:conv-dismiss-subagents") return { ...entry, hidden: true };
					if (entry.id === "host:conv-force-dismiss") return armedTarget ? entry : { ...entry, hidden: true };
					return entry;
				})
				.filter((e) => !e.hidden);
		};

		const visibleEntries = computeMenuEntries({
			kind: "elsewhere",
			id: "c1",
			owner: "device-task-123",
			pseudo: true,
		});

		expect(visibleEntries.some((e) => e.id === "host:conv-force-dismiss")).toBe(true);
		expect(visibleEntries.some((e) => e.id === "host:conv-dismiss-subagents")).toBe(false);
	});
});
