/**
 * 阶段三单测：双引擎适配层（DSH Agent Adapter Layer for Plugins）。
 * 验证 DshClientSession 与 DshAgentService 的插件扩展接口：
 * readConversationForPlugins / listRunningForPlugins / listHistoryForPlugins /
 * searchForPlugins / steerForPlugins / abortForPlugins / listModelsForPlugins。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClientSession, DshAgentService } from "../../server/dsh/dsh-agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";

describe("Phase 3: DSH Agent Adapter Layer (AAL)", () => {
	let dir: string;
	let stateStore: ClientStateStore;
	let dataDir: string;
	let agentDir: string;
	let cs: DshClientSession;
	let service: DshAgentService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dsh-aal-test-"));
		dataDir = join(dir, "data");
		agentDir = join(dir, "agent");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		stateStore = new ClientStateStore(join(dataDir, "client-state.json"));

		service = new DshAgentService(dir, stateStore, dataDir, agentDir);
		cs = DshClientSession.create("test-client", dir, stateStore, dataDir, agentDir);
		// 模拟挂载运行时，避免真实进程启动
		(cs as unknown as { runtime: unknown }).runtime = {
			close: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
		};
	});

	afterEach(async () => {
		try {
			await cs.dispose();
			await service.disposeAll();
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	});

	it("DshClientSession.readConversationForPlugins 返回对话快照", () => {
		const snap = cs.readConversationForPlugins();
		expect(snap).toBeTruthy();
		expect(snap?.clientId).toBe("test-client");
		expect(snap?.conversationId).toBeTruthy();
		expect(snap?.isSubagent).toBe(false);
		expect(Array.isArray(snap?.messages)).toBe(true);
		expect(snap?.model).toContain("deepseek");

		// 指定 clientId 不匹配时返回 null
		expect(cs.readConversationForPlugins({ clientId: "other-client" })).toBeNull();
	});

	it("DshClientSession.listRunningForPlugins 返回运行中对话", () => {
		const running = cs.listRunningForPlugins();
		expect(Array.isArray(running)).toBe(true);
		expect(running.length).toBeGreaterThanOrEqual(1);
		expect(running[0]?.kind).toBe("running");
		expect(running[0]?.cwd).toBe(dir);
	});

	it("DshClientSession.listModelsForPlugins 返回模型配置", async () => {
		const models = await cs.listModelsForPlugins();
		expect(Array.isArray(models)).toBe(true);
		expect(models.length).toBeGreaterThanOrEqual(1);
		expect(models[0]?.provider).toBe("deepseek");
		expect(models[0]?.id).toContain("deepseek");
	});

	it("DshClientSession.steerForPlugins 将插队内容压入 followUp 队列", async () => {
		const convId = cs.activeConversationId();
		const res = await cs.steerForPlugins(convId, "新的任务指示");
		expect(res.ok).toBe(true);

		// 空消息被拒绝
		const emptyRes = await cs.steerForPlugins(convId, "   ");
		expect(emptyRes.ok).toBe(false);

		// 未知对话被拒绝
		const unknownRes = await cs.steerForPlugins("non-existent-id", "test");
		expect(unknownRes.ok).toBe(false);
	});

	it("DshClientSession.abortForPlugins 中止正在运行的对话", async () => {
		const convId = cs.activeConversationId();
		// 会话未在 streaming 时幂等返回 ok: true
		const res = await cs.abortForPlugins(convId);
		expect(res.ok).toBe(true);

		// 未知对话返回 error
		const unknownRes = await cs.abortForPlugins("unknown-conv");
		expect(unknownRes.ok).toBe(false);
	});

	it("DshClientSession.searchForPlugins 搜索会话", async () => {
		// 空 query 返回空数组
		const empty = await cs.searchForPlugins("");
		expect(empty).toEqual([]);

		// 匹配当前对话标题
		const found = await cs.searchForPlugins("新对话");
		expect(Array.isArray(found)).toBe(true);
	});

	it("DshAgentService.pluginClient 与 readConversationForPlugins 多引擎统一适配", async () => {
		// 尚未 attach 客户端前 fallback 为 undefined
		expect(service.pluginClient()).toBeUndefined();
		expect(service.readConversationForPlugins()).toBeNull();

		// attach 客户端后能够被选取与读取
		const attachedCs = await service.attach("attached-client", () => {});
		expect(service.pluginClient()).toBe(attachedCs);

		const snap = service.readConversationForPlugins({ clientId: "attached-client" });
		expect(snap?.clientId).toBe("attached-client");
	});
});
