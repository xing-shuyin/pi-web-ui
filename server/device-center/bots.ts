import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceWorkspaceError, validateDeviceProject } from "./workspaces.js";
import { isBotToolHighPrivilege } from "./bot-execution.js";

export interface LocalBot {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills: string[];
	mcpServers: string[];
	enabled: boolean;
	revision: number;
	/**
	 * 身份元数据（存量数据 / 迁移包兼容）：Bot registry 不按它自动调度。
	 * 常驻由宿主 `plugins.alwaysOn` 承接，定时由 `schedule` 工具承接；这里只留痕，
	 * 不要在 UI 或工具里把它当成已接线的能力。见 docs/agent-bot-design.md §8.2。
	 */
	trigger?: "on_demand" | "always_on" | "scheduled";
	/** 身份来源与修订：谁写的 systemPrompt、被改写几次。 */
	identity?: { authoredBy: "human" | "model"; authoredAt: number; modelRevision: number };
}
export type LocalBotInput = Omit<LocalBot, "id" | "revision"> & {
	id?: string;
	revision?: number;
	/**
	 * 仅用于写入校验、不进注册表：模型起草的 Bot 若带高权限工具，必须在人工确认时逐项列进这里。
	 * （人通过设备中心编辑时 authoredBy 会被盖成 human，不受此限。）
	 */
	approvedTools?: string[];
};
export interface LocalBotLease {
	bot: LocalBot;
	root: string;
	revision: string;
	release(): void;
}
export interface LocalBotRegistry {
	setScope(scope: string): Promise<void>;
	list(): LocalBot[];
	get(id: string): LocalBot | undefined;
	upsert(input: LocalBotInput): Promise<LocalBot>;
	remove(id: string, revision: number): Promise<void>;
	/** 是否有执行租约（群/设备任务在跑）。私聊发消息前用它做一次可读的忙检查。 */
	busy(id: string): boolean;
	acquire(id: string): Promise<LocalBotLease>;
}
function fail(status: number, code: string, message: string): never {
	throw new DeviceWorkspaceError(status, code, message);
}
function validate(input: LocalBot): LocalBot {
	if (
		!input ||
		typeof input.id !== "string" ||
		!input.id ||
		input.id.length > 256 ||
		typeof input.name !== "string" ||
		!input.name.trim() ||
		input.name.length > 200 ||
		typeof input.description !== "string" ||
		input.description.length > 4000 ||
		typeof input.systemPrompt !== "string" ||
		input.systemPrompt.length > 32000 ||
		typeof input.cwd !== "string" ||
		typeof input.enabled !== "boolean" ||
		!Number.isSafeInteger(input.revision) ||
		input.revision < 1 ||
		(input.model !== undefined &&
			(!input.model ||
				typeof input.model.provider !== "string" ||
				!input.model.provider ||
				typeof input.model.modelId !== "string" ||
				!input.model.modelId))
	)
		fail(400, "BOT_INVALID", "Invalid Bot identity or model");
	for (const key of ["tools", "skills", "mcpServers"] as const) {
		if (
			!Array.isArray(input[key]) ||
			input[key].length > 512 ||
			input[key].some((v) => typeof v !== "string" || !v || v.length > 1024) ||
			new Set(input[key]).size !== input[key].length
		)
			fail(400, "BOT_INVALID", `Invalid Bot ${key}`);
	}
	if (input.trigger !== undefined && !["on_demand", "always_on", "scheduled"].includes(input.trigger))
		fail(400, "BOT_INVALID", "Invalid Bot trigger");
	if (
		input.identity !== undefined &&
		(!input.identity ||
			(input.identity.authoredBy !== "human" && input.identity.authoredBy !== "model") ||
			!Number.isSafeInteger(input.identity.authoredAt) ||
			!Number.isSafeInteger(input.identity.modelRevision) ||
			input.identity.modelRevision < 0)
	)
		fail(400, "BOT_INVALID", "Invalid Bot identity block");
	return {
		id: input.id,
		name: input.name.trim(),
		description: input.description,
		systemPrompt: input.systemPrompt,
		cwd: input.cwd,
		...(input.model ? { model: { provider: input.model.provider, modelId: input.model.modelId } } : {}),
		tools: [...input.tools],
		skills: [...input.skills],
		mcpServers: [...input.mcpServers],
		enabled: input.enabled,
		revision: input.revision,
		...(input.trigger ? { trigger: input.trigger } : {}),
		...(input.identity
			? {
					identity: {
						authoredBy: input.identity.authoredBy,
						authoredAt: input.identity.authoredAt,
						modelRevision: input.identity.modelRevision,
					},
				}
			: {}),
	};
}

/**
 * 本机 Bot 身份的作用域。
 *
 * Bot 属于**这台机器**，不属于某次 Hub 配对；旧版本按 `[hubUrl, deviceId]` 分文件，
 * 换配对/断连一次就“Bot 全不见了”。现在固定一个机器级 scope（见 `adoptLegacyScope`）。
 */
export const LOCAL_BOT_SCOPE = "local";

/** 候选文件必须是完整合法的 registry（解析 + 每个条目过校验），否则不配当唯一单源。 */
function parseRegistry(content: string): boolean {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!Array.isArray(parsed)) return false;
		for (const entry of parsed) validate(entry as LocalBot);
		return true;
	} catch {
		return false;
	}
}

/**
 * 一次性迁移：首次运行（本机 scope 文件还不存在）时，按修改时间从新到旧找一个**合法**的旧
 * scope 文件搬过来。坏文件 / 异构文件一律跳过——迁移只是便利，绝不能把启动搞挂
 * （旧文件全部保留，可人工回滚；迁移幂等）。
 */
async function adoptLegacyScope(directory: string, target: string): Promise<void> {
	try {
		await stat(target);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
	const candidates: { path: string; mtime: number }[] = [];
	try {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const path = join(directory, entry.name);
			if (path === target) continue;
			const info = await stat(path).catch(() => undefined);
			if (info) candidates.push({ path, mtime: info.mtimeMs });
		}
	} catch {
		return;
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	for (const candidate of candidates) {
		const content = await readFile(candidate.path, "utf8").catch(() => undefined);
		if (!content || !parseRegistry(content)) continue;
		await writeFile(target, content, { mode: 0o600, flag: "wx" }).catch(() => undefined);
		return;
	}
}

export async function createLocalBotRegistry(dataDir: string): Promise<LocalBotRegistry> {
	await mkdir(dataDir, { recursive: true });
	const directory = join(dataDir, "device-bots");
	await mkdir(directory, { recursive: true });
	const scopeFile = (scope: string) => join(directory, `${createHash("sha256").update(scope).digest("hex")}.json`);
	const localFile = scopeFile(LOCAL_BOT_SCOPE);
	await adoptLegacyScope(directory, localFile);
	let file = localFile;
	let bots = new Map<string, LocalBot>();
	const leases = new Map<string, number>();
	let serial: Promise<unknown> = Promise.resolve();
	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = serial.then(operation);
		serial = result.catch(() => {});
		return result;
	}
	async function load(path: string): Promise<Map<string, LocalBot>> {
		const loaded = new Map<string, LocalBot>();
		try {
			const saved: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!Array.isArray(saved)) throw new Error("Invalid Bot registry");
			for (const entry of saved) {
				const bot = validate(entry);
				if (loaded.has(bot.id)) throw new Error("Duplicate Bot ID");
				loaded.set(bot.id, bot);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return loaded;
	}
	bots = await load(file);
	async function commit(next: Map<string, LocalBot>) {
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify([...next.values()]), { mode: 0o600, flag: "wx" });
			await rename(temporary, file);
		} catch {
			fail(500, "BOT_SAVE_FAILED", "Could not save Bot registry");
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
		bots = next;
	}
	function mutable(id: string, revision: number | undefined) {
		const current = bots.get(id);
		if (!current) fail(404, "BOT_NOT_FOUND", "Bot not found");
		if (current.revision !== revision) fail(409, "BOT_REVISION_CONFLICT", "Bot configuration changed");
		if (leases.get(id)) fail(409, "BOT_BUSY", "Bot is busy; wait for all execution and file operations to stop");
		return current;
	}
	return {
		setScope: (scope) =>
			enqueue(async () => {
				if (typeof scope !== "string" || !scope || scope.length > 4096)
					fail(400, "BOT_SCOPE_INVALID", "Invalid Bot scope");
				const nextFile = scopeFile(scope);
				if (nextFile === file) return;
				if (leases.size) fail(409, "BOT_BUSY", "Bot scope is busy");
				const next = await load(nextFile);
				file = nextFile;
				bots = next;
			}),
		list: () => structuredClone([...bots.values()]),
		get: (id) => {
			const bot = bots.get(id);
			return bot && structuredClone(bot);
		},
		upsert: (input) =>
			enqueue(async () => {
				if (!input || typeof input !== "object") fail(400, "BOT_INVALID", "Invalid Bot");
				// 模型只能起草、不能授权：模型 authorship 的 Bot 携带高权限工具时，
				// 必须由确认卡把每一项列进 approvedTools，否则这里再拒一次（前端漏判也拦得住）。
				if (input.identity?.authoredBy === "model") {
					const approved = new Set(input.approvedTools ?? []);
					const unapproved = (input.tools ?? []).filter((tool) => isBotToolHighPrivilege(tool) && !approved.has(tool));
					if (unapproved.length)
						fail(
							400,
							"BOT_NEEDS_APPROVAL",
							`High-privilege tools require explicit human approval: ${unapproved.join(", ")}`,
						);
				}
				const current = input.id ? mutable(input.id, input.revision) : undefined;
				const bot = validate({ ...input, id: current?.id ?? randomUUID(), revision: (current?.revision ?? 0) + 1 });
				bot.cwd = await validateDeviceProject(bot.cwd, dataDir);
				const next = new Map(bots);
				next.set(bot.id, bot);
				await commit(next);
				return structuredClone(bot);
			}),
		remove: (id, revision) =>
			enqueue(async () => {
				mutable(id, revision);
				const next = new Map(bots);
				next.delete(id);
				await commit(next);
			}),
		busy: (id) => leases.has(id),
		acquire: (id) =>
			enqueue(async () => {
				const bot = bots.get(id);
				if (!bot || !bot.enabled) fail(409, "BOT_UNAVAILABLE", "Bot is missing or disabled");
				const root = await validateDeviceProject(bot.cwd, dataDir);
				leases.set(id, (leases.get(id) ?? 0) + 1);
				let released = false;
				return {
					bot: structuredClone(bot),
					root,
					revision: `${id}:${bot.revision}`,
					release() {
						if (released) return;
						released = true;
						const count = (leases.get(id) ?? 1) - 1;
						if (count) leases.set(id, count);
						else leases.delete(id);
					},
				};
			}),
	};
}
