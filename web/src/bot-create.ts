import { appSend } from "./app-globals";
import { DEVICE_GROUPS_CHANGED, DeviceGroupRequestError, deviceGroupRequest } from "./components/DeviceGroupSection";
import { requestNewChat } from "./new-chat-request";
import type { ClientMessage } from "./types";

/**
 * 「新建智能体」的两个入口（单源）。
 *
 * - AI 创建（默认推荐）：把一句话交给服务端的 `bot-draft-runner` 跑一次模型调用，
 *   产出**草案**（`BotDraft`）；草案出现在左栏「待确认的新智能体」里，人按下「创建」才真的建。
 *   这条路不占用任何会话，所以在私聊里点加号也不会被 `agent_bot` 工具禁用影响。
 * - 手动创建：**就地弹「新建智能体」表单**（`BotCreateDialog` 复用设备中心同一个编辑器），
 *   不切视图——加号本来就在左栏，为了填个表单跳去设备中心再跳回来是白绕一圈。
 */

export interface BotDraftResult {
	id: string;
	name: string;
	description?: string;
	rationale?: string;
}

export const BOT_DRAFT_REQUEST_MAX = 2000;

const FALLBACK_BOT_DRAFT_PROMPT = [
	"请根据以下需求为我设计并起草一个智能体（Bot）：",
	"{{request}}",
	"",
	'调用 agent_bot 工具（op="draft"）生成智能体草案',
].join("\n");

/**
 * 组装发送给正式对话的「起草智能体」指令：
 * 优先使用用户在设置中自定义的提示词模板，空则回退到默认模板；
 * 支持 `{{request}}` / `{{input}}` 占位符，若模板中未写占位符则自动附加在末尾。
 */
export function buildBotDraftPrompt(template: string, defaultTemplate: string, request: string): string {
	const cleanRequest = request.trim();
	const base = template.trim() || defaultTemplate.trim() || FALLBACK_BOT_DRAFT_PROMPT;
	if (base.includes("{{request}}") || base.includes("{{input}}")) {
		return base.replaceAll("{{request}}", cleanRequest).replaceAll("{{input}}", cleanRequest);
	}
	return cleanRequest ? `${base}\n\n${cleanRequest}` : base;
}

/**
 * 在正式普通对话中发起智能体起草：
 * 新建一个普通对话（复用当前工作区与默认模型/全部工具），并发送起草指令。
 */
export async function startBotDraftChat(
	request: string,
	opts?: {
		promptTemplate?: string;
		defaultTemplate?: string;
		cwd?: string | null;
		send?: (message: ClientMessage) => boolean;
	},
): Promise<string> {
	const sentence = request.trim();
	if (!sentence) {
		throw new DeviceGroupRequestError(400, "DRAFT_REQUEST_EMPTY", "Describe the Bot in one sentence first");
	}
	if (sentence.length > BOT_DRAFT_REQUEST_MAX) {
		throw new DeviceGroupRequestError(400, "DRAFT_REQUEST_TOO_LONG", "Describe the Bot in 2000 characters or less");
	}
	const send = opts?.send ?? appSend;
	const conversationId = await requestNewChat(send, 8000, opts?.cwd ?? undefined);
	if (!conversationId) {
		throw new DeviceGroupRequestError(502, "DRAFT_FAILED", "Failed to start a new conversation");
	}
	const text = buildBotDraftPrompt(opts?.promptTemplate ?? "", opts?.defaultTemplate ?? "", sentence);
	if (!send({ type: "prompt", text, targetConversationId: conversationId })) {
		throw new DeviceGroupRequestError(502, "DRAFT_FAILED", "Failed to send prompt");
	}
	return conversationId;
}

/** 一句话 → 草案。只产草案，不创建。 */
export async function createBotDraft(
	request: string,
	signal?: AbortSignal,
	cwd?: string | null,
): Promise<BotDraftResult> {
	const data = await deviceGroupRequest<{ draft?: BotDraftResult }>(
		"bot-drafts",
		signal ?? new AbortController().signal,
		{ request, ...(cwd ? { cwd } : {}) },
	);
	const draft = data?.draft;
	if (!draft?.id) throw new Error("Bot draft response is missing draft.id");
	// 左栏（及其它读 bot-panel 的地方）据此重新拉一次草案列表。
	window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
	return draft;
}

const EVENT = "pi-web-ui:bot-create";

/** 起草失败的几类可操作原因；`failed` 是兜底（带服务端 `detail`）。 */
export type BotDraftFailure = "no-model" | "unparsable" | "timeout" | "request" | "workspace" | "failed";

export function botDraftFailureKind(error: unknown): BotDraftFailure {
	if (!(error instanceof DeviceGroupRequestError)) return "failed";
	switch (error.code) {
		case "DRAFT_NO_MODEL":
			return "no-model";
		case "DRAFT_UNPARSEABLE":
			return "unparsable";
		case "DRAFT_TIMEOUT":
			return "timeout";
		case "DRAFT_REQUEST_EMPTY":
		case "DRAFT_REQUEST_TOO_LONG":
			return "request";
		case "WORKSPACE_INVALID":
		case "BOT_CWD_INVALID":
			return "workspace";
		default:
			return "failed";
	}
}

/**
 * 起草案的错误文案。
 *
 * 以前直接显示 `error.message`，而它是“Device group request failed (502)”——用户只知道服务器吐了 502，
 * 根本看不出真正原因（模型/Key/套餐）。真实原因在 `detail` 里（只对 `bot-drafts` 路径下发）。
 * 模板里的 `{detail}` 占位符没内容时连同前面的分隔符一起去掉。
 */
export function botDraftFailureText(error: unknown, words: Record<BotDraftFailure, string>): string {
	const kind = botDraftFailureKind(error);
	const detail = error instanceof DeviceGroupRequestError ? error.detail : "";
	// “模型不可用/请求不合法/工作区不合法”自带完整含义，再拼上游文本反而吵。
	const template = words[kind];
	const [head, tail] = template.split("{detail}");
	const status = error instanceof DeviceGroupRequestError ? error.status : 0;
	if (!detail || kind === "no-model" || kind === "request" || kind === "workspace") {
		const plain = head.replace(/[\s:：,，-]+$/, "");
		// 没有可展示的原因但拿到了 HTTP 状态：至少让人知道是服务端拒绝还是网关挂了。
		return status && kind === "failed" ? `${plain}（HTTP ${status}）` : plain;
	}
	return tail === undefined ? head : `${head}${detail}${tail}`;
}

/** 手动创建：让挂着的 `BotCreateDialog` 打开空白表单（本视图内弹窗，不切设备中心）。 */
export function requestBotCreate(): void {
	window.dispatchEvent(new Event(EVENT));
}

export function subscribeBotCreateRequest(handler: () => void): () => void {
	window.addEventListener(EVENT, handler);
	return () => window.removeEventListener(EVENT, handler);
}

const AI_DRAFT_EVENT = "pi-web-ui:bot-ai-draft";

/** 触发「在主对话输入框中用 AI 创建智能体」模式（在输入框上方挂载引用标识并聚焦）。 */
export function requestBotAiDraftMode(): void {
	window.dispatchEvent(new CustomEvent(AI_DRAFT_EVENT));
}

export function subscribeBotAiDraftMode(handler: () => void): () => void {
	const listener = () => handler();
	window.addEventListener(AI_DRAFT_EVENT, listener);
	return () => window.removeEventListener(AI_DRAFT_EVENT, listener);
}
