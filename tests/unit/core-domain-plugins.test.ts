import { describe, expect, it, vi } from "vitest";
import { ClientRuntime, type ClientFrames } from "../../packages/keel/src/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { PluginsPort } from "../../packages/keel/src/contracts/plugins.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { McpOAuthMessage } from "../../packages/keel/src/contracts/plugins.js";
import { createPluginsHandlers, type PluginsHandlers } from "../../packages/keel/src/domains/plugins/handlers.js";
import type { ServerMessage } from "../../server/protocol.js";

type Call = [name: string, ...args: unknown[]];

const server = { name: "fs", scope: "project" as const, command: "npx", args: ["-y", "mcp-fs"] };
const oauth = {
	type: "mcp_oauth_start" as const,
	reqId: "r1",
	name: "github",
	scope: "global" as const,
};

function fakePort(overrides: Partial<PluginsPort> = {}): { port: PluginsPort; calls: Call[] } {
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
			return Promise.resolve();
		};
	const port: PluginsPort = {
		saveMcpServer: record("saveMcpServer") as PluginsPort["saveMcpServer"],
		deleteMcpServer: record("deleteMcpServer") as PluginsPort["deleteMcpServer"],
		toggleMcpServer: record("toggleMcpServer") as PluginsPort["toggleMcpServer"],
		reloadMcp: record("reloadMcp") as PluginsPort["reloadMcp"],
		handleMcpOAuth: record("handleMcpOAuth") as PluginsPort["handleMcpOAuth"],
		installSkill: record("installSkill") as PluginsPort["installSkill"],
		uninstallSkill: record("uninstallSkill") as PluginsPort["uninstallSkill"],
		fetchMcpMarket: record("fetchMcpMarket") as PluginsPort["fetchMcpMarket"],
		fetchSkillMarket: record("fetchSkillMarket") as PluginsPort["fetchSkillMarket"],
		fetchSkillContent: record("fetchSkillContent") as PluginsPort["fetchSkillContent"],
		enableInstalledPlugin: vi.fn(async (pluginId: string) => {
			calls.push(["enableInstalledPlugin", pluginId]);
			return true;
		}) as PluginsPort["enableInstalledPlugin"],
		checkPluginUpdates: record("checkPluginUpdates") as PluginsPort["checkPluginUpdates"],
		checkUpdate: record("checkUpdate") as PluginsPort["checkUpdate"],
		checkUpdatesAll: record("checkUpdatesAll") as PluginsPort["checkUpdatesAll"],
		...overrides,
	};
	return { port, calls };
}

const cases: [keyof PluginsHandlers, (h: PluginsHandlers) => unknown, Call][] = [
	["saveMcpServer", (h) => h.saveMcpServer(server, "old", "global"), ["saveMcpServer", server, "old", "global"]],
	["deleteMcpServer", (h) => h.deleteMcpServer("fs", "project"), ["deleteMcpServer", "fs", "project"]],
	["toggleMcpServer", (h) => h.toggleMcpServer("fs", "global", false), ["toggleMcpServer", "fs", "global", false]],
	["reloadMcp", (h) => h.reloadMcp(), ["reloadMcp"]],
	["handleMcpOAuth", (h) => h.handleMcpOAuth(oauth), ["handleMcpOAuth", oauth]],
	["installSkill", (h) => h.installSkill("tdd", "global", "# TDD"), ["installSkill", "tdd", "global", "# TDD"]],
	["uninstallSkill", (h) => h.uninstallSkill("tdd", "project"), ["uninstallSkill", "tdd", "project"]],
	[
		"fetchMcpMarket",
		(h) => h.fetchMcpMarket("smithery", "git", 2, true),
		["fetchMcpMarket", "smithery", "git", 2, true],
	],
	["fetchSkillMarket", (h) => h.fetchSkillMarket("a/b", false), ["fetchSkillMarket", "a/b", false]],
	["fetchSkillContent", (h) => h.fetchSkillContent("a/b", "tdd"), ["fetchSkillContent", "a/b", "tdd"]],
	["enableInstalledPlugin", (h) => h.enableInstalledPlugin("qq"), ["enableInstalledPlugin", "qq"]],
	["checkPluginUpdates", (h) => h.checkPluginUpdates(true), ["checkPluginUpdates", true]],
	["checkUpdate", (h) => h.checkUpdate(), ["checkUpdate"]],
	["checkUpdatesAll", (h) => h.checkUpdatesAll(true), ["checkUpdatesAll", true]],
];

/** 变更 MCP / 技能的那 6 个：端口解析成功后要刷设置帧（清单跟着走）。 */
const pushesSettings: (keyof PluginsHandlers)[] = [
	"saveMcpServer",
	"deleteMcpServer",
	"toggleMcpServer",
	"reloadMcp",
	"installSkill",
	"uninstallSkill",
];

describe("插件 / MCP / 技能 handler（B6）· 14 个按位转发", () => {
	for (const [member, invoke, expected] of cases) {
		it(`${member} → ${expected[0]}`, async () => {
			const { port, calls } = fakePort();
			await invoke(createPluginsHandlers({ plugins: () => port }));
			expect(calls).toEqual([expected]);
		});
	}

	it("端口缺省时每个成员都**同步**抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const handlers = createPluginsHandlers({});
		const bad: string[] = [];
		for (const [member, invoke] of cases) {
			try {
				const result = invoke(handlers) as Promise<unknown> | undefined;
				// 同步返回 = 抛错被包成了 promise（或干脆没抛），两种都算失败。
				if (result && typeof (result as Promise<unknown>).then === "function") void result.catch(() => {});
				bad.push(`${member}（没同步抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) bad.push(`${member}（抛错类型不对）`);
			}
		}
		expect(bad).toEqual([]);
	});

	it("MCP / 技能变更后刷设置帧；市场与更新查询不刷", async () => {
		const { port } = fakePort();
		const pushSettings = vi.fn();
		const handlers = createPluginsHandlers({ plugins: () => port, pushSettings });
		for (const [member, invoke] of cases) {
			pushSettings.mockClear();
			await invoke(handlers);
			const expected = pushesSettings.includes(member) ? 1 : 0;
			expect([member, pushSettings.mock.calls.length]).toEqual([member, expected]);
		}
	});

	it("端口抛错原样冒泡，且不刷设置帧（失败不伪装成成功）", async () => {
		const { port } = fakePort({
			saveMcpServer: (() => Promise.reject(new Error("EACCES: mcp.json"))) as PluginsPort["saveMcpServer"],
		});
		const pushSettings = vi.fn();
		const handlers = createPluginsHandlers({ plugins: () => port, pushSettings });
		await expect(handlers.saveMcpServer(server)).rejects.toThrow("EACCES: mcp.json");
		expect(pushSettings).not.toHaveBeenCalled();
	});

	it("enableInstalledPlugin 的布尔回执原样透出（false = 名单里本来就没有）", async () => {
		const { port } = fakePort({ enableInstalledPlugin: async () => false });
		await expect(createPluginsHandlers({ plugins: () => port }).enableInstalledPlugin("qq")).resolves.toBe(false);
	});
});

function fakeClock(): ClockPort {
	return { now: () => 1_000, after: () => () => {} };
}

function makeRuntime(plugins: (() => PluginsPort | undefined) | undefined) {
	const sent: ServerMessage[] = [];
	const pushSettings = vi.fn();
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work",
		env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
		clock: fakeClock(),
		transport: { send: (msg: ServerMessage) => void sent.push(msg), isClosed: () => false },
		...(plugins ? { plugins } : {}),
	});
	const frames: ClientFrames = {
		pushSettings,
		refreshSessions: async () => {},
		pushProjects: async () => {},
		listModels: () => {},
		pushDefaultModel: () => {},
	};
	runtime.attachFrames(frames);
	return { runtime, pushSettings, sent };
}

describe("app · ClientRuntime 把插件面接进分发表", () => {
	/** 分发表上的调用参数（与域 handler 表逐条对齐）：经 `handlers()` 原样打一遍。 */
	const dispatchArgs: [keyof PluginsHandlers, unknown[]][] = [
		["saveMcpServer", [server, "old", "global"]],
		["deleteMcpServer", ["fs", "project"]],
		["toggleMcpServer", ["fs", "global", false]],
		["reloadMcp", []],
		["handleMcpOAuth", [oauth]],
		["installSkill", ["tdd", "global", "# TDD"]],
		["uninstallSkill", ["tdd", "project"]],
		["fetchMcpMarket", ["smithery", "git", 2, true]],
		["fetchSkillMarket", ["a/b", false]],
		["fetchSkillContent", ["a/b", "tdd"]],
		["enableInstalledPlugin", ["qq"]],
		["checkPluginUpdates", [true]],
		["checkUpdate", []],
		["checkUpdatesAll", [true]],
	];
	const surface = (runtime: ClientRuntime): Record<string, (...a: unknown[]) => unknown> =>
		runtime.handlers() as unknown as Record<string, (...a: unknown[]) => unknown>;

	it("注入端口后 14 个成员经 DispatchSession 全部真实响应（不再抛 not-ready）", async () => {
		const { port, calls } = fakePort();
		const { runtime, pushSettings } = makeRuntime(() => port);
		const cs = surface(runtime);
		for (const [member, args] of dispatchArgs) await cs[member](...args);
		expect(calls).toEqual(dispatchArgs.map(([member, args]) => [member, ...args]));
		expect(pushSettings).toHaveBeenCalledTimes(6);
	});

	it("没注入端口时 14 个成员经 DispatchSession 调用都**同步**抛 CoreEngineNotReadyError", () => {
		const { runtime } = makeRuntime(undefined);
		const cs = surface(runtime);
		const bad: string[] = [];
		for (const [member, args] of dispatchArgs) {
			try {
				const result = cs[member](...args) as Promise<unknown> | undefined;
				if (result && typeof result.then === "function") void result.catch(() => {});
				bad.push(`${member}（没同步抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) bad.push(`${member}（抛错类型不对）`);
			}
		}
		expect(bad).toEqual([]);
	});

	it("同一份端口只建一次 handler（与其它域同口径）", () => {
		const { port } = fakePort();
		const { runtime } = makeRuntime(() => port);
		expect(runtime.handlers().saveMcpServer).toBe(runtime.handlers().saveMcpServer);
	});
});

/** 类型面：`McpOAuthMessage` 就是协议里那四条，端口不必再描述一遍。 */
const oauthTypeCheck: McpOAuthMessage = oauth;
void oauthTypeCheck;
