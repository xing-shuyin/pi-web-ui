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

	it("applies conversation reasoning controls without overriding model sampler settings", () => {
		const payload = { messages: [], temperature: 0.8, top_p: 0.9 };
		const result = mergeModelSamplingParamsIntoProviderPayload(
			payload,
			{
				api: "openai-completions",
				samplingParams: { top_k: 32 },
			},
			{
				profile: "gemma4",
				thinkingEnabled: true,
				thinkingEffort: "high",
				preserveThinking: true,
			},
		);
		expect(result).toEqual({
			messages: [],
			temperature: 0.8,
			top_p: 0.9,
			top_k: 32,
			chat_template_kwargs: {
				enable_thinking: true,
				reasoning_effort: "high",
				preserve_thinking: true,
			},
		});
	});

	it("detects Gemma 4 from the provider model and explicitly sends thinking off", () => {
		const result = mergeModelSamplingParamsIntoProviderPayload(
			{ model: "gemma-4", messages: [] },
			{
				id: "gemma-4-it",
				api: "openai-completions",
			},
			{
				thinkingEnabled: false,
				thinkingEffort: "medium",
				preserveThinking: true,
			},
		);
		expect(result).toEqual({
			model: "gemma-4",
			messages: [],
			chat_template_kwargs: {
				enable_thinking: false,
				reasoning_effort: "medium",
				preserve_thinking: true,
			},
		});
	});

	it("does not inject conversation sampler defaults into non-OpenAI payloads", () => {
		const payload = { input: "Hello" };
		const result = mergeModelSamplingParamsIntoProviderPayload(
			payload,
			{ api: "anthropic-messages" },
			{ thinkingEnabled: true },
		);
		expect(result).toEqual({ input: "Hello" });
	});

	it("leaves non-record payloads unchanged", () => {
		const params = { api: "openai-completions", samplingParams: { top_k: 64 } };
		const stringPayload = "Hello";
		const arrayPayload = ["Hello"];

		expect(mergeModelSamplingParamsIntoProviderPayload(stringPayload, params)).toBe(stringPayload);
		expect(mergeModelSamplingParamsIntoProviderPayload(arrayPayload, params)).toBe(arrayPayload);
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
