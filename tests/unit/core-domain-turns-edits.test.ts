import { describe, expect, it, vi } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { MessageEditSession, TurnAgentMessage, TurnEntry } from "../../packages/keel/src/contracts/turns.js";
import { createTurnsEditHandlers, type TurnsEditDeps } from "../../packages/keel/src/domains/turns/index.js";
import type { DispatchSession } from "../../packages/keel/src/engine-service.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { PromptAttachment, ServerMessage } from "../../server/protocol.js";

function fakeClock(): ClockPort {
	let now = 1_000;
	return {
		now: () => (now += 1),
		after: () => () => {},
	};
}

function fakeTransport() {
	const sent: ServerMessage[] = [];
	let closed = false;
	return {
		sent,
		close: () => {
			closed = true;
		},
		port: {
			send: (msg: ServerMessage) => void sent.push(msg),
			isClosed: () => closed,
		},
	};
}

function notices(sent: ServerMessage[]): Array<{ level: string; text: string }> {
	return sent
		.filter((msg) => msg.type === "notice")
		.map((msg) => {
			const notice = msg as unknown as { level: string; text: string };
			return { level: notice.level, text: notice.text };
		});
}

function entry(id: string, message: NonNullable<TurnEntry["message"]>, parentId?: string | null): TurnEntry {
	return { id, type: "message", parentId, message };
}

interface EditorState {
	entries: TurnEntry[];
	branch: TurnEntry[];
	uiIds: Map<string, string>;
	messages: TurnAgentMessage[];
	calls: string[];
	leaf: string | null;
	sessionFile: string | undefined;
	streaming: boolean;
	retrying: boolean;
	token: unknown;
}

/**
 * 假编辑面：只模拟「条目树会怎么变」，编排本身（删哪些 / 往哪分叉）由被测域决定。
 * 每个动作都记进 `calls`，失败注入用 `failOn`。
 */
function fakeEditor(overrides: Partial<EditorState> = {}, failOn: string[] = []) {
	const state: EditorState = {
		entries: [],
		branch: [],
		uiIds: new Map(),
		messages: [],
		calls: [],
		leaf: null,
		sessionFile: "/tmp/s.jsonl",
		streaming: false,
		retrying: false,
		token: Symbol("session"),
		...overrides,
	};
	const fail = (name: string): void => {
		if (failOn.includes(name)) throw new Error(`${name} failed`);
		state.calls.push(name);
	};
	const editor: MessageEditSession = {
		get sessionFile() {
			return state.sessionFile;
		},
		get isStreaming() {
			return state.streaming;
		},
		get thinkingLevel() {
			return "high";
		},
		model: { provider: "anthropic", id: "claude" },
		abort: async () => void fail("abort"),
		clearQueue: () => fail("clearQueue"),
		waitForIdle: async () => {},
		isRetrying: () => state.retrying,
		sessionToken: () => state.token,
		setThinkingLevel: (level: string) => fail(`setThinkingLevel:${level}`),
		agentMessages: () => state.messages,
		contextEntries: () => state.entries,
		branchEntries: () => state.branch,
		entry: (id: string) => state.entries.find((item) => item.id === id),
		leafId: () => state.leaf,
		uiIds: () => state.uiIds,
		hideEntry: (id: string) => {
			fail(`hideEntry:${id}`);
			state.entries = state.entries.filter((item) => item.id !== id);
		},
		branch: (fromId: string) => {
			if (failOn.includes("branch")) throw new Error("branch failed");
			state.calls.push(`branch:${fromId}`);
			state.leaf = fromId;
		},
		resetLeaf: () => {
			if (failOn.includes("resetLeaf")) throw new Error("resetLeaf failed");
			state.calls.push("resetLeaf");
			state.leaf = null;
		},
		appendCustomEntry: (customType: string) => {
			if (failOn.includes("appendCustomEntry")) throw new Error("appendCustomEntry failed");
			state.calls.push(`appendCustomEntry:${customType}`);
		},
		rebuildMessages: () => {
			state.calls.push("rebuildMessages");
			state.messages = [...state.messages];
		},
		reload: async () => {
			if (failOn.includes("reload")) throw new Error("reload failed");
			state.calls.push("reload");
		},
		restoreSessionFile: (file: string | undefined) => state.calls.push(`restoreSessionFile:${file ?? "none"}`),
		sendCustomMessage: async (message, options) => {
			if (failOn.includes("sendCustomMessage")) throw new Error("sendCustomMessage failed");
			state.calls.push(`sendCustomMessage:${message.customType}:${options?.triggerTurn === true}`);
		},
	};
	return { editor, state };
}

function harness(options: { editor?: MessageEditSession; editorOf?: TurnsEditDeps["editorOf"]; sessionFile?: string }) {
	const transport = fakeTransport();
	const registry = new ConversationRegistry<Conversation>();
	const conv = new Conversation({ id: "c1", clientId: "cl", cwd: "/w", kind: "user", createdAt: 1_000 });
	registry.add(conv);
	registry.activate(conv.id);
	const reask = vi.fn(async () => {});
	const flushSnapshot = vi.fn();
	const deps: TurnsEditDeps = {
		registry,
		transport: transport.port,
		clock: fakeClock(),
		...(options.editorOf ? { editorOf: options.editorOf } : { editorOf: () => options.editor }),
		reask,
		flushSnapshot,
	};
	return { deps, conv, transport, reask, flushSnapshot };
}

/** 一轮问答：user → assistant(带 schedule 调用) → toolResult → user（后续历史）。 */
function turnEntries(): { entries: TurnEntry[]; uiIds: Map<string, string> } {
	const entries: TurnEntry[] = [
		{ id: "u1", type: "message", parentId: null, message: { role: "user", timestamp: 1 } },
		entry(
			"a1",
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "toolCall", id: "call1", name: "schedule" }],
			},
			"u1",
		),
		entry("t1", { role: "toolResult", toolCallId: "call1", timestamp: 3 }, "a1"),
		entry("u2", { role: "user", timestamp: 4 }, "t1"),
	];
	return {
		entries,
		uiIds: new Map([
			["u1", "u-1-0"],
			["a1", "a-2-1"],
			["u2", "u-4-3"],
		]),
	};
}

describe("editMessage · happy path", () => {
	it("按老实现的顺序截断历史并重新提问（附件交给宿主管线）", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, sessionFile: "/s.jsonl" });
		const h = harness({ editor });
		const attachments = [{ path: "/a.png", mode: "inline" }] as PromptAttachment[];

		await createTurnsEditHandlers(h.deps).editMessage("u-4-3", "  改过的问题  ", attachments);

		// 截断基准 = u2 往上第一个「轮次实体」= t1；先清队列、再分叉、再落重问标记、再重算消息、再重载。
		expect(state.calls).toEqual([
			"clearQueue",
			"branch:t1",
			"appendCustomEntry:pi-web-ui:reask",
			"rebuildMessages",
			"reload",
			"clearQueue",
			"setThinkingLevel:high",
		]);
		expect(h.reask).toHaveBeenCalledWith(h.conv, "改过的问题", attachments);
		expect(notices(h.transport.sent)).toEqual([{ level: "info", text: "已在当前对话重新提问，后续历史已移除" }]);
		expect(h.flushSnapshot).toHaveBeenCalled();
	});

	it("首条消息没有父条目：resetLeaf 而不是 branch", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, leaf: "u1" });
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).editMessage("u-1-0", "改首条");

		expect(state.calls).toContain("resetLeaf");
		expect(state.calls.some((call) => call.startsWith("branch:"))).toBe(false);
	});

	it("正在生成：先 abort，再等这一轮收尾（相位回收窗口）", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, streaming: true });
		const whenIdle = vi.fn(async () => {});
		const h = harness({ editor });

		await createTurnsEditHandlers({ ...h.deps, whenIdle }).editMessage("u-4-3", "改");

		expect(state.calls[0]).toBe("clearQueue");
		expect(state.calls[1]).toBe("abort");
		expect(whenIdle).toHaveBeenCalledWith("c1");
	});

	it("空文本但带附件：放行（老实现 #443）", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds });
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).editMessage("u-4-3", "  ", [{ path: "/a.png" }] as PromptAttachment[]);

		expect(h.reask).toHaveBeenCalledWith(h.conv, "", [expect.objectContaining({ path: "/a.png" })]);
		expect(state.calls).toContain("reload");
	});
});

describe("editMessage · 拒绝路径", () => {
	it("空文本且无附件：warning 并提前返回（不碰会话）", async () => {
		const { editor, state } = fakeEditor({});
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).editMessage("u-1-0", "   ", []);

		expect(notices(h.transport.sent)).toEqual([{ level: "warning", text: "编辑内容为空，已取消" }]);
		expect(state.calls).toEqual([]);
		expect(h.reask).not.toHaveBeenCalled();
	});

	it("找不到消息 / 不是用户消息：报错不截断", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds });
		const h = harness({ editor });
		const handlers = createTurnsEditHandlers(h.deps);

		await handlers.editMessage("a-2-1", "改 assistant？");
		await handlers.editMessage("u-9-9", "改不存在的？");

		expect(state.calls).toEqual([]);
		expect(notices(h.transport.sent)).toEqual([
			{ level: "error", text: "找不到要编辑的消息（可能已被压缩或不在当前分支）" },
			{ level: "error", text: "找不到要编辑的消息（可能已被压缩或不在当前分支）" },
		]);
	});

	it("会话没有编辑窄面：按「找不到消息」拒绝（老实现的文案）", async () => {
		const h = harness({ editorOf: () => undefined });
		await createTurnsEditHandlers(h.deps).editMessage("u-1-0", "改");

		expect(notices(h.transport.sent)).toEqual([
			{ level: "error", text: "找不到要编辑的消息（可能已被压缩或不在当前分支）" },
		]);
	});
});

describe("editMessage · 失败回滚", () => {
	it("落重问标记失败：指回原文件 + 叶指针回原位，再把错误报成 notice", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, leaf: "u2", sessionFile: "/s.jsonl" }, [
			"appendCustomEntry",
		]);
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).editMessage("u-4-3", "改");

		expect(state.calls).toEqual(["clearQueue", "branch:t1", "restoreSessionFile:/s.jsonl", "branch:u2"]);
		expect(h.reask).not.toHaveBeenCalled();
		expect(notices(h.transport.sent)).toEqual([{ level: "error", text: "编辑重问失败：appendCustomEntry failed" }]);
	});

	it("取消定时任务失败：截断根本没提交（commit 由宿主在落盘成功后调）", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, leaf: "u2", sessionFile: "/s.jsonl" });
		const cancelDiscarded = vi.fn(async () => {
			throw new Error("scheduler write failed");
		});
		const h = harness({ editor });

		await createTurnsEditHandlers({ ...h.deps, cancelDiscarded }).editMessage("u-1-0", "改首条");

		expect(cancelDiscarded).toHaveBeenCalledWith({
			sessionFile: "/s.jsonl",
			toolCallIds: new Set(["call1"]),
			commit: expect.any(Function),
		});
		expect(state.calls).toEqual(["clearQueue"]);
		expect(notices(h.transport.sent)).toEqual([{ level: "error", text: "编辑重问失败：scheduler write failed" }]);
	});

	it("取消定时任务成功后由 commit 截断（宿主决定何时提交）", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, leaf: "u2", sessionFile: "/s.jsonl" });
		const h = harness({ editor });

		await createTurnsEditHandlers({
			...h.deps,
			cancelDiscarded: async ({ commit }) => commit(),
		}).editMessage("u-4-3", "改");

		expect(state.calls).toEqual([
			"clearQueue",
			"branch:t1",
			"appendCustomEntry:pi-web-ui:reask",
			"rebuildMessages",
			"reload",
			"clearQueue",
			"setThinkingLevel:high",
		]);
	});

	it("重载失败：历史已截断（老实现不回滚），错误如实报出", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, branch: entries, uiIds, leaf: "u2" }, ["reload"]);
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).editMessage("u-4-3", "改");

		expect(state.calls).toContain("appendCustomEntry:pi-web-ui:reask");
		expect(state.calls.some((call) => call.startsWith("restoreSessionFile:"))).toBe(false);
		expect(h.reask).not.toHaveBeenCalled();
		expect(notices(h.transport.sent)).toEqual([{ level: "error", text: "编辑重问失败：reload failed" }]);
	});
});

describe("editMessage · 跨 await 归属复核", () => {
	it("重载期间会话被换掉：续体不再喂轮，也不报错", async () => {
		const { entries, uiIds } = turnEntries();
		const first = fakeEditor({ entries, branch: entries, uiIds });
		const second = fakeEditor({ entries, branch: entries, uiIds });
		let swapped = false;
		first.editor.reload = async () => {
			first.state.calls.push("reload");
			swapped = true;
		};
		const h = harness({ editorOf: () => (swapped ? second.editor : first.editor) });

		await createTurnsEditHandlers(h.deps).editMessage("u-4-3", "改");

		expect(h.reask).not.toHaveBeenCalled();
		expect(notices(h.transport.sent)).toEqual([]);
	});
});

describe("deleteMessage", () => {
	it("删用户消息：连带前面的附件旁注，重算消息并让会话列表失效", async () => {
		const entries: TurnEntry[] = [
			{ id: "f1", type: "custom_message", customType: "file", display: true },
			{ id: "u1", type: "message", parentId: "f1", message: { role: "user", timestamp: 1 } },
			entry("a1", { role: "assistant", timestamp: 2 }, "u1"),
		];
		const { editor, state } = fakeEditor({ entries, uiIds: new Map([["u1", "u-1-1"]]) });
		const sessionsChanged = vi.fn();
		const h = harness({ editor });

		await createTurnsEditHandlers({ ...h.deps, sessionsChanged }).deleteMessage("u-1-1");

		expect(state.calls).toEqual(["hideEntry:u1", "hideEntry:f1", "rebuildMessages"]);
		expect(sessionsChanged).toHaveBeenCalledWith("c1");
		expect(notices(h.transport.sent)).toEqual([]);
	});

	it("删 assistant：连带它的工具结果", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, uiIds });
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).deleteMessage("a-2-1");

		expect(state.calls).toEqual(["hideEntry:a1", "hideEntry:t1", "rebuildMessages"]);
	});

	it("删不存在 / 已删的消息：报错（老文案），不碰条目", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, uiIds });
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).deleteMessage("u-9-9");

		expect(state.calls).toEqual([]);
		expect(notices(h.transport.sent)).toEqual([{ level: "error", text: "删除消息失败：Message not found" }]);
	});

	it("生成中拒绝删除", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor } = fakeEditor({ entries, uiIds, streaming: true });
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).deleteMessage("a-2-1");

		expect(notices(h.transport.sent)).toEqual([
			{ level: "error", text: "删除消息失败：Stop generation before deleting a message" },
		]);
	});

	it("中途失败：从文件回滚（无文件的会话不动）并把内存消息重算一遍", async () => {
		const { entries, uiIds } = turnEntries();
		const { editor, state } = fakeEditor({ entries, uiIds }, ["hideEntry:t1"]);
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).deleteMessage("a-2-1");

		expect(state.calls).toEqual(["hideEntry:a1", "restoreSessionFile:/tmp/s.jsonl", "rebuildMessages"]);
		expect(notices(h.transport.sent)).toEqual([{ level: "error", text: "删除消息失败：hideEntry:t1 failed" }]);
	});
});

describe("retryLast", () => {
	it("最后一条 assistant 报错：发一条隐藏的引导消息并真开一轮", async () => {
		const { editor, state } = fakeEditor({
			messages: [{ role: "user" }, { role: "assistant", stopReason: "error", errorMessage: "boom" }],
		});
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).retryLast();

		expect(state.calls).toEqual(["sendCustomMessage:manual-retry:true"]);
		expect(h.conv.phase).toBe("idle");
		expect(notices(h.transport.sent)).toEqual([]);
	});

	it("没有失败的上一轮：info 并返回", async () => {
		const { editor, state } = fakeEditor({ messages: [{ role: "assistant", stopReason: "stop" }] });
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).retryLast();

		expect(state.calls).toEqual([]);
		expect(notices(h.transport.sent)).toEqual([{ level: "info", text: "没有可重试的失败：上一轮没有报错结束" }]);
	});

	it("生成中 / 自动重试中：各自一句 info", async () => {
		const streaming = fakeEditor({ messages: [{ role: "assistant", stopReason: "error" }], streaming: true });
		const first = harness({ editor: streaming.editor });
		await createTurnsEditHandlers(first.deps).retryLast();

		const retrying = fakeEditor({ messages: [{ role: "assistant", stopReason: "error" }], retrying: true });
		const second = harness({ editor: retrying.editor });
		await createTurnsEditHandlers(second.deps).retryLast();

		expect(notices(first.transport.sent)).toEqual([{ level: "info", text: "对话正在生成中，无需重试" }]);
		expect(notices(second.transport.sent)).toEqual([{ level: "info", text: "正在自动重试中，稍候即可" }]);
	});

	it("补发失败：先回相位再报错（不留「在跑」的假象）", async () => {
		const { editor } = fakeEditor({ messages: [{ role: "assistant", stopReason: "error" }] }, ["sendCustomMessage"]);
		const h = harness({ editor });

		await createTurnsEditHandlers(h.deps).retryLast();

		expect(h.conv.phase).toBe("idle");
		expect(notices(h.transport.sent)).toEqual([{ level: "error", text: "手动重试失败：sendCustomMessage failed" }]);
	});
});

describe("接线形状", () => {
	it("三个 handler 能直接落进 DispatchSession 的同名成员（签名不漂）", () => {
		const { editor } = fakeEditor({});
		const handlers = createTurnsEditHandlers(harness({ editor }).deps);
		const surface: Pick<DispatchSession, "editMessage" | "deleteMessage" | "retryLast"> = handlers;

		expect(typeof surface.editMessage).toBe("function");
		expect(typeof surface.deleteMessage).toBe("function");
		expect(typeof surface.retryLast).toBe("function");
	});
});

describe("端口未注入：同步抛", () => {
	const cases: Array<[string, (handlers: ReturnType<typeof createTurnsEditHandlers>) => Promise<unknown>]> = [
		["editMessage", (handlers) => handlers.editMessage("u-1-0", "改")],
		["deleteMessage", (handlers) => handlers.deleteMessage("a-2-1")],
		["retryLast", (handlers) => handlers.retryLast()],
	];

	for (const [name, call] of cases) {
		it(`${name} 没有编辑窄面时同步抛 CoreEngineNotReadyError（不是 rejected promise）`, () => {
			const h = harness({ editorOf: () => undefined });
			const handlers = createTurnsEditHandlers({ ...h.deps, editorOf: undefined });

			expect(() => call(handlers)).toThrow(CoreEngineNotReadyError);
		});
	}

	it("editMessage 没有重问端口时同样同步抛", () => {
		const { editor } = fakeEditor({});
		const h = harness({ editor });
		const handlers = createTurnsEditHandlers({ ...h.deps, reask: undefined });

		expect(() => handlers.editMessage("u-1-0", "改")).toThrow(CoreEngineNotReadyError);
		expect(notices(h.transport.sent)).toEqual([]);
	});
});
