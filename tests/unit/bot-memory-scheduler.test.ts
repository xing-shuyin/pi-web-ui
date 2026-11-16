import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBotMemory } from "../../server/device-center/bot-memory.js";
import { runBotMemoryMaintenanceOnce } from "../../server/device-center/bot-memory-scheduler.js";

const dirs: string[] = [];

async function dataDir() {
	const dir = await mkdtemp(join(tmpdir(), "pi-bot-memory-cron-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const botsOf = (ids: string[]) => ({ list: () => ids.map((id) => ({ id, name: id })) });

describe("记忆日常维护", () => {
	it("对每个 Bot 跑一次 compact，过期条目归档并留下 REPORT", async () => {
		const dir = await dataDir();
		// 用可控时钟写入两条"30 天前的 Bot 推断"，再让维护把它们归档。
		const past = Date.UTC(2026, 0, 1);
		const memory = createBotMemory({ root: join(dir, "bot-agents", "bot-a", "memory"), now: () => past });
		await memory.write({ scope: "topic:news", text: "临时观察", source: { type: "bot", id: "bot-a", at: past } });
		await memory.write({ scope: "topic:news", text: "另一条临时观察", source: { type: "bot", id: "bot-a", at: past } });

		const result = await runBotMemoryMaintenanceOnce({ dataDir: dir, bots: botsOf(["bot-a"]) });
		expect(result.bots).toBe(1);
		// 时间戳是"现在"，两条 Bot 推断都超过 30 天 → 归档。
		expect(result.expired).toBeGreaterThanOrEqual(2);
		const report = await readFile(join(dir, "bot-agents", "bot-a", "memory", "REPORT.md"), "utf8");
		expect(report).toContain("never used");
		const remaining = await createBotMemory({ root: join(dir, "bot-agents", "bot-a", "memory") }).snapshot();
		expect(remaining.entries).toHaveLength(0);
	});

	it("单个 Bot 失败不影响其它 Bot", async () => {
		const dir = await dataDir();
		const failures: string[] = [];
		const result = await runBotMemoryMaintenanceOnce({
			dataDir: dir,
			bots: botsOf(["../escape", "bot-ok"]),
			onError: (botId) => failures.push(botId),
		});
		expect(failures).toEqual(["../escape"]);
		expect(result.bots).toBe(1);
	});

	it("定时器走 armDelay 分片（≤6h），而不是一次睡 24h", () => {
		const source = readFileSync(join(process.cwd(), "server/device-center/bot-memory-scheduler.ts"), "utf8");
		expect(source).toContain("armDelay(");
		// 唯一一次 setTimeout 的延迟必须来自 armDelay 分片结果，不能手写 24h。
		expect(source).toMatch(/const delay = armDelay\(/);
		expect(source).toMatch(/setTimeout\(\(\) => \{[\s\S]*?\}, delay\)/);
		expect(source).not.toMatch(/setTimeout\([^)]*24\s*\*\s*60/);
	});
});
