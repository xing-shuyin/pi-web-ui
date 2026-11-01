import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { ClientStateStore } from "../../server/client-state.js";
import { DurableAgentService } from "../../server/durable/durable-agent-service.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("Durable 引擎项目记录与对话持久化真实测试", () => {
	let tempDir: string;
	let dataDir: string;
	let workspace1: string;
	let workspace2: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-durable-e2e-"));
		dataDir = join(tempDir, "data");
		workspace1 = join(tempDir, "ws1");
		workspace2 = join(tempDir, "ws2");
		mkdirSync(workspace1, { recursive: true });
		mkdirSync(workspace2, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	async function waitForMessage<T extends ServerMessage["type"]>(
		emitted: ServerMessage[],
		type: T,
		timeoutMs = 1000,
	): Promise<Extract<ServerMessage, { type: T }>> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const found = emitted.find((m) => m.type === type);
			if (found) return found as Extract<ServerMessage, { type: T }>;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`Timeout waiting for message type: ${type}`);
	}

	it("1. 打开项目与切换工作区时，自动记录并实时推送 projects 列表", async () => {
		const stateStore = new ClientStateStore(join(dataDir, "client-state.json"));
		const service = new DurableAgentService({
			cwd: workspace1,
			dataDir,
			stateStore,
		});

		const emitted: ServerMessage[] = [];
		const session = await service.attach("test-client-1", (msg) => emitted.push(msg));

		// 验证初次 attach 推送了 projects 消息，且包含当前 workspace1
		const lastProjMsg = await waitForMessage(emitted, "projects");
		expect(lastProjMsg.projects.some((p) => p.path === workspace1)).toBe(true);

		// 切换到 workspace2
		emitted.length = 0;
		await (session as any).setCwd(workspace2);

		// 验证切换后 stateStore 记住了 workspace2，并向前端推送了包含 workspace2 的新 projects 列表
		const afterSwitchMsg = await waitForMessage(emitted, "projects");
		expect(afterSwitchMsg.projects.some((p) => p.path === workspace2)).toBe(true);

		// 测试删除项目 removeProject
		await (session as any).removeProject(workspace1);
		const finalProjects = await stateStore.getRecentProjects("test-client-1");
		expect(finalProjects.some((p) => p.path === workspace1)).toBe(false);

		await service.disposeAll();
	});

	it("2. 对话正常保存，移出运行中列表 (dismiss) 不会误删磁盘记录", async () => {
		const stateStore = new ClientStateStore(join(dataDir, "client-state.json"));
		const store = new UniversalSessionStore(dataDir, "durable");
		const service = new DurableAgentService({
			cwd: workspace1,
			dataDir,
			stateStore,
		});

		const emitted: ServerMessage[] = [];
		const session = await service.attach("test-client-2", (msg) => emitted.push(msg));

		// 模拟发送一条用户消息并保存
		const uSession = session as any;
		const activeConv = uSession.activeConv;
		expect(activeConv).toBeDefined();
		const convId = activeConv.id;

		activeConv.messages.push({
			id: "u-1",
			role: "user",
			content: [{ type: "text", text: "保存测试消息" }],
			timestamp: Date.now(),
		});
		activeConv.updatedAt = Date.now();
		store.saveConversation(workspace1, activeConv);

		// 验证磁盘上确实存在该持久化记录
		const diskConv = store.loadConversation(workspace1, convId);
		expect(diskConv).toBeDefined();
		expect(diskConv?.messages.length).toBe(1);

		// 移出运行中会话 (用户在界面关闭此 tab，调用 dismissConversation)
		await uSession.dismissConversation(convId);

		// ⭐ 核心验证：移出后内存中不再有此会话，但磁盘上的历史文件依然完好保存！
		expect(uSession.conversations.has(convId)).toBe(false);
		const diskConvAfterDismiss = store.loadConversation(workspace1, convId);
		expect(diskConvAfterDismiss).toBeDefined();
		expect(diskConvAfterDismiss?.id).toBe(convId);

		// 验证历史会话列表依然包含此会话
		emitted.length = 0;
		await uSession.refreshSessions();
		const sessionsMsg = emitted.find((m) => m.type === "sessions") as Extract<ServerMessage, { type: "sessions" }>;
		expect(sessionsMsg).toBeDefined();
		expect(sessionsMsg.sessions.some((s) => s.path === convId)).toBe(true);

		// 验证用户从历史列表中点击 switch_session / switchConversation 可以重新恢复并打开
		await uSession.switchConversation(convId);
		expect(uSession.activeConvId).toBe(convId);
		expect(uSession.conversations.has(convId)).toBe(true);
		expect(uSession.activeConv.messages[0].content[0].text).toBe("保存测试消息");

		// 验证真正删除会话 (deleteSession) 会彻底清除磁盘文件
		await uSession.deleteSession(convId);
		expect(store.loadConversation(workspace1, convId)).toBeNull();

		await service.disposeAll();
	});

	it("3. 重新建立连接 (刷新页面) 时，能够恢复历史项目工作区并推送初始完整快照", async () => {
		const stateStore = new ClientStateStore(join(dataDir, "client-state.json"));
		const service = new DurableAgentService({
			cwd: workspace1,
			dataDir,
			stateStore,
		});

		// 客户端 3 首先访问 workspace2
		stateStore.remember("client-3", workspace2);

		const emitted: ServerMessage[] = [];
		// 客户端 3 连接接入
		const session = await service.attach("client-3", (msg) => emitted.push(msg));

		// 验证 session 自动恢复了客户端上次的 lastCwd (workspace2)
		expect((session as any).cwd).toBe(workspace2);

		// 验证 attachSink 立即向客户端下发了全量 snapshot
		const snapshots = emitted.filter((m) => m.type === "snapshot");
		expect(snapshots.length).toBeGreaterThan(0);
		const lastSnap = snapshots[snapshots.length - 1] as Extract<ServerMessage, { type: "snapshot" }>;
		expect(lastSnap.state.cwd).toBe(workspace2);

		await service.disposeAll();
	});
});
