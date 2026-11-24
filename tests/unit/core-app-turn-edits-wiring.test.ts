import { describe, expect, it, vi } from "vitest";
import { ClientRuntime, type ClientRuntimeOptions } from "../../packages/keel/src/app/client-runtime.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { PluginsPort } from "../../packages/keel/src/contracts/plugins.js";
import type { TurnEntry } from "../../packages/keel/src/contracts/turns.js";
import type { ServerMessage } from "../../server/protocol.js";

function fakeClock(): ClockPort & { advance(ms: number): void } {
	let now = 1_000;
	const timers: Array<{ at: number; fn: () => void }> = [];
	return {
		now: () => now,
		after: (ms, fn) => {
			const entry = { at: now + ms, fn };
			timers.push(entry);
			return () => {
				const idx = timers.indexOf(entry);
				if (idx >= 0) timers.splice(idx, 1);
			};
		},
		advance(ms: number) {
			now += ms;
			for (const timer of [...timers]) {
				if (timer.at <= now) {
					timer.fn();
					const idx = timers.indexOf(timer);
					if (idx >= 0) timers.splice(idx, 1);
				}
			}
		},
	};
}

function fakeTransport() {
	const sent: ServerMessage[] = [];
	let closed = false;
	return {
		sent,
		port: {
			send: (msg: ServerMessage) => void sent.push(msg),
			isClosed: () => closed,
		},
	};
}

function notices(sent: ServerMessage[]): string[] {
	return sent.flatMap((msg) => (msg.type === "notice" ? [(msg as unknown as { text: string }).text] : []));
}

function catchThrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("预期同步抛出，实际没有抛");
}

interface FakeTurnMessage {
	role?: string;
	errorMessage?: string;
	stopReason?: string;
	timestamp?: number;
	content?: unknown;
}

interface FakeSessionOptions {
	entries?: TurnEntry[];
	messages?: FakeTurnMessage[];
	streaming?: boolean;
	sessionFile?: string;
}

/**
 * 假会话：同时满足 `EditSessionHost`（条目树 + 会话动作）与 `TurnCapableSession`（`sendUserMessage` 是
 * 唯一喂轮出口落到的那一步）。每个动作都记进 `calls`，顺序断言就靠它。
 */
function fakeSession(options: FakeSessionOptions = {}) {
	const calls: string[] = [];
	const entries = options.entries ?? [];
	let leaf: string | null = entries.at(-1)?.id ?? null;
	let pendingTurn: Promise<void> | undefined;
	const session = {
		isStreaming: options.streaming ?? false,
		sessionFile: options.sessionFile ?? "/agent/sessions/s1.jsonl",
		messages: options.messages ?? [],
		model: { provider: "anthropic", id: "claude" } as unknown,
		thinkingLevel: "high",
		isRetrying: false,
		sessionManager: {
			buildContextEntries: () => entries,
			getBranch: () => entries,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
			getLeafId: () => leaf,
			buildSessionProjection: () => ({
				entries: entries.map((entry) => ({
					sourceEntry: { id: entry.id },
					messages: entry.message ? [entry.message] : [],
				})),
			}),
			appendContextEdit: (targetId: string, replacement: unknown) =>
				void calls.push(`appendContextEdit:${targetId}:${String(replacement)}`),
			branch: (fromId: string) => {
				calls.push(`branch:${fromId}`);
				leaf = fromId;
			},
			resetLeaf: () => {
				calls.push("resetLeaf");
				leaf = null;
			},
			appendCustomEntry: (customType: string) => void calls.push(`appendCustomEntry:${customType}`),
			setSessionFile: (file: string) => void calls.push(`setSessionFile:${file}`),
		},
		abort: async () => {
			calls.push("abort");
			session.isStreaming = false;
		},
		clearQueue: () => void calls.push("clearQueue"),
		reload: async () => void calls.push("reload"),
		refreshContext: () => void calls.push("refreshContext"),
		waitForIdle: async () => {},
		setThinkingLevel: (level: string) => void calls.push(`setThinkingLevel:${level}`),
		setModel: async (model: unknown) => void calls.push(`setModel:${String((model as { id?: string })?.id)}`),
		sendCustomMessage: async (message: { customType?: string }) =>
			void calls.push(`sendCustomMessage:${message.customType ?? ""}`),
		// 喂轮出口（`promptSession` → `session.sendUserMessage`）。`holdTurn()` 能让这一轮悬着，
		// 用来验证编辑面必须等这一轮真的收尾（`whenIdle`）。
		sendUserMessage: (text: string) => {
			calls.push(`sendUserMessage:${text}`);
			const held = pendingTurn;
			pendingTurn = undefined;
			return held ?? Promise.resolve();
		},
		dispose: () => {},
	};
	return {
		session,
		calls,
		holdTurn(): () => void {
			let release = (): void => {};
			pendingTurn = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => release();
		},
	};
}

function fakeSessions(session: unknown): SessionRegistry {
	const opened = { session, sessionId: "s1", sessionFile: "/agent/sessions/s1.jsonl", dispose: () => {} };
	return {
		get: (conversationId: string) => (conversationId === "c1" ? opened : undefined),
		ensure: async () => opened,
		close: () => {},
		closeAll: () => {},
		has: (conversationId: string) => conversationId === "c1",
		openCount: () => 1,
	} as unknown as SessionRegistry;
}

function makeRuntime(overrides: Partial<ClientRuntimeOptions> = {}) {
	const clock = fakeClock();
	const transport = fakeTransport();
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work",
		env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: false },
		clock,
		transport: transport.port,
		...overrides,
	});
	const conv = runtime.createConversation({ id: "c1", kind: "user", createdAt: 5 });
	return { runtime, conv, clock, transport };
}

function entry(id: string, message: FakeTurnMessage, parentId?: string | null): TurnEntry {
	return { id, type: "message", parentId, message };
}

/** 一轮问答 + 后续一条用户消息：投影编号 `u-10-0` / `a-11-1` / `u-12-2`（与 `view.ts` 同源）。 */
function turnEntries(): TurnEntry[] {
	return [
		entry("e1", { role: "user", timestamp: 10 }, null),
		entry("e2", { role: "assistant", timestamp: 11 }, "e1"),
		entry("e3", { role: "user", timestamp: 12 }, "e2"),
	];
}

describe("ClientRuntime · 消息编辑面装配（未接）", () => {
	it("没接会话注册表：editMessage / deleteMessage / retryLast 同步抛 CoreEngineNotReadyError", () => {
		const { runtime } = makeRuntime();
		const cs = runtime.handlers();
		const calls = [() => cs.editMessage("u-10-0", "改"), () => cs.deleteMessage?.("u-10-0"), () => cs.retryLast()];
		for (const call of calls) {
			const thrown = catchThrown(call);
			expect(thrown).toBeInstanceOf(CoreEngineNotReadyError);
			expect((thrown as Error).message).toContain("turnEdits");
		}
	});

	it("会话注册表在、但这个对话没开会话：只发 notice，不抛也不拿半死句柄", async () => {
		const { session } = fakeSession({ entries: turnEntries() });
		const { runtime, transport } = makeRuntime({ sessions: fakeSessions(session) });
		// 活动对话换成注册表里没开会话的那一个（假注册表只认 "c1"）。
		runtime.createConversation({ id: "c2", kind: "user", createdAt: 6 });
		const cs = runtime.handlers();
		await expect(cs.editMessage("u-10-0", "改")).resolves.toBeUndefined();
		await expect(cs.deleteMessage?.("u-10-0")).resolves.toBeUndefined();
		await expect(cs.retryLast()).resolves.toBeUndefined();
		expect(notices(transport.sent)).toEqual([
			"找不到要编辑的消息（可能已被压缩或不在当前分支）",
			"删除消息失败：Message not found",
			"没有可重试的失败：上一轮没有报错结束",
		]);
	});
});

describe("ClientRuntime · 消息编辑面（接通后）", () => {
	it("deleteMessage：摘掉条目 → 重算上下文 → 会话列表失效", async () => {
		const { session, calls } = fakeSession({ entries: turnEntries() });
		const refreshSessions = vi.fn(async () => {});
		const { runtime } = makeRuntime({ sessions: fakeSessions(session) });
		runtime.attachFrames({
			pushSettings: () => {},
			refreshSessions,
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		await runtime.handlers().deleteMessage?.("a-11-1");
		expect(calls).toEqual(["appendContextEdit:e2:null", "refreshContext"]);
		await Promise.resolve();
		expect(refreshSessions).toHaveBeenCalledTimes(1);
	});

	it("retryLast：最后一条 assistant 报错 → 走 manual-retry 并回收相位", async () => {
		const { session, calls } = fakeSession({
			entries: turnEntries(),
			messages: [
				{ role: "user", timestamp: 12 },
				{ role: "assistant", stopReason: "error" },
			],
		});
		const { runtime, conv, transport } = makeRuntime({ sessions: fakeSessions(session) });
		await runtime.handlers().retryLast();
		expect(calls).toEqual(["sendCustomMessage:manual-retry"]);
		expect(conv.phase).toBe("idle");
		expect(notices(transport.sent)).toEqual([]);
	});

	it("retryLast：上一轮没报错就只发提示（不动会话）", async () => {
		const { session, calls } = fakeSession({
			entries: turnEntries(),
			messages: [{ role: "assistant", stopReason: "end" }],
		});
		const { runtime, transport } = makeRuntime({ sessions: fakeSessions(session) });
		await runtime.handlers().retryLast();
		expect(calls).toEqual([]);
		expect(notices(transport.sent)).toContain("没有可重试的失败：上一轮没有报错结束");
	});

	it("editMessage：截断 → 重载 → 恢复模型与思考档 → 经唯一喂轮出口重新提问", async () => {
		const { session, calls } = fakeSession({ entries: turnEntries(), sessionFile: "/a/s1.jsonl" });
		const refreshSessions = vi.fn(async () => {});
		const onSessionModelChanged = vi.fn();
		const { runtime, conv, clock, transport } = makeRuntime({
			sessions: fakeSessions(session),
			onSessionModelChanged,
		});
		runtime.attachFrames({
			pushSettings: () => {},
			refreshSessions,
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		await runtime.handlers().editMessage("u-12-2", "  改过的问题  ");
		expect(calls).toEqual([
			"clearQueue",
			"branch:e2",
			"appendCustomEntry:pi-web-ui:reask",
			"refreshContext",
			"reload",
			"clearQueue",
			"setModel:claude",
			"setThinkingLevel:high",
			"sendUserMessage:改过的问题",
		]);
		// 模型恢复后的宿主收尾（压缩预留重算 / 插件通知）也要走一次。
		expect(onSessionModelChanged).toHaveBeenCalledWith("c1");
		await Promise.resolve();
		expect(refreshSessions).toHaveBeenCalledTimes(1);
		expect(conv.phase).toBe("idle");
		expect(notices(transport.sent)).toEqual(["已在当前对话重新提问，后续历史已移除"]);
		// 出帧只经闸门（老实现 flushSnapshot() 就是立即出）：一帧全量，不重复发。
		const frames = transport.sent.filter((msg) => msg.type === "snapshot");
		expect(frames).toHaveLength(1);
		clock.advance(200);
		expect(transport.sent.filter((msg) => msg.type === "snapshot")).toHaveLength(1);
	});

	it("editMessage：有一轮在飞时先 abort 并等它真的收尾，再截断", async () => {
		const { session, calls, holdTurn } = fakeSession({ entries: turnEntries() });
		const { runtime, conv } = makeRuntime({ sessions: fakeSessions(session) });
		const release = holdTurn();
		const first = runtime.turns.start(conv, session as never, "第一轮");
		await Promise.resolve();
		session.isStreaming = true;
		const editing = runtime.handlers().editMessage("u-12-2", "改");
		await Promise.resolve();
		// 这一轮还没收尾：截断不能先发生。
		expect(calls).toContain("abort");
		expect(calls).not.toContain("branch:e2");
		release();
		await first;
		await editing;
		expect(calls.indexOf("branch:e2")).toBeGreaterThan(calls.indexOf("abort"));
		expect(calls).toContain("sendUserMessage:改");
		expect(conv.phase).toBe("idle");
	});
});

describe("ClientRuntime · dispose 收口", () => {
	it("插件端口的 MCP OAuth 随客户端关闭收口一次（幂等）", () => {
		const dispose = vi.fn();
		const { runtime } = makeRuntime({ plugins: () => ({ dispose }) as unknown as PluginsPort });
		runtime.dispose();
		runtime.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("没接插件端口时 dispose 不抛", () => {
		const { runtime } = makeRuntime();
		expect(() => runtime.dispose()).not.toThrow();
	});
});
