import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	estimateBaseContext,
	estimateContextWeights,
	reconcileContextCategories,
	type ContextWeights,
} from "../../server/context-usage.js";
import { estimatePromptTokens, renderPromptTemplate } from "../../server/prompt-composer.js";
import { deduplicateRequestContext, externalizeRequestEvidence } from "../../server/request-context.js";
import type { AgentMessage } from "../../server/serialize.js";

const empty: ContextWeights = {
	systemPrompt: 0,
	memoryFiles: 0,
	tools: 0,
	skills: 0,
	toolResults: 0,
	messages: 0,
	other: 0,
};

function base(
	options: { promptTemplate?: string; promptOverrides?: Record<string, string>; promptDisabled?: string[] } = {},
) {
	const texts = {
		soul: "System instructions.",
		context: "Project memory.",
		skills: "Skills catalog.",
		tools: "Tools catalog.",
	};
	const full = renderPromptTemplate(
		options.promptTemplate ?? "",
		texts,
		options.promptOverrides,
		options.promptDisabled,
	);
	return { result: estimateBaseContext({ full, texts, toolsSchema: "Tool schemas." }, options), full };
}

function readExchange(id: string, text: string): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "README.md" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolName: "read",
			toolCallId: id,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		},
	];
}

function totalWeights(weights: ContextWeights): number {
	return Object.values(weights).reduce((sum, tokens) => sum + tokens, 0);
}

function categoryTokens(weights: ContextWeights, total: number, category: keyof ContextWeights): number {
	const rows = reconcileContextCategories(weights, total);
	expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(total);
	return rows.find((row) => row.category === category)?.tokens ?? 0;
}

describe("context usage categories", () => {
	it("keeps the existing prompt + schema baseline and separates sources", () => {
		const { result, full } = base();
		expect(result.tokens).toBe(estimatePromptTokens(full) + estimatePromptTokens("Tool schemas."));
		expect(result.weights.memoryFiles).toBe(estimatePromptTokens("Project memory."));
		expect(result.weights.skills).toBe(estimatePromptTokens("Skills catalog."));
		expect(result.weights.tools).toBe(estimatePromptTokens("Tools catalog.") + estimatePromptTokens("Tool schemas."));
		expect(Object.values(result.weights).reduce((n, value) => n + value, 0)).toBeCloseTo(result.tokens);
	});

	it("respects overridden, omitted, disabled and repeated prompt sections", () => {
		const { result } = base({
			promptTemplate: "Custom instructions {{context}} {{context}} {{skills}}",
			promptOverrides: { context: "Replacement memory" },
			promptDisabled: ["skills"],
		});
		expect(result.weights.memoryFiles).toBe(2 * estimatePromptTokens("Replacement memory"));
		expect(result.weights.skills).toBe(0);
		expect(result.weights.tools).toBe(estimatePromptTokens("Tool schemas."));
		expect(result.weights.systemPrompt).toBeGreaterThan(0);
	});

	it("separates tool arguments/results, skill bodies, messages and compaction summaries", () => {
		const messages = [
			{ role: "system", content: "Already counted in the baseline" },
			{ role: "user", content: "Hello world" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Inspecting the file" },
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "README.md" } },
				],
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "File contents" }] },
			{ role: "toolResult", toolName: "skill", content: [{ type: "text", text: "Skill instructions" }] },
			{ role: "compactionSummary", summary: "Previous context" },
		];
		const weights = estimateContextWeights(empty, messages);
		expect(weights.systemPrompt).toBe(0);
		expect(weights.messages).toBeGreaterThan(0);
		expect(weights.toolResults).toBeGreaterThan(0);
		expect(weights.skills).toBeGreaterThan(0);
		expect(weights.other).toBeGreaterThan(0);
		const compacted = estimateContextWeights(empty, [messages[5]]);
		expect(compacted.toolResults).toBe(0);
		expect(compacted.skills).toBe(0);
	});

	it("counts streaming content once and never changes its source messages", () => {
		const streaming = { role: "assistant", content: [{ type: "text", text: "Streaming answer" }] };
		const original = JSON.stringify(streaming);
		expect(estimateContextWeights(empty, [], streaming)).toEqual(estimateContextWeights(empty, [streaming], streaming));
		expect(JSON.stringify(streaming)).toBe(original);
	});

	it("reuses settled-message estimates and re-estimates growing streaming content", () => {
		const cache = new WeakMap<object, ContextWeights>();
		const settled = { role: "user", content: "Settled message" };
		const streaming = { role: "assistant", content: [{ type: "text", text: "Now" }] };
		const before = estimateContextWeights(empty, [settled, streaming], streaming, cache);
		expect(cache.has(settled)).toBe(true);
		expect(cache.has(streaming)).toBe(false);
		streaming.content[0].text = "A much longer streaming answer that is still being generated";
		const after = estimateContextWeights(empty, [settled, streaming], streaming, cache);
		expect(after.messages).toBeGreaterThan(before.messages);
		expect(estimateContextWeights(empty, [], undefined, cache).messages).toBe(0);
	});

	it("keeps raw transcript estimates distinct from the actual deduplicated request view", () => {
		const messages = [
			...readExchange("first", "read output\n".repeat(1000)),
			...readExchange("repeat", "read output\n".repeat(1000)),
		];
		const original = JSON.stringify(messages);
		const request = deduplicateRequestContext(messages);
		expect(request).not.toBe(messages);
		expect(request[3]).not.toBe(messages[3]);
		expect(request[3]).toMatchObject({
			content: [{ text: expect.stringContaining("see earlier tool call first") }],
		});
		const baseline = { ...empty, systemPrompt: 1000 };
		const rawWeights = estimateContextWeights(baseline, messages);
		const requestWeights = estimateContextWeights(baseline, request);
		const saved = estimateTokens(messages[3]) - estimateTokens(request[3]);
		expect(saved).toBeGreaterThan(2000);
		expect(rawWeights.toolResults - requestWeights.toolResults).toBe(saved);
		expect(rawWeights.systemPrompt).toBe(requestWeights.systemPrompt);
		const total = totalWeights(requestWeights);
		expect(categoryTokens(rawWeights, total, "systemPrompt")).toBeLessThan(
			categoryTokens(requestWeights, total, "systemPrompt"),
		);
		expect(categoryTokens(rawWeights, total, "toolResults")).toBeGreaterThan(
			categoryTokens(requestWeights, total, "toolResults"),
		);
		expect(JSON.stringify(messages)).toBe(original);
	});

	it("keeps raw transcript estimates distinct from actual externalized evidence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "context-usage-"));
		try {
			const messages = readExchange("large", "evidence line\n".repeat(3000));
			const original = JSON.stringify(messages);
			const deduplicated = deduplicateRequestContext(messages);
			expect(deduplicated).toBe(messages);
			const sessionFile = join(dir, "session.jsonl");
			await writeFile(sessionFile, "", "utf8");
			const request = await externalizeRequestEvidence(deduplicated, sessionFile, {
				messageTokens: 0,
				keepRecentResults: 0,
			});
			expect(request[1]).not.toBe(messages[1]);
			expect(request[1]).toMatchObject({
				content: [{ text: expect.stringContaining("context-evidence:") }],
			});
			const evidenceText =
				messages[1].role === "toolResult" && messages[1].content[0].type === "text" ? messages[1].content[0].text : "";
			expect(
				await readFile(
					join(`${sessionFile}.evidence`, `${createHash("sha256").update(evidenceText).digest("hex")}.txt`),
					"utf8",
				),
			).toBe(evidenceText);
			const baseline = { ...empty, systemPrompt: 1000 };
			const rawWeights = estimateContextWeights(baseline, messages);
			const requestWeights = estimateContextWeights(baseline, request);
			const saved = estimateTokens(messages[1]) - estimateTokens(request[1]);
			expect(saved).toBeGreaterThan(8000);
			expect(rawWeights.toolResults - requestWeights.toolResults).toBe(saved);
			const total = totalWeights(requestWeights);
			expect(categoryTokens(rawWeights, total, "systemPrompt")).toBeLessThan(
				categoryTokens(requestWeights, total, "systemPrompt"),
			);
			expect(categoryTokens(rawWeights, total, "toolResults")).toBeGreaterThan(
				categoryTokens(requestWeights, total, "toolResults"),
			);
			expect(JSON.stringify(messages)).toBe(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refreshes the final message after an SDK message_end extension replaces it in place", async () => {
		const cache = new WeakMap<object, ContextWeights>();
		const messages = readExchange("first", "original tool result");
		const final = messages[1];
		const before = estimateContextWeights(empty, messages, undefined, cache);
		await Promise.resolve();
		Object.assign(final, { content: [{ type: "text", text: "replacement tool result\n".repeat(1000) }] });
		const after = estimateContextWeights(empty, messages, undefined, cache);
		expect(messages[1]).toBe(final);
		expect(after.toolResults).toBeGreaterThan(before.toolResults);
		expect(after).toEqual(estimateContextWeights(empty, messages));
		messages.push({ role: "user", content: "Continue", timestamp: 1 });
		expect(estimateContextWeights(empty, messages, undefined, cache)).toEqual(estimateContextWeights(empty, messages));
	});

	it("reuses stable prefix estimates without rereading large content", () => {
		const cache = new WeakMap<object, ContextWeights>();
		const content = vi.fn(() => "Stable prefix\n".repeat(10000));
		const prefix = {
			role: "user",
			get content() {
				return content();
			},
		};
		const last = { role: "user", content: "Last message" };
		const messages = [prefix, last];
		const before = estimateContextWeights(empty, messages, undefined, cache);
		const reads = content.mock.calls.length;
		expect(reads).toBeGreaterThan(0);
		expect(cache.has(prefix)).toBe(true);
		for (let count = 0; count < 20; count++) {
			expect(estimateContextWeights(empty, messages, undefined, cache)).toEqual(before);
		}
		expect(content).toHaveBeenCalledTimes(reads);
	});

	it("evicts a previously cached prefix when it becomes the final message", async () => {
		const cache = new WeakMap<object, ContextWeights>();
		const messages = readExchange("first", "original");
		messages.push({ role: "user", content: "Continue", timestamp: 1 });
		estimateContextWeights(empty, messages, undefined, cache);
		const final = messages[1];
		expect(cache.has(final)).toBe(true);
		messages.pop();
		estimateContextWeights(empty, messages, undefined, cache);
		await Promise.resolve();
		Object.assign(final, { content: [{ type: "text", text: "changed\n".repeat(1000) }] });
		messages.push({ role: "user", content: "Continue again", timestamp: 2 });
		expect(estimateContextWeights(empty, messages, undefined, cache)).toEqual(estimateContextWeights(empty, messages));
	});

	it.each([0, 1, 17, 99, 100, 251, 1000])(
		"reconciles categories to the authoritative total %i without negative values",
		(total) => {
			const weights = { ...empty, systemPrompt: 71.25, memoryFiles: 13.5, tools: 12.75, messages: 99.5 };
			const rows = reconcileContextCategories(weights, total);
			expect(rows.reduce((n, row) => n + row.tokens, 0)).toBe(total);
			expect(rows.every((row) => Number.isInteger(row.tokens) && row.tokens > 0)).toBe(true);
		},
	);

	it("puts unexplained usage in Other without inflating the known categories", () => {
		const rows = reconcileContextCategories({ ...empty, systemPrompt: 40, tools: 10 }, 100);
		expect(rows).toEqual([
			{ category: "systemPrompt", tokens: 40 },
			{ category: "tools", tokens: 10 },
			{ category: "other", tokens: 50 },
		]);
	});
});
