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

		const lastProjMsg = await waitForMessage(emitted, "projects");
		expect(lastProjMsg.projects.some((p) => p.path === workspace1)).toBe(true);

		emitted.length = 0;
		await (session as any).setCwd(workspace2);

		const afterSwitchMsg = await waitForMessage(emitted, "projects");
		expect(afterSwitchMsg.projects.some((p) => p.path === workspace2)).toBe(true);

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

		const diskConv = store.loadConversation(workspace1, convId);
		expect(diskConv).toBeDefined();
		expect(diskConv?.messages.length).toBe(1);

		await uSession.dismissConversation(convId);

		expect(uSession.conversations.has(convId)).toBe(false);
		const diskConvAfterDismiss = store.loadConversation(workspace1, convId);
		expect(diskConvAfterDismiss).toBeDefined();
		expect(diskConvAfterDismiss?.id).toBe(convId);

		emitted.length = 0;
		await uSession.refreshSessions();
		const sessionsMsg = emitted.find((m) => m.type === "sessions") as Extract<ServerMessage, { type: "sessions" }>;
		expect(sessionsMsg).toBeDefined();
		expect(sessionsMsg.sessions.some((s) => s.path === convId)).toBe(true);

		await uSession.switchConversation(convId);
		expect(uSession.activeConvId).toBe(convId);
		expect(uSession.conversations.has(convId)).toBe(true);
		expect(uSession.activeConv.messages[0].content[0].text).toBe("保存测试消息");

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

		stateStore.remember("client-3", workspace2);

		const emitted: ServerMessage[] = [];
		const session = await service.attach("client-3", (msg) => emitted.push(msg));

		expect((session as any).cwd).toBe(workspace2);

		const snapshots = emitted.filter((m) => m.type === "snapshot");
		expect(snapshots.length).toBeGreaterThan(0);
		const lastSnap = snapshots[snapshots.length - 1] as Extract<ServerMessage, { type: "snapshot" }>;
		expect(lastSnap.state.cwd).toBe(workspace2);

		await service.disposeAll();
	});
});
