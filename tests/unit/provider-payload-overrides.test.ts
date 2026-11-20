import { describe, expect, it } from "vitest";
import { mergeModelSamplingParamsIntoProviderPayload } from "../../server/provider-payload-overrides.js";

describe("provider payload sampling overrides", () => {
	it("adds nested model sampling parameters to OpenAI-compatible chat requests", () => {
		const payload = {
			model: "gemma-4",
			messages: [{ role: "user", content: "Hello" }],
			temperature: 0.8,
			top_k: 64,
			top_p: 0.95,
		};

		const result = mergeModelSamplingParamsIntoProviderPayload(payload, {
			api: "openai-completions",
			samplingParams: {
				chat_template_kwargs: {
					enable_thinking: true,
					reasoning_effort: "medium",
					preserve_thinking: true,
				},
			},
		});

		expect(result).toEqual({
			...payload,
			chat_template_kwargs: {
				enable_thinking: true,
				reasoning_effort: "medium",
				preserve_thinking: true,
			},
		});
	});

	it("preserves request-level values and merges nested kwargs per key", () => {
		const payload = {
			messages: [],
			temperature: 0.8,
			chat_template_kwargs: {
				enable_thinking: false,
				custom_flag: "request",
			},
		};

		const result = mergeModelSamplingParamsIntoProviderPayload(payload, {
			api: "openai-completions",
			samplingParams: {
				temperature: 0.3,
				top_k: 64,
				chat_template_kwargs: {
					enable_thinking: true,
					reasoning_effort: "medium",
					preserve_thinking: true,
				},
			},
		});

		expect(result).toEqual({
			messages: [],
			temperature: 0.8,
			top_k: 64,
			chat_template_kwargs: {
				enable_thinking: false,
				reasoning_effort: "medium",
				preserve_thinking: true,
				custom_flag: "request",
			},
		});
	});

	it("applies conversation sampling values over model and request defaults", () => {
		const payload = { messages: [], temperature: 0.8, top_p: 0.9 };
		const result = mergeModelSamplingParamsIntoProviderPayload(payload, {
			api: "openai-completions",
			samplingParams: { top_k: 32 },
		}, {
			temperature: 0.4,
			min_p: 0.05,
			top_p: 0.95,
			top_k: 48,
			profile: "gemma4",
			thinkingEnabled: true,
			thinkingEffort: "high",
			preserveThinking: true,
		});
		expect(result).toEqual({
			messages: [],
			temperature: 0.4,
			top_p: 0.95,
			top_k: 48,
			min_p: 0.05,
			chat_template_kwargs: {
				enable_thinking: true,
				reasoning_effort: "high",
				preserve_thinking: true,
			},
		});
	});

	it("applies standard sampling overrides to non-OpenAI payloads without chat-template fields", () => {
		const payload = { input: "Hello" };
		const result = mergeModelSamplingParamsIntoProviderPayload(payload, { api: "anthropic-messages" }, {
			temperature: 0.2,
			top_p: 0.8,
			thinkingEnabled: true,
		});
		expect(result).toEqual({ input: "Hello", temperature: 0.2, top_p: 0.8 });
	});

	it("leaves non-record payloads unchanged", () => {
		const payload = "Hello";
		const params = { api: "anthropic-messages", samplingParams: { top_k: 64 } };
		expect(mergeModelSamplingParamsIntoProviderPayload(payload, params)).toBe(payload);
		expect(
			mergeModelSamplingParamsIntoProviderPayload({ prompt: "Hello" }, {
				api: "openai-completions",
				samplingParams: { top_k: 64 },
			}),
		).toEqual({ prompt: "Hello" });
	});

	it("leaves the original payload and model parameters untouched", () => {
		const payload = { messages: [], chat_template_kwargs: { request: true } };
		const samplingParams = { chat_template_kwargs: { model: true } };

		const result = mergeModelSamplingParamsIntoProviderPayload(payload, {
			api: "openai-completions",
			samplingParams,
		});

		expect(result).not.toBe(payload);
		expect(payload.chat_template_kwargs).toEqual({ request: true });
		expect(samplingParams.chat_template_kwargs).toEqual({ model: true });
	});
});
