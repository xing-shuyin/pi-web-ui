import type { Express, Request, Response } from "express";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { isQuickAskModel, normalizeQuickAskSettings, type QuickAskSettings } from "./quick-ask-settings.js";

export const MAX_QUICK_ASK_TEXT_LENGTH = 65_536;
export const MAX_QUICK_ASK_MESSAGES = 100;
export const QUICK_ASK_TIMEOUT_MS = 120_000;

class QuickAskError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

type QuickAskMessage = { role: "user" | "assistant"; content: string };
type QuickAskRequest = { messages: QuickAskMessage[]; fallbackModel?: string };
export function parseQuickAskRequest(body: unknown): QuickAskRequest {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new QuickAskError(400, "Expected an object");
	const value = body as Record<string, unknown>;
	if (Object.keys(value).some((key) => key !== "messages" && key !== "fallbackModel"))
		throw new QuickAskError(400, "Unexpected request field");
	if (!Array.isArray(value.messages) || !value.messages.length) throw new QuickAskError(400, "messages is required");
	if (value.messages.length > MAX_QUICK_ASK_MESSAGES) throw new QuickAskError(413, "Too many messages");
	let length = 0;
	const messages = value.messages.map((item): QuickAskMessage => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new QuickAskError(400, "Invalid message");
		if (
			Object.keys(item).some((key) => key !== "role" && key !== "content") ||
			(item.role !== "user" && item.role !== "assistant") ||
			typeof item.content !== "string" ||
			!item.content.trim()
		)
			throw new QuickAskError(400, "Messages require a user/assistant role and non-empty content");
		length += item.content.length;
		return { role: item.role, content: item.content };
	});
	if (length > MAX_QUICK_ASK_TEXT_LENGTH) throw new QuickAskError(413, "Messages are too long");
	if (
		messages[0].role !== "user" ||
		messages.at(-1)?.role !== "user" ||
		messages.some((message, index) => index > 0 && messages[index - 1].role === message.role)
	)
		throw new QuickAskError(400, "Messages must alternate user/assistant and end with a user question");
	if (value.fallbackModel !== undefined && !isQuickAskModel(value.fallbackModel))
		throw new QuickAskError(400, "fallbackModel must be provider/id");
	return { messages, ...(value.fallbackModel !== undefined ? { fallbackModel: value.fallbackModel as string } : {}) };
}

interface Dependencies {
	getSettings: () => Partial<QuickAskSettings>;
	getRuntime: (signal: AbortSignal) => Promise<ModelRuntime>;
	timeoutMs?: number;
}

async function complete(
	request: QuickAskRequest,
	settings: QuickAskSettings,
	runtime: ModelRuntime,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const spec = settings.quickAskModel ?? request.fallbackModel;
	const slash = spec?.indexOf("/") ?? -1;
	let model = spec ? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	// Main conversation engines may expose provider IDs that do not exist in the independent SDK catalog.
	if (!model && !settings.quickAskModel) model = (await runtime.getAvailable(undefined, { signal }))[0];
	signal.throwIfAborted();
	if (!model)
		throw new QuickAskError(
			400,
			settings.quickAskModel ? `Model not found: ${settings.quickAskModel}` : "No available model",
		);
	type Messages = Parameters<ModelRuntime["completeSimple"]>[1]["messages"];
	const messages: Messages = request.messages.map((message) =>
		message.role === "user"
			? { role: "user", content: [{ type: "text", text: message.content }], timestamp: Date.now() }
			: {
					role: "assistant",
					content: [{ type: "text", text: message.content }],
					timestamp: Date.now(),
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
	);
	const result = await runtime.completeSimple(
		model,
		{
			messages,
			...(settings.quickAskSystemPrompt ? { systemPrompt: settings.quickAskSystemPrompt } : {}),
		},
		{
			...(settings.quickAskThinking !== "off" ? { reasoning: settings.quickAskThinking } : {}),
			signal,
			maxTokens: 4096,
		},
	);
	signal.throwIfAborted();
	if (result.stopReason === "error" || result.stopReason === "aborted")
		throw new QuickAskError(502, result.errorMessage || "Model completion failed");
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!text) throw new QuickAskError(502, "Model returned no answer");
	return { text, model: `${model.provider}/${model.id}` };
}

async function respondWithCancellation(
	req: Request,
	res: Response,
	deps: Dependencies,
	operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
	const controller = new AbortController();
	const onDisconnect = () => {
		if (!res.writableEnded) controller.abort(new QuickAskError(499, "Request cancelled"));
	};
	req.once("aborted", onDisconnect);
	res.once("close", onDisconnect);
	let rejectAbort!: (error: unknown) => void;
	const interrupted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => rejectAbort(controller.signal.reason);
	controller.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new QuickAskError(504, "Quick ask timed out")),
		deps.timeoutMs ?? QUICK_ASK_TIMEOUT_MS,
	);
	timer.unref();
	try {
		const result = await Promise.race([operation(controller.signal), interrupted]);
		if (!res.destroyed) res.json(result);
	} catch (error) {
		if (!res.destroyed)
			res
				.status(error instanceof QuickAskError ? error.status : 502)
				.json({ error: error instanceof Error ? error.message : "Quick ask failed" });
	} finally {
		clearTimeout(timer);
		req.off("aborted", onDisconnect);
		res.off("close", onDisconnect);
		controller.signal.removeEventListener("abort", onAbort);
	}
}

export function registerQuickAskRoutes(app: Express, deps: Dependencies): void {
	app.get("/api/quick-ask/models", async (req, res) => {
		await respondWithCancellation(req, res, deps, async (signal) => {
			const runtime = await deps.getRuntime(signal);
			signal.throwIfAborted();
			const available = await runtime.getAvailable(undefined, { signal });
			signal.throwIfAborted();
			return {
				models: available.map((model) => ({ provider: model.provider, id: model.id, label: model.name || model.id })),
			};
		});
	});
	app.post("/api/quick-ask", async (req, res) => {
		let request: QuickAskRequest;
		try {
			request = parseQuickAskRequest(req.body);
		} catch (error) {
			res.status(error instanceof QuickAskError ? error.status : 400).json({ error: (error as Error).message });
			return;
		}
		await respondWithCancellation(req, res, deps, async (signal) => {
			const settings = normalizeQuickAskSettings(deps.getSettings());
			return complete(request, settings, await deps.getRuntime(signal), signal);
		});
	});
}

/** Only auth/catalog configuration is loaded; no AgentSession or resource loader is created. */
export function createQuickAskRuntime(agentDir: string, signal?: AbortSignal): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		signal,
	});
}
