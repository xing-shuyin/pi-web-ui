import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { persistContextEvidence, contextEvidenceReference } from "./context-evidence.js";

type Message = AgentSession["messages"][number];
const READ_ONLY_TOOLS = new Set(["read", "grep", "find"]);
const MIN_DUPLICATE_CHARS = 4096;
const evidenceReady = new WeakSet<object>();

export function enableRequestEvidence(sessionManager: object): void {
	evidenceReady.add(sessionManager);
}

export function deduplicateRequestContext(messages: Message[]): Message[] {
	const calls = new Map<string, string>();
	const originals = new Map<string, { content: string; id: string }>();
	let output = messages;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user") {
			calls.clear();
			originals.clear();
			continue;
		}
		if (message.role === "assistant") {
			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			if (toolCalls.some((block) => !READ_ONLY_TOOLS.has(block.name))) {
				calls.clear();
				originals.clear();
				continue;
			}
			for (const block of toolCalls) {
				calls.set(block.id, JSON.stringify([block.name, block.arguments]));
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		if (!READ_ONLY_TOOLS.has(message.toolName)) {
			calls.clear();
			originals.clear();
			continue;
		}
		const call = calls.get(message.toolCallId);
		if (!call) continue;
		calls.delete(message.toolCallId);
		const previous = originals.get(call);
		originals.delete(call);
		if (message.isError || !message.content.length || message.content.some((block) => block.type !== "text")) continue;
		if (message.content.some((block) => Object.keys(block).some((key) => key !== "type" && key !== "text"))) continue;
		if ("structuredContent" in message) continue;
		const content = JSON.stringify(message.content);
		if (content.length < MIN_DUPLICATE_CHARS) continue;
		if (!previous || previous.content !== content) {
			originals.set(call, { content, id: message.toolCallId });
			continue;
		}
		originals.set(call, previous);
		if (output === messages) output = messages.slice();
		output[index] = {
			...message,
			content: [
				{
					type: "text",
					text: `[Exact duplicate result: see earlier tool call ${previous.id} in this context. The tool ran successfully and returned identical content.]`,
				},
			],
		};
	}
	return output;
}

export function requestMessageBudget(
	model: { contextWindow: number; maxTokens: number } | undefined,
	systemPrompt: string,
	tools: unknown[],
): number {
	const window = model?.contextWindow ?? 128000;
	const output = Math.min(model?.maxTokens ?? 16384, Math.floor(window / 4));
	const fixed = Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 3);
	return Math.max(0, Math.floor(window * 0.7) - fixed - output);
}

export interface RequestEvidenceBudget {
	messageTokens?: number;
	keepRecentResults?: number;
	signal?: AbortSignal;
}

export async function externalizeRequestEvidence(
	messages: Message[],
	sessionFile: string,
	budget: RequestEvidenceBudget = {},
): Promise<Message[]> {
	let output = messages;
	const evidenceReads = new Set<string>();
	const results = messages.flatMap((message, index) => (message.role === "toolResult" ? [index] : []));
	const protectedFrom = results[Math.max(0, results.length - (budget.keepRecentResults ?? 0))] ?? messages.length;
	let estimatedTokens = Math.ceil(JSON.stringify(messages).length / 3);
	const target = budget.messageTokens ?? 0;
	for (let index = 0; index < messages.length; index++) {
		budget.signal?.throwIfAborted();
		const message = messages[index];
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || block.name !== "read") continue;
				const args = block.arguments as Record<string, unknown>;
				const path = args.path ?? args.file_path;
				if (typeof path === "string" && (path.startsWith("context-evidence:") || /\.evidence[\\/]/.test(path)))
					evidenceReads.add(block.id);
			}
		}
		if (message.role !== "toolResult" || message.isError || !READ_ONLY_TOOLS.has(message.toolName)) continue;
		if (evidenceReads.has(message.toolCallId)) continue;
		if ("structuredContent" in message || message.content.length !== 1) continue;
		const block = message.content[0];
		if (block.type !== "text" || Object.keys(block).some((key) => key !== "type" && key !== "text")) continue;
		if (block.text.length < 24000 || index >= protectedFrom || estimatedTokens <= target) continue;
		const path = await persistContextEvidence(sessionFile, block.text, budget.signal);
		budget.signal?.throwIfAborted();
		if (!path) continue;
		if (output === messages) output = messages.slice();
		estimatedTokens -= Math.max(0, Math.floor((block.text.length - 6500) / 3));
		output[index] = {
			...message,
			content: [
				{
					type: "text",
					text:
						`[Long tool result: ${block.text.length} characters. Full UTF-8 evidence file: ${JSON.stringify(contextEvidenceReference(block.text))}. Use read with offset/limit for omitted lines.]\n` +
						block.text.slice(0, 3000) +
						"\n[… middle omitted; complete output in evidence file …]\n" +
						block.text.slice(-3000),
				},
			],
		};
	}
	return output;
}

export function requestContextExtension(pi: ExtensionAPI): void {
	pi.on("context", async (event, ctx) => {
		try {
			ctx.signal?.throwIfAborted();
			const messages = deduplicateRequestContext(event.messages);
			const sessionFile = ctx.sessionManager.getSessionFile();
			return {
				messages:
					sessionFile &&
					evidenceReady.has(ctx.sessionManager) &&
					!ctx.cwd.trim().startsWith("ssh://") &&
					pi.getActiveTools().includes("read")
						? await externalizeRequestEvidence(messages, sessionFile, {
								messageTokens: requestMessageBudget(
									ctx.model,
									ctx.getSystemPrompt(),
									pi.getAllTools().filter((tool) => pi.getActiveTools().includes(tool.name)),
								),
								keepRecentResults: 2,
								signal: ctx.signal,
							})
						: messages,
			};
		} catch {
			ctx.signal?.throwIfAborted();
			return { messages: event.messages };
		}
	});
}
