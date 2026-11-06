import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceWorkspaceError, validateDeviceProject } from "./workspaces.js";

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
}
export type LocalBotInput = Omit<LocalBot, "id" | "revision"> & { id?: string; revision?: number };
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
	};
}

export async function createLocalBotRegistry(dataDir: string): Promise<LocalBotRegistry> {
	await mkdir(dataDir, { recursive: true });
	const directory = join(dataDir, "device-bots");
	await mkdir(directory, { recursive: true });
	const scopeFile = (scope: string) => join(directory, `${createHash("sha256").update(scope).digest("hex")}.json`);
	let file = scopeFile("unpaired");
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
