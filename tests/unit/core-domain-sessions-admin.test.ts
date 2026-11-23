import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONV_TITLE } from "../../server/agent-formatters.js";
import {
	deleteSessionFile,
	dismissConversation,
	renameConversation,
	renameSession,
} from "../../packages/keel/src/domains/sessions/index.js";
import {
	Conversation,
	type ConversationInit,
	ConversationRegistry,
} from "../../packages/keel/src/kernel/conversation/index.js";

/**
 * 会话管理操作域：删除 / 重命名 / 关闭只碰「文件 + 注册表 + 相位」，
 * 不碰 SDK、不猜时间（一律从 `now` 进）。
 */

const NOW = 1_750_000_000_000;
const CREATED = 1_700_000_000_000;
const SESSION_FILE = "/sessions/sess-a.jsonl";

function seed(
	registry: ConversationRegistry<Conversation>,
	over: Partial<ConversationInit> & { id: string },
): Conversation {
	return registry.add(
		new Conversation({
			clientId: "client-1",
			cwd: "/work/demo",
			kind: "user",
			createdAt: CREATED,
			...over,
		}),
	);
}

function clock(): () => number {
	return () => NOW;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("deleteSessionFile", () => {
	it("路径不在允许范围时拒绝，而且根本不去碰文件", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const removeFile = vi.fn(async () => true);
		const result = await deleteSessionFile({
			registry,
			now: clock(),
			isAllowedPath: () => false,
			removeFile,
			sessionFile: "/etc/passwd",
		});
		expect(result).toEqual({ deleted: false, reason: "not-allowed" });
		expect(removeFile).not.toHaveBeenCalled();
	});

	it("文件不存在时回 missing（删除器说没删就是没删）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const result = await deleteSessionFile({
			registry,
			now: clock(),
			isAllowedPath: () => true,
			removeFile: async () => false,
			sessionFile: SESSION_FILE,
		});
		expect(result).toEqual({ deleted: false, reason: "missing" });
	});

	it("删成功回 deleted，并把原路径原样交给删除器", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const removeFile = vi.fn(async () => true);
		const result = await deleteSessionFile({
			registry,
			now: clock(),
			isAllowedPath: () => true,
			removeFile,
			sessionFile: SESSION_FILE,
		});
		expect(result).toEqual({ deleted: true });
		expect(removeFile).toHaveBeenCalledWith(SESSION_FILE);
		expect(removeFile).toHaveBeenCalledTimes(1);
	});

	it("删掉文件后，绑定它的对话只解绑、不被移除也不被退役", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const holder = seed(registry, { id: "conv-a", sessionFile: SESSION_FILE });
		const other = seed(registry, { id: "conv-b", sessionFile: "/sessions/sess-b.jsonl" });

		const result = await deleteSessionFile({
			registry,
			now: clock(),
			isAllowedPath: () => true,
			removeFile: async () => true,
			sessionFile: SESSION_FILE,
		});

		expect(result).toEqual({ deleted: true });
		expect(registry.size()).toBe(2);
		expect(registry.get(holder.id)).toBe(holder);
		expect(holder.meta.sessionFile).toBeUndefined();
		expect(registry.bySessionFile(SESSION_FILE)).toBeUndefined();
		expect(holder.phase).toBe("idle");
		expect(other.meta.sessionFile).toBe("/sessions/sess-b.jsonl");
	});

	it("没有对话绑着这个文件时，注册表一动不动", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const other = seed(registry, { id: "conv-b", sessionFile: "/sessions/sess-b.jsonl" });

		await deleteSessionFile({
			registry,
			now: clock(),
			isAllowedPath: () => true,
			removeFile: async () => true,
			sessionFile: "/sessions/orphan.jsonl",
		});

		expect(registry.size()).toBe(1);
		expect(registry.get(other.id)).toBe(other);
		expect(registry.bySessionFile("/sessions/sess-b.jsonl")).toBe(other);
	});

	it("缺省路径判定 fail-closed：没配会话根目录就一律判越界", async () => {
		vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
		const registry = new ConversationRegistry<Conversation>();
		const removeFile = vi.fn(async () => true);

		const result = await deleteSessionFile({ registry, now: clock(), removeFile, sessionFile: SESSION_FILE });

		expect(result).toEqual({ deleted: false, reason: "not-allowed" });
		expect(removeFile).not.toHaveBeenCalled();
	});

	it("缺省路径判定认会话根目录内的真文件，目录外的兄弟文件照样越界", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-sessions-admin-"));
		vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", root);
		const inside = join(root, "sess-a.jsonl");
		const outside = join(root, "..", `outside-${process.pid}.jsonl`);
		writeFileSync(inside, "{}\n");
		writeFileSync(outside, "{}\n");
		const registry = new ConversationRegistry<Conversation>();

		const allowed = await deleteSessionFile({ registry, now: clock(), sessionFile: inside });
		const refused = await deleteSessionFile({ registry, now: clock(), sessionFile: outside });

		expect(allowed).toEqual({ deleted: true });
		expect(existsSync(inside)).toBe(false);
		expect(refused).toEqual({ deleted: false, reason: "not-allowed" });
		expect(existsSync(outside)).toBe(true);
	});
});

describe("renameSession", () => {
	it("标题去空白后返回（历史行写盘由调用方落）", () => {
		expect(renameSession({ sessionFile: SESSION_FILE, title: "  周会 纪要  " })).toEqual({ title: "周会 纪要" });
	});

	it("空标题归一成默认标题，而不是返回空串", () => {
		expect(renameSession({ sessionFile: SESSION_FILE, title: "   " })).toEqual({ title: DEFAULT_CONV_TITLE });
		expect(renameSession({ sessionFile: SESSION_FILE, title: "" })).toEqual({ title: DEFAULT_CONV_TITLE });
	});
});

describe("renameConversation", () => {
	it("改名成功：标题归一 + 记一次活动时间", () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a", title: "旧标题" });

		const result = renameConversation({
			registry,
			conversationId: conversation.id,
			title: "  新 标题 ",
			now: NOW,
		});

		expect(result).toEqual({ renamed: true, title: "新 标题" });
		expect(conversation.meta.title).toBe("新 标题");
		expect(conversation.meta.lastActiveAt).toBe(NOW);
	});

	it("空标题归一成默认标题，并照常算改名成功", () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a", title: "旧标题" });

		const result = renameConversation({ registry, conversationId: conversation.id, title: "  ", now: NOW });

		expect(result).toEqual({ renamed: true, title: DEFAULT_CONV_TITLE });
		expect(conversation.meta.title).toBe(DEFAULT_CONV_TITLE);
	});

	it("对话不存在时回 renamed:false，不抛也不动别人", () => {
		const registry = new ConversationRegistry<Conversation>();
		const other = seed(registry, { id: "conv-b", title: "别人的" });

		const result = renameConversation({ registry, conversationId: "conv-missing", title: "新标题", now: NOW });

		expect(result).toEqual({ renamed: false });
		expect(other.meta.title).toBe("别人的");
		expect(other.meta.lastActiveAt).toBe(CREATED);
	});

	it("只改标题与活动时间，身份、工作目录、绑定文件、相位都不动", () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a", title: "旧标题", sessionFile: SESSION_FILE });
		conversation.beginTurn(CREATED + 1);

		renameConversation({ registry, conversationId: conversation.id, title: "新标题", now: NOW });

		expect(conversation.meta.id).toBe("conv-a");
		expect(conversation.meta.clientId).toBe("client-1");
		expect(conversation.meta.cwd).toBe("/work/demo");
		expect(conversation.meta.kind).toBe("user");
		expect(conversation.meta.createdAt).toBe(CREATED);
		expect(conversation.meta.sessionFile).toBe(SESSION_FILE);
		expect(conversation.phase).toBe("running");
	});
});

describe("dismissConversation", () => {
	it("关掉主对话：退役相位 + 摘出注册表 + 收一次会话资源", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a", sessionFile: SESSION_FILE });
		registry.activate(conversation.id);
		const closed: string[] = [];

		const result = await dismissConversation({
			registry,
			now: clock(),
			conversationId: conversation.id,
			closeSession: (id) => closed.push(id),
		});

		expect(result).toEqual({ dismissed: true, closedSubagents: [] });
		expect(conversation.phase).toBe("retired");
		expect(registry.has(conversation.id)).toBe(false);
		expect(registry.bySessionFile(SESSION_FILE)).toBeUndefined();
		expect(registry.activeId()).toBe("");
		expect(closed).toEqual([conversation.id]);
	});

	it("运行中的对话也能关：退役是单向闸，相位先落到 retiring 再 retired", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a" });
		conversation.beginTurn(NOW);

		const result = await dismissConversation({ registry, now: clock(), conversationId: conversation.id });

		expect(result).toEqual({ dismissed: true, closedSubagents: [] });
		expect(conversation.phase).toBe("retired");
		expect(conversation.acceptsTurns).toBe(false);
	});

	it("withFinishedSubagents 为真：已结束的子代理被连带关掉，每个 id 各收一次资源", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const main = seed(registry, { id: "conv-main" });
		const child = seed(registry, { id: "sub-1", kind: "subagent", parentId: main.id });
		const child2 = seed(registry, { id: "sub-2", kind: "subagent", parentId: main.id });
		child2.beginTurn(NOW);
		child2.endTurn(NOW);
		const closed: string[] = [];

		const result = await dismissConversation({
			registry,
			now: clock(),
			conversationId: main.id,
			withFinishedSubagents: true,
			closeSession: (id) => closed.push(id),
		});

		expect(result.dismissed).toBe(true);
		expect(result.closedSubagents).toEqual(["sub-1", "sub-2"]);
		expect(child.phase).toBe("retired");
		expect(child2.phase).toBe("retired");
		expect(registry.has(child.id)).toBe(false);
		expect(registry.has(child2.id)).toBe(false);
		expect(registry.size()).toBe(0);
		expect(closed).toEqual(["sub-1", "sub-2", main.id]);
	});

	it("不给 withFinishedSubagents 就不连带：子代理留在注册表、也没被收资源", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const main = seed(registry, { id: "conv-main" });
		const child = seed(registry, { id: "sub-1", kind: "subagent", parentId: main.id });
		const closed: string[] = [];

		const result = await dismissConversation({
			registry,
			now: clock(),
			conversationId: main.id,
			closeSession: (id) => closed.push(id),
		});

		expect(result).toEqual({ dismissed: true, closedSubagents: [] });
		expect(registry.get(child.id)).toBe(child);
		expect(child.phase).toBe("idle");
		expect(closed).toEqual([main.id]);
	});

	it("还在跑的子代理不连带关（withFinishedSubagents 只算已结束的）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const main = seed(registry, { id: "conv-main" });
		const running = seed(registry, { id: "sub-run", kind: "subagent", parentId: main.id });
		running.beginTurn(NOW);
		const done = seed(registry, { id: "sub-done", kind: "subagent", parentId: main.id });

		const result = await dismissConversation({
			registry,
			now: clock(),
			conversationId: main.id,
			withFinishedSubagents: true,
		});

		expect(result.closedSubagents).toEqual(["sub-done"]);
		expect(done.phase).toBe("retired");
		expect(running.phase).toBe("running");
		expect(registry.get(running.id)).toBe(running);
	});

	it("只连带直接子代理：孙代理与别人家的子代理都不动", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const main = seed(registry, { id: "conv-main" });
		const child = seed(registry, { id: "sub-1", kind: "subagent", parentId: main.id });
		const grandchild = seed(registry, { id: "sub-1-1", kind: "subagent", parentId: child.id });
		const stranger = seed(registry, { id: "sub-other", kind: "subagent", parentId: "conv-other" });

		const result = await dismissConversation({
			registry,
			now: clock(),
			conversationId: main.id,
			withFinishedSubagents: true,
		});

		expect(result.closedSubagents).toEqual(["sub-1"]);
		expect(registry.get(grandchild.id)).toBe(grandchild);
		expect(registry.get(stranger.id)).toBe(stranger);
		expect(registry.size()).toBe(2);
	});

	it("同样的对话再 dismiss 一次是幂等的：dismissed:false、状态与资源都不再动", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a" });
		const closed: string[] = [];
		const deps = {
			registry,
			now: clock(),
			conversationId: conversation.id,
			closeSession: (id: string) => closed.push(id),
		};

		const first = await dismissConversation(deps);
		const second = await dismissConversation(deps);

		expect(first).toEqual({ dismissed: true, closedSubagents: [] });
		expect(second).toEqual({ dismissed: false, closedSubagents: [] });
		expect(closed).toEqual([conversation.id]);
	});

	it("已退役但还挂在注册表里的对话不再被关（也不被顺手移除）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const conversation = seed(registry, { id: "conv-a" });
		conversation.retire();
		conversation.finishRetire();
		const closed: string[] = [];

		const result = await dismissConversation({
			registry,
			now: clock(),
			conversationId: conversation.id,
			closeSession: (id) => closed.push(id),
		});

		expect(result).toEqual({ dismissed: false, closedSubagents: [] });
		expect(registry.get(conversation.id)).toBe(conversation);
		expect(closed).toEqual([]);
	});

	it("对话不存在时回 dismissed:false，不动注册表里的其它对话", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const other = seed(registry, { id: "conv-b" });

		const result = await dismissConversation({ registry, now: clock(), conversationId: "conv-missing" });

		expect(result).toEqual({ dismissed: false, closedSubagents: [] });
		expect(registry.get(other.id)).toBe(other);
		expect(other.phase).toBe("idle");
	});
});
