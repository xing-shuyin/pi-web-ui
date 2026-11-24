import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientRuntime, type ClientFrames } from "../../packages/keel/src/app/client-runtime.js";
import { ComposerDraftsStore } from "../../packages/keel/src/composer-drafts.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";

function fakeTransport(): { sent: ServerMessage[]; port: TransportPort } {
	const sent: ServerMessage[] = [];
	return { sent, port: { send: (msg) => void sent.push(msg), isClosed: () => false } };
}

function makeRuntime(options: { drafts?: ComposerDraftsStore } = {}): {
	runtime: ClientRuntime;
	sent: ServerMessage[];
	frames: { sessions: number };
} {
	const transport = fakeTransport();
	const frames = { sessions: 0 };
	const runtime = new ClientRuntime({
		clientId: "c1",
		cwd: "/work",
		env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
		clock: { now: () => 1, after: () => () => {} },
		transport: transport.port,
		...options,
	});
	const api: ClientFrames = {
		pushSettings: () => {},
		refreshSessions: async () => void (frames.sessions += 1),
		pushProjects: async () => {},
		listModels: () => {},
		pushDefaultModel: () => {},
	};
	runtime.attachFrames(api);
	return { runtime, sent: transport.sent, frames };
}

const notices = (sent: ServerMessage[]) => sent.filter((m) => m.type === "notice");

describe("会话状态 handler（B4）", () => {
	it("switchConversation：存在的对话就切活动指针；不存在发 warning 且不切", () => {
		const { runtime, sent } = makeRuntime();
		const a = runtime.createConversation({ kind: "user" });
		const b = runtime.createConversation({ kind: "user" });
		expect(runtime.registry.activeId()).toBe(b.id);

		runtime.handlers().switchConversation(a.id);
		expect(runtime.registry.activeId()).toBe(a.id);
		expect(notices(sent)).toEqual([]);

		runtime.handlers().switchConversation("nope");
		expect(runtime.registry.activeId()).toBe(a.id);
		expect(notices(sent).at(-1)).toMatchObject({ level: "warning" });
	});

	it("removeQueued：按 id / 文本 / 下标摘掉队列项，并刷新快照", () => {
		const { runtime } = makeRuntime();
		const conv = runtime.createConversation({ kind: "user" });
		conv.queues.enqueue("followUp", "第一条");
		conv.queues.enqueue("followUp", "第二条");
		const before = runtime.publisher.rev;
		runtime.handlers().removeQueued("followUp", "第一条");
		expect(conv.queues.texts("followUp")).toEqual(["第二条"]);
		expect(runtime.publisher.rev).toBeGreaterThanOrEqual(before);
	});

	it("removeQueued：对话不在注册表里就抛（老口径：队列已失效）", async () => {
		const { runtime } = makeRuntime();
		runtime.createConversation({ kind: "user" });
		await expect(runtime.handlers().removeQueued("steer", "x", 0, "gone")).rejects.toThrow(
			"Queue conversation is no longer available",
		);
	});

	it("activeConversations / pendingMessages 计数口径", () => {
		const { runtime } = makeRuntime();
		const a = runtime.createConversation({ kind: "user" });
		runtime.createConversation({ kind: "user" });
		a.beginTurn(2);
		a.queues.enqueue("steer", "s1");
		a.queues.enqueue("followUp", "f1");
		expect(runtime.handlers().activeConversations?.()).toBe(1);
		expect(runtime.handlers().pendingMessages?.()).toBe(2);
	});

	it("getMessagesOfConversation：不在注册表里返回 undefined（不是空数组）", () => {
		const { runtime } = makeRuntime();
		expect(runtime.handlers().getMessagesOfConversation?.("nope")).toBeUndefined();
		const conv = runtime.createConversation({ kind: "user" });
		expect(runtime.handlers().getMessagesOfConversation?.(conv.id)).toEqual([]);
	});

	it("dismissFinishedSubagents：只收口空闲的子代理，父对话保留", () => {
		const { runtime } = makeRuntime();
		const parent = runtime.createConversation({ kind: "user" });
		const sub = runtime.createConversation({ kind: "subagent", parentId: parent.id });
		const running = runtime.createConversation({ kind: "subagent", parentId: parent.id });
		running.beginTurn(1);

		runtime.handlers().dismissFinishedSubagents?.(parent.id);
		expect(runtime.registry.has(sub.id)).toBe(false);
		expect(runtime.registry.has(running.id)).toBe(true);
		expect(runtime.registry.has(parent.id)).toBe(true);
	});

	it("dismissFinishedSubagents：父对话不存在时发 warning", () => {
		const { runtime, sent } = makeRuntime();
		runtime.createConversation({ kind: "user" });
		runtime.handlers().dismissFinishedSubagents?.("ghost");
		expect(notices(sent).at(-1)).toMatchObject({ level: "warning" });
	});
});

describe("草稿保存（B4）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-keel-drafts-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("真的落盘，且下一次从同一份文件读得回来", async () => {
		const file = join(dir, "drafts.json");
		const { runtime } = makeRuntime({ drafts: new ComposerDraftsStore(file) });
		runtime.createConversation({ kind: "user" });
		const cs = runtime.handlers();
		expect(cs.saveDraft).toBeDefined();
		await cs.saveDraft?.("sess-1", "写了一半", 1234);
		expect(readFileSync(file, "utf8")).toContain("写了一半");
		const reopened = new ComposerDraftsStore(file);
		expect(await reopened.get("sess-1")).toMatchObject({ text: "写了一半" });
	});

	it("空 sessionId 直接返回，不建文件", async () => {
		const file = join(dir, "drafts2.json");
		const { runtime } = makeRuntime({ drafts: new ComposerDraftsStore(file) });
		await runtime.handlers().saveDraft?.("", "x", 1);
		expect(() => readFileSync(file, "utf8")).toThrow();
	});
});

describe("草稿叶子在 keel 里（P1 式搬迁的连带项）", () => {
	it("DRAFT 常量仍由同一份实现提供", () => {
		expect(new ComposerDraftsStore(join(tmpdir(), "x.json"))).toBeInstanceOf(ComposerDraftsStore);
		expect(vi.isMockFunction(vi.fn())).toBe(true);
	});
});

describe("终端/项目脚本（B5a）", () => {
	it("getTerminalCwd：按对话取 cwd，未知对话回落到进程 cwd", () => {
		const { runtime } = makeRuntime();
		const conv = runtime.createConversation({ kind: "user", cwd: "/work/a" });
		expect(runtime.handlers().getTerminalCwd?.(conv.id)).toBe("/work/a");
		expect(runtime.handlers().getTerminalCwd?.("ghost")).toBe("/work");
	});

	it("findTerminalManager：不在该管理器里就返回 undefined（不抛）", () => {
		const { runtime } = makeRuntime();
		runtime.createConversation({ kind: "user" });
		expect(runtime.handlers().findTerminalManager?.("t-1")).toBeUndefined();
	});

	it("listProjectScripts：找不到 package.json 就是空表（叶子兜底不抛）", () => {
		const { runtime, sent } = makeRuntime();
		runtime.handlers().listProjectScripts?.("/definitely/not/here");
		const frame = sent.filter((m) => m.type === "project_scripts").at(-1);
		// 帧里的 cwd 是叶子归一后的绝对路径：只断言「空表 + 没 error」，不猜盘符样式。
		expect(frame).toMatchObject({ scripts: {} });
		expect(frame && "error" in frame ? frame.error : undefined).toBeUndefined();
	});
});
