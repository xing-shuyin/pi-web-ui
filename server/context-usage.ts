import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ContextCategory, ContextCategoryUsage } from "./protocol.js";
import type { AgentMessage } from "./serialize.js";
import { effectiveTemplate, estimatePromptTokens, overrideOf } from "./prompt-composer.js";

export type ContextWeights = Record<ContextCategory, number>;

function emptyWeights(): ContextWeights {
	return { systemPrompt: 0, memoryFiles: 0, tools: 0, skills: 0, toolResults: 0, messages: 0, other: 0 };
}

export function estimateBaseContext(
	snapshot: { full: string; texts: Record<string, string>; toolsSchema: string },
	options: { promptTemplate?: string; promptOverrides?: Record<string, string>; promptDisabled?: string[] },
): { tokens: number; weights: ContextWeights } {
	const weights = emptyWeights();
	const disabled = new Set(options.promptDisabled ?? []);
	const template = effectiveTemplate(options.promptTemplate ?? "");
	for (const match of template.matchAll(/\{\{\s*(context|skills|tools)\s*\}\}/g)) {
		const name = match[1];
		if (disabled.has(name)) continue;
		const text = overrideOf(options.promptOverrides, name) || snapshot.texts[name] || "";
		const category = name === "context" ? "memoryFiles" : name === "skills" ? "skills" : "tools";
		weights[category] += estimatePromptTokens(text);
	}
	const prompt = estimatePromptTokens(snapshot.full);
	const schema = estimatePromptTokens(snapshot.toolsSchema);
	const sections = weights.memoryFiles + weights.skills + weights.tools;
	if (sections > prompt) {
		for (const category of ["memoryFiles", "skills", "tools"] as const) {
			weights[category] = sections > 0 ? (weights[category] * prompt) / sections : 0;
		}
	}
	weights.systemPrompt = Math.max(0, prompt - Math.min(prompt, sections));
	weights.tools += schema;
	return { tokens: prompt + schema, weights };
}

export function estimateContextWeights(
	base: ContextWeights,
	messages: unknown[],
	streamingMessage?: unknown,
	cache?: WeakMap<object, ContextWeights>,
): ContextWeights {
	const weights = { ...base };
	const add = (value: unknown, settled = false) => {
		if (!value || typeof value !== "object") return;
		if (!settled) cache?.delete(value);
		const cached = settled ? cache?.get(value) : undefined;
		if (cached) {
			for (const category of Object.keys(weights) as ContextCategory[]) weights[category] += cached[category];
			return;
		}
		const contribution = emptyWeights();
		const message = value as AgentMessage;
		if (message.role === "system") return;
		if (message.role === "toolResult") {
			contribution[message.toolName === "skill" ? "skills" : "toolResults"] += estimateTokens(message);
		} else if (message.role === "bashExecution") {
			contribution.toolResults += estimateTokens(message);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			const calls = message.content.filter((block) => block.type === "toolCall");
			const prose = message.content.filter((block) => block.type !== "toolCall");
			if (calls.length) contribution.toolResults += estimateTokens({ ...message, content: calls });
			if (prose.length) contribution.messages += estimateTokens({ ...message, content: prose });
		} else {
			contribution[message.role === "user" ? "messages" : "other"] += estimateTokens(message);
		}
		if (settled) cache?.set(value, contribution);
		for (const category of Object.keys(weights) as ContextCategory[]) weights[category] += contribution[category];
	};
	const lastMessage = messages[messages.length - 1];
	for (const message of messages) add(message, message !== streamingMessage && message !== lastMessage);
	if (streamingMessage && !messages.includes(streamingMessage)) add(streamingMessage);
	return weights;
}

export function reconcileContextCategories(weights: ContextWeights, usedTokens: number): ContextCategoryUsage[] {
	const total = Math.max(0, Math.round(Number.isFinite(usedTokens) ? usedTokens : 0));
	const entries = (Object.keys(weights) as ContextCategory[]).map((category) => ({
		category,
		tokens: Number.isFinite(weights[category]) ? Math.max(0, weights[category]) : 0,
	}));
	const sum = entries.reduce((n, row) => n + row.tokens, 0);
	if (sum < total) entries.find((row) => row.category === "other")!.tokens += total - sum;
	const scale = sum > total ? total / sum : 1;
	let assigned = 0;
	const rows = entries.map((row) => {
		const previous = assigned;
		assigned += row.tokens * scale;
		return { category: row.category, tokens: Math.round(assigned) - Math.round(previous) };
	});
	return rows.filter((row) => row.tokens > 0);
}
