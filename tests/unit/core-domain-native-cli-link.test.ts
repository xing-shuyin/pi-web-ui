import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { CoreEngine } from "../../packages/keel/src/app/core-engine.js";
import type { DispatchSession } from "../../packages/keel/src/engine-service.js";
import type { ServerMessage, TerminalInfo } from "../../server/protocol.js";
import { TerminalManager } from "../../server/terminals.js";
import { createCoreNativeCli, asCoreNativeCliTerminals } from "../../server/core-native-cli-adapter.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

/**
 * 真链路：真 `CoreEngine`（真内核装配 + 真终端宿主 + 真 `TerminalManager` + 真转录落盘）
 * 把一条 CLI 对话从 `newCliChat` 起到 `stop`：
 *
 * `newCliChat` → `getNativeCliConversation`（读得到终端与状态）→ `updateNativeCliTitleFromInput`
 * （转录里的 `session_info` 真变了）→ `controlNativeCli("reconnect")`（真再起一次）→
 * `controlNativeCli("stop")`（真停，`pty.kill` 真被调用）。
 *
 * 只有两处是假的，都在进程边界上（仓库既有约定）：`node-pty` 的 spawn（测试里不真开进程）
 * 与设置存储的假体（`createFakeSettingsStore`）。内核、适配器、宿主运行时全是真的。
 */
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

interface FakePty {
	write: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	onData: ReturnType<typeof vi.fn>;
	onExit: ReturnType<typeof vi.fn>;
}

let root: string;
let pty: FakePty;
let previousAgentDir: string | undefined;
let engines: CoreEngine[] = [];
let managers: TerminalManager[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-core-cli-link-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	// SDK 的转录目录跟着 agent 目录走：指到临时目录，别往用户 home 里写。
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	pty = {
		write: vi.fn(),
		kill: vi.fn(),
		resize: vi.fn(),
		onData: vi.fn(() => ({ dispose: vi.fn() })),
		onExit: vi.fn(() => ({ dispose: vi.fn() })),
	};
	vi.mocked(spawn)
		.mockReset()
		.mockReturnValue(pty as never);
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.disposeAll();
	for (const manager of managers.splice(0)) manager.killAll({ shutdown: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** 真 `CoreEngine` + 真 `TerminalManager` + **真宿主 CLI 适配器**（组合根那一行的最小复刻）。 */
async function connect(): Promise<{ cs: DispatchSession; sent: ServerMessage[] }> {
	const sent: ServerMessage[] = [];
	const engine = new CoreEngine(root, {
		version: "test",
		stateStore: createFakeSettingsStore(),
		attach: true,
		terminalManager: ({ emit, cwd, lang }) => {
			const manager = new TerminalManager(emit, cwd, lang);
			managers.push(manager);
			return manager;
		},
		nativeCli: (sinks) =>
			createCoreNativeCli({
				dataDir: join(root, "data"),
				terminalOf: (id, cwd) => asCoreNativeCliTerminals(sinks.terminalOf(id, cwd)),
				emit: (msg) => sinks.emit(msg),
				publish: () => sinks.publish(),
				refreshSessions: () => sinks.refreshSessions(),
				inheritModel: (preset) => sinks.inheritModel(preset),
				remoteService: () => null,
			}),
	});
	engines.push(engine);
	const cs = await engine.attach("client-1", (msg) => void sent.push(msg));
	return { cs, sent };
}

describe("core 原生 CLI · 真链路（CoreEngine → 适配器 → 终端叶子 → 转录）", () => {
	it("newCliChat 真起会话 → 读得到 → 改标题 → 重连 → 真停", async () => {
		const { cs, sent } = await connect();
		const ready: string[] = [];
		const started = await cs.newCliChat!(
			{ preset: "custom", executable: process.execPath, args: ["interactive.js"] },
			root,
			(id) => void ready.push(id),
			"custom CLI",
		);
		expect(started).toBe(true);
		const conversationId = ready[0]!;
		expect(conversationId).toMatch(/^c-/);

		// ① 内核记的账 + 宿主的状态 + 真 terminal 都到位（PTY 真被请求过，且命令行是 CLI 配置）。
		const cli = cs.getNativeCliConversation!(conversationId);
		expect(cli).toMatchObject({ terminalId: `cli-${conversationId}` });
		expect(cli?.status?.phase).toMatch(/running|starting/);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
		const spawnedArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
		expect(spawnedArgs.join(" ")).toContain("interactive.js");

		// ①' 左栏运行列表也带着这个状态：没有它，活着的 CLI 会被画成「已结束」。
		const cliRow = () =>
			[...sent]
				.reverse()
				.find(
					(message): message is Extract<ServerMessage, { type: "conversations" }> =>
						message.type === "conversations" && message.conversations.some((row) => row.id === conversationId),
				)
				?.conversations.find((row) => row.id === conversationId);
		await vi.waitFor(() => expect(cliRow()?.nativeCli?.status?.phase).toBe("running"));
		expect(cliRow()?.nativeCli?.terminalId).toBe(`cli-${conversationId}`);

		// ② 转录落盘：历史列表读的那份文件里同时有 CLI 配置与绑定（重扫是异步的，等一帧）。
		const findCliSession = () => {
			const frame = [...sent]
				.reverse()
				.find((message): message is Extract<ServerMessage, { type: "sessions" }> => message.type === "sessions");
			return frame?.sessions.find((session) => session.nativeCli?.preset === "custom");
		};
		await vi.waitFor(() => expect(findCliSession()).toBeDefined());
		const transcript = findCliSession()!;
		expect(statSync(transcript.path).isFile()).toBe(true);

		// ③ 标题回填：用户输入派生 → 转录里多了 `session_info`，左栏历史行的标题跟着变。
		cs.updateNativeCliTitleFromInput!(conversationId, "修一下登录页");
		expect(readFileSync(transcript.path, "utf8")).toContain("修一下登录页");
		await vi.waitFor(() => expect(findCliSession()?.name).toBe("修一下登录页"));

		// ④ 真停：终端真的被收掉（POSIX 直接 kill；Windows 走 Ctrl+C + 300ms 兵底 kill），
		//    状态跟着变 exited（不是「看起来停了」）。
		await cs.controlNativeCli!(conversationId, `cli-${conversationId}`, "stop");
		expect(pty.kill.mock.calls.length + pty.write.mock.calls.length).toBeGreaterThan(0);
		expect(cs.getNativeCliConversation!(conversationId)?.status?.phase).toBe("exited");
		// 运行列表同步翻成 exited（同一个状态账，不是两处各写一份）。
		await vi.waitFor(() => expect(cliRow()?.nativeCli?.status?.phase).toBe("exited"));

		// ⑤ 重连：同一个对话 / 终端 id 真再起一次（PTY 第二次 spawn，状态回到 running）。
		await cs.controlNativeCli!(conversationId, `cli-${conversationId}`, "reconnect");
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
		expect(cs.getNativeCliConversation!(conversationId)?.status?.phase).toBe("running");
	});

	it("目录不存在 → false + error notice，不留对话也不留转录（失败不吞）", async () => {
		const { cs, sent } = await connect();
		const ready: string[] = [];
		const started = await cs.newCliChat!({ preset: "claude" }, join(root, "nope"), (id) => void ready.push(id));
		expect(started).toBe(false);
		expect(ready).toEqual([]);
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
		const notice = sent.find(
			(message): message is Extract<ServerMessage, { type: "notice" }> =>
				message.type === "notice" && message.level === "error",
		);
		expect(notice?.text).toContain("新建 CLI 对话失败");
	});
});

/** `TerminalInfo` 只在这里被引用一次：确认终端信息形状与协议一致。 */
const _terminalInfo: TerminalInfo | undefined = undefined;
void _terminalInfo;
