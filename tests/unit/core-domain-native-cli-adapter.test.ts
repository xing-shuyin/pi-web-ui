import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createCoreNativeCli,
	type CoreNativeCliSinks,
	type CoreNativeCliTerminals,
} from "../../server/core-native-cli-adapter.js";
import type { NativeCliTarget } from "../../packages/keel/src/contracts/native-cli.js";
import type { NativeCliStatus, ServerMessage, TerminalInfo } from "../../server/protocol.js";

type Call = [name: string, ...args: unknown[]];

function fakeTerminals(calls: Call[], options: { persistent?: boolean; spawn?: boolean } = {}) {
	const spawn = options.spawn ?? true;
	const runtime: { nativeCliRuntime?: { onStatus?(id: string, status: Partial<NativeCliStatus>): void } } = {};
	const terminals = {
		detachNativeCli: (id: string): void => void calls.push(["detachNativeCli", id]),
		stopNativeCli: async (id: string): Promise<void> => void calls.push(["stopNativeCli", id]),
		hasPersistentNativeCli: (): boolean => options.persistent === true,
		async createNativeCli(
			id: string,
			cwd: string,
			cols: number,
			rows: number,
			fallbackCwd: string,
			title: string,
			opts: { nativeCli: unknown },
		): Promise<TerminalInfo | null> {
			calls.push(["createNativeCli", id, cwd, title, opts.nativeCli]);
			if (!spawn) return null;
			runtime.nativeCliRuntime?.onStatus?.(id, { phase: "running", updatedAt: 1 });
			return { id, title, cwd, cols, rows, running: true, exitCode: null } as TerminalInfo;
		},
		getNativeCliTerminal: (): TerminalInfo => ({ running: true }) as TerminalInfo,
		getRawOutput: (): string => "",
		get nativeCliRuntime(): { onStatus?(id: string, status: Partial<NativeCliStatus>): void } | undefined {
			return runtime.nativeCliRuntime;
		},
		set nativeCliRuntime(next: { onStatus?(id: string, status: Partial<NativeCliStatus>): void } | undefined) {
			runtime.nativeCliRuntime = next;
		},
	};
	return terminals as unknown as CoreNativeCliTerminals & {
		createNativeCli: (...args: never[]) => Promise<TerminalInfo | null>;
		nativeCliRuntime?: Record<string, unknown>;
	};
}

let root: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-core-native-cli-"));
	// SDK 的会话目录跟着 agent 目录走：指到临时目录，测试不往用户 home 里写转录。
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function sinks(
	calls: Call[],
	manager: ReturnType<typeof fakeTerminals> | undefined,
	overrides: Partial<CoreNativeCliSinks> = {},
): CoreNativeCliSinks {
	return {
		dataDir: join(root, "data"),
		terminalOf: () => manager,
		emit: (msg: ServerMessage) => void calls.push(["emit", msg.type]),
		publish: () => void calls.push(["publish"]),
		refreshSessions: () => void calls.push(["refreshSessions"]),
		inheritModel: () => undefined,
		remoteService: () => null,
		...overrides,
	};
}

const target = (overrides: Partial<NativeCliTarget> = {}): NativeCliTarget => ({
	conversationId: "c-1",
	terminalId: "cli-c-1",
	config: { preset: "custom", executable: process.execPath },
	cwd: root,
	title: "claude CLI",
	...overrides,
});

describe("宿主侧 native-cli 适配器 · 四个成员真接上", () => {
	it("launch：真起 CLI（PTY 走宿主终端管理器）、绑定落盘、返回终端 id / 目录 / 转录", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(sinks(calls, manager));
		const launched = await port.launch({
			conversationId: "c-1",
			config: { preset: "custom", executable: process.execPath, args: ["interactive.js"] },
			cwd: root,
			title: "custom CLI",
		});
		expect(launched.terminalId).toBe("cli-c-1");
		expect(launched.cwd).toBe(root);
		expect(launched.sessionFile && statSync(launched.sessionFile).isFile()).toBe(true);
		// 客户端配置原样交给 PTY 叶子（没有可继承的模型时也绝不带 model）。
		expect(calls.find((call) => call[0] === "createNativeCli")).toEqual([
			"createNativeCli",
			"cli-c-1",
			root,
			"custom CLI",
			{ preset: "custom", executable: process.execPath, args: ["interactive.js"] },
		]);
		// 转录里落了配置与绑定：重启后 `readNativeCliConfig` / `readNativeCliBinding` 读它。
		const entries = readFileSync(launched.sessionFile!, "utf8").trim().split("\n");
		expect(entries.some((line) => line.includes('"webui/native-cli"'))).toBe(true);
		expect(entries.some((line) => line.includes('"webui/native-cli-state"'))).toBe(true);
		// PTY 叶子的状态回调已经接到这条 CLI 的账上。
		expect(port.statusOf(target())).toMatchObject({ phase: "running" });
	});

	it("launch：客户端塞的 model 一律不信任（丢掉），继承开关关了就不带模型", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(sinks(calls, manager));
		await port.launch({
			conversationId: "c-1",
			config: { preset: "claude", model: { provider: "x", id: "y" } },
			cwd: root,
			title: "claude CLI",
		});
		const created = calls.find((call) => call[0] === "createNativeCli")!;
		expect((created[4] as Record<string, unknown>).model).toBeUndefined();
	});

	it("launch：继承开关打开时按当前对话的模型补上", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(
			sinks(calls, manager, { inheritModel: () => ({ provider: "anthropic", id: "claude-x" }) }),
		);
		await port.launch({ conversationId: "c-1", config: { preset: "claude" }, cwd: root, title: "claude CLI" });
		expect((calls.find((call) => call[0] === "createNativeCli")![4] as Record<string, unknown>).model).toEqual({
			provider: "anthropic",
			id: "claude-x",
		});
	});

	it("launch：终端起不来就 reject（内核据此报错），并且不留转录", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls, { spawn: false });
		const port = createCoreNativeCli(sinks(calls, manager));
		await expect(
			port.launch({ conversationId: "c-1", config: { preset: "claude" }, cwd: root, title: "claude CLI" }),
		).rejects.toThrow("Native CLI process could not be created");
		expect(port.statusOf(target())).toBeUndefined();
	});

	it("launch：目录不存在 / keep-alive 不在远端 → reject（不留下半死对话）", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(sinks(calls, manager));
		await expect(
			port.launch({
				conversationId: "c-1",
				config: { preset: "claude" },
				cwd: join(root, "nope"),
				title: "claude CLI",
			}),
		).rejects.toThrow("CLI working directory is not a directory");
		await expect(
			port.launch({
				conversationId: "c-1",
				config: { preset: "claude", keepAlive: true },
				cwd: root,
				title: "claude CLI",
			}),
		).rejects.toThrow("CLI keep-alive requires an SSH workspace");
		expect(calls.some((call) => call[0] === "createNativeCli")).toBe(false);
	});

	it("applyTitle：标题写进 CLI 转录（历史列表的事实源）并重扫列表", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(sinks(calls, manager));
		const launched = await port.launch({
			conversationId: "c-1",
			config: { preset: "claude" },
			cwd: root,
			title: "claude CLI",
		});
		port.applyTitle(target({ title: "修一下登录页" }));
		const lines = readFileSync(launched.sessionFile!, "utf8").trim().split("\n");
		expect(lines.some((line) => line.includes("修一下登录页"))).toBe(true);
		expect(calls.filter((call) => call[0] === "refreshSessions")).toHaveLength(1);
	});

	it("reconnect：同一个终端 id 再起一次（远端 attach / 本地重起都在宿主叶子里）", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(sinks(calls, manager));
		await port.launch({ conversationId: "c-1", config: { preset: "claude" }, cwd: root, title: "claude CLI" });
		await port.reconnect(target({ title: "排障会话" }));
		const created = calls.filter((call) => call[0] === "createNativeCli");
		expect(created).toHaveLength(2);
		expect(created[1][1]).toBe("cli-c-1");
		// 重连后的终端标签跟着内核给的最新标题。
		expect(created[1][3]).toBe("排障会话");
	});

	it("reconnect：没有这条 CLI 账就明说，不假装连上了", async () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(sinks(calls, fakeTerminals(calls)));
		await expect(port.reconnect(target())).rejects.toThrow("CLI conversation is not owned by this client");
	});

	it("statusOf：没有这条 CLI 就是 undefined（不发明相位）", () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(sinks(calls, fakeTerminals(calls)));
		expect(port.statusOf(target())).toBeUndefined();
	});

	it("PTY 的事件接到状态账与出帧（`native_cli_event`）", async () => {
		const calls: Call[] = [];
		const manager = fakeTerminals(calls);
		const port = createCoreNativeCli(sinks(calls, manager));
		await port.launch({ conversationId: "c-1", config: { preset: "claude" }, cwd: root, title: "claude CLI" });
		const runtime = manager.nativeCliRuntime as {
			prepare(id: string, config: unknown, cwd: string, signal: AbortSignal, onEvent: (e: unknown) => void): unknown;
			onEvent(id: string, event: unknown): void;
		};
		expect(typeof runtime.prepare).toBe("function");
		runtime.onEvent("cli-c-1", { type: "submitted", eventId: "e1" });
		runtime.onEvent("cli-c-1", { type: "done", eventId: "e2" });
		expect(calls.filter((call) => call[0] === "emit").map((call) => call[1])).toEqual([
			"native_cli_prompt_submitted",
			"native_cli_event",
		]);
		expect(port.statusOf(target())).toMatchObject({ phase: "running", activity: "idle" });
	});
});

describe("宿主侧 native-cli 适配器 · 终端归属那几个动作", () => {
	it("detach：落到 `TerminalManager.detachNativeCli`", () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(sinks(calls, fakeTerminals(calls)));
		port.detach(target());
		expect(calls).toEqual([["detachNativeCli", "cli-c-1"]]);
	});

	it("stop（本地）：只停终端，不碰远端持久实例", async () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(sinks(calls, fakeTerminals(calls)));
		await port.stop(target());
		expect(calls).toEqual([["stopNativeCli", "cli-c-1"]]);
	});

	it("stop（远端 keep-alive 但 SSH 服务不可用）：不假装停掉了", async () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(sinks(calls, fakeTerminals(calls)));
		await expect(port.stop(target({ config: { preset: "claude", keepAlive: true } }))).rejects.toThrow(
			"SSH service is unavailable; remote stop could not be confirmed",
		);
		expect(calls).toEqual([]);
	});

	it("终端管理器不存在：明说哪个对话拿不到，而不是静默成功", async () => {
		const port = createCoreNativeCli(sinks([], undefined));
		expect(() => port.detach(target())).toThrow("CLI terminal manager is not available for this conversation");
		await expect(port.stop(target())).rejects.toThrow("CLI terminal manager is not available for this conversation");
		await expect(
			port.launch({ conversationId: "c-1", config: { preset: "claude" }, cwd: root, title: "x" }),
		).rejects.toThrow("CLI terminal manager is not available for this conversation");
	});
});

/** 宿主侧状态字段的窄面（协议里的 `NativeCliStatus` 就是这一份）。 */
const _statusShape: NativeCliStatus = { phase: "running", updatedAt: 1 };
void _statusShape;
/** `SessionManager` 在测试里只用一次：确认宿主落的转录能被 SDK 读回（不是自家编的文件格式）。 */
void SessionManager;
