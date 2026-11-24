import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCorePlugins } from "../../server/core-plugin-adapter.js";
import { currentCorePluginsHandle } from "../../server/core-plugins-handle.js";
import type { ServerMessage } from "../../server/protocol.js";

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-core-plugins-"));
	const agentDir = join(root, "agent");
	const dataDir = join(root, "data");
	const cwd = join(root, "work");
	for (const dir of [agentDir, dataDir, cwd]) mkdirSync(dir, { recursive: true });
	return { root, agentDir, dataDir, cwd };
}

function makeAdapter(overrides: Partial<Parameters<typeof createCorePlugins>[0]> = {}) {
	const dirs = workspace();
	const sent: ServerMessage[] = [];
	const reloadSession = vi.fn(async () => {});
	let disabledPlugins: string[] | undefined = ["qq", "office"];
	const adapter = createCorePlugins({
		agentDir: dirs.agentDir,
		dataDir: dirs.dataDir,
		version: "9.9.9",
		emit: (msg) => void sent.push(msg),
		isDisposed: () => false,
		getCwd: () => dirs.cwd,
		getLang: () => "zh",
		reloadSession,
		getDisabledPlugins: () => disabledPlugins,
		setDisabledPlugins: async (next) => {
			disabledPlugins = next;
		},
		...overrides,
	});
	return { adapter, sent, dirs, reloadSession, disabled: () => disabledPlugins };
}

const kinds = (sent: ServerMessage[]) => sent.map((msg) => msg.type);

describe("宿主插件适配器 · 真实叶子（写 mcp.json / 技能目录 / 插件更新）", () => {
	it("saveMcpServer 真写项目 mcp.json 并广播清单 + 清单变更", async () => {
		const { adapter, sent, dirs } = makeAdapter();
		await adapter.saveMcpServer({ name: "fs", scope: "project", command: "npx", args: ["-y", "mcp-fs"] });

		const written = JSON.parse(readFileSync(join(dirs.cwd, ".pi", "mcp.json"), "utf8")) as {
			mcpServers: Record<string, { command?: string }>;
		};
		expect(written.mcpServers.fs?.command).toBe("npx");
		expect(kinds(sent)).toEqual(["mcp_servers", "extension_inventory_changed"]);
		const frame = sent[0] as Extract<ServerMessage, { type: "mcp_servers" }>;
		expect(frame.servers.map((s) => [s.name, s.scope])).toEqual([["fs", "project"]]);
	});

	it("toggleMcpServer / deleteMcpServer 真改文件，失败时发 error notice 且不广播", async () => {
		const { adapter, sent, dirs } = makeAdapter();
		await adapter.saveMcpServer({ name: "fs", scope: "project", command: "npx" });
		sent.length = 0;

		await adapter.toggleMcpServer("fs", "project", false);
		const toggled = JSON.parse(readFileSync(join(dirs.cwd, ".pi", "mcp.json"), "utf8")) as {
			mcpServers: Record<string, { enabled?: boolean }>;
		};
		expect(toggled.mcpServers.fs?.enabled).toBe(false);
		expect(kinds(sent)).toEqual(["mcp_servers", "extension_inventory_changed"]);

		sent.length = 0;
		await adapter.deleteMcpServer("fs", "project");
		expect(existsSync(join(dirs.cwd, ".pi", "mcp.json"))).toBe(true);
		expect(kinds(sent)).toEqual(["mcp_servers", "extension_inventory_changed"]);

		sent.length = 0;
		await adapter.deleteMcpServer("nope", "project");
		expect(kinds(sent)).toEqual(["notice"]);
		expect((sent[0] as Extract<ServerMessage, { type: "notice" }>).level).toBe("error");
	});

	it("reloadMcp 没接连接域也能跑通（只读配置文件 + 通知）", async () => {
		const { adapter, sent } = makeAdapter();
		await adapter.reloadMcp();
		expect(kinds(sent)).toEqual(["mcp_servers", "extension_inventory_changed", "notice"]);
	});

	it("listMcpServers 与 mcp_servers 帧同源：全局 + 项目一次给全", async () => {
		const { adapter, dirs } = makeAdapter();
		await adapter.saveMcpServer({ name: "fs", scope: "project", command: "npx" });

		const list = adapter.listMcpServers?.();
		expect(list?.servers.map((server) => `${server.scope}:${server.name}`)).toEqual(["project:fs"]);
		expect(list?.projectPath).toBe(join(dirs.cwd, ".pi", "mcp.json"));
		// cwd 可以显式给（宿主句柄侧的场景）：换一个 cwd 就读不到这条项目配置。
		expect(adapter.listMcpServers?.(join(dirs.root, "elsewhere"))?.servers).toEqual([]);
	});

	it("dispose 关掉端口并收回宿主句柄，晚装配的端口不被早退的客户端带走", async () => {
		const first = makeAdapter();
		const firstHandle = currentCorePluginsHandle();
		expect(firstHandle).toBeDefined();

		const second = makeAdapter();
		const secondHandle = currentCorePluginsHandle();
		expect(secondHandle).not.toBe(firstHandle);

		first.adapter.dispose?.();
		expect(currentCorePluginsHandle()).toBe(secondHandle);
		second.adapter.dispose?.();
		expect(currentCorePluginsHandle()).not.toBe(secondHandle);
	});

	it("installSkill 真写 SKILL.md 并让内核重开会话", async () => {
		const { adapter, sent, dirs, reloadSession } = makeAdapter();
		await adapter.installSkill("tdd", "project", "# TDD\n写测试");
		const file = join(dirs.cwd, ".pi", "skills", "tdd", "SKILL.md");
		expect(readFileSync(file, "utf8")).toBe("# TDD\n写测试\n");
		expect(reloadSession).toHaveBeenCalledTimes(1);
		expect(kinds(sent)).toEqual(["notice"]);
		expect((sent[0] as Extract<ServerMessage, { type: "notice" }>).level).toBe("info");
	});

	it("installSkill 名字非法：发 error notice，不落盘、不重开会话", async () => {
		const { adapter, sent, dirs, reloadSession } = makeAdapter();
		await adapter.installSkill("bad name!", "project", "# x");
		expect(existsSync(join(dirs.cwd, ".pi", "skills"))).toBe(false);
		expect(reloadSession).not.toHaveBeenCalled();
		expect((sent[0] as Extract<ServerMessage, { type: "notice" }>).level).toBe("error");
	});

	it("uninstallSkill 真删目录；找不到时发 warning 且不重开会话", async () => {
		const { adapter, sent, dirs, reloadSession } = makeAdapter();
		await adapter.installSkill("tdd", "global", "# TDD");
		expect(existsSync(join(dirs.agentDir, "skills", "tdd"))).toBe(true);
		sent.length = 0;
		reloadSession.mockClear();

		await adapter.uninstallSkill("tdd", "global");
		expect(existsSync(join(dirs.agentDir, "skills", "tdd"))).toBe(false);
		expect(reloadSession).toHaveBeenCalledTimes(1);
		expect((sent[0] as Extract<ServerMessage, { type: "notice" }>).level).toBe("info");

		sent.length = 0;
		reloadSession.mockClear();
		await adapter.uninstallSkill("tdd", "global");
		expect((sent[0] as Extract<ServerMessage, { type: "notice" }>).level).toBe("warning");
		expect(reloadSession).not.toHaveBeenCalled();
	});

	it("fetchSkillContent('local') 读磁盘技能正文（不联网）", async () => {
		const { adapter, sent, dirs } = makeAdapter();
		mkdirSync(join(dirs.cwd, ".pi", "skills", "tdd"), { recursive: true });
		writeFileSync(join(dirs.cwd, ".pi", "skills", "tdd", "SKILL.md"), "# TDD\n内容", "utf8");

		await adapter.fetchSkillContent("local", "tdd");
		expect(kinds(sent)).toEqual(["skill_content_result"]);
		const frame = sent[0] as Extract<ServerMessage, { type: "skill_content_result" }>;
		expect(frame.ok).toBe(true);
		expect(frame.content).toContain("内容");
	});

	it("enableInstalledPlugin 真摘名单（不在名单里返回 false 且不写）", async () => {
		const { adapter, disabled } = makeAdapter();
		await expect(adapter.enableInstalledPlugin("qq")).resolves.toBe(true);
		expect(disabled()).toEqual(["office"]);
		await expect(adapter.enableInstalledPlugin("qq")).resolves.toBe(false);
		expect(disabled()).toEqual(["office"]);
	});

	it("checkPluginUpdates 走真叶子：dataDir/plugins 为空 → 空清单 + 手动提示", async () => {
		const { adapter, sent } = makeAdapter();
		await adapter.checkPluginUpdates(true);
		expect(kinds(sent)).toEqual(["plugin_updates", "notice"]);
		expect((sent[0] as Extract<ServerMessage, { type: "plugin_updates" }>).updates).toEqual([]);
		expect((sent[1] as Extract<ServerMessage, { type: "notice" }>).level).toBe("info");
	});

	it("客户端已断开时不再出帧（变更照旧成立）", async () => {
		const { adapter, sent, disabled } = makeAdapter({ isDisposed: () => true });
		await expect(adapter.enableInstalledPlugin("qq")).resolves.toBe(true);
		expect(disabled()).toEqual(["office"]);
		await adapter.reloadMcp();
		await adapter.fetchSkillContent("local", "no-such-skill");
		expect(sent).toEqual([]);
	});
});
