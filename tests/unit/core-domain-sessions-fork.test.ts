import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createBranchFile } from "../../packages/keel/src/adapters/sdk/session-opener.js";
import { createSessionSurface } from "../../packages/keel/src/app/session-surface.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { MessageEditSession, TurnEntry } from "../../packages/keel/src/contracts/turns.js";
import { createSessionForks, type SessionForkOptions } from "../../packages/keel/src/domains/sessions/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ServerMessage } from "../../server/protocol.js";

function fakeTransport() {
	const sent: ServerMessage[] = [];
	const port = { send: (msg: ServerMessage) => void sent.push(msg), isClosed: () => false };
	return { sent, port };
}

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

/** 一轮问答：u1 → a1（分叉点）；条目 id 同时当出帧编号用，解析单源在 `domains/turns/entries`。 */
function turnEntries(): TurnEntry[] {
	const u1 = entry("u1", "user", null);
	const a1 = entry("a1", "assistant", "u1");
	return [u1, a1, entry("u2", "user", "a1")];
}

function fakeEditor(overrides: { entries?: TurnEntry[]; sessionFile?: string } = {}) {
	const entries = overrides.entries ?? turnEntries();
	const state = { sessionFile: overrides.sessionFile ?? "/s/session.jsonl" };
	const editor: MessageEditSession = {
		get sessionFile() {
			return state.sessionFile;
		},
		get isStreaming() {
			return false;
		},
		thinkingLevel: "high",
		sessionToken: () => editor,
		agentMessages: () => [],
		contextEntries: () => entries,
		branchEntries: () => entries,
		entry: (id: string) => entries.find((item) => item.id === id),
		leafId: () => entries.at(-1)?.id ?? null,
		uiIds: () => new Map(entries.map((item) => [item.id, item.id])),
		hideEntry: () => {},
		branch: () => {},
		resetLeaf: () => {},
		appendCustomEntry: () => {},
		rebuildMessages: () => {},
		reload: async () => {},
		restoreSessionFile: () => {},
		sendCustomMessage: async () => {},
	};
	return { editor, state };
}

interface Harness {
	deps: SessionForkOptions;
	conv: Conversation;
	registry: ConversationRegistry<Conversation>;
	sent: ServerMessage[];
	calls: string[];
	flush: () => void;
}

function harness(overrides: Partial<SessionForkOptions> = {}, editor = fakeEditor().editor): Harness {
	const transport = fakeTransport();
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
	const calls: string[] = [];
	let flushed = 0;
	const deps: SessionForkOptions = {
		registry,
		editorOf: () => editor,
		entryIdOf: (ed, messageId) => ed.contextEntries().find((item) => item.id === messageId)?.id,
		baseEntryIdOf: (ed, entryId) => {
			const target = ed.entry(entryId);
			return target ? (target.parentId ?? null) : null;
		},
		createBranchFile: async (input) => {
			calls.push(`createBranchFile:${input.leafId}`);
			return `/s/forked-${input.leafId}.jsonl`;
		},
		rebind: async (request) => {
			calls.push(`rebind:${request.sessionFile ?? "new"}:${request.cwd}`);
			return { conversation: conv };
		},
		markListed: (id) => calls.push(`markListed:${id}`),
		flushSnapshot: () => {
			flushed += 1;
		},
		notice: (level, text) => void transport.sent.push({ type: "notice", level, text } as ServerMessage),
		...overrides,
	};
	return { deps, conv, registry, sent: transport.sent, calls, flush: () => void flushed };
}

describe("forkSession · 位置解析与派生", () => {
	it("position=at：按这条消息的条目 id 派生，重绑到新文件且 cwd 不变", async () => {
		const h = harness();

		await createSessionForks(h.deps).forkSession("a1", "at");

		expect(h.calls).toEqual(["createBranchFile:a1", "rebind:/s/forked-a1.jsonl:/w", "markListed:c1"]);
		expect(notices(h.sent).at(-1)).toMatchObject({ level: "info" });
	});

	it("position=before（缺省）：派生的基准是这一轮之前的条目", async () => {
		const h = harness();

		await createSessionForks(h.deps).forkSession("u2");

		expect(h.calls[0]).toBe("createBranchFile:a1");
		expect(h.calls[1]).toBe("rebind:/s/forked-a1.jsonl:/w");
	});

	it("显式 conversationId：按那条对话（不是活动对话）派生", async () => {
		const h = harness();
		const other = new Conversation({
			id: "c2",
			clientId: "cl",
			cwd: "/other",
			kind: "user",
			createdAt: 2_000,
			sessionFile: "/s/two.jsonl",
		});
		h.registry.add(other);

		await createSessionForks(h.deps).forkSession("a1", "at", "c2");

		expect(h.calls[1]).toBe("rebind:/s/forked-a1.jsonl:/other");
	});

	it("消息 id 解析不到：报错并不派生", async () => {
		const h = harness();

		await createSessionForks(h.deps).forkSession("nope", "at");

		expect(h.calls).toEqual([]);
		expect(notices(h.sent)).toEqual([
			{
				level: "error",
				text: "找不到指定的消息节点（可能已被压缩或不在当前分支）",
			},
		]);
	});

	it("before 且没有基准（首条消息之前）：拒绝派生，不留空会话", async () => {
		const h = harness({ baseEntryIdOf: () => null });

		await createSessionForks(h.deps).forkSession("u1");

		expect(h.calls).toEqual([]);
		expect(notices(h.sent).at(-1)?.level).toBe("error");
	});

	it("对话没有会话文件：报错并不派生（内核不拿内存树假装落盘）", async () => {
		const { editor, state } = fakeEditor();
		state.sessionFile = "";
		const registry = new ConversationRegistry<Conversation>();
		const bare = new Conversation({ id: "c9", clientId: "cl", cwd: "/w", kind: "user", createdAt: 1_000 });
		registry.add(bare);
		registry.activate(bare.id);
		const sent: ServerMessage[] = [];
		const calls: string[] = [];
		const forks = createSessionForks({
			registry,
			editorOf: () => editor,
			entryIdOf: (ed, messageId) => ed.contextEntries().find((item) => item.id === messageId)?.id,
			createBranchFile: async (input) => {
				calls.push(`createBranchFile:${input.leafId}`);
				return "/s/x.jsonl";
			},
			rebind: async () => {
				calls.push("rebind");
				return { conversation: bare };
			},
			flushSnapshot: () => {},
			notice: (level, text) => void sent.push({ type: "notice", level, text } as ServerMessage),
		});

		await forks.forkSession("a1", "at");

		expect(calls).toEqual([]);
		expect(sent.at(-1)).toMatchObject({ level: "error" });
	});
});

describe("forkSession · 失败真回滚", () => {
	it("重绑失败：派生出来的文件与证据目录全部删掉", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-fork-cleanup-"));
		try {
			const branchFile = join(dir, "branch.jsonl");
			writeFileSync(branchFile, "{}\n", "utf8");
			const removed: string[] = [];
			const h = harness({
				createBranchFile: async () => branchFile,
				rebind: async () => {
					throw new Error("open failed");
				},
				evidence: () => ({
					copy: async () => {},
					remove: async (file) => void removed.push(file),
				}),
			});

			await createSessionForks(h.deps).forkSession("a1", "at");

			expect(existsSync(branchFile)).toBe(false);
			expect(removed).toEqual([branchFile]);
			expect(notices(h.sent).at(-1)).toMatchObject({ level: "error" });
			expect(notices(h.sent).at(-1)?.text).toContain("open failed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("证据搬运失败也算派生失败：新转录不会留下来", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-fork-evidence-"));
		try {
			const branchFile = join(dir, "branch.jsonl");
			writeFileSync(branchFile, "{}\n", "utf8");
			const h = harness({
				createBranchFile: async () => branchFile,
				evidence: () => ({
					copy: async () => {
						throw new Error("evidence budget exceeded");
					},
				}),
			});

			await createSessionForks(h.deps).forkSession("a1", "at");

			expect(existsSync(branchFile)).toBe(false);
			expect(h.calls.some((call) => call.startsWith("rebind:"))).toBe(false);
			expect(notices(h.sent).at(-1)?.text).toContain("evidence budget exceeded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("forkSession · 端口未注入", () => {
	it("派生窄口缺失：同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const h = harness({ createBranchFile: undefined });
		const forks = createSessionForks(h.deps);

		expect(() => forks.forkSession("a1", "at")).toThrow(CoreEngineNotReadyError);
	});

	it("编辑窄面缺失（会话实体未接）：同步抛", () => {
		const h = harness({ editorOf: undefined });

		expect(() => createSessionForks(h.deps).forkSession("a1", "at")).toThrow(CoreEngineNotReadyError);
	});
});

/** 真 SDK：派生出来的必须是一份**新**文件，两边各自 append 都只写自己的文件。 */
describe("adapters/sdk · createBranchFile", () => {
	it("派生新转录：原文件不被改写，两边都能继续写且不串", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-branch-file-"));
		try {
			const source = SessionManager.create(dir, dir);
			const u1 = source.appendMessage({ role: "user", content: "第一问", timestamp: 1 });
			source.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "第一答" }],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				stopReason: "stop",
				timestamp: 2,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			source.appendMessage({ role: "user", content: "第二问", timestamp: 3 });
			const sourceFile = source.getSessionFile();
			expect(sourceFile).toBeTruthy();
			const before = readFileSync(sourceFile as string, "utf8");

			const branch = await createBranchFile({ sessionFile: sourceFile as string, leafId: u1 });

			expect(branch).not.toBe(sourceFile);
			expect(existsSync(branch)).toBe(true);
			// 分叉只含「根 → u1」这条路径
			const branchLines = readFileSync(branch, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(branchLines[0]).toMatchObject({ type: "session", parentSession: sourceFile });
			expect(branchLines).toHaveLength(2);
			expect(branchLines[1]).toMatchObject({ id: u1 });

			// 两边各自继续写：谁都不许碰对方的文件
			SessionManager.open(sourceFile as string).appendMessage({
				role: "user",
				content: "原对话继续",
				timestamp: 4,
			});
			SessionManager.open(branch).appendMessage({ role: "user", content: "分叉继续", timestamp: 5 });

			expect(readFileSync(sourceFile as string, "utf8")).not.toContain("分叉继续");
			expect(readFileSync(branch, "utf8")).not.toContain("原对话继续");
			expect(readFileSync(sourceFile as string, "utf8")).toContain("第二问");
			// 源文件在派生那一刻一个字节都没变（派生只写新文件）
			expect(readFileSync(sourceFile as string, "utf8").startsWith(before)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("源转录不存在：fail-closed 报错，不在别处新建", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-branch-missing-"));
		try {
			await expect(createBranchFile({ sessionFile: join(dir, "nope.jsonl"), leafId: "x" })).rejects.toThrow(
				/源转录不存在/,
			);
			expect(existsSync(join(dir, "nope.jsonl"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("条目 id 不在树上：报错而不是悄悄派生出全量副本", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-branch-unknown-"));
		try {
			const source = SessionManager.create(dir, dir);
			source.appendMessage({ role: "user", content: "问", timestamp: 1 });
			const sourceFile = source.getSessionFile() as string;

			await expect(createBranchFile({ sessionFile: sourceFile, leafId: "ghost" })).rejects.toThrow(/not found/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** 整条链：session-surface 用真 SDK 派生转录 + 重绑原语切到新对话（旧对话退役、旧会话释放）。 */
describe("session-surface · forkSession 接线", () => {
	function appendUser(manager: SessionManager, text: string, timestamp: number): string {
		return manager.appendMessage({ role: "user", content: text, timestamp });
	}

	it("at 指定消息：新对话指向派生出来的转录，活动切换，旧会话被释放", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-surface-fork-"));
		try {
			const manager = SessionManager.create(dir, dir);
			const first = appendUser(manager, "第一问", 1);
			appendUser(manager, "第二问", 2);
			const sourceFile = manager.getSessionFile() as string;

			const closed: string[] = [];
			const registry = new ConversationRegistry<Conversation>();
			const source = new Conversation({
				id: "c1",
				clientId: "cl",
				cwd: dir,
				kind: "user",
				createdAt: 1,
				sessionFile: sourceFile,
			});
			registry.add(source);
			registry.activate(source.id);
			const session = {
				sessionManager: manager,
				sessionFile: sourceFile,
				isStreaming: false,
				messages: manager.buildSessionProjection().messages,
				abort: async () => {},
				clearQueue: () => ({ steering: [], followUp: [] }),
				reload: async () => {},
				refreshContext: () => {},
				sendCustomMessage: async () => {},
			};
			const surface = createSessionSurface({
				clientId: "cl",
				registry,
				sessions: {
					ensure: async () => ({}),
					close: (id: string) => void closed.push(id),
					get: (id: string) => (id === source.id ? { session } : undefined),
				} as unknown as SessionRegistry,
				cwd: () => dir,
				roots: () => [],
				setWorkspace: () => {},
				createConversation: (init) => {
					const conv = new Conversation({
						id: `c-${registry.size() + 1}`,
						clientId: "cl",
						cwd: init.cwd ?? dir,
						kind: init.kind ?? "user",
						createdAt: 10,
						...(init.sessionFile ? { sessionFile: init.sessionFile } : {}),
					});
					registry.add(conv);
					return conv;
				},
				frames: { flush: () => {}, pushSessions: () => {}, pushProjects: () => {} },
				onActivated: () => {},
				notice: () => {},
				isClosed: () => false,
			});

			await surface.forks().forkSession(first, "at");

			const active = registry.activeConv();
			expect(active?.id).not.toBe(source.id);
			expect(active?.meta.sessionFile).toBeTruthy();
			expect(active?.meta.sessionFile).not.toBe(sourceFile);
			expect(readFileSync(active?.meta.sessionFile as string, "utf8")).toContain("第一问");
			expect(readFileSync(active?.meta.sessionFile as string, "utf8")).not.toContain("第二问");
			expect(registry.has(source.id)).toBe(false);
			expect(closed).toEqual([source.id]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
