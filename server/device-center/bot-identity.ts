import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "../atomic-file.js";

/**
 * Bot 身份变更台账（`bot-agents/<id>/identity/changes.jsonl`）。
 *
 * 记的是"它是什么"发生了变化：`systemPrompt` / `tools` / `name`，带前后 hash。
 * 三条纪律：
 *   1. 只追加、截断保留最近 200 条，便于回溯而不无限增长；
 *   2. 每天最多 10 次（人改与模型自改同算），挡住失控的自改循环；
 *   3. 没有实际变化就不写，避免噪声淹没真正的变更。
 */

export const IDENTITY_CHANGES_PER_DAY = 10;
export const IDENTITY_CHANGES_KEEP = 200;

export interface BotIdentitySnapshot {
	id: string;
	name: string;
	systemPrompt: string;
	tools: readonly string[];
}

export interface BotIdentityChange {
	at: number;
	changed: ("created" | "systemPrompt" | "tools" | "name")[];
	from?: string;
	to: string;
	tools: string[];
}

export type BotIdentityChangeResult =
	{ written: true; change: BotIdentityChange } | { written: false; reason: "unchanged" | "rate_limited" };

function identityPath(dataDir: string, botId: string): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(botId)) throw new Error("Invalid Bot id for identity log");
	return join(dataDir, "bot-agents", botId, "identity", "changes.jsonl");
}

function hashOf(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function readChanges(file: string): Promise<BotIdentityChange[]> {
	try {
		return (await readFile(file, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as BotIdentityChange)
			.filter((entry) => typeof entry?.at === "number");
	} catch {
		return [];
	}
}

export async function appendIdentityChange(
	dataDir: string,
	next: BotIdentitySnapshot,
	previous?: Pick<BotIdentitySnapshot, "name" | "systemPrompt" | "tools">,
	now = Date.now(),
): Promise<BotIdentityChangeResult> {
	const changed: BotIdentityChange["changed"] = [];
	if (!previous) changed.push("created");
	else {
		if (previous.systemPrompt !== next.systemPrompt) changed.push("systemPrompt");
		if (JSON.stringify([...previous.tools]) !== JSON.stringify([...next.tools])) changed.push("tools");
		if (previous.name !== next.name) changed.push("name");
	}
	if (!changed.length) return { written: false, reason: "unchanged" };
	const file = identityPath(dataDir, next.id);
	const existing = await readChanges(file);
	const dayStart = new Date(now).setHours(0, 0, 0, 0);
	const today = existing.filter((entry) => entry.at >= dayStart).length;
	if (today >= IDENTITY_CHANGES_PER_DAY) return { written: false, reason: "rate_limited" };
	const change: BotIdentityChange = {
		at: now,
		changed,
		...(previous ? { from: hashOf(previous.systemPrompt) } : {}),
		to: hashOf(next.systemPrompt),
		tools: [...next.tools],
	};
	await mkdir(dirname(file), { recursive: true });
	await writeAtomic(
		file,
		`${[...existing, change]
			.slice(-IDENTITY_CHANGES_KEEP)
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	return { written: true, change };
}
