import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendIdentityChange,
	IDENTITY_CHANGES_PER_DAY,
	type BotIdentitySnapshot,
} from "../../server/device-center/bot-identity.js";

const dirs: string[] = [];
async function dataDir() {
	const dir = await mkdtemp(join(tmpdir(), "pi-bot-identity-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const bot = (patch: Partial<BotIdentitySnapshot> = {}): BotIdentitySnapshot => ({
	id: "bot-1",
	name: "Atlas",
	systemPrompt: "你负责盯 issue",
	tools: ["read", "memory"],
	...patch,
});

describe("Bot 身份变更台账", () => {
	it("创建、无变化、以及 systemPrompt/tools/name 的变更分别记账", async () => {
		const dir = await dataDir();
		const created = await appendIdentityChange(dir, bot());
		expect(created).toMatchObject({ written: true, change: { changed: ["created"] } });

		expect(await appendIdentityChange(dir, bot(), bot())).toEqual({ written: false, reason: "unchanged" });

		const edited = await appendIdentityChange(dir, bot({ systemPrompt: "你负责写回复" }), bot());
		expect(edited).toMatchObject({ written: true, change: { changed: ["systemPrompt"] } });
		if (edited.written) expect(edited.change.from).toBeTruthy();

		const tools = await appendIdentityChange(
			dir,
			bot({ systemPrompt: "你负责写回复", tools: ["read"] }),
			bot({ systemPrompt: "你负责写回复" }),
		);
		expect(tools).toMatchObject({ written: true, change: { changed: ["tools"] } });

		const lines = (await readFile(join(dir, "bot-agents", "bot-1", "identity", "changes.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean);
		expect(lines).toHaveLength(3);
	});

	it("每天最多 10 次：第 11 次被限速，第二天恢复", async () => {
		const dir = await dataDir();
		const day = new Date(Date.UTC(2026, 1, 11, 9)).getTime();
		let previous: BotIdentitySnapshot | undefined;
		for (let i = 0; i < IDENTITY_CHANGES_PER_DAY; i++) {
			const next = bot({ systemPrompt: `版本 ${i}` });
			const result = await appendIdentityChange(dir, next, previous, day + i * 1000);
			expect(result.written).toBe(true);
			previous = next;
		}
		const blocked = await appendIdentityChange(dir, bot({ systemPrompt: "版本 X" }), previous, day + 20_000);
		expect(blocked).toEqual({ written: false, reason: "rate_limited" });
		const tomorrow = await appendIdentityChange(
			dir,
			bot({ systemPrompt: "版本 X" }),
			previous,
			day + 26 * 60 * 60 * 1000,
		);
		expect(tomorrow.written).toBe(true);
	});

	it("拒绝越界 Bot id（防止写到 dataDir 之外）", async () => {
		const dir = await dataDir();
		await expect(appendIdentityChange(dir, bot({ id: "../escape" }))).rejects.toThrow(/Invalid Bot id/);
	});
});
