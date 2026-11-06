import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UniversalSessionStore,
	UniversalSession,
	MockAgentDriver,
	type UniversalConversation,
} from "../../server/universal/index.js";
import type { ServerMessage, ConversationSummary } from "../../server/protocol.js";

describe("通用底座（Universal Base）子代理（Subagent）体系单测", () => {
	let tempDir: string;
	let store: UniversalSessionStore;
	let session: UniversalSession;
	let outbox: ServerMessage[];

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-subagent-test-"));
		store = new UniversalSessionStore(tempDir);
		outbox = [];

		const driverFactory = (cwd: string) => new MockAgentDriver(cwd);
		const initialDriver = driverFactory(tempDir);

		session = new UniversalSession({
			clientId: "test-client",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			driver: initialDriver,
			driverFactory,
			lang: "zh",
		});

		await session.newChat();
		outbox.length = 0;
	});

	afterEach(() => {
		session.dispose();
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {}
		}
	});

	it("1. 基础能力声明：通用底座应声明 subagents: true", () => {
		const caps = session.getCapabilities();
		expect(caps.subagents).toBe(true);
	});

	it("2. spawnSubagent：能够创建子代理并在后台驱动执行完成", async () => {
		const { convId } = await session.spawnSubagent("请调研代码仓库结构", "explore", tempDir);

		expect(convId).toMatch(/^subconv-/);

		const initialSnap = session.subagentHost.getSubagent(convId);
		expect(initialSnap).toBeDefined();
		expect(initialSnap?.convId).toBe(convId);
		expect(initialSnap?.type).toBe("explore");
		expect(initialSnap?.title).toBeDefined();

		const waitResult = await session.waitSubagents(5, [convId]);
		expect(waitResult.length).toBe(1);
		expect(waitResult[0].convId).toBe(convId);
		expect(waitResult[0].state).toBe("done");
		expect(waitResult[0].streaming).toBe(false);
		expect(waitResult[0].output).toContain("I have processed your request");

		const finalSnap = session.subagentHost.getSubagent(convId);
		expect(finalSnap?.state).toBe("done");
		expect(finalSnap?.streaming).toBe(false);
	});

	it("3. listSubagents：能够按作用域过滤子代理列表", async () => {
		const { convId: sub1 } = await session.spawnSubagent(
			"子任务 1",
			"general",
			tempDir,
			undefined,
			undefined,
			undefined,
			false,
		);
		const { convId: sub2 } = await session.spawnSubagent(
			"子任务 2",
			"review",
			tempDir,
			undefined,
			undefined,
			undefined,
			true,
		);

		await session.waitSubagents(5, [sub1, sub2]);

		const all = session.subagentHost.listSubagents("all");
		expect(all.some((s) => s.convId === sub1)).toBe(true);
		expect(all.some((s) => s.convId === sub2)).toBe(true);

		const ephemeralOnly = session.subagentHost.listSubagents("subagent");
		expect(ephemeralOnly.some((s) => s.convId === sub1)).toBe(true);
		expect(ephemeralOnly.some((s) => s.convId === sub2)).toBe(false);

		const persistentOnly = session.subagentHost.listSubagents("persistent");
		expect(persistentOnly.some((s) => s.convId === sub1)).toBe(false);
		expect(persistentOnly.some((s) => s.convId === sub2)).toBe(true);
	});

	it("4. stopSubagent：能够中止正在运行的子代理并更新状态为 canceled", async () => {
		const { convId } = await session.spawnSubagent("一个即将被中止的任务", "general", tempDir);

		await session.stopSubagent(convId);

		const snap = session.subagentHost.getSubagent(convId);
		expect(snap?.state).toBe("canceled");
		expect(snap?.canceled).toBe(true);
		expect(snap?.streaming).toBe(false);
	});

	it("5. steerSubagent：能够向子代理追加补充指令", async () => {
		const { convId } = await session.spawnSubagent("初始任务", "general", tempDir);
		await session.waitSubagents(5, [convId]);

		await session.steerSubagent(convId, "追加的补充说明");

		const snap = session.subagentHost.getSubagent(convId);
		expect(snap?.messageCount).toBeGreaterThanOrEqual(3);
	});

	it("6. handoffSubagent：支持对等子代理间交接任务并注入交接消息", async () => {
		const { convId: peerA } = await session.spawnSubagent("分析模块", "explore", tempDir);
		const { convId: peerB } = await session.spawnSubagent("实现模块", "implement", tempDir);

		await session.waitSubagents(5, [peerA, peerB]);

		await session.handoffSubagent(peerA, peerB, "这是分析出的接口定义数据");

		const snapA = session.subagentHost.getSubagent(peerA);
		const snapB = session.subagentHost.getSubagent(peerB);

		expect(snapA?.handoffTo).toContain(peerB);
		expect(snapB?.handoffFrom).toContain(peerA);

		const convB = (session as any).conversations.get(peerB) as UniversalConversation;
		const lastMsg = convB.messages[convB.messages.length - 1];
		expect(lastMsg.role).toBe("user");
		const textContent = (lastMsg.content[0] as any).text;
		expect(textContent).toContain("Peer Hand-off");
		expect(textContent).toContain("这是分析出的接口定义数据");
	});

	it("7. persistConversation：支持将轻量子代理固化为持久化历史会话", async () => {
		const { convId } = await session.spawnSubagent(
			"轻量探索",
			"explore",
			tempDir,
			undefined,
			undefined,
			undefined,
			false,
		);
		await session.waitSubagents(5, [convId]);

		expect(session.subagentHost.getSubagent(convId)?.persisted).toBe(false);

		await session.persistConversation(convId);

		expect(session.subagentHost.getSubagent(convId)?.persisted).toBe(true);

		const diskConv = store.loadConversation(tempDir, convId);
		expect(diskConv).toBeDefined();
		expect(diskConv?.id).toBe(convId);
		expect(diskConv?.isEphemeral).toBe(false);
	});

	it("8. dismissConversation 级联清理：关闭父会话并级联清理属于它的子代理", async () => {
		const parentId = (session as any).activeConvId as string;
		const { convId: childSub } = await session.spawnSubagent(
			"子代理任务",
			"explore",
			tempDir,
			undefined,
			undefined,
			parentId,
			false,
		);
		await session.waitSubagents(5, [childSub]);

		expect(session.subagentHost.getSubagent(childSub)).toBeDefined();

		await session.dismissConversation(parentId, true);

		expect(session.subagentHost.getSubagent(childSub)).toBeUndefined();
	});

	it("9. dismissFinishedSubagents：批量清理已完成的子代理", async () => {
		const { convId: sub1 } = await session.spawnSubagent("子任务 A", "explore", tempDir);
		const { convId: sub2 } = await session.spawnSubagent("子任务 B", "explore", tempDir);
		await session.waitSubagents(5, [sub1, sub2]);

		expect(session.subagentHost.getSubagent(sub1)).toBeDefined();
		expect(session.subagentHost.getSubagent(sub2)).toBeDefined();

		await session.dismissFinishedSubagents();

		expect(session.subagentHost.getSubagent(sub1)).toBeUndefined();
		expect(session.subagentHost.getSubagent(sub2)).toBeUndefined();
	});

	it("10. getToolInfo：subagent 工具信息正确返回定义", () => {
		outbox.length = 0;
		session.getToolInfo("subagent");

		const toolInfoMsg = outbox.find((m) => m.type === "tool_info") as any;
		expect(toolInfoMsg).toBeDefined();
		expect(toolInfoMsg.name).toBe("subagent");
		expect(toolInfoMsg.found).toBe(true);
		expect(toolInfoMsg.description).toBeDefined();
		expect(toolInfoMsg.parameters).toBeDefined();
	});

	it("11. 斜杠命令：/subagent 能够正常拦截并派发子代理", async () => {
		outbox.length = 0;
		await session.prompt("/subagent:explore 调查项目文件清单");

		const infoNotice = outbox.find((m) => m.type === "notice" && m.level === "info") as any;
		expect(infoNotice).toBeDefined();
		expect(infoNotice.text).toContain("已派发子代理");

		const snaps = session.subagentHost.listSubagents();
		expect(snaps.length).toBeGreaterThan(0);
		expect(snaps[0].type).toBe("explore");
	});

	it("12. conversations 摘要回显：正确回显子代理运行态与父子关系", async () => {
		const parentId = (session as any).activeConvId as string;
		const { convId } = await session.spawnSubagent("测试回显任务", "review", tempDir, undefined, undefined, parentId);

		outbox.length = 0;
		await session.refreshSessions();

		const convMsg = outbox.find((m) => m.type === "conversations") as any;
		expect(convMsg).toBeDefined();
		const targetSummary = convMsg.conversations.find((c: ConversationSummary) => c.id === convId);
		expect(targetSummary).toBeDefined();
		expect(targetSummary.isSubagent).toBe(true);
		expect(targetSummary.subagentType).toBe("review");
		expect(targetSummary.subagentParentId).toBe(parentId);
	});
});
