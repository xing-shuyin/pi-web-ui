import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import { openHistoryConversation, type OpenHistoryInput } from "../../packages/keel/src/domains/history/open.js";
import { projectTranscriptText } from "../../packages/keel/src/domains/history/transcript.js";

/** 投影抛错用「整块换成会抛的实现」来造：真实现自己吞错，只能从外面顶掉一次。 */
const projectionFault = vi.hoisted(() => ({ fail: false }));

vi.mock("../../packages/keel/src/domains/history/transcript.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/keel/src/domains/history/transcript.js")>();
	return {
		...actual,
		projectTranscriptText: (text: string, opts?: { seq?: number }) => {
			if (projectionFault.fail) throw new Error("projection boom");
			return actual.projectTranscriptText(text, opts);
		},
	};
});

/**
 * 打开历史会话（历史域）：身份只由 registry 裁定，消息只由转录投影产出。
 * 用例全部走手写最小 jsonl，断言行为而不锚解法。
 */

const CWD = "/work/demo";
const NOW = 1_750_000_000_000;
const TS = 1_700_000_000_000;
const SESSION_FILE = "/sessions/sess-a.jsonl";

const HEADER = { type: "session", version: 3, id: "sess-a", cwd: CWD, timestamp: "2024-01-01T00:00:00Z" };

function userLine(id: string, parentId: string | null, text: string, ts: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: text, timestamp: ts },
	};
}

function assistantLine(id: string, parentId: string | null, text: string, ts: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			stopReason: "stop",
			timestamp: ts,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

/** 原样拼接：对象按 jsonl 序列化，字符串当作「已经是原始文本的行」（坏行用例靠它）。 */
function jsonl(...lines: unknown[]): string {
	return lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
}

const USER_AND_ASSISTANT = jsonl(
	HEADER,
	userLine("m1", null, "问题", TS + 1_000),
	assistantLine("m2", "m1", "回答", TS + 2_000),
);

function texts(messages: readonly UiMessage[]): string[] {
	return messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
}

function ids(messages: readonly UiMessage[]): string[] {
	return messages.map((m) => m.id);
}

function entryOf(over: Partial<OpenHistoryInput["entry"]> = {}): OpenHistoryInput["entry"] {
	return { id: "sess-a", title: "旧会话", sessionFile: SESSION_FILE, ...over };
}

/** 计数用的假读盘：第 N 次调用返回第 N 份文本（不够就重复最后一份）。 */
function reader(...chunks: string[]) {
	const calls: string[] = [];
	let index = 0;
	return {
		calls,
		readFile: async (path: string): Promise<string> => {
			calls.push(path);
			const text = chunks[Math.min(index, chunks.length - 1)] ?? "";
			index += 1;
			return text;
		},
	};
}

interface OpenOptions {
	text?: string;
	readFile?: (path: string) => Promise<string>;
	entry?: OpenHistoryInput["entry"];
	cwd?: string;
	now?: number;
}

function openHistory(registry: ConversationRegistry<Conversation>, opts: OpenOptions = {}) {
	return openHistoryConversation({
		registry,
		clientId: "client-1",
		cwd: opts.cwd ?? CWD,
		entry: opts.entry ?? entryOf(),
		now: opts.now ?? NOW,
		readFile: opts.readFile ?? (async () => opts.text ?? ""),
	});
}

function newRegistry(): ConversationRegistry<Conversation> {
	return new ConversationRegistry<Conversation>();
}

describe("openHistoryConversation：没打开过 → 新建对话", () => {
	it("新建 user 对话：cwd / title / sessionFile 落进 meta，createdAt 用 now", async () => {
		const registry = newRegistry();

		const { conversation } = await openHistory(registry, { text: USER_AND_ASSISTANT });

		expect(conversation.meta).toMatchObject({
			id: "sess-a",
			clientId: "client-1",
			cwd: CWD,
			title: "旧会话",
			kind: "user",
			createdAt: NOW,
			lastActiveAt: NOW,
			sessionFile: SESSION_FILE,
		});
		expect(registry.size()).toBe(1);
		expect(registry.activeId()).toBe("sess-a");
		expect(registry.bySessionFile(SESSION_FILE)).toBe(conversation);
	});

	it("条目没给 id：由 registry 发号，同进程内两个会话不撞号", async () => {
		const registry = newRegistry();

		const first = await openHistory(registry, { entry: entryOf({ id: undefined, sessionFile: "/s/a.jsonl" }) });
		const second = await openHistory(registry, { entry: entryOf({ id: undefined, sessionFile: "/s/b.jsonl" }) });

		expect([first.conversation.id, second.conversation.id]).toEqual(["c-1", "c-2"]);
		expect(registry.size()).toBe(2);
	});

	it("消息按条目顺序投影，id 与直接投影同一份文本一致", async () => {
		const opened = await openHistory(newRegistry(), { text: USER_AND_ASSISTANT });

		expect(opened.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(texts(opened.messages)).toEqual(["问题", "回答"]);
		expect(ids(opened.messages)).toEqual(ids(projectTranscriptText(USER_AND_ASSISTANT).projection.messages));
		expect(ids(opened.messages)).toEqual([`u-${TS + 1_000}-0`, `a-${TS + 2_000}-1`]);
	});

	it("同一份文本两次打开（各自 registry）：消息 id 串完全一致", async () => {
		const first = await openHistory(newRegistry(), { text: USER_AND_ASSISTANT });
		const second = await openHistory(newRegistry(), { text: USER_AND_ASSISTANT });

		expect(ids(second.messages)).toEqual(ids(first.messages));
	});

	it("空转录（只有 header）：对话照建，消息空且不计数", async () => {
		const registry = newRegistry();

		const opened = await openHistory(registry, { text: jsonl(HEADER) });

		expect(opened.messages).toEqual([]);
		expect(opened.skippedLines).toBe(0);
		expect(registry.activeId()).toBe("sess-a");
	});
});

describe("openHistoryConversation：同一会话文件不重建", () => {
	it("连开两次：conversation 同一实例、registry 只有一条、readFile 只被调两次", async () => {
		const registry = newRegistry();
		const fake = reader(USER_AND_ASSISTANT, USER_AND_ASSISTANT);

		const first = await openHistory(registry, { readFile: fake.readFile });
		const second = await openHistory(registry, { readFile: fake.readFile });

		expect(second.conversation).toBe(first.conversation);
		expect(registry.size()).toBe(1);
		expect(fake.calls).toEqual([SESSION_FILE, SESSION_FILE]);
		expect(ids(second.messages)).toEqual(ids(first.messages));
	});

	it("已开时身份与标题不被条目改写：同 sessionFile 换 id / 标题也还是旧对话", async () => {
		const registry = newRegistry();
		const first = await openHistory(registry, { text: USER_AND_ASSISTANT });

		const second = await openHistory(registry, {
			text: USER_AND_ASSISTANT,
			now: NOW + 60_000,
			entry: entryOf({ id: "sess-other", title: "改过的标题" }),
		});

		expect(second.conversation).toBe(first.conversation);
		expect(second.conversation.id).toBe("sess-a");
		expect(second.conversation.meta.title).toBe("旧会话");
		expect(second.conversation.meta.createdAt).toBe(NOW);
		expect(registry.size()).toBe(1);
		expect(registry.activeId()).toBe("sess-a");
	});

	it("消息每次重新投影：第二次读到别的文本，消息跟着变但对话不变", async () => {
		const registry = newRegistry();
		const fake = reader(
			jsonl(HEADER, userLine("m1", null, "第一版", TS + 1_000)),
			jsonl(HEADER, userLine("m1", null, "第二版", TS + 1_000)),
		);

		const first = await openHistory(registry, { readFile: fake.readFile });
		const second = await openHistory(registry, { readFile: fake.readFile });

		expect(texts(first.messages)).toEqual(["第一版"]);
		expect(texts(second.messages)).toEqual(["第二版"]);
		expect(second.conversation).toBe(first.conversation);
	});
});

describe("openHistoryConversation：激活切换", () => {
	it("开 B 后 active 是 B；再开已开的 A，active 回 A 且实例不变", async () => {
		const registry = newRegistry();
		const a = await openHistory(registry, { entry: entryOf() });
		const b = await openHistory(registry, {
			entry: entryOf({ id: "sess-b", title: "新会话", sessionFile: "/sessions/b.jsonl" }),
		});

		expect(registry.activeId()).toBe("sess-b");

		const again = await openHistory(registry, { entry: entryOf() });

		expect(registry.activeId()).toBe("sess-a");
		expect(again.conversation).toBe(a.conversation);
		expect(again.conversation).not.toBe(b.conversation);
	});
});

describe("openHistoryConversation：读盘与投影失败不抛", () => {
	it("读盘抛错：不抛，空消息 + skippedLines 1，对话仍然建好并激活", async () => {
		const registry = newRegistry();

		const opened = await openHistory(registry, {
			readFile: async () => {
				throw new Error("EACCES");
			},
		});

		expect(opened.messages).toEqual([]);
		expect(opened.skippedLines).toBe(1);
		expect(registry.activeId()).toBe("sess-a");
		expect(registry.bySessionFile(SESSION_FILE)).toBe(opened.conversation);
	});

	it("已开的对话读盘失败：不重建，返回的还是同一个", async () => {
		const registry = newRegistry();
		const first = await openHistory(registry, { text: USER_AND_ASSISTANT });
		let calls = 0;

		const opened = await openHistory(registry, {
			readFile: async () => {
				calls += 1;
				throw new Error("EIO");
			},
		});

		expect(calls).toBe(1);
		expect(opened.conversation).toBe(first.conversation);
		expect(opened.messages).toEqual([]);
		expect(opened.skippedLines).toBe(1);
		expect(registry.size()).toBe(1);
	});

	it("投影抛错：不抛，空消息 + skippedLines 1", async () => {
		const registry = newRegistry();
		projectionFault.fail = true;
		try {
			const opened = await openHistory(registry, { text: USER_AND_ASSISTANT });

			expect(opened.messages).toEqual([]);
			expect(opened.skippedLines).toBe(1);
			expect(registry.activeId()).toBe("sess-a");
		} finally {
			projectionFault.fail = false;
		}
	});
});

describe("openHistoryConversation：skippedLines 透传", () => {
	it("坏行：好行照出，坏行计数与直接投影同口径", async () => {
		const text = jsonl(HEADER, userLine("m1", null, "你好", TS + 1_000), '{"type":"message","id":"m2"');

		const opened = await openHistory(newRegistry(), { text });

		expect(texts(opened.messages)).toEqual(["你好"]);
		expect(opened.skippedLines).toBe(1);
		expect(opened.skippedLines).toBe(projectTranscriptText(text).skippedLines);
	});

	it("序列化为 null 的隐藏消息计入跳过，seq 不为它空转", async () => {
		const text = jsonl(
			HEADER,
			userLine("m1", null, "前", TS + 1_000),
			{
				type: "custom_message",
				id: "c1",
				parentId: "m1",
				timestamp: "2024-01-01T00:00:02Z",
				customType: "note",
				content: "隐藏备注",
				display: false,
			},
			userLine("m2", "c1", "后", TS + 3_000),
		);

		const opened = await openHistory(newRegistry(), { text });

		expect(texts(opened.messages)).toEqual(["前", "后"]);
		expect(opened.skippedLines).toBe(1);
		expect(ids(opened.messages)).toEqual([`u-${TS + 1_000}-0`, `u-${TS + 3_000}-1`]);
	});
});

describe("openHistoryConversation：默认读盘（不注入 readFile）", () => {
	it("真读磁盘：utf8 读出整份转录并出消息", async () => {
		const dir = mkdtempSync(join(tmpdir(), "core-history-open-"));
		const file = join(dir, "sess-a.jsonl");
		writeFileSync(file, USER_AND_ASSISTANT, "utf8");
		const registry = newRegistry();

		const opened = await openHistoryConversation({
			registry,
			clientId: "client-1",
			cwd: CWD,
			entry: entryOf({ sessionFile: file }),
			now: NOW,
		});

		expect(texts(opened.messages)).toEqual(["问题", "回答"]);
		expect(opened.skippedLines).toBe(0);
		expect(registry.bySessionFile(file)).toBe(opened.conversation);
	});

	it("默认读盘碰上不存在的文件：不抛，空消息 + skippedLines 1", async () => {
		const dir = mkdtempSync(join(tmpdir(), "core-history-open-"));
		const missing = join(dir, "missing.jsonl");
		const registry = newRegistry();

		const opened = await openHistoryConversation({
			registry,
			clientId: "client-1",
			cwd: CWD,
			entry: entryOf({ sessionFile: missing }),
			now: NOW,
		});

		expect(opened.messages).toEqual([]);
		expect(opened.skippedLines).toBe(1);
		expect(registry.bySessionFile(missing)).toBe(opened.conversation);
	});
});
