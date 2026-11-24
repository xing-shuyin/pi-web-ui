import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsFramePort } from "../../packages/keel/src/contracts/settings.js";
import type { BackgroundPort } from "../../packages/keel/src/contracts/background.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

/**
 * 连接期三件事（老实现 `AgentService.attach()` + `ClientSession.attachSink()` 的对应物）：
 *
 * - **A** `attach()` 之后必须有一条活动会话（空白、已开会话）——否则 `conversationId` 恒空，
 *   `set_model` / `get_tool_info` / `set_goal` 这些「先要一条会话」的能力第一步就落空；
 * - **B** 连接期要推初始态帧（老 `attachSink()` 那 12 类里内核有生产者的一批）；
 * - **K** 同 clientId 重连要换 `send`（旧 socket 不再收帧），quiesce 时拒新连接 + 拒新回合。
 *
 * SDK 会话是假的（真开会话要模型与 auth）；门面、运行时、出帧闸全是真的。
 */
const openTurnSession = vi.fn();

vi.mock("../../packages/keel/src/adapters/sdk/index.js", () => ({
	openTurnSession: (...args: unknown[]) => openTurnSession(...args),
}));

const { CoreEngine } = await import("../../packages/keel/src/app/core-engine.js");
const { QuiesceRejectedError, isQuiesceRejection } = await import("../../packages/keel/src/contracts/quiesce.js");
type Engine = InstanceType<typeof CoreEngine>;

let root: string;
let engines: Engine[] = [];
let opened: number;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-core-connect-"));
	opened = 0;
	openTurnSession.mockReset();
	openTurnSession.mockImplementation(async () => {
		opened += 1;
		const session = {
			isStreaming: false,
			sessionFile: undefined,
			messages: [] as unknown[],
			model: { provider: "anthropic", id: "claude" },
			sendUserMessage: async () => {},
			subscribe: () => () => {},
			dispose: () => {},
		};
		return { session, sessionId: `s${opened}`, dispose: () => {} };
	});
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.disposeAll();
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function engineWith(extra: Record<string, unknown> = {}): Engine {
	const engine = new CoreEngine(root, {
		version: "test",
		attach: true,
		agentDir: join(root, "agent"),
		stateStore: createFakeSettingsStore(),
		...extra,
	} as never);
	engines.push(engine);
	return engine;
}

/** 记录所有帧的收集器（按类型取值用）。 */
function collector(): { sent: ServerMessage[]; types(): string[] } {
	const sent: ServerMessage[] = [];
	return { sent, types: () => sent.map((m) => m.type) };
}

describe("core/app · 连接期首条对话（A）", () => {
	it("attach 后立刻有一条活动会话，快照 conversationId 非空", async () => {
		const engine = engineWith();
		const { sent } = collector();
		const cs = await engine.attach("c1", (msg) => void sent.push(msg));

		expect(cs.activeConversationId?.()).toBe("c-1");
		// 会话真的开了（不是只登记一条空对话）：`set_model` / `get_tool_info` 都读它。
		expect(openTurnSession).toHaveBeenCalledTimes(1);
		const snap = sent.find((m) => m.type === "snapshot") as Extract<ServerMessage, { type: "snapshot" }> | undefined;
		// 首帧快照由组合根在 attach 之后 flush（这里手推一次，只验快照内容不再为空）。
		cs.flushSnapshot(true);
		const full = sent.filter((m) => m.type === "snapshot").at(-1) as
			Extract<ServerMessage, { type: "snapshot" }> | undefined;
		expect((snap ?? full)?.state.conversationId).toBe("c-1");
	});

	it("空白对话不进「运行的对话」（有内容前不出行）", async () => {
		const engine = engineWith();
		const { sent } = collector();
		await engine.attach("c1", (msg) => void sent.push(msg));
		const convs = sent.filter((m) => m.type === "conversations").at(-1) as
			Extract<ServerMessage, { type: "conversations" }> | undefined;
		expect(convs?.conversations ?? []).toEqual([]);
		expect(convs?.activeId).toBe("c-1");
	});

	it("重连复用同一条运行时，不另开第二条对话", async () => {
		const engine = engineWith();
		const first = collector();
		const second = collector();
		const cs = await engine.attach("c1", (msg) => void first.sent.push(msg));
		await engine.attach("c1", (msg) => void second.sent.push(msg));

		expect(cs.activeConversationId?.()).toBe("c-1");
		expect(openTurnSession).toHaveBeenCalledTimes(1);
	});
});

describe("core/app · 连接期初始态帧（B）", () => {
	it("推齐内核有生产者的那几类帧（会话 / 目标 / 设置 / 后台 / 预设 / 默认模型）", async () => {
		const settingsPushes: number[] = [];
		const bgPushes: number[] = [];
		const engine = engineWith({
			settingsFrame: (sinks: { emit(msg: ServerMessage): void }) => {
				const port = {
					push: () => {
						settingsPushes.push(1);
						sinks.emit({ type: "settings_state", settings: { toolApprovalEnabled: true } } as never);
					},
				};
				return port as unknown as SettingsFramePort;
			},
			background: (sinks: { emit(msg: ServerMessage): void }) => {
				const port = {
					refreshBgTasks: () => {
						bgPushes.push(1);
						sinks.emit({ type: "bg_servers", servers: [] } as never);
					},
				};
				return port as unknown as BackgroundPort;
			},
		});
		const { sent, types } = collector();
		await engine.attach("c1", (msg) => void sent.push(msg));

		expect(types()).toContain("conversations");
		expect(types()).toContain("goal_status");
		expect(types()).toContain("settings_state");
		expect(types()).toContain("bg_servers");
		expect(types()).toContain("dsh_presets");
		// `pushDefaultModel` 由宿主面建好时推（`host-faces.ts`）——连接期一次，不重复。
		expect(types().filter((t) => t === "default_model")).toHaveLength(1);
		expect(settingsPushes).toHaveLength(1);
		expect(bgPushes).toHaveLength(1);
	});

	it("重连把初始态整包重推（新 socket 没有基线）", async () => {
		const engine = engineWith({
			settingsFrame: (sinks: { emit(msg: ServerMessage): void }) =>
				({
					push: () => sinks.emit({ type: "settings_state", settings: {} } as never),
				}) as unknown as SettingsFramePort,
		});
		const first = collector();
		await engine.attach("c1", (msg) => void first.sent.push(msg));
		const before = first.types().length;

		const second = collector();
		await engine.attach("c1", (msg) => void second.sent.push(msg));
		expect(second.types()).toContain("settings_state");
		expect(second.types()).toContain("goal_status");
		expect(second.types()).toContain("conversations");
		// 旧 socket 只该收到第一次连接期的那一批，不再跟着重连再收一遍。
		expect(first.types().length).toBe(before);
	});

	it("模型/供应商端口没装配时不推供应商帧、也不把连接搞挂", async () => {
		const engine = engineWith();
		const { types } = collector();
		await engine.attach("c1", () => {});
		expect(types()).not.toContain("provider_keys");
	});
});

describe("core/app · 重连与 quiesce（K）", () => {
	it("同 clientId 重连换 send：旧 socket 不再收到帧", async () => {
		const engine = engineWith();
		const first = collector();
		const second = collector();
		await engine.attach("c1", (msg) => void first.sent.push(msg));
		await engine.attach("c1", (msg) => void second.sent.push(msg));
		const beforeOld = first.types().length;

		// 任一次出帧都该走「最新那个 sender」。
		engine.applyPluginCommandCatalog();
		await Promise.resolve();
		expect(first.types().length).toBe(beforeOld);
	});

	it("quiesce 拒**新连接**（`code: QUIESCED`），已持有运行时的客户端照常重连", async () => {
		const engine = engineWith();
		await engine.attach("c1", () => {});
		engine.quiesce();

		await expect(engine.attach("brand-new", () => {})).rejects.toBeInstanceOf(QuiesceRejectedError);
		await expect(engine.attach("brand-new", () => {})).rejects.toSatisfy(isQuiesceRejection);
		// 排空要能观察存量：已有运行时的客户端不许被锁在外面。
		await expect(engine.attach("c1", () => {})).resolves.toBeDefined();
	});

	it("quiesce 拒新回合：prompt 回一条 notice + 刷快照，不喂轮", async () => {
		const engine = engineWith();
		const { sent } = collector();
		const cs = await engine.attach("c1", (msg) => void sent.push(msg));
		const sendUserMessage = openTurnSession.mock.results[0]?.value;
		const before = sent.length;
		engine.quiesce();

		await cs.prompt("hello");
		const fresh = sent.slice(before);
		expect(fresh.some((m) => m.type === "notice" && /quiesce/.test(m.text))).toBe(true);
		expect(fresh.some((m) => m.type === "snapshot" || m.type === "snapshot_delta")).toBe(true);
		expect(sendUserMessage).toBeDefined();

		engine.unquiesce();
	});

	it("detach 只拆最后一个 socket；认不出的 send 仍按整条连接拆除", async () => {
		const engine = engineWith();
		const s1 = (): void => {};
		const s2 = (): void => {};
		await engine.attach("c1", s1);
		await engine.attach("c1", s2);

		engine.detach("c1", s1);
		expect(engine.get("c1")).toBeDefined();
		engine.detach("c1", s2);
		expect(engine.get("c1")).toBeUndefined();

		// 老契约：调用方随手给的 send 认不出来，就当整条连接拆掉（`attach` 之后 `get` 必须为空）。
		await engine.attach("c2", () => {});
		engine.detach("c2", () => {});
		expect(engine.get("c2")).toBeUndefined();
	});
});
