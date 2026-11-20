import type { SamplingOverrides } from "./protocol.js";

const conversationSamplingOverrides = new Map<string, SamplingOverrides>();

export function setConversationSamplingOverrides(conversationId: string, overrides?: SamplingOverrides): void {
	if (!conversationId) return;
	if (!overrides) {
		conversationSamplingOverrides.delete(conversationId);
		return;
	}
	conversationSamplingOverrides.set(conversationId, { ...overrides });
}

export function getConversationSamplingOverrides(
	conversationId?: string,
	parentConversationId?: string,
): SamplingOverrides | undefined {
	return (
		(conversationId ? conversationSamplingOverrides.get(conversationId) : undefined) ??
		(parentConversationId ? conversationSamplingOverrides.get(parentConversationId) : undefined)
	);
}

type ProviderModelLike =
	| {
			id?: string;
			api?: string;
			samplingParams?: Record<string, unknown>;
	  }
	| undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeModelSamplingParamsIntoProviderPayload(
	payload: unknown,
	model: ProviderModelLike,
	overrides?: SamplingOverrides,
): unknown {
	if (!isRecord(payload)) return payload;

	const modelParams = model?.samplingParams;
	const overrideParams: Record<string, unknown> = {};

	// Keep the boolean check explicit: false is a real setting, not an absent value.
	// Gemma's llama.cpp chat template expects all three controls inside
	// chat_template_kwargs, including reasoning_effort while thinking is disabled.
	const isGemma4Model = /(?:^|[-_/])gemma[-_]?4(?:[-_/]|$)/i.test(model?.id ?? "");
	const hasModelChatTemplate = isRecord(modelParams) && isRecord(modelParams.chat_template_kwargs);
	const usesChatTemplateThinking =
		model?.api === "openai-completions" &&
		(overrides?.profile === "gemma4" || isGemma4Model || hasModelChatTemplate) &&
		typeof overrides?.thinkingEnabled === "boolean";
	if (usesChatTemplateThinking) {
		overrideParams.chat_template_kwargs = {
			enable_thinking: overrides.thinkingEnabled,
			reasoning_effort: overrides.thinkingEffort ?? "medium",
			preserve_thinking: overrides.preserveThinking ?? true,
		};
	}

	if ((!isRecord(modelParams) || Object.keys(modelParams).length === 0) && Object.keys(overrideParams).length === 0) {
		return payload;
	}

	const merged: Record<string, unknown> = {
		...(isRecord(modelParams) ? modelParams : {}),
		...payload,
		...overrideParams,
	};
	const modelChatTemplateKwargs =
		isRecord(modelParams) && isRecord(modelParams.chat_template_kwargs) ? modelParams.chat_template_kwargs : {};
	const requestChatTemplateKwargs = payload.chat_template_kwargs;
	const overrideChatTemplateKwargs = overrideParams.chat_template_kwargs;

	if (
		Object.keys(modelChatTemplateKwargs).length > 0 ||
		isRecord(requestChatTemplateKwargs) ||
		isRecord(overrideChatTemplateKwargs)
	) {
		merged.chat_template_kwargs = {
			...modelChatTemplateKwargs,
			...(isRecord(requestChatTemplateKwargs) ? requestChatTemplateKwargs : {}),
			...(isRecord(overrideChatTemplateKwargs) ? overrideChatTemplateKwargs : {}),
		};
	}

	// Do not leak the native top-level reasoning_effort alongside the explicit
	// chat-template contract. The requested value belongs only in the nested object.
	if (usesChatTemplateThinking) delete merged.reasoning_effort;

	return merged;
}
