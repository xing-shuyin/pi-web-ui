import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botMemoryRoot, createBotMemory } from "../../server/device-center/bot-memory.js";
import {
	BOT_HOME_BUNDLE_VERSION,
	exportBotHome,
	importBotHome,
	parseBotHomeBundle,
} from "../../server/device-center/bot-home.js";

const dirs: string[] = [];
async function temp(prefix: string) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const botDef = (id: string) => ({
	id,
	name: "巡检员",
	description: "仓库巡检",
	systemPrompt: "你负责巡检",
	cwd: "/work/demo",
	tools: ["read", "memory"],
	skills: [],
	mcpServers: [],
});

describe("Bot 的家迁移（身份 + 记忆）", () => {
	it("导出含身份与记忆；导入到另一台设备后条目与 profile 都在", async () => {
		const source = await temp("bot-home-src-");
		const target = await temp("bot-home-dst-");
		const memory = createBotMemory({ root: botMemoryRoot(source, "bot-1") });
		await memory.write({
			scope: "project:demo",
			text: "构建命令是 npm run build",
			source: { type: "user", id: "acc", at: Date.now() },
			confidence: "confirmed",
		});
		await memory.promote((await memory.search("构建命令"))[0].id);
		await mkdir(join(source, "bot-agents", "bot-1", "identity"), { recursive: true });
		await writeFile(join(source, "bot-agents", "bot-1", "identity", "profile.md"), "# 巡检员\n换机器后我还是我。\n");
		await writeFile(
			join(source, "bot-agents", "bot-1", "identity", "changes.jsonl"),
			`${JSON.stringify({ at: Date.now(), changed: ["created"], to: "x", tools: ["read"] })}\n`,
		);

		const bundle = await exportBotHome(source, botDef("bot-1"));
		expect(bundle.memory).toHaveLength(1);
		expect(bundle.identity.profile).toContain("换机器后我还是我");
		expect(bundle.identity.changes).toHaveLength(1);

		const parsed = parseBotHomeBundle(JSON.parse(JSON.stringify(bundle)));
		const result = await importBotHome(target, parsed, "bot-2");
		expect(result.imported).toBe(1);
		expect(result.profile).toBe(true);
		expect(result.changes).toBe(1);

		const restored = createBotMemory({ root: botMemoryRoot(target, "bot-2") });
		const entries = await restored.snapshot();
		expect(entries.entries.map((entry) => entry.text)).toContain("构建命令是 npm run build");
		expect(entries.entries[0].resident).toBe(true);
		const profile = await readFile(join(target, "bot-agents", "bot-2", "identity", "profile.md"), "utf8");
		expect(profile).toContain("换机器后我还是我");
	});

	it("坏条目被跳过：未知 scope / 机密 / 超长 / 重复", async () => {
		const target = await temp("bot-home-bad-");
		const bundle = parseBotHomeBundle({
			version: BOT_HOME_BUNDLE_VERSION,
			exportedAt: Date.now(),
			source: { botId: "bot-1" },
			bot: botDef("bot-1"),
			identity: { changes: [] },
			memory: [
				{ scope: "project:demo", text: "合法的一条", kind: "fact", confidence: "unverified" },
				{ scope: "secrets:aws", text: "非法 scope" },
				{ scope: "project:demo", text: "带密码 password = hunter2hunter2" },
				{ scope: "project:demo", text: "x".repeat(600) },
				{ scope: "project:demo", text: "合法的一条", kind: "fact", confidence: "unverified" },
			],
		});
		const result = await importBotHome(target, bundle, "bot-1");
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(4);
	});

	it("导入包不能把 Bot 变成常驻，也不接受未知字段", async () => {
		const parsed = parseBotHomeBundle({
			version: BOT_HOME_BUNDLE_VERSION,
			exportedAt: Date.now(),
			source: { botId: "bot-1" },
			bot: { ...botDef("bot-1"), trigger: "always_on", backdoor: async () => {} },
			identity: { changes: [] },
			memory: [],
		});
		expect(parsed.bot).not.toHaveProperty("trigger");
		expect(parsed.bot).not.toHaveProperty("backdoor");
	});

	it("版本不符或缺少 Bot 定义直接拒绝；profile 含机密也拒绝", () => {
		expect(() => parseBotHomeBundle({ version: 999, bot: botDef("b") })).toThrow(/version/);
		expect(() => parseBotHomeBundle({ version: BOT_HOME_BUNDLE_VERSION })).toThrow(/Bot definition/);
		expect(() =>
			parseBotHomeBundle({
				version: BOT_HOME_BUNDLE_VERSION,
				bot: botDef("b"),
				identity: { profile: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", changes: [] },
				memory: [],
			}),
		).toThrow(/secret/);
	});
});
