import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "../atomic-file.js";
import { botMemoryRoot, createBotMemory, findSecret } from "./bot-memory.js";

/**
 * Bot 的"家"迁移：把身份 + 记忆打包成可带走的 JSON，在另一台设备导入。
 *
 * 边界（都很窄，故意）：
 *   - 只搬 `bot-agents/<id>/`（身份与记忆），不搬工作目录内容（那是项目，走文件同步/git）；
 *   - 导入时**强制** `trigger: "on_demand"`，不允许一个包把新设备变成常驻消耗；
 *   - 记忆条目仍然过写入校验（scope / 长度 / 机密 / 去重 / 容量），非法条目跳过并计数；
 *   - profile 与 changes 有大小上限，且拒绝含机密的 profile。
 */

export const BOT_HOME_BUNDLE_VERSION = 1;
export const BOT_HOME_PROFILE_MAX_BYTES = 16 * 1024;
export const BOT_HOME_CHANGES_MAX_LINES = 200;
export const BOT_HOME_CHANGES_MAX_BYTES = 64 * 1024;

export interface BotHomeBot {
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills: string[];
	mcpServers: string[];
	identity?: { authoredBy: "human" | "model"; authoredAt: number; modelRevision: number };
}

export interface BotHomeBundle {
	version: number;
	exportedAt: number;
	source: { botId: string };
	bot: BotHomeBot;
	identity: { profile?: string; changes: string[] };
	memory: unknown[];
}

export interface BotHomeImportResult {
	imported: number;
	skipped: number;
	profile: boolean;
	changes: number;
}

function identityDir(dataDir: string, botId: string): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(botId)) throw new Error("Invalid Bot id for home directory");
	return join(dataDir, "bot-agents", botId);
}

async function readTextCapped(path: string, maxBytes: number): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		return Buffer.byteLength(text, "utf8") > maxBytes ? undefined : text;
	} catch {
		return undefined;
	}
}

export async function exportBotHome(dataDir: string, bot: BotHomeBot & { id: string }): Promise<BotHomeBundle> {
	const memory = createBotMemory({ root: botMemoryRoot(dataDir, bot.id) });
	const { entries } = await memory.snapshot();
	const root = identityDir(dataDir, bot.id);
	const profile = await readTextCapped(join(root, "identity", "profile.md"), BOT_HOME_PROFILE_MAX_BYTES);
	const changesRaw = (await readTextCapped(join(root, "identity", "changes.jsonl"), BOT_HOME_CHANGES_MAX_BYTES)) ?? "";
	const changes = changesRaw.split("\n").filter(Boolean).slice(-BOT_HOME_CHANGES_MAX_LINES);
	return {
		version: BOT_HOME_BUNDLE_VERSION,
		exportedAt: Date.now(),
		source: { botId: bot.id },
		bot: {
			name: bot.name,
			description: bot.description,
			systemPrompt: bot.systemPrompt,
			cwd: bot.cwd,
			...(bot.model ? { model: { provider: bot.model.provider, modelId: bot.model.modelId } } : {}),
			tools: [...bot.tools],
			skills: [...bot.skills],
			mcpServers: [...bot.mcpServers],
			...(bot.identity ? { identity: { ...bot.identity } } : {}),
		},
		identity: { ...(profile ? { profile } : {}), changes },
		memory: entries.map((entry) => ({
			id: entry.id,
			scope: entry.scope,
			text: entry.text,
			kind: entry.kind,
			confidence: entry.confidence,
			source: entry.source,
			createdAt: entry.createdAt,
			resident: entry.resident === true,
		})),
	};
}

/** 导入前的结构校验：只允许已知字段，避免把任意 JSON 写进 Bot 目录。 */
export function parseBotHomeBundle(raw: unknown): BotHomeBundle {
	const fail = (message: string): never => {
		throw Object.assign(new Error(message), { code: "BOT_IMPORT_INVALID", status: 400 });
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Import bundle must be an object");
	const bundle = raw as Record<string, unknown>;
	if (bundle.version !== BOT_HOME_BUNDLE_VERSION)
		fail(`Unsupported bundle version (expected ${BOT_HOME_BUNDLE_VERSION})`);
	const bot = bundle.bot as Record<string, unknown> | undefined;
	if (!bot || typeof bot !== "object") fail("Bundle is missing the Bot definition");
	const botDef = bot as Record<string, unknown>;
	const text = (value: unknown, max: number, field: string) => {
		if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) fail(`Invalid ${field}`);
		return value as string;
	};
	const list = (value: unknown, field: string) => {
		if (value === undefined) return [] as string[];
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || item.length > 128))
			fail(`Invalid ${field}`);
		return [...new Set(value as string[])];
	};
	const identity = bundle.identity as Record<string, unknown> | undefined;
	const profile =
		identity && typeof identity.profile === "string" && identity.profile.trim()
			? identity.profile.slice(0, BOT_HOME_PROFILE_MAX_BYTES)
			: undefined;
	if (profile && findSecret(profile)) fail("Profile looks like it contains a secret");
	const changes =
		identity && Array.isArray(identity.changes)
			? identity.changes.filter((line): line is string => typeof line === "string").slice(-BOT_HOME_CHANGES_MAX_LINES)
			: [];
	const model = botDef.model as Record<string, unknown> | undefined;
	return {
		version: BOT_HOME_BUNDLE_VERSION,
		exportedAt: typeof bundle.exportedAt === "number" ? bundle.exportedAt : Date.now(),
		source: {
			botId:
				typeof (bundle.source as { botId?: unknown })?.botId === "string"
					? (bundle.source as { botId: string }).botId
					: "unknown",
		},
		bot: {
			name: text(botDef.name, 200, "name"),
			description: typeof botDef.description === "string" ? botDef.description.slice(0, 4000) : "",
			systemPrompt: typeof botDef.systemPrompt === "string" ? botDef.systemPrompt.slice(0, 32 * 1024) : "",
			cwd: typeof botDef.cwd === "string" ? botDef.cwd : "",
			...(model && typeof model.provider === "string" && typeof model.modelId === "string"
				? { model: { provider: model.provider, modelId: model.modelId } }
				: {}),
			tools: list(botDef.tools, "tools"),
			skills: list(botDef.skills, "skills"),
			mcpServers: list(botDef.mcpServers, "mcpServers"),
			...(botDef.identity && typeof botDef.identity === "object"
				? {
						identity: {
							authoredBy:
								(botDef.identity as { authoredBy?: string }).authoredBy === "human"
									? ("human" as const)
									: ("model" as const),
							authoredAt:
								typeof (botDef.identity as { authoredAt?: unknown }).authoredAt === "number"
									? (botDef.identity as { authoredAt: number }).authoredAt
									: Date.now(),
							modelRevision:
								typeof (botDef.identity as { modelRevision?: unknown }).modelRevision === "number"
									? (botDef.identity as { modelRevision: number }).modelRevision
									: 1,
						},
					}
				: {}),
		},
		identity: { ...(profile ? { profile } : {}), changes },
		memory: Array.isArray(bundle.memory) ? bundle.memory.slice(0, 400) : [],
	};
}

/** 把包写进本机 `bot-agents/<id>/`（记忆走同一套写入校验）。 */
export async function importBotHome(
	dataDir: string,
	bundle: BotHomeBundle,
	botId: string,
): Promise<BotHomeImportResult> {
	const root = identityDir(dataDir, botId);
	await mkdir(join(root, "identity"), { recursive: true });
	let profile = false;
	if (bundle.identity.profile) {
		await writeAtomic(join(root, "identity", "profile.md"), bundle.identity.profile);
		profile = true;
	}
	let changes = 0;
	if (bundle.identity.changes.length) {
		const file = join(root, "identity", "changes.jsonl");
		const existing = (await readTextCapped(file, BOT_HOME_CHANGES_MAX_BYTES))?.split("\n").filter(Boolean) ?? [];
		const merged = [...existing, ...bundle.identity.changes].slice(-BOT_HOME_CHANGES_MAX_LINES);
		await mkdir(dirname(file), { recursive: true });
		await writeAtomic(file, `${merged.join("\n")}\n`);
		changes = bundle.identity.changes.length;
	}
	const memory = createBotMemory({ root: botMemoryRoot(dataDir, botId) });
	const imported = await memory.importEntries(bundle.memory);
	return { ...imported, profile, changes };
}
