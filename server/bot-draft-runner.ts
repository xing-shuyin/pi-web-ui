import { createQuickAskRuntime } from "./quick-ask.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelSessionId } from "./model-session.js";
import type { ThinkingLevel } from "./protocol.js";
import { BotDraftError, normalizeBotDraft, type BotDraft, type BotDraftInput } from "./device-center/bot-drafts.js";

/**
 * 「一句话建 Bot」的服务端执行者。
 *
 * 与 `agent_bot` 工具的区别：那个是对话里的模型自己起草（需要一条普通对话、且模型主动调用）；
 * 这里是**用户点一次按钮**触发的一次性请求——不占用会话、不受当前会话是不是私聊影响。
 * 两条路都只产草案（`BotDraft`），真正创建仍要人在界面上确认。
 */

const SYSTEM_PROMPT = [
	"You design one coding-assistant Bot from a single sentence the user wrote.",
	"Answer with a single JSON object and nothing else (no prose, no code fence).",
	"Fields:",
	"  name: short display name (<= 24 chars), in the user's language.",
	"  description: one sentence, what it does.",
	"  systemPrompt: the Bot's standing instructions, second person, concrete rules, <= 600 chars.",
	'  tools: array of tool names chosen from the allowed list. Include "memory" when the Bot should remember things across sessions (most assistants should).',
	"  skills: array of skill names (usually empty).",
	"  mcpServers: array (usually empty).",
	"  rationale: one short sentence addressed to the user explaining the design choices.",
	"Never invent tools outside the allowed list. Prefer the smallest tool set that does the job;",
	"omit high-privilege tools unless the request clearly needs them.",
].join("\n");

export interface BotDraftRunnerOptions {
	/** `<agentDir>` 下的 auth.json/models.json 用来解析模型。 */
	agentDir: string;
	/**
	 * 草案默认工作目录：模型不知道也不该猜设备上的绝对路径，由宿主给一个（通常是当前工作区）。
	 * 模型若返回了别的 cwd 也会被这里覆盖——路径必须由人/宿主决定。
	 */
	cwd: string;
	/** 允许草案使用的工具名（与 `agent_bot` 工具同一份白名单）。 */
	allowedTools: ReadonlySet<string>;
	/**
	 * 起草用的 `provider/modelId`（**每次起草现取**：设置里的「起草模型」随时会变）。
	 * 不设或取不到 → 回退到本机可用模型列表的首位。
	 */
	model?: string | (() => string | undefined);
	/** 起草用的思考强度（同样是现取）；`off`/未设 → 不传 reasoning。 */
	thinking?: ThinkingLevel | (() => ThinkingLevel | undefined);
	create(input: BotDraftInput, createdBy: "model" | "human"): Promise<BotDraft>;
}

function resolveOption<T>(value: T | (() => T) | undefined): T | undefined {
	return typeof value === "function" ? (value as () => T)() : value;
}

export const BOT_DRAFT_REQUEST_MAX = 2_000;
export const BOT_DRAFT_REQUEST_TIMEOUT_MS = 90_000;

/** 从模型输出里取 JSON：允许被 ```json 包住或前后带一句客套话。 */
export function parseBotDraftJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced ? fenced[1] : trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) throw new BotDraftError(502, "DRAFT_UNPARSEABLE", "Model returned no JSON object");
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		throw new BotDraftError(502, "DRAFT_UNPARSEABLE", "Model returned invalid JSON");
	}
}

export const DRAFT_MODEL_ATTEMPTS = 3;

/**
 * 候选模型：先用默认（用户选中的）模型，再按可用列表补位；去重、最多三个。
 *
 * 为什么要多个：`getAvailable()` 的首位只代表“已配置”，不代表“这个账号/套餐能跑它”——
 * 例如 OpenCode Go 会直接拒绝套餐不含的模型（400）。这种拒绝是账号级的，换下一个候选就能跑通。
 */
export function draftModelCandidates<T extends { provider: string; id: string }>(
	preferred: T | undefined,
	available: readonly T[],
): T[] {
	const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	const candidates: T[] = preferred ? [preferred] : [];
	for (const model of available) if (!candidates.some((kept) => key(kept) === key(model))) candidates.push(model);
	return candidates.slice(0, DRAFT_MODEL_ATTEMPTS);
}

export function createBotDraftRunner(options: BotDraftRunnerOptions) {
	return async function draftFromRequest(request: string, outerSignal?: AbortSignal, cwd?: string): Promise<BotDraft> {
		const sentence = request.trim();
		if (!sentence) throw new BotDraftError(400, "DRAFT_REQUEST_EMPTY", "Describe the Bot in one sentence first");
		if (sentence.length > BOT_DRAFT_REQUEST_MAX)
			throw new BotDraftError(400, "DRAFT_REQUEST_TOO_LONG", "Describe the Bot in 2000 characters or less");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), BOT_DRAFT_REQUEST_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		outerSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			const runtime = await createQuickAskRuntime(options.agentDir, controller.signal);
			const spec = resolveOption(options.model)?.trim() ?? "";
			const thinking = resolveOption(options.thinking);
			const slash = spec.indexOf("/");
			const preferred = slash > 0 ? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
			const available = await runtime.getAvailable(undefined, { signal: controller.signal });
			const models = draftModelCandidates(preferred, available);
			if (!models.length) throw new BotDraftError(409, "DRAFT_NO_MODEL", "No model is available for drafting a Bot");

			let failure: unknown;
			for (const [index, model] of models.entries()) {
				try {
					return await draftWith(runtime, model, sentence, controller.signal, thinking, cwd);
				} catch (error) {
					failure = error;
					// 只对「模型这一层挂了」换下一个候选：账号级拒绝（套餐不含该模型、Key 失效）换个模型往往直接能救回来；
					// 草案解析失败/请求被取消继续换模型只是白烧一次调用。
					const retryable = error instanceof BotDraftError && error.code === "DRAFT_FAILED";
					if (index === models.length - 1 || !retryable || controller.signal.aborted) throw error;
				}
			}
			throw failure;
		} catch (error) {
			if (controller.signal.aborted && !outerSignal?.aborted)
				throw new BotDraftError(504, "DRAFT_TIMEOUT", "Drafting took too long; try again or create the Bot manually");
			throw error;
		} finally {
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", onAbort);
		}
	};

	async function draftWith(
		runtime: ModelRuntime,
		model: Parameters<ModelRuntime["completeSimple"]>[0],
		sentence: string,
		signal: AbortSignal,
		thinking: ThinkingLevel | undefined,
		cwd?: string,
	): Promise<BotDraft> {
		const result = await runtime.completeSimple(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `${sentence}\n\nAllowed tools: ${[...options.allowedTools].join(", ")}`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				signal,
				maxTokens: 1200,
				...(thinking && thinking !== "off" ? { reasoning: thinking } : {}),
				sessionId: modelSessionId(sentence),
			},
		);
		signal.throwIfAborted();
		if (result.stopReason === "error" || result.stopReason === "aborted")
			throw new BotDraftError(502, "DRAFT_FAILED", result.errorMessage || "Model completion failed");
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const parsed = parseBotDraftJson(text) as Record<string, unknown>;
		// 模型不知道设备路径：cwd 永远由宿主盖章（本次请求的项目优先，其次宿主默认）。
		const input = normalizeBotDraft({ ...parsed, cwd: cwd?.trim() || options.cwd }, options.allowedTools, "model");
		return await options.create(input, "model");
	}
}
