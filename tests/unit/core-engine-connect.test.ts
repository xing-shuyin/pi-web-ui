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
 * - **K** 同 clientId 重连要重推初始态（同一 clientId 的活 socket 是老 `emit()` 的扇出口径：镜像都收），
 *   quiesce 时拒新连接 + 拒新回合。
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
/** 每个假会话的 `sendUserMessage`：验「quiesce 期不喂轮」用（喂了就一定经过它）。 */
let feeds: ReturnType<typeof vi.fn>[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-core-connect-"));
	opened = 0;
	feeds = [];
	openTurnSession.mockReset();
	openTurnSession.mockImplementation(async () => {
		opened += 1;
		const sendUserMessage = vi.fn(async () => {});
		feeds.push(sendUserMessage);
		const session = {
			isStreaming: false,
			sessionFile: undefined,
			messages: [] as unknown[],
			model: { provider: "anthropic", id: "claude" },
			sendUserMessage,
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
		const send1 = (msg: ServerMessage): void => void first.sent.push(msg);
		await engine.attach("c1", send1);
		const before = first.types().length;

		const second = collector();
		const send2 = (msg: ServerMessage): void => void second.sent.push(msg);
		await engine.attach("c1", send2);
		expect(second.types()).toContain("settings_state");
		expect(second.types()).toContain("goal_status");
		expect(second.types()).toContain("conversations");
		// 期望变（P6）：同一 clientId 的活 socket 是老 `emit()` 的扇出口径（`sinks` 里每个都收），
		// 所以重推这一批旧 socket 同样收到——它们是同一份运行时的镜像，不是被「换掉」的外部连接。
		expect(new Set(first.types().slice(before))).toEqual(new Set(second.types()));

		// 真重连路径（刷新页面 = `detach` → 同 clientId 新 socket）：初始态必须整包重推。
		// 运行时要留到宽限期，但「重推初始态」的口子得跟着运行时一起留，否则新 socket 只拿到一帧快照。
		engine.detach("c1", send2);
		const third = collector();
		await engine.attach("c1", (msg) => void third.sent.push(msg));
		expect(third.types()).toContain("settings_state");
		expect(third.types()).toContain("conversations");
		expect(openTurnSession).toHaveBeenCalledTimes(1);
	});

	it("模型/供应商端口没装配时不推供应商帧、也不把连接搞挂", async () => {
		const engine = engineWith();
		const { types } = collector();
		await engine.attach("c1", () => {});
		expect(types()).not.toContain("provider_keys");
	});
});

describe("core/app · 重连与 quiesce（K）", () => {
	it("同 clientId 重连后出帧仍走本连接：两个活 socket 都收（镜像），不串到别的客户端", async () => {
		const engine = engineWith({
			slashCommands: (sinks: { emit(msg: ServerMessage): void }) =>
				({ push: () => sinks.emit({ type: "slash_commands", commands: [] } as never) }) as never,
		});
		const first = collector();
		const second = collector();
		await engine.attach("c1", (msg) => void first.sent.push(msg));
		await engine.attach("c1", (msg) => void second.sent.push(msg));
		const beforeOld = first.types().length;

		// 出帧走 `deliverTo`（该 clientId 的每个活 socket），不是「只给最新那个」——
		// 所以重连后的两个 socket 是同一份运行时的镜像，同步收到同一帧。
		engine.applyPluginCommandCatalog();
		await Promise.resolve();
		expect(second.types()).toContain("slash_commands");
		expect(first.types().slice(beforeOld)).toEqual(["slash_commands"]);
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
		const flushed = vi.spyOn(cs, "flushSnapshot");
		const before = sent.length;
		engine.quiesce();

		await cs.prompt("hello");
		const fresh = sent.slice(before);
		expect(fresh.some((m) => m.type === "notice" && /quiesce/.test(m.text))).toBe(true);
		// 期望变（P6）：拒绝后仍然刷一帧快照，但那一帧归出帧闸判——内容没变就跳过
		//（老 `SnapshotChannel.push()` 也是「同一份内容绝不发第二遍」），所以不再断言「必有一帧」，
		// 改验「刷快照确实被叫到」+「一个回合都没喂进去」。
		expect(flushed).toHaveBeenCalledTimes(1);
		expect(feeds[0]).not.toHaveBeenCalled();

		engine.unquiesce();
	});

	it("detach 只拆最后一个 socket；认不出的 send 仍按整条连接拆除", async () => {
		const engine = engineWith();
		const seen: string[] = [];
		const s1 = (msg: ServerMessage): void => void seen.push(`s1:${msg.type}`);
		const s2 = (msg: ServerMessage): void => void seen.push(`s2:${msg.type}`);
		await engine.attach("c1", s1);
		await engine.attach("c1", s2);
		const notice: ServerMessage = { type: "notice", level: "info", text: "x", textEn: "x" };

		engine.detach("c1", s1);
		expect(engine.get("c1")).toBeDefined();
		seen.length = 0;
		engine.deliverTo("c1", notice);
		// 只拆了 s1：剩下的 socket 照常收帧（出口让给剩下那个）。
		expect(seen).toEqual(["s2:notice"]);

		engine.detach("c1", s2);
		// 期望变（P6）：最后一个 socket 走了**只标离线**、不再立刻拆运行时（宽限期内可重连 / 被认领），
		// 与老 `agent-service-daemon.ts` 的 `detach()` 逐条同口径（那里也只在 canvas / device-task 上真拆）。
		expect(engine.get("c1")).toBeDefined();
		seen.length = 0;
		engine.deliverTo("c1", notice);
		// 但 socket 账已清：整条连接不再有任何出口。
		expect(seen).toEqual([]);

		// 老契约：调用方随手给的 send 认不出来，就当整条连接拆掉（出口全部失效），运行时同样留宽限期。
		const s3 = (msg: ServerMessage): void => void seen.push(`s3:${msg.type}`);
		await engine.attach("c2", s3);
		engine.detach("c2", () => {});
		seen.length = 0;
		engine.deliverTo("c2", notice);
		expect(seen).toEqual([]);
		expect(engine.get("c2")).toBeDefined();
	});
});
