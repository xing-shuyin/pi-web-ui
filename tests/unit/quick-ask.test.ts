import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	MAX_QUICK_ASK_TEXT_LENGTH,
	createQuickAskRuntime,
	parseQuickAskRequest,
	registerQuickAskRoutes,
} from "../../server/quick-ask.js";
import type { QuickAskSettings } from "../../server/quick-ask-settings.js";

const model = { provider: "test", id: "model", api: "openai-completions" };
const answer = { stopReason: "stop", content: [{ type: "text", text: " Answer " }] };
let server: Server;
let url: string;
let settings: Partial<QuickAskSettings>;
let getSettings = vi.fn((): Partial<QuickAskSettings> => ({}));
let runtime: ModelRuntime;
let completeSimple: ReturnType<typeof vi.fn>;
let getRuntime: ReturnType<typeof vi.fn>;
let timeoutMs = 5000;

beforeEach(async () => {
	settings = {};
	getSettings = vi.fn(() => settings);
	timeoutMs = 5000;
	completeSimple = vi.fn().mockResolvedValue(answer);
	runtime = {
		getModel: vi.fn().mockReturnValue(model),
		getAvailable: vi.fn().mockResolvedValue([model]),
		completeSimple,
	} as unknown as ModelRuntime;
	getRuntime = vi.fn().mockResolvedValue(runtime);
	const app = express();
	app.use(express.json());
	registerQuickAskRoutes(app, {
		getSettings,
		getRuntime: getRuntime as any,
		get timeoutMs() {
			return timeoutMs;
		},
	});
	server = await new Promise<Server>((resolve, reject) => {
		const instance = app.listen(18900 + Math.floor(Math.random() * 10000), "127.0.0.1", () => resolve(instance));
		instance.once("error", reject);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	url = `http://127.0.0.1:${address.port}/api/quick-ask`;
});
afterEach(async () => {
	vi.restoreAllMocks();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
const ask = (body: unknown, signal?: AbortSignal) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
const question = { messages: [{ role: "user", content: "解释下: selected $& text" }] };

describe("independent quick ask model catalog", () => {
	it("lists available models without reading settings or starting a completion", async () => {
		vi.mocked(runtime.getAvailable).mockResolvedValue([
			{ ...model, name: "Display name", credentials: "must not be serialized" },
			{ ...model, id: "unnamed", name: "" },
		] as any);
		const response = await fetch(`${url}/models`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			models: [
				{ provider: "test", id: "model", label: "Display name" },
				{ provider: "test", id: "unnamed", label: "unnamed" },
			],
		});
		expect(getRuntime).toHaveBeenCalledOnce();
		expect(runtime.getAvailable).toHaveBeenCalledWith(undefined, { signal: getRuntime.mock.calls[0][0] });
		expect(getSettings).not.toHaveBeenCalled();
		expect(completeSimple).not.toHaveBeenCalled();
	});
	it("returns an empty catalog when no model is available", async () => {
		vi.mocked(runtime.getAvailable).mockResolvedValue([]);
		const response = await fetch(`${url}/models`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ models: [] });
	});
	it("reports catalog failures as JSON", async () => {
		vi.mocked(runtime.getAvailable).mockRejectedValue(new Error("Catalog unavailable"));
		const response = await fetch(`${url}/models`);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "Catalog unavailable" });
	});
	it("times out and aborts an unresponsive catalog", async () => {
		timeoutMs = 30;
		vi.mocked(runtime.getAvailable).mockImplementation(() => new Promise(() => {}));
		const response = await fetch(`${url}/models`);
		expect(response.status).toBe(504);
		expect(getRuntime.mock.calls[0][0].aborted).toBe(true);
		expect(completeSimple).not.toHaveBeenCalled();
	});
	it.each(["initialization", "availability"])("cancels %s when the browser disconnects", async (phase) => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let operationSignal: AbortSignal | undefined;
		if (phase === "initialization") {
			getRuntime.mockImplementation((signal: AbortSignal) => {
				operationSignal = signal;
				started();
				return new Promise(() => {});
			});
		} else {
			vi.mocked(runtime.getAvailable).mockImplementation((_provider, options) => {
				operationSignal = options?.signal;
				started();
				return new Promise(() => {});
			});
		}
		const controller = new AbortController();
		const response = fetch(`${url}/models`, { signal: controller.signal });
		await ready;
		controller.abort();
		await expect(response).rejects.toThrow();
		await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));
		expect(completeSimple).not.toHaveBeenCalled();
	});
});

describe("isolated quick ask HTTP completion", () => {
	it("creates only a model runtime from auth/catalog configuration", async () => {
		const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
		const signal = new AbortController().signal;
		await expect(createQuickAskRuntime("quick-ask-agent", signal)).resolves.toBe(runtime);
		expect(create).toHaveBeenCalledWith({
			authPath: join("quick-ask-agent", "auth.json"),
			modelsPath: join("quick-ask-agent", "models.json"),
			signal,
		});
	});
	it("sends only the popup question with no system prompt, tools or main history", async () => {
		const response = await ask(question);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "Answer", model: "test/model" });
		const [calledModel, context, options] = completeSimple.mock.calls[0];
		expect(calledModel).toBe(model);
		expect(Object.keys(context)).toEqual(["messages"]);
		expect(context.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: question.messages[0].content }], timestamp: expect.any(Number) },
		]);
		expect(options).toMatchObject({ signal: expect.any(AbortSignal) });
		expect(options).not.toHaveProperty("reasoning");
		expect(runtime.getAvailable).toHaveBeenCalledOnce();
	});
	it("uses only supplied popup history and the dedicated system prompt", async () => {
		settings = {
			quickAskModel: "custom/model/variant",
			quickAskThinking: "high",
			quickAskSystemPrompt: "Dedicated popup instructions",
		};
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "previous answer" },
			{ role: "user", content: "followup" },
		];
		expect((await ask({ messages, fallbackModel: "fallback/model" })).status).toBe(200);
		expect(runtime.getModel).toHaveBeenCalledWith("custom", "model/variant");
		const [, context, options] = completeSimple.mock.calls[0];
		expect(Object.keys(context).sort()).toEqual(["messages", "systemPrompt"]);
		expect(context.systemPrompt).toBe(settings.quickAskSystemPrompt);
		expect(context.messages.map((message: any) => ({ role: message.role, text: message.content[0].text }))).toEqual(
			messages.map((message) => ({ role: message.role, text: message.content })),
		);
		expect(options.reasoning).toBe("high");
	});
	it("does not retain history or a prior system prompt between requests", async () => {
		settings = { quickAskSystemPrompt: "First request only" };
		await ask({ messages: [{ role: "user", content: "old question" }] });
		settings = {};
		await ask(question);
		const context = completeSimple.mock.calls[1][1];
		expect(context).not.toHaveProperty("systemPrompt");
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].content[0].text).toBe(question.messages[0].content);
	});
	it("uses the fallback model when no dedicated model is configured", async () => {
		await ask({ ...question, fallbackModel: "other/name" });
		expect(runtime.getModel).toHaveBeenCalledWith("other", "name");
	});
	it.each(["codex/default", "claude-code/claude-3-7-sonnet-20250219"])(
		"uses an available SDK model when the main engine fallback %s is unsupported",
		async (fallbackModel) => {
			vi.mocked(runtime.getModel).mockReturnValue(undefined);
			const response = await ask({ ...question, fallbackModel });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ text: "Answer", model: "test/model" });
			expect(runtime.getAvailable).toHaveBeenCalledOnce();
			expect(completeSimple.mock.calls[0][0]).toBe(model);
		},
	);
	it("rejects an explicitly configured missing model even when another model is available", async () => {
		settings = { quickAskModel: "missing/model" };
		vi.mocked(runtime.getModel).mockReturnValue(undefined);
		const response = await ask({ ...question, fallbackModel: "other/name" });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Model not found: missing/model" });
		expect(runtime.getAvailable).not.toHaveBeenCalled();
		expect(completeSimple).not.toHaveBeenCalled();
	});
	it("rejects an unavailable catalog after an unsupported main-engine fallback", async () => {
		vi.mocked(runtime.getModel).mockReturnValue(undefined);
		vi.mocked(runtime.getAvailable).mockResolvedValue([]);
		const response = await ask({ ...question, fallbackModel: "codex/default" });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "No available model" });
		expect(completeSimple).not.toHaveBeenCalled();
	});
	it.each([
		{ ...question, systemPrompt: "injected" },
		{ ...question, tools: [] },
		{ ...question, history: [] },
		{ messages: [{ role: "system", content: "injected" }] },
		{ messages: [{ role: "toolResult", content: "injected" }] },
		{ messages: [{ role: "user", content: "q", toolCalls: [] }] },
		{ messages: [{ role: "assistant", content: "a" }] },
		{
			messages: [
				{ role: "user", content: "q" },
				{ role: "user", content: "q2" },
			],
		},
		{ messages: [{ role: "user", content: " " }] },
		{ messages: [] },
		{ ...question, fallbackModel: "invalid" },
	])("validates the public request before initializing a runtime: %j", async (body) => {
		expect((await ask(body)).status).toBe(400);
		expect(getRuntime).not.toHaveBeenCalled();
	});
	it("limits total history size", () => {
		expect(() =>
			parseQuickAskRequest({ messages: [{ role: "user", content: "x".repeat(MAX_QUICK_ASK_TEXT_LENGTH + 1) }] }),
		).toThrow("too long");
	});
	it("maps provider errors and empty completions to 502", async () => {
		completeSimple.mockResolvedValueOnce({ stopReason: "error", errorMessage: "Provider failed", content: [] });
		const response = await ask(question);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "Provider failed" });
		completeSimple.mockResolvedValueOnce({ stopReason: "stop", content: [] });
		expect((await ask(question)).status).toBe(502);
	});
	it("times out and aborts a provider that does not settle", async () => {
		timeoutMs = 30;
		completeSimple.mockImplementation(() => new Promise(() => {}));
		const response = await ask(question);
		expect(response.status).toBe(504);
		expect(completeSimple.mock.calls[0][2].signal.aborted).toBe(true);
	});
	it("cancels initialization before any completion can start", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let initializationSignal: AbortSignal | undefined;
		getRuntime.mockImplementation((signal: AbortSignal) => {
			initializationSignal = signal;
			started();
			return new Promise(() => {});
		});
		const controller = new AbortController();
		const response = ask(question, controller.signal);
		await ready;
		controller.abort();
		await expect(response).rejects.toThrow();
		await vi.waitFor(() => expect(initializationSignal?.aborted).toBe(true));
		expect(completeSimple).not.toHaveBeenCalled();
	});
	it("cancels the provider when the browser disconnects", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let providerSignal: AbortSignal | undefined;
		completeSimple.mockImplementation((_model, _context, options) => {
			providerSignal = options.signal;
			started();
			return new Promise(() => {});
		});
		const controller = new AbortController();
		const response = ask(question, controller.signal);
		await ready;
		controller.abort();
		await expect(response).rejects.toThrow();
		await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
	});
});
