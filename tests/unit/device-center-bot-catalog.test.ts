import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalBotOptions } from "../../server/device-center/bot-catalog.js";
import { isBotToolHighPrivilege, registerBotExecution } from "../../server/device-center/bot-execution.js";
import { McpProjectRuntimeRegistry } from "../../server/mcp-project-runtime.js";
import type { LocalBot } from "../../server/device-center/bots.js";

const cleanups: string[] = [];
afterEach(async () => {
	for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "bot-catalog-"));
	cleanups.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	return { defaultCwd: cwd, agentDir, dataDir: join(root, "data") };
}
describe("local Bot catalog", () => {
	it("captures current default tools without replacing an explicitly empty selection", async () => {
		const sources = await fixture();
		let selected = ["read", "device_collab", "conversation"];
		const configured = { ...sources, defaultTools: () => selected };
		const first = await getLocalBotOptions(configured, undefined, new AbortController().signal);
		// `memory` 是 Bot 的私产，新 Bot 默认就带（不受全局默认工具影响）。
		expect(first.defaultTools).toEqual([...selected, "memory"]);
		selected.push("write");
		expect(first.defaultTools).not.toContain("write");
		selected = [];
		expect((await getLocalBotOptions(configured, undefined, new AbortController().signal)).defaultTools).toEqual([
			"memory",
		]);
	});
	it("inspects unknown project MCP state without constructing a bridge", async () => {
		const sources = await fixture();
		let created = 0;
		const registry = new McpProjectRuntimeRegistry({
			dataDir: sources.dataDir,
			createBridge: () => {
				created++;
				throw new Error("Unexpected MCP process startup");
			},
		});
		try {
			expect(registry.peekBridge(sources.defaultCwd)).toBeUndefined();
			const result = await getLocalBotOptions(
				{ ...sources, peekMcpBridge: (cwd) => registry.peekBridge(cwd) },
				undefined,
				new AbortController().signal,
			);
			expect(created).toBe(0);
			expect(result.mcpServers).toEqual([]);
		} finally {
			await registry.dispose();
		}
	});
	it("captures cwd across awaits, strips private model data, and preserves full slash IDs", async () => {
		const sources = await fixture();
		let release!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = getLocalBotOptions(
			{
				...sources,
				models: async () => {
					await wait;
					return [
						{
							id: "custom/vendor/model",
							name: "Model",
							provider: "custom",
							reasoning: false,
							vision: false,
							apiKey: "private",
						} as any,
					];
				},
			},
			sources.defaultCwd,
			new AbortController().signal,
		);
		release();
		const result = await pending;
		expect(result.cwd).toBe(sources.defaultCwd);
		expect(result.models).toEqual([
			{ id: "custom/vendor/model", name: "Model", provider: "custom", reasoning: false, vision: false },
		]);
	});
	it("cancels before publishing after a slow model read", async () => {
		const sources = await fixture();
		const controller = new AbortController();
		await expect(
			getLocalBotOptions(
				{
					...sources,
					models: async () => {
						controller.abort();
						return [];
					},
				},
				undefined,
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});
	it("uses skill names for exactly the same whitelist execution compares", async () => {
		const sources = await fixture();
		const path = join(sources.agentDir, "skills", "folder-name", "SKILL.md");
		await mkdir(join(sources.agentDir, "skills", "folder-name"), { recursive: true });
		await writeFile(path, "---\nname: actual-runtime-name\ndescription: Test skill\n---\nInstructions\n");
		const result = await getLocalBotOptions(sources, undefined, new AbortController().signal);
		expect(result.tools.find((tool) => tool.id === "conversation")).toMatchObject({ warning: "high_privilege" });
		expect(result.tools.find((tool) => tool.id === "device_collab")).not.toHaveProperty("warning");
		const skill = result.skills.find((item) => item.path === path)!;
		expect(skill.id).toBe("actual-runtime-name");
		const execution = registerBotExecution({
			id: "bot",
			enabled: true,
			cwd: sources.defaultCwd,
			revision: 1,
			skills: [skill.id],
			tools: ["read", "conversation", "subagent_custom", "team_custom"],
			mcpServers: [],
		} as unknown as LocalBot);
		try {
			expect(execution.capability.filterSkills([{ name: skill.id }, { name: path }])).toEqual([{ name: skill.id }]);
			for (const name of ["conversation", "subagent_custom", "team_custom"]) {
				expect(isBotToolHighPrivilege(name)).toBe(true);
				expect(execution.capability.allowsTool(name)).toBe(true);
			}
		} finally {
			execution.release();
		}
	});
});
