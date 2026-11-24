import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundPort } from "../../packages/keel/src/contracts/background.js";
import type { PluginAgentTool, PluginToolSyncPort } from "../../packages/keel/src/contracts/plugin.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

/**
 * 引擎级钩子的接线：插件 AI 工具（开会话装配 + 目录变了就地同步）、插件命令目录、后台面板。
 *
 * 这里测的是**新内核真的消费了钩子**（老实现 `applyPluginAgentTools` / `applyPluginCommandCatalog` /
 * `refreshBackgroundServers` 三件），不是插件系统本身——插件持有的东西全在宿主，内核只按钩子取。
 * 只有两处是假的：SDK 的会话（不真开模型）与设置存储的假体（仓库既有约定）。
 */
const openTurnSession = vi.fn();

vi.mock("../../packages/keel/src/adapters/sdk/index.js", () => ({
	openTurnSession: (...args: unknown[]) => openTurnSession(...args),
}));

const { CoreEngine } = await import("../../packages/keel/src/app/core-engine.js");
const { createCoreSlashCommands } = await import("../../server/core-commands-adapter.js");
type Engine = InstanceType<typeof CoreEngine>;

const waitTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 会话假体：喂轮永不收尾（这一轮就「一直在跑」），其余只要够 `subscribeSession` 容错即可。 */
function fakeSession() {
	const session = {
		isStreaming: true,
		sessionFile: "/agent/sessions/s1.jsonl",
		messages: [] as unknown[],
		model: { provider: "anthropic", id: "claude" },
		thinkingLevel: "high",
		sendUserMessage: () => new Promise<void>(() => {}),
		subscribe: () => () => {},
		dispose: () => {},
	};
	return { session, sessionId: "s1", sessionFile: session.sessionFile, dispose: () => {} };
}

function pluginTool(name: string, pluginId = "demo"): PluginAgentTool {
	return {
		pluginId,
		name,
		description: `${name} tool`,
		execute: async () => "ok",
	};
}

function fakeBackground(): BackgroundPort & { refreshes: number } {
	const port = {
		refreshes: 0,
		refreshBgTasks: () => void (port.refreshes += 1),
		listBgServers: async () => {},
		killBackgroundServer: async () => true,
		killAllBackgroundServers: async () => [],
		startBgScript: () => {},
		restartBgJob: () => {},
		setBackgroundKeep: () => true,
		cleanBackgroundLeftovers: async () => [],
	};
	return port;
}

let root: string;
let engines: Engine[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-core-plugin-hooks-"));
	openTurnSession.mockReset();
	openTurnSession.mockImplementation(async () => fakeSession());
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.disposeAll();
	rmSync(root, { recursive: true, force: true });
});

/** 装配一台真内核：只有 SDK 会话与设置存储是假的，钩子按老 `wireEngineHooks` 的手法装在实例上。 */
async function connect(options: {
	tools?: PluginAgentTool[];
	sync?: PluginToolSyncPort;
	onSlashPush?: () => void;
	background?: BackgroundPort;
}): Promise<{ engine: Engine; cs: Awaited<ReturnType<Engine["attach"]>>; sent: ServerMessage[] }> {
	const background = options.background;
	const sync = options.sync;
	const engine = new CoreEngine(root, {
		version: "test",
		attach: true,
		agentDir: join(root, "agent"),
		stateStore: createFakeSettingsStore(),
		...(sync ? { pluginToolSync: () => sync } : {}),
		...(options.onSlashPush ? { slashCommands: () => ({ push: () => options.onSlashPush?.() }) } : {}),
		...(background ? { background: () => background } : {}),
	});
	engines.push(engine);
	// 组合根 `wireEngineHooks` 的同手法：实例建好之后再装钩子（内核必须懒取）。
	const tools = options.tools ?? [];
	engine.pluginToolsProvider = () => tools;
	engine.pluginCommandsProvider = () => [{ name: "/demo", description: "demo" }];
	engine.pluginBgTasksProvider = () => [{ pid: -1, since: 1, name: "watch", status: "running" } as never];
	const sent: ServerMessage[] = [];
	const cs = await engine.attach("c1", (msg) => void sent.push(msg));
	return { engine, cs, sent };
}

/** 让这条连接真的开一次会话（`prompt` → 唯一喂轮出口 → 会话注册表）。 */
async function openFirstSession(cs: { prompt: (text: string) => Promise<void> }): Promise<void> {
	void cs.prompt("hello");
	await waitTick();
	await waitTick();
}

describe("core/app · 插件 AI 工具进会话", () => {
	it("开会话时把插件工具装进自定义工具表（不是空函数）", async () => {
		const { cs } = await connect({ tools: [pluginTool("demo_tool")] });
		await openFirstSession(cs);

		expect(openTurnSession).toHaveBeenCalledTimes(1);
		const passed = openTurnSession.mock.calls[0][0] as { customTools?: { name: string }[] };
		const names = (passed.customTools ?? []).map((tool) => tool.name);
		expect(names).toContain("demo_tool");
		// 内置那几件还在（插件工具是追加，不是替换）。
		expect(names).toContain("bash");
	});

	it("预设 / 关掉名单三道闸都生效", async () => {
		const store = createFakeSettingsStore();
		store.saveSettings("c1", { disabledPluginTools: ["off_tool"], disabledPlugins: ["bad"] });
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			stateStore: store,
		});
		engines.push(engine);
		engine.pluginToolsProvider = () => [pluginTool("on_tool"), pluginTool("off_tool"), pluginTool("bad_tool", "bad")];
		const cs = await engine.attach("c1", () => {});
		await openFirstSession(cs);

		const passed = openTurnSession.mock.calls[0][0] as { customTools?: { name: string }[] };
		const names = (passed.customTools ?? []).map((tool) => tool.name);
		expect(names).toContain("on_tool");
		expect(names).not.toContain("off_tool");
		expect(names).not.toContain("bad_tool");
	});

	it("插件目录变了：已开的会话被就地同步（老实现 applyPluginAgentTools 同口径）", async () => {
		const synced: { defs: string[]; prev: string[] }[] = [];
		const sync: PluginToolSyncPort = {
			syncIntoSession: (_session, defs, prev) => {
				const names = defs.map((def) => (def as { name: string }).name);
				synced.push({ defs: names, prev: [...prev] });
				return new Set(names);
			},
		};
		const tools = [pluginTool("first_tool")];
		const { engine, cs } = await connect({ tools, sync });
		await openFirstSession(cs);
		expect(synced).toHaveLength(0); // 开会话走的是装配，不是同步口

		tools.push(pluginTool("second_tool"));
		engine.applyPluginAgentTools();

		expect(synced).toHaveLength(1);
		expect(synced[0].defs).toEqual(["first_tool", "second_tool"]);
		// 基线 = 上一次真装进会话的那一批：摘工具靠它，不能是空集。
		expect(synced[0].prev).toEqual(["first_tool"]);
	});

	it("没有同步口 / 没开会话：不报错，也不假装同步好了", async () => {
		const { engine, cs } = await connect({ tools: [pluginTool("demo_tool")] });
		// 还没开会话：一次同步都不该发生（也没有会话可同步）。
		expect(() => engine.applyPluginAgentTools()).not.toThrow();
		await openFirstSession(cs);
		expect(() => engine.applyPluginAgentTools()).not.toThrow();
	});
});

describe("core/app · 插件命令目录与后台面板", () => {
	it("applyPluginCommandCatalog 让宿主重算并下发 slash_commands", async () => {
		let pushes = 0;
		const { engine } = await connect({ onSlashPush: () => void (pushes += 1) });
		engine.applyPluginCommandCatalog();
		expect(pushes).toBe(1);
	});

	it("插件命令真的进 slash_commands 帧（走真宿主 SlashCommandsService）", async () => {
		const sent: ServerMessage[] = [];
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			stateStore: createFakeSettingsStore(),
			// 组合根那一行的最小复刻：宿主适配器 + 引擎钩子。
			slashCommands: (sinks) => createCoreSlashCommands(sinks),
		});
		engines.push(engine);
		engine.pluginCommandsProvider = () => [{ name: "plugin_cmd", description: "插件命令" }];
		await engine.attach("c1", (msg) => void sent.push(msg));
		engine.applyPluginCommandCatalog();
		await waitTick();

		const frame = sent.find((msg) => msg.type === "slash_commands") as
			{ commands: { name: string; source?: string }[] } | undefined;
		expect(frame?.commands.some((cmd) => cmd.name === "plugin_cmd" && cmd.source === "plugin")).toBe(true);
	});

	it("refreshBackgroundServers 重投影面板（不重扫端口）", async () => {
		const background = fakeBackground();
		const { engine } = await connect({ background });
		engine.refreshBackgroundServers();
		expect(background.refreshes).toBe(1);
	});

	it("插件常驻任务行来自引擎钩子（面板上真能看到这一类行，也停得掉）", async () => {
		const seen: unknown[] = [];
		const stopped: string[] = [];
		const background = fakeBackground();
		// 宿主的行来源与「停掉它」的句柄就是 `createHostFaces` 传进 sinks 的那两条：这里直接读投影。
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			stateStore: createFakeSettingsStore(),
			background: (sinks) => {
				seen.push(sinks.pluginTasks?.());
				stopped.push(String(sinks.stopBgTask?.("task-1")));
				return background;
			},
		});
		engines.push(engine);
		engine.pluginBgTasksProvider = () => [{ pid: -1, since: 1, name: "watch", status: "running" } as never];
		engine.pluginStopBgTask = (taskId) => taskId === "task-1";
		await engine.attach("c1", () => {});
		// 两个字段名必须与宿主适配器（`server/core-background-adapter.ts`）逐字对齐，否则面板上是空行。
		expect(seen[0]).toEqual([{ pid: -1, since: 1, name: "watch", status: "running" }]);
		expect(stopped[0]).toBe("true");
	});
});
