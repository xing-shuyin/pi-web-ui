import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { ChatModeState } from "../../packages/keel/src/domains/tools/index.js";
import { chatModeTranscriptOf, withChatModeGates } from "../../packages/keel/src/adapters/sdk/chat-mode.js";
import type { OpenedSession } from "../../packages/keel/src/adapters/sdk/session-opener.js";
import { createCoreChatModePort, type CoreChatModeSinks } from "../../server/core-chat-mode-adapter.js";
import { readDelegateModeFromSession, readPlanModeFromSession } from "../../server/chat-mode-entries.js";

type GatedTool = { execute: (...args: unknown[]) => Promise<{ content?: unknown }> };

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-mode-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 真转录：SDK `SessionManager`（`plan/mode` 条目就是重启后能读回来的那份真值）。 */
function newManager(dir: string): SessionManager {
	const manager = SessionManager.create(dir);
	// 先有消息才有转录文件：`appendModeEntry` 的三态判定看的就是「这份会话落不落盘」。
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
	return manager;
}

/** 会话假体只交窄面要的两项（`sessionManager` + `reload`），不整份 SDK 会话。 */
function openedWith(manager: unknown, reload?: () => Promise<void>): OpenedSession {
	return {
		session: { sessionManager: manager, ...(reload ? { reload } : {}) },
		sessionId: "s1",
		dispose() {},
	} as unknown as OpenedSession;
}

interface Harness {
	manager: unknown;
	state: ChatModeState;
	port: ReturnType<typeof createCoreChatModePort>;
	sent: ServerMessage[];
	/** 快照刷了几次（出帧的触发点在适配器里）。 */
	flushes(): number;
	reload: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	gated: GatedTool;
}

function harness(input: { manager?: unknown; withSession?: boolean } = {}): Harness {
	const manager = input.manager ?? newManager(tempDir());
	const reload = vi.fn(async () => {});
	const transcript = chatModeTranscriptOf(openedWith(manager, reload));
	const withSession = input.withSession ?? true;
	const state = new ChatModeState();
	const sent: ServerMessage[] = [];
	let flushes = 0;
	const sinks: CoreChatModeSinks = {
		emit: (msg) => void sent.push(msg),
		flushSnapshot: () => void (flushes += 1),
		transcriptOf: () => (withSession ? transcript : undefined),
		ensureTranscript: async () => (withSession ? transcript : undefined),
		setMode: (kind, enabled, conversationId) => state.setMode(kind, enabled, conversationId ?? "conv-1"),
	};
	const write = vi.fn(async () => ({ content: [{ type: "text", text: "written" }] }));
	// 门禁吃的是执行期 thunk：状态一翻，下一次调用立刻按新值拦/放行（与内核注册时同一份定义）。
	const [gated] = withChatModeGates(
		[{ name: "write", description: "写文件", parameters: { type: "object", properties: {} }, execute: write }],
		{
			planMode: () => state.planModeOf("conv-1"),
			delegateMode: () => state.delegateModeOf("conv-1"),
			getLang: () => "zh",
		},
	) as GatedTool[];
	return {
		manager,
		state,
		port: createCoreChatModePort(sinks),
		sent,
		flushes: () => flushes,
		reload,
		write,
		gated: gated!,
	};
}

const noticeTexts = (sent: readonly ServerMessage[]): string[] =>
	sent.filter((m) => m.type === "notice").map((m) => (m.type === "notice" ? m.text : ""));

describe("模式开关：三处真值一次落齐", () => {
	it("① 转录条目 ② 写工具真的被拦 ③ 提示词重载被调（同一次开关）", async () => {
		const h = harness();
		// 开关之前：门禁放行（否则「被拦」证明不了任何事）
		await expect(h.gated.execute({}, {}, undefined)).resolves.toBeTruthy();

		await h.port.setPlanMode(true, "conv-1");

		expect(readPlanModeFromSession(h.manager)).toBe(true);
		expect(h.state.planModeOf("conv-1")).toBe(true);
		await expect(h.gated.execute({}, {}, undefined)).rejects.toThrow(/计划模式/);
		// 拦在门禁里：底层工具一次都没执行到
		expect(h.write).toHaveBeenCalledTimes(1);
		expect(h.reload).toHaveBeenCalledTimes(1);
		expect(h.flushes()).toBeGreaterThan(0);
	});

	it("关掉之后三处一起回退：条目写 false、门禁放行、再次重载", async () => {
		const h = harness();
		await h.port.setPlanMode(true, "conv-1");
		await h.port.setPlanMode(false, "conv-1");

		expect(readPlanModeFromSession(h.manager)).toBe(false);
		expect(h.state.planModeOf("conv-1")).toBe(false);
		await expect(h.gated.execute({}, {}, undefined)).resolves.toEqual({
			content: [{ type: "text", text: "written" }],
		});
		expect(h.reload).toHaveBeenCalledTimes(2);
	});

	it("审查者模式走同一条链：delegate/mode 条目 + 写工具被拒 + 重载", async () => {
		const h = harness();
		await h.port.setDelegateMode(true, "conv-1");

		expect(readDelegateModeFromSession(h.manager)).toBe(true);
		expect(h.state.delegateModeOf("conv-1")).toBe(true);
		// 审查者模式的门禁按错误结果拒绝（老口径 `withDelegationGate`），不是抛。
		const denied = (await h.gated.execute({}, {}, undefined)) as unknown as {
			isError?: boolean;
			details?: { delegateDenied?: boolean };
		};
		expect(denied.isError).toBe(true);
		expect(denied.details?.delegateDenied).toBe(true);
		expect(h.write).not.toHaveBeenCalled();
		expect(h.reload).toHaveBeenCalledTimes(1);
	});

	it("重启后恢复：新进程读同一条转录，restore() 把门禁重新拉起来", async () => {
		const manager = newManager(tempDir());
		const first = harness({ manager });
		await first.port.setPlanMode(true, "conv-1");

		// 新进程：从盘上重开转录 + 全新的内核状态（内存里没有任何模式痕迹）
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const second = harness({ manager: reopened });
		expect(second.state.planModeOf("conv-1")).toBe(false);
		await expect(second.gated.execute({}, {}, undefined)).resolves.toBeTruthy();

		second.port.restore?.("conv-1");

		expect(second.state.planModeOf("conv-1")).toBe(true);
		await expect(second.gated.execute({}, {}, undefined)).rejects.toThrow(/计划模式/);
	});
});

describe("模式开关：写不进去就不算数（#968）", () => {
	it("拿不到会话 / 无转录 = failed：门禁不翻、不重载、如实告知", async () => {
		const h = harness({ withSession: false });
		await h.port.setPlanMode(true, "conv-1");

		expect(h.state.planModeOf("conv-1")).toBe(false);
		await expect(h.gated.execute({}, {}, undefined)).resolves.toBeTruthy();
		expect(h.reload).not.toHaveBeenCalled();
		expect(noticeTexts(h.sent)[0]).toMatch(/没能写入对话记录/);
	});

	it("未落盘的会话 = transient：本次生效但明说「不保存」", async () => {
		const appendCustomEntry = vi.fn();
		const h = harness({ manager: { appendCustomEntry, isPersisted: () => false } });
		await h.port.setPlanMode(true, "conv-1");

		expect(appendCustomEntry).toHaveBeenCalledWith("plan/mode", { enabled: true });
		expect(h.state.planModeOf("conv-1")).toBe(true);
		await expect(h.gated.execute({}, {}, undefined)).rejects.toThrow(/计划模式/);
		expect(noticeTexts(h.sent)).toEqual([expect.stringContaining("计划模式"), expect.stringContaining("不保存")]);
	});

	it("开会话就抛（退役中）= 同样按 failed 处理，不 reject", async () => {
		const state = new ChatModeState();
		const sent: ServerMessage[] = [];
		const port = createCoreChatModePort({
			emit: (msg) => void sent.push(msg),
			flushSnapshot: () => {},
			transcriptOf: () => undefined,
			ensureTranscript: async () => {
				throw new Error("conversation is retiring");
			},
			setMode: (kind, enabled, conversationId) => state.setMode(kind, enabled, conversationId),
		});

		await expect(port.setPlanMode(true, "conv-1")).resolves.toBeUndefined();
		expect(state.planModeOf("conv-1")).toBe(false);
		expect(noticeTexts(sent)).toHaveLength(1);
	});
});
