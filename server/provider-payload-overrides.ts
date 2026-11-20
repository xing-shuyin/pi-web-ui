import type { SamplingOverrides } from "./protocol.js";

const conversationSamplingOverrides = new Map<string, SamplingOverrides>();

export function setConversationSamplingOverrides(conversationId: string, overrides?: SamplingOverrides): void {
	if (!conversationId) return;
	if (!overrides) { conversationSamplingOverrides.delete(conversationId); return; }
	conversationSamplingOverrides.set(conversationId, { ...overrides });
}

export function getConversationSamplingOverrides(conversationId?: string): SamplingOverrides | undefined {
	return conversationId ? conversationSamplingOverrides.get(conversationId) : undefined;
}

type ProviderModelLike = {
	api?: string;
	samplingParams?: Record<string, unknown>;
} | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeModelSamplingParamsIntoProviderPayload(
	payload: unknown,
	model: ProviderModelLike,
	overrides?: SamplingOverrides,
): unknown {
	if (model?.api !== "openai-completions" || !isRecord(payload) || !Array.isArray(payload.messages)) {
		return payload;
	}

	const modelParams = model.samplingParams;
	const overrideParams: Record<string, unknown> = {};
	if (typeof overrides?.temperature === "number") overrideParams.temperature = overrides.temperature;
	if (typeof overrides?.min_p === "number") overrideParams.min_p = overrides.min_p;
	if (typeof overrides?.top_p === "number") overrideParams.top_p = overrides.top_p;
	if (typeof overrides?.top_k === "number") overrideParams.top_k = overrides.top_k;
	if (overrides?.thinkingEnabled !== undefined) {
		overrideParams.chat_template_kwargs = {
			enable_thinking: overrides.thinkingEnabled,
			...(overrides.thinkingEnabled && overrides.thinkingEffort ? { reasoning_effort: overrides.thinkingEffort } : {}),
			preserve_thinking: overrides.preserveThinking ?? true,
		};
	}
	if ((!isRecord(modelParams) || Object.keys(modelParams).length === 0) && Object.keys(overrideParams).length === 0) return payload;

	const merged: Record<string, unknown> = { ...(isRecord(modelParams) ? modelParams : {}), ...overrideParams, ...payload };
	const modelChatTemplateKwargs = { ...(isRecord(modelParams) && isRecord(modelParams.chat_template_kwargs) ? modelParams.chat_template_kwargs : {}), ...(isRecord(overrideParams.chat_template_kwargs) ? overrideParams.chat_template_kwargs : {}) };
	const requestChatTemplateKwargs = payload.chat_template_kwargs;

	if (isRecord(modelChatTemplateKwargs) || isRecord(requestChatTemplateKwargs)) {
		merged.chat_template_kwargs = {
			...(isRecord(modelChatTemplateKwargs) ? modelChatTemplateKwargs : {}),
			...(isRecord(requestChatTemplateKwargs) ? requestChatTemplateKwargs : {}),
		};
	}

	return merged;
}
