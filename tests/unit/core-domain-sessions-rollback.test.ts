import { describe, expect, it } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { MessageEditSession, TurnEntry } from "../../packages/keel/src/contracts/turns.js";
import { createSessionRollbacks, type SessionRollbackOptions } from "../../packages/keel/src/domains/sessions/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ServerMessage } from "../../server/protocol.js";

function notices(sent: ServerMessage[]): Array<{ level: string; text: string }> {
	return sent
		.filter((msg) => msg.type === "notice")
		.map((msg) => {
			const notice = msg as unknown as { level: string; text: string };
			return { level: notice.level, text: notice.text };
		});
}

function entry(id: string, role: string, parentId?: string | null): TurnEntry {
	return { id, type: "message", parentId, message: { role } };
}

function turnEntries(): TurnEntry[] {
	return [entry("u1", "user", null), entry("a1", "assistant", "u1"), entry("u2", "user", "a1")];
}

interface EditorState {
	calls: string[];
	leaf: string | null;
	streaming: boolean;
	token: unknown;
	entries: TurnEntry[];
}

function fakeEditor(state: EditorState, failOn: string[] = []) {
	// 失败只注入一次：复位时（`branch(previousLeaf)`）必须能真的跑完，否则测不到回滚本身。
	const failed = new Set<string>();
	const fail = (name: string, message: string): void => {
		if (failOn.includes(name) && !failed.has(name)) {
			failed.add(name);
			throw new Error(message);
		}
	};
	const editor: MessageEditSession = {
		sessionFile: "/s/session.jsonl",
		get isStreaming() {
			return state.streaming;
		},
		thinkingLevel: "high",
		abort: async () => void state.calls.push("abort"),
		clearQueue: () => void state.calls.push("clearQueue"),
		waitForIdle: async () => {},
		isRetrying: () => false,
		sessionToken: () => state.token,
		setThinkingLevel: () => {},
		agentMessages: () => [],
		contextEntries: () => state.entries,
		branchEntries: () => state.entries,
		entry: (id: string) => state.entries.find((item) => item.id === id),
		leafId: () => state.leaf,
		uiIds: () => new Map(state.entries.map((item) => [item.id, item.id])),
		hideEntry: () => {},
		branch: (fromId: string) => {
			fail("branch", "branch failed");
			state.calls.push(`branch:${fromId}`);
			state.leaf = fromId;
		},
		resetLeaf: () => {
			state.calls.push("resetLeaf");
			state.leaf = null;
		},
		appendCustomEntry: () => {},
		rebuildMessages: () => {
			fail("rebuildMessages", "rebuildMessages failed");
			state.calls.push("rebuildMessages");
		},
		reload: async () => {
			fail("reload", "reload failed");
			state.calls.push("reload");
		},
		restoreSessionFile: () => {},
		sendCustomMessage: async () => {},
	};
	return editor;
}

interface Harness {
	deps: SessionRollbackOptions;
	conv: Conversation;
	registry: ConversationRegistry<Conversation>;
	state: EditorState;
	sent: ServerMessage[];
}

function harness(options: { failOn?: string[]; state?: Partial<EditorState> } = {}): Harness {
	const registry = new ConversationRegistry<Conversation>();
	const conv = new Conversation({
		id: "c1",
		clientId: "cl",
		cwd: "/w",
		kind: "user",
		createdAt: 1_000,
		sessionFile: "/s/session.jsonl",
	});
	registry.add(conv);
	registry.activate(conv.id);
	const state: EditorState = {
		calls: [],
		leaf: "u2",
		streaming: false,
		token: Symbol("session"),
		entries: turnEntries(),
		...options.state,
	};
	const editor = fakeEditor(state, options.failOn ?? []);
	const sent: ServerMessage[] = [];
	const deps: SessionRollbackOptions = {
		registry,
		editorOf: () => editor,
		entryIdOf: (ed, messageId) => ed.contextEntries().find((item) => item.id === messageId)?.id,
		afterReload: () => void state.calls.push("afterReload"),
		flushSnapshot: () => {},
		notice: (level, text) => void sent.push({ type: "notice", level, text } as ServerMessage),
	};
	return { deps, conv, registry, state, sent };
}

describe("rollbackSession · 叶指针改到条目 + 重载（不换会话）", () => {
	it("happy path：先清队列，再 branch → 重算消息 → 重载 → 宿主收尾", async () => {
		const h = harness();

		await createSessionRollbacks(h.deps).rollbackSession("a1");

		expect(h.state.calls).toEqual(["clearQueue", "branch:a1", "rebuildMessages", "reload", "afterReload"]);
		expect(h.state.leaf).toBe("a1");
		expect(notices(h.sent).at(-1)).toMatchObject({ level: "info" });
		expect(notices(h.sent).at(-1)?.text).toContain("已回滚至选定消息");
	});

	it("正在生成：先 abort 再动叶指针", async () => {
		const h = harness({ state: { streaming: true } });

		await createSessionRollbacks(h.deps).rollbackSession("u2");

		expect(h.state.calls.slice(0, 2)).toEqual(["abort", "clearQueue"]);
		expect(h.state.calls).toContain("branch:u2");
	});

	it("按 conversationId 回滚那条对话（不是活动对话）", async () => {
		const h = harness();
		const other = new Conversation({
			id: "c2",
			clientId: "cl",
			cwd: "/w",
			kind: "user",
			createdAt: 2_000,
			sessionFile: "/s/two.jsonl",
		});
		h.registry.add(other);
		const otherSent: ServerMessage[] = [];
		let seen: string[] = [];
		const deps: SessionRollbackOptions = {
			...h.deps,
			editorOf: (id) => {
				seen.push(id);
				return fakeEditor(h.state);
			},
			notice: (level, text) => void otherSent.push({ type: "notice", level, text } as ServerMessage),
		};

		await createSessionRollbacks(deps).rollbackSession("a1", "c2");

		expect(seen.length).toBeGreaterThan(0);
		expect(new Set(seen)).toEqual(new Set(["c2"]));
	});

	it("队列跟着清：回滚后不许把旧分支排队的意图续投出去", async () => {
		const h = harness();
		h.conv.queues.enqueue("followUp", "排队的话");

		await createSessionRollbacks(h.deps).rollbackSession("a1");

		expect(h.conv.queues.total()).toBe(0);
	});
});

describe("rollbackSession · 失败回滚到原位", () => {
	it("重载失败：叶指针按进函数时抓的稳定 id 复位，并如实报错", async () => {
		const h = harness({ failOn: ["reload"] });

		await createSessionRollbacks(h.deps).rollbackSession("a1");

		// 先进到 a1，再被 reload 打回来：复位到 u2（不是重读 leafId，也不留在 a1）
		expect(h.state.calls).toEqual(["clearQueue", "branch:a1", "rebuildMessages", "branch:u2", "rebuildMessages"]);
		expect(h.state.leaf).toBe("u2");
		expect(notices(h.sent).at(-1)).toMatchObject({ level: "error" });
		expect(notices(h.sent).at(-1)?.text).toContain("回滚失败：reload failed");
	});

	it("branch 自己失败：叶指针没动过，也照常复位并报错", async () => {
		const h = harness({ failOn: ["branch"] });

		await createSessionRollbacks(h.deps).rollbackSession("a1");

		expect(h.state.calls).toEqual(["clearQueue", "branch:u2", "rebuildMessages"]);
		expect(h.state.leaf).toBe("u2");
		expect(notices(h.sent).at(-1)?.level).toBe("error");
	});

	it("跨 await 期间会话被换掉：不再改游标、也不再报成功", async () => {
		const h = harness();
		let dropped = false;
		const deps: SessionRollbackOptions = {
			...h.deps,
			afterReload: () => {
				throw new Error("must not run after the conversation is gone");
			},
			editorOf: (id) => {
				// reload 之后这条对话已经被摘出注册表（退役 / 换会话）
				if (dropped) return undefined;
				const editor = fakeEditor(h.state);
				const original = editor.reload;
				editor.reload = async () => {
					await original?.();
					h.registry.remove(id);
					dropped = true;
				};
				return editor;
			},
		};

		await createSessionRollbacks(deps).rollbackSession("a1");

		expect(dropped).toBe(true);
		expect(notices(h.sent)).toEqual([]);
	});

	it("检查点不存在：报错并不动叶指针", async () => {
		const h = harness();

		await createSessionRollbacks(h.deps).rollbackSession("ghost");

		expect(h.state.calls).toEqual([]);
		expect(notices(h.sent)).toEqual([{ level: "error", text: "找不到指定的回滚检查点（可能已被压缩或不存在）" }]);
	});
});

describe("rollbackSession · 端口未注入", () => {
	it("编辑窄面缺失（会话实体未接）：同步抛 CoreEngineNotReadyError", () => {
		const h = harness();
		const rollbacks = createSessionRollbacks({ ...h.deps, editorOf: undefined });

		expect(() => rollbacks.rollbackSession("a1")).toThrow(CoreEngineNotReadyError);
	});
});
