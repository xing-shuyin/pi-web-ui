import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../atomic-file.js";
import { isBotToolHighPrivilege } from "./bot-execution.js";

/**
 * 「一句话创建」的草案层：AI 只写草案，人按一次确认才落成 Bot。
 *
 * 约束（服务端强制，不靠提示词）：
 *   - 草案里出现高权限工具时，必须由人在确认时逐项授权（`approvedTools`），AI 无法自授权；
 *   - 草案只是数据，不触发任何执行；过期自动作废（默认 7 天）；
 *   - 待确认数量有上限，避免模型刷屏式建 Bot。
 */

export const BOT_DRAFT_MAX_PENDING = 12;
export const BOT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BOT_DRAFT_NAME_MAX = 60;
export const BOT_DRAFT_DESCRIPTION_MAX = 200;
export const BOT_DRAFT_PROMPT_MAX = 8 * 1024;
export const BOT_DRAFT_MAX_TOOLS = 64;

export type BotTrigger = "on_demand" | "always_on" | "scheduled";

export interface BotDraftInput {
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools?: string[];
	skills?: string[];
	mcpServers?: string[];
	trigger?: BotTrigger;
	/** AI 自述"为什么这样配"，给确认卡展示。 */
	rationale?: string;
	/** 创建后是否立刻跑首轮自举（自我介绍 + 记忆骨架自检）。 */
	bootstrap?: boolean;
}

export interface BotDraft {
	id: string;
	createdAt: number;
	updatedAt: number;
	status: "pending" | "approved" | "discarded" | "created";
	createdBy: "model" | "human";
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills: string[];
	mcpServers: string[];
	trigger: BotTrigger;
	rationale?: string;
	bootstrap: boolean;
	/** 高权限工具清单：确认时必须逐项出现在 approvedTools 里。 */
	highPrivilegeTools: string[];
	approvedTools?: string[];
	botId?: string;
}

export class BotDraftError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "BotDraftError";
	}
}

function text(value: unknown, max: number, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new BotDraftError(400, "DRAFT_INVALID", `Invalid ${field}`);
	return value.trim();
}

function stringList(value: unknown, field: string, allowed?: ReadonlySet<string>): string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length > BOT_DRAFT_MAX_TOOLS ||
		value.some((item) => typeof item !== "string" || !item || item.length > 128) ||
		new Set(value).size !== value.length
	)
		throw new BotDraftError(400, "DRAFT_INVALID", `Invalid ${field}`);
	if (allowed) {
		const unknown = (value as string[]).filter((item) => !allowed.has(item));
		if (unknown.length)
			throw new BotDraftError(400, "DRAFT_UNKNOWN_TOOL", `Unknown tools: ${unknown.slice(0, 8).join(", ")}`);
	}
	return [...(value as string[])];
}

export function normalizeBotDraft(
	input: unknown,
	allowedTools: ReadonlySet<string>,
	createdBy: "model" | "human",
): BotDraftInput {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new BotDraftError(400, "DRAFT_INVALID", "Draft must be an object");
	const raw = input as Record<string, unknown>;
	const name = text(raw.name, BOT_DRAFT_NAME_MAX, "name");
	const description = text(raw.description, BOT_DRAFT_DESCRIPTION_MAX, "description");
	const systemPrompt = text(raw.systemPrompt, BOT_DRAFT_PROMPT_MAX, "systemPrompt");
	const cwd = text(raw.cwd, 4096, "cwd");
	if (cwd.includes("\0")) throw new BotDraftError(400, "DRAFT_INVALID", "Invalid cwd");
	const model =
		raw.model === undefined
			? undefined
			: (() => {
					const value = raw.model as Record<string, unknown> | null;
					if (
						!value ||
						typeof value !== "object" ||
						typeof value.provider !== "string" ||
						!value.provider ||
						typeof value.modelId !== "string" ||
						!value.modelId
					)
						throw new BotDraftError(400, "DRAFT_INVALID", "Invalid model");
					return { provider: value.provider, modelId: value.modelId };
				})();
	// trigger 只作身份留痕（兼容存量草稿 / 人工 API），不是自动调度开关：
	// 常驻/定时由宿主 alwaysOn 插件与 schedule 工具承接，Bot registry 不按它起任务。
	const trigger = raw.trigger === undefined ? "on_demand" : raw.trigger;
	if (trigger !== "on_demand" && trigger !== "always_on" && trigger !== "scheduled")
		throw new BotDraftError(400, "DRAFT_INVALID", "Invalid trigger");
	if (createdBy === "model" && trigger === "always_on")
		throw new BotDraftError(400, "DRAFT_TRIGGER_DENIED", "Only a human can make a Bot always on");
	return {
		name,
		description,
		systemPrompt,
		cwd,
		...(model ? { model } : {}),
		tools: stringList(raw.tools, "tools", allowedTools),
		skills: stringList(raw.skills, "skills"),
		mcpServers: stringList(raw.mcpServers, "mcpServers"),
		trigger,
		...(typeof raw.rationale === "string" && raw.rationale.trim()
			? { rationale: raw.rationale.trim().slice(0, 500) }
			: {}),
		bootstrap: raw.bootstrap === true,
	};
}

export function createBotDraftStore(dataDir: string, now: () => number = () => Date.now()) {
	const file = join(dataDir, "bot-drafts.json");
	let serial: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const run = serial.then(work, work);
		serial = run.catch(() => {});
		return run;
	};

	async function load(): Promise<BotDraft[]> {
		try {
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((entry): entry is BotDraft => Boolean(entry) && typeof (entry as BotDraft).id === "string");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async function save(drafts: BotDraft[]): Promise<void> {
		await mkdir(dataDir, { recursive: true });
		// 只保留最近 50 条，避免草案文件无限增长（pending 另有上限）。
		const kept = drafts.slice(-50);
		await writeAtomic(file, JSON.stringify(kept));
	}

	function live(draft: BotDraft): boolean {
		return draft.status === "pending" && now() - draft.createdAt < BOT_DRAFT_TTL_MS;
	}

	return {
		async create(input: BotDraftInput, createdBy: "model" | "human" = "model"): Promise<BotDraft> {
			return enqueue(async () => {
				const drafts = await load();
				const pending = drafts.filter(live);
				if (pending.length >= BOT_DRAFT_MAX_PENDING)
					throw new BotDraftError(429, "DRAFT_LIMIT", "Too many pending Bot drafts; confirm or discard one first");
				const highPrivilegeTools = (input.tools ?? []).filter((tool) => isBotToolHighPrivilege(tool));
				const draft: BotDraft = {
					id: randomUUID(),
					createdAt: now(),
					updatedAt: now(),
					status: "pending",
					createdBy,
					name: input.name,
					description: input.description,
					systemPrompt: input.systemPrompt,
					cwd: input.cwd,
					...(input.model ? { model: input.model } : {}),
					tools: input.tools ?? [],
					skills: input.skills ?? [],
					mcpServers: input.mcpServers ?? [],
					trigger: input.trigger ?? "on_demand",
					...(input.rationale ? { rationale: input.rationale } : {}),
					bootstrap: input.bootstrap === true,
					highPrivilegeTools,
				};
				drafts.push(draft);
				await save(drafts);
				return draft;
			});
		},
		async list(): Promise<BotDraft[]> {
			const drafts = await load();
			return drafts.filter(live).map((draft) => ({ ...draft }));
		},
		async get(id: string): Promise<BotDraft | undefined> {
			const draft = (await load()).find((entry) => entry.id === id && live(entry));
			return draft ? { ...draft } : undefined;
		},
		async discard(id: string): Promise<void> {
			await enqueue(async () => {
				const drafts = await load();
				const draft = drafts.find((entry) => entry.id === id && live(entry));
				if (!draft) throw new BotDraftError(404, "DRAFT_MISSING", "Bot draft not found or expired");
				draft.status = "discarded";
				draft.updatedAt = now();
				await save(drafts);
			});
		},
		/**
		 * 人的确认（第一阶段）：只校验、不落状态。
		 *
		 * 必须先校验后创建：旧实现先把状态写成 `approved` 再 upsert，一旦 upsert 失败
		 * （工作目录不存在 / Bot 正忙），`live()` 只认 `pending`，草案就从列表里消失了——
		 * 既不能重试也不能取消，用户只能重新写一句话起草。
		 * 现在由调用方在 Bot 真正创建成功后调 `markCreated` 收尾。
		 */
		async assertApprovable(id: string, approvedTools: string[]): Promise<BotDraft> {
			return enqueue(async () => {
				const drafts = await load();
				const draft = drafts.find((entry) => entry.id === id && live(entry));
				if (!draft) throw new BotDraftError(404, "DRAFT_MISSING", "Bot draft not found or expired");
				const approved = new Set(approvedTools);
				const missing = draft.highPrivilegeTools.filter((tool) => !approved.has(tool));
				if (missing.length)
					throw new BotDraftError(
						409,
						"DRAFT_NEEDS_APPROVAL",
						`High-privilege tools require explicit approval: ${missing.join(", ")}`,
					);
				// 只记录“人批准了哪些工具”，**不改 status**：upsert 失败时草案仍在 pending，
				// 重试能直接带上同一份授权，不用重新勾。
				draft.approvedTools = [...approved];
				draft.updatedAt = now();
				await save(drafts);
				return { ...draft };
			});
		},
		/** 第二阶段：Bot 已经落库，草案才算完成（带上一并授权的高权限工具，便于审计）。 */
		async markCreated(id: string, botId: string, approvedTools?: string[]): Promise<void> {
			await enqueue(async () => {
				const drafts = await load();
				const draft = drafts.find((entry) => entry.id === id);
				if (!draft) return;
				draft.botId = botId;
				if (approvedTools) draft.approvedTools = [...approvedTools];
				draft.status = "created";
				draft.updatedAt = now();
				await save(drafts);
			});
		},
	};
}

export type BotDraftStore = ReturnType<typeof createBotDraftStore>;
