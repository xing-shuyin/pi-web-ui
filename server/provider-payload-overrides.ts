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
): unknown {
	if (model?.api !== "openai-completions" || !isRecord(payload) || !Array.isArray(payload.messages)) {
		return payload;
	}

	const modelParams = model.samplingParams;
	if (!isRecord(modelParams) || Object.keys(modelParams).length === 0) return payload;

	const merged: Record<string, unknown> = { ...modelParams, ...payload };
	const modelChatTemplateKwargs = modelParams.chat_template_kwargs;
	const requestChatTemplateKwargs = payload.chat_template_kwargs;

	if (isRecord(modelChatTemplateKwargs) || isRecord(requestChatTemplateKwargs)) {
		merged.chat_template_kwargs = {
			...(isRecord(modelChatTemplateKwargs) ? modelChatTemplateKwargs : {}),
			...(isRecord(requestChatTemplateKwargs) ? requestChatTemplateKwargs : {}),
		};
	}

	return merged;
}
