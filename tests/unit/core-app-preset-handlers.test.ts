import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientFrames, ClientRuntimeOptions } from "../../packages/keel/src/app/client-runtime.js";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import type { OpenedSession } from "../../packages/keel/src/adapters/sdk/session-opener.js";
import { chatModeTranscriptOf } from "../../packages/keel/src/adapters/sdk/chat-mode.js";
import { emptyView } from "../../packages/keel/src/app/conversation-handlers.js";
import { conversationPresetViewOf } from "../../packages/keel/src/app/preset-handlers.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { PresetTranscriptPort } from "../../packages/keel/src/contracts/presets.js";
import { ChatModeState, PresetState } from "../../packages/keel/src/domains/tools/index.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import type { TurnCapableSession } from "../../packages/keel/src/contracts/session.js";
import { createCorePresetTranscriptPort, type CorePresetSinks } from "../../server/core-preset-adapter.js";
import { readPermissionFromSession } from "../../server/permission-preset.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "preset-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeClock(): ClockPort & { scheduled: number[] } {
	const scheduled: number[] = [];
	return {
		scheduled,
		now: () => 1_000,
		after: (ms: number, _fn: () => void) => {
			scheduled.push(ms);
			return () => {};
		},
	};
}

function fakeFrames() {
	return {
		pushSettings: vi.fn(),
		refreshSessions: vi.fn(async () => {}),
		pushProjects: vi.fn(async () => {}),
		listModels: vi.fn(),
		pushDefaultModel: vi.fn(),
	} satisfies ClientFrames;
}

/**
 * 会话假体：**真的**实现 `getAllTools` / `getActiveToolNames` / `setActiveToolsByName`
 * （活动集是它自己的数组），所以「工具集合真的变了」是被它证明的，不是被 spy 证明的。
 * `resourceLoader.reload()` 记次数：提示词重载也是一件真事。
 */
function fakeSession(
	tools: readonly string[],
	active: readonly string[],
	options: { withReload?: boolean; messages?: readonly unknown[]; streaming?: boolean } = {},
) {
	const all = [...tools];
	let current = [...active];
	const reload = vi.fn(async () => {});
	const session = {
		getAllTools: () => all.map((name) => ({ name })),
		getActiveToolNames: () => [...current],
		setActiveToolsByName: (names: string[]) => {
			current = [...names];
		},
		...(options.withReload === false ? {} : { resourceLoader: { reload } }),
		messages: options.messages ?? [],
		isStreaming: options.streaming === true,
		dispose() {},
	};
	return { session: session as unknown as TurnCapableSession, reload, active: () => [...current] };
}

function makeRuntime(overrides: Partial<ClientRuntimeOptions> = {}) {
	const sent: ServerMessage[] = [];
	const clock = fakeClock();
	const frames = fakeFrames();
	// 显式传 `presets: undefined` = 不注入（未接线用例要的形态）；没传才给一份默认的。
	const viewPresets = overrides.presets ?? new PresetState();
	const withPresets = "presets" in overrides ? overrides : { ...overrides, presets: viewPresets };
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work",
		env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
		clock,
		transport: { send: (msg) => void sent.push(msg), isClosed: () => false },
		// 快照投影与 `CoreEngine.attach()` 用同一份（`conversationPresetViewOf`），不另写一条。
		viewOf: (conv) => ({
			...emptyView(conv),
			...conversationPresetViewOf({
				conversationId: conv.id,
				queued: conv.queues.total(),
				session: overrides.sessions?.get(conv.id)?.session,
				settings: overrides.stateStore?.()?.getSettingsSnapshot("client-1"),
				presets: viewPresets,
				lang: "zh",
			}),
		}),
		...withPresets,
	});
	runtime.attachFrames(frames);
	return { runtime, sent, frames, clock };
}

/** `SessionRegistry` 的窄面假体：`get` 只认已经「开过」的会话，`ensure` 当场开一个。 */
function fakeSessions(sessions: Map<string, { session: TurnCapableSession }>) {
	const ensured: string[] = [];
	return {
		ensured,
		lookup: {
			get: (id: string) => sessions.get(id),
			// 与真 `SessionRegistry.ensure` 同语义：已经开着就原样返回，**不重复开**。
			ensure: async (conv: { id: string }) => {
				const existing = sessions.get(conv.id);
				if (existing) return existing;
				ensured.push(conv.id);
				const opened = { session: fakeSession([], []).session };
				sessions.set(conv.id, opened);
				return opened;
			},
		},
	};
}

/** 全量工具清单：预设白名单才有东西可减。 */
const ALL_TOOLS = ["bash", "read", "edit", "write", "grep", "notes"] as const;

describe("selectAgentPreset：真的按预设重设 active tools + 真的重载提示词", () => {
	it("标准 → 只读分析：活动集真的变了，且 reload 真的被调用；快照能看见 agentPreset", async () => {
		const store = createFakeSettingsStore();
		const conv = { id: "c-1" };
		const fake = fakeSession(ALL_TOOLS, ALL_TOOLS);
		const sessions = new Map([["c-1", { session: fake.session }]]);
		const { lookup, ensured } = fakeSessions(sessions);
		const presets = new PresetState();
		const { runtime, sent, frames } = makeRuntime({
			stateStore: () => store,
			sessions: lookup as never,
			presets,
			chatModes: new ChatModeState(),
		});
		runtime.createConversation({ id: conv.id });

		await runtime.handlers().selectAgentPreset?.("reader");

		// 真工具集变化：写/执行类工具被预设白名单减掉（不是只改了状态）。
		const after = fake.active();
		expect(after).toContain("read");
		for (const removed of ["bash", "edit", "write"]) expect(after).not.toContain(removed);
		expect(after).not.toEqual([...ALL_TOOLS]);
		expect(fake.reload).toHaveBeenCalledTimes(1);
		// 会话是空的：不需要另开一个（已有的那个就够门禁）。
		expect(ensured).toEqual([]);
		expect(presets.agentPresetOf("c-1")).toBe("reader");
		expect(sent).toEqual([
			{
				type: "notice",
				level: "info",
				text: "已切换为「只读分析」预设",
				textEn: 'Switched to preset "Read-only analysis"',
			},
		]);
		const state = runtime.snapshotView().conversation;
		// 空会话还能再切（老实现在这里也不锁）：锁只在「已经开跑」之后生效。
		expect(state?.agentPreset).toEqual({ id: "reader", name: "只读分析", locked: false });
		// 真的能“看得到”：同一份投影经过帧构建器之后确实带上了这两个字段。
		sent.length = 0;
		runtime.publisher.flush({ forceFull: true });
		const frame = sent.find((msg) => msg.type === "snapshot");
		expect(frame?.type === "snapshot" ? frame.state.agentPreset : undefined).toEqual({
			id: "reader",
			name: "只读分析",
			locked: false,
		});
		expect(frame?.type === "snapshot" ? frame.state.permission : undefined).toBe("workspace-write-never");
	});

	it("没有任何消息的会话才不锁：会话已经开跑时锁死并原样告知，不改状态", async () => {
		const store = createFakeSettingsStore();
		// 已经发过一条消息 = 会话开跑过（老实现同口径：`blank` 才允许切）。
		const fake = fakeSession(ALL_TOOLS, ALL_TOOLS, { messages: [{ role: "user" }] });
		const { lookup } = fakeSessions(new Map([["c-1", { session: fake.session }]]));
		const presets = new PresetState();
		const { runtime, sent } = makeRuntime({
			stateStore: () => store,
			sessions: lookup as never,
			presets,
		});
		runtime.createConversation({ id: "c-1" });

		await runtime.handlers().selectAgentPreset?.("minimal");

		expect(presets.agentPresetOf("c-1")).toBe("standard");
		expect(presets.lockedOf("c-1")).toBe(true);
		expect(fake.active()).toEqual([...ALL_TOOLS]);
		expect(sent).toEqual([
			{
				type: "notice",
				level: "warning",
				text: "会话已开始，预设锁定为「全功能」（空白会话可切换）",
				textEn: 'Session already started; preset locked to "Full access" (only blank sessions can switch)',
			},
		]);
	});

	it("没有会话可重设工具（假体不给 resourceLoader）时拒绝切换：不假成功、不改状态", async () => {
		const fake = fakeSession(ALL_TOOLS, ALL_TOOLS, { withReload: false });
		const { lookup } = fakeSessions(new Map([["c-1", { session: fake.session }]]));
		const presets = new PresetState();
		const { runtime, sent } = makeRuntime({ sessions: lookup as never, presets });
		runtime.createConversation({ id: "c-1" });

		await runtime.handlers().selectAgentPreset?.("minimal");

		expect(presets.agentPresetOf("c-1")).toBeUndefined();
		expect(fake.active()).toEqual([...ALL_TOOLS]);
		expect(sent[0]).toMatchObject({ type: "notice", level: "warning" });
	});

	it("会话还没开就开一个再门禁（老实现里每个对话都有会话）", async () => {
		const fake = fakeSession(ALL_TOOLS, ALL_TOOLS);
		const open = new Map<string, { session: TurnCapableSession }>();
		const { lookup, ensured } = fakeSessions(open);
		const presets = new PresetState();
		const { runtime } = makeRuntime({ sessions: lookup as never, presets });
		runtime.createConversation({ id: "c-9" });
		// 打开时给出真工具集（`ensure` 的兜底假体是空工具集）。
		open.set("c-9", { session: fake.session });
		open.delete("c-9");

		await runtime.handlers().selectAgentPreset?.("ask");

		expect(ensured).toEqual(["c-9"]);
		expect(presets.agentPresetOf("c-9")).toBe("ask");
	});

	it("未注入预设运行态 / 会话面时同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const { runtime } = makeRuntime({ presets: undefined });
		const cs = runtime.handlers();
		expect(() => cs.selectAgentPreset?.("minimal")).toThrow(CoreEngineNotReadyError);
	});
});

describe("setPermissionPreset：先落转录条目，再改内存投影", () => {
	/** 真转录：`permission/preset` 条目就是重启后能读回来的那一份真值。 */
	function realTranscript() {
		const manager = SessionManager.create(tempDir());
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		return manager;
	}

	it("写会话级 mode 条目 + 快照 permission 真填，重启后从转录读回", async () => {
		const manager = realTranscript();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const transcript = chatModeTranscriptOf({ session: { sessionManager: manager } } as unknown as OpenedSession);
		const sinks: CorePresetSinks = {
			transcriptOf: () => transcript,
			ensureTranscript: async () => transcript,
		};
		const port = createCorePresetTranscriptPort(sinks);
		const { lookup } = fakeSessions(new Map());
		const presets = new PresetState();
		const { runtime, sent } = makeRuntime({
			sessions: lookup as never,
			presets,
			presetTranscript: () => port,
		});
		runtime.createConversation({ id: "c-1" });

		expect(runtime.snapshotView().conversation?.permission).toBe("workspace-write-never");

		await runtime.handlers().setPermissionPreset?.("read-only");

		expect(sent).toEqual([
			{
				type: "notice",
				level: "info",
				text: "当前会话权限已切换为「只读模式」",
				textEn: 'Current session permission switched to "Read Only"',
			},
		]);
		expect(runtime.snapshotView().conversation?.permission).toBe("read-only");
		// 与 `plan/mode` 同一套机制：条目真的在这份转录里，重开 manager 还能读回。
		const reopened = SessionManager.open(sessionFile!);
		expect(readPermissionFromSession(reopened)).toBe("read-only");
	});

	it("写不进转录（会话开不起来）时保持旧值，并如实告知写失败", async () => {
		const presets = new PresetState();
		const port = createCorePresetTranscriptPort({
			transcriptOf: () => undefined,
			ensureTranscript: async () => undefined,
		});
		const { runtime, sent } = makeRuntime({ presets, presetTranscript: () => port });
		runtime.createConversation({ id: "c-1" });

		await runtime.handlers().setPermissionPreset?.("read-only");

		expect(presets.permissionOf("c-1")).toBeUndefined();
		expect(runtime.snapshotView().conversation?.permission).toBe("workspace-write-never");
		expect(sent[0]).toMatchObject({ type: "notice", level: "warning" });
	});

	it("同值重发也要再写一次条目（上次写失败就是这次重试的机会，#968）", async () => {
		const written: string[] = [];
		const port: PresetTranscriptPort = {
			setPermission: async (preset) => {
				written.push(preset);
				return "ok";
			},
			readPermission: () => "read-only",
		};
		const presets = new PresetState();
		presets.setPermission("c-1", "read-only");
		const { runtime, sent } = makeRuntime({ presets, presetTranscript: () => port });
		runtime.createConversation({ id: "c-1" });

		await runtime.handlers().setPermissionPreset?.("read-only");

		expect(written).toEqual(["read-only"]);
		// 值没变：只写条目，不再公告「已切换」。
		expect(sent).toEqual([]);
	});

	it("未注入权限条目端口时同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const { runtime } = makeRuntime({ presets: new PresetState() });
		const cs = runtime.handlers();
		expect(() => cs.setPermissionPreset?.("read-only")).toThrow(CoreEngineNotReadyError);
	});
});
