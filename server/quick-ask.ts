import type { Express, Request, Response } from "express";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { QuickAskMessage, QuickAskStreamEvent } from "./protocol.js";
import { isQuickAskModel, normalizeQuickAskSettings, type QuickAskSettings } from "./quick-ask-settings.js";
import {
	MAX_QUICK_ASK_ATTACHMENTS,
	MAX_QUICK_ASK_TOTAL_IMAGE_BYTES,
	QuickAskError,
	parseQuickAskAttachment,
	quickAskAttachmentText,
	parseQuickAskContextRequest,
	resolveQuickAskContext,
	QUICK_ASK_CONTEXT_TIMEOUT_MS,
	type QuickAskContextDependencies,
} from "./quick-ask-context.js";

export const MAX_QUICK_ASK_TEXT_LENGTH = 65_536;
export const MAX_QUICK_ASK_MESSAGES = 100;
export const QUICK_ASK_TIMEOUT_MS = 120_000;

type QuickAskRequest = { messages: QuickAskMessage[]; fallbackModel?: string };
export function parseQuickAskRequest(body: unknown): QuickAskRequest {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new QuickAskError(400, "Expected an object");
	const value = body as Record<string, unknown>;
	if (Object.keys(value).some((key) => key !== "messages" && key !== "fallbackModel"))
		throw new QuickAskError(400, "Unexpected request field");
	if (!Array.isArray(value.messages) || !value.messages.length) throw new QuickAskError(400, "messages is required");
	if (value.messages.length > MAX_QUICK_ASK_MESSAGES) throw new QuickAskError(413, "Too many messages");
	let length = 0;
	let attachmentCount = 0;
	let imageBytes = 0;
	const messages = value.messages.map((item): QuickAskMessage => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new QuickAskError(400, "Invalid message");
		if (
			Object.keys(item).some((key) => key !== "role" && key !== "content" && key !== "attachments") ||
			(item.role !== "user" && item.role !== "assistant") ||
			typeof item.content !== "string" ||
			!item.content.trim()
		)
			throw new QuickAskError(400, "Messages require a user/assistant role and non-empty content");
		length += item.content.length;
		let attachments: QuickAskMessage["attachments"];
		if (item.attachments !== undefined) {
			if (item.role !== "user" || !Array.isArray(item.attachments))
				throw new QuickAskError(400, "Only user messages can contain an attachments array");
			attachmentCount += item.attachments.length;
			if (attachmentCount > MAX_QUICK_ASK_ATTACHMENTS)
				throw new QuickAskError(413, "Too many attachments (maximum 8 per topic)");
			const parsedAttachments: NonNullable<QuickAskMessage["attachments"]> =
				item.attachments.map(parseQuickAskAttachment);
			attachments = parsedAttachments;
			for (const attachment of parsedAttachments) {
				length += quickAskAttachmentText(attachment).length;
				if (attachment.image) imageBytes += Buffer.byteLength(attachment.image.data, "base64");
			}
			if (imageBytes > MAX_QUICK_ASK_TOTAL_IMAGE_BYTES)
				throw new QuickAskError(413, "Images exceed the total 6 MiB budget");
		}
		return { role: item.role, content: item.content, ...(attachments ? { attachments } : {}) };
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
	context?: QuickAskContextDependencies;
	contextTimeoutMs?: number;
}

async function complete(
	request: QuickAskRequest,
	settings: QuickAskSettings,
	runtime: ModelRuntime,
	signal: AbortSignal,
	emit?: (event: QuickAskStreamEvent) => void,
) {
	signal.throwIfAborted();
	const spec = settings.quickAskModel ?? request.fallbackModel;
	const slash = spec?.indexOf("/") ?? -1;
	let model = spec ? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	if (!model && !settings.quickAskModel) model = (await runtime.getAvailable(undefined, { signal }))[0];
	signal.throwIfAborted();
	if (!model)
		throw new QuickAskError(
			400,
			settings.quickAskModel ? `Model not found: ${settings.quickAskModel}` : "No available model",
		);
	if (
		request.messages.some((message) => message.attachments?.some((attachment) => attachment.image)) &&
		!model.input?.includes("image")
	)
		throw new QuickAskError(
			400,
			`Model ${model.provider}/${model.id} does not support image references; choose an image-capable model`,
		);
	type Messages = Parameters<ModelRuntime["completeSimple"]>[1]["messages"];
	const messages: Messages = request.messages.map((message) =>
		message.role === "user"
			? {
					role: "user",
					content: [
						{ type: "text", text: message.content },
						...(message.attachments ?? []).flatMap(
							(
								attachment,
							): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> => [
								{ type: "text", text: quickAskAttachmentText(attachment) },
								...(attachment.image ? [{ type: "image" as const, ...attachment.image }] : []),
							],
						),
					],
					timestamp: Date.now(),
				}
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
	const context = {
		messages,
		...(settings.quickAskSystemPrompt ? { systemPrompt: settings.quickAskSystemPrompt } : {}),
	};
	const options = {
		...(settings.quickAskThinking !== "off" ? { reasoning: settings.quickAskThinking } : {}),
		signal,
		maxTokens: 4096,
	};
	let result: Awaited<ReturnType<ModelRuntime["completeSimple"]>> | undefined;
	if (emit) {
		emit({ type: "start", model: `${model.provider}/${model.id}` });
		let lastTextIndex: number | undefined;
		for await (const event of runtime.streamSimple(model, context, options)) {
			signal.throwIfAborted();
			if (event.type === "text_delta") {
				if (lastTextIndex !== undefined && lastTextIndex !== event.contentIndex) emit({ type: "delta", text: "\n" });
				lastTextIndex = event.contentIndex;
				emit({ type: "delta", text: event.delta });
			} else if (event.type === "done") {
				result = event.message;
			} else if (event.type === "error") {
				throw new QuickAskError(502, event.error.errorMessage || "Model completion failed");
			}
		}
		if (!result) throw new QuickAskError(502, "Model stream ended before completion");
	} else {
		result = await runtime.completeSimple(model, context, options);
	}
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
	deps: Pick<Dependencies, "timeoutMs">,
	operation: (signal: AbortSignal, emit?: (event: QuickAskStreamEvent) => void) => Promise<unknown>,
	streaming = false,
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
	const emit = streaming
		? (event: QuickAskStreamEvent) => {
				controller.signal.throwIfAborted();
				if (res.destroyed || res.writableEnded) return;
				if (!res.headersSent) {
					res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
					res.setHeader("Cache-Control", "no-store, no-transform");
					res.setHeader("X-Accel-Buffering", "no");
					res.flushHeaders();
				}
				res.write(`${JSON.stringify(event)}\n`);
			}
		: undefined;
	try {
		const result = await Promise.race([operation(controller.signal, emit), interrupted]);
		if (!res.destroyed && !res.writableEnded) {
			if (emit) res.end();
			else res.json(result);
		}
	} catch (error) {
		if (!res.destroyed && !res.writableEnded) {
			const message = error instanceof Error ? error.message : "Quick ask failed";
			if (res.headersSent)
				res.end(`${JSON.stringify({ type: "error", error: message } satisfies QuickAskStreamEvent)}\n`);
			else res.status(error instanceof QuickAskError ? error.status : 502).json({ error: message });
		}
	} finally {
		clearTimeout(timer);
		req.off("aborted", onDisconnect);
		res.off("close", onDisconnect);
		controller.signal.removeEventListener("abort", onAbort);
	}
}

export function registerQuickAskRoutes(app: Express, deps: Dependencies): void {
	app.post("/api/quick-ask/context", async (req, res) => {
		let request: ReturnType<typeof parseQuickAskContextRequest>;
		try {
			request = parseQuickAskContextRequest(req.body);
		} catch (error) {
			res.status(error instanceof QuickAskError ? error.status : 400).json({ error: (error as Error).message });
			return;
		}
		await respondWithCancellation(
			req,
			res,
			{ timeoutMs: deps.contextTimeoutMs ?? QUICK_ASK_CONTEXT_TIMEOUT_MS },
			async (signal) => {
				if (!deps.context) throw new QuickAskError(503, "Reference snapshots are unavailable");
				const settings = normalizeQuickAskSettings(deps.getSettings());
				const scope =
					request.scope ??
					(request.source.kind === "conversation"
						? settings.quickAskConversationScope
						: request.source.kind === "directory"
							? settings.quickAskFolderScope
							: undefined);
				return { attachment: await resolveQuickAskContext({ ...request, scope }, deps.context, signal) };
			},
		);
	});
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
		await respondWithCancellation(
			req,
			res,
			deps,
			async (signal, emit) => {
				const settings = normalizeQuickAskSettings(deps.getSettings());
				const result = await complete(request, settings, await deps.getRuntime(signal), signal, emit);
				emit?.({ type: "done", ...result });
				return result;
			},
			req.accepts("application/x-ndjson") === "application/x-ndjson" &&
				req.get("Accept")?.includes("application/x-ndjson") === true,
		);
	});
}

export function createQuickAskRuntime(agentDir: string, signal?: AbortSignal): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		signal,
	});
}
