import { describe, expect, it } from "vitest";
import {
	appendQuickAskQuestion,
	explainSelectionPrompt,
	readQuickAskResponse,
	translateSelectionPrompt,
	type QuickAskAttachment,
} from "../../web/src/quick-ask.js";

describe("quick ask stream reader", () => {
	const response = (text: string, byteSize = 1) => {
		const bytes = new TextEncoder().encode(text);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (let i = 0; i < bytes.length; i += byteSize) controller.enqueue(bytes.slice(i, i + byteSize));
					controller.close();
				},
			}),
			{ headers: { "Content-Type": "application/x-ndjson" } },
		);
	};
	it.each([1, 7, 65536])("decodes split UTF-8 and NDJSON frames with %i-byte chunks", async (size) => {
		const events = [
			{ type: "start", model: "test/model" },
			{ type: "delta", text: "中文🙂\n代码" },
			{ type: "done", model: "test/model", text: "中文🙂\n代码" },
		];
		const received: unknown[] = [];
		await readQuickAskResponse(response(events.map((event) => JSON.stringify(event)).join("\r\n"), size), (event) =>
			received.push(event),
		);
		expect(received).toEqual(events);
	});
	it("emits deltas before the response body closes", async () => {
		let writer!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				writer = controller;
			},
			cancel() {
				cancelled = true;
			},
		});
		const received: unknown[] = [];
		const reading = readQuickAskResponse(
			new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }),
			(event) => received.push(event),
		);
		const emit = (event: unknown) => writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
		emit({ type: "delta", text: "First" });
		await Promise.resolve();
		await Promise.resolve();
		expect(received).toEqual([{ type: "delta", text: "First" }]);
		emit({ type: "done", text: "First answer", model: "test/model" });
		await reading;
		expect(cancelled).toBe(true);
	});
	it("retains delivered text when a later frame reports a provider error", async () => {
		const received: unknown[] = [];
		await expect(
			readQuickAskResponse(
				response('{"type":"delta","text":"Partial"}\n{"type":"error","error":"Disconnected"}\n'),
				(event) => received.push(event),
			),
		).rejects.toThrow("Disconnected");
		expect(received).toEqual([{ type: "delta", text: "Partial" }]);
	});
	it.each([
		'{"type":"delta","text":"Partial"}\n',
		'{"type":"done","text":"","model":"test/model"}\n',
		'{"type":"delta","text":3}\n',
		"null\n",
	])("rejects incomplete or malformed streams: %s", async (text) => {
		await expect(readQuickAskResponse(response(text), () => {})).rejects.toThrow();
	});
	it("supports JSON responses from older servers and HTTP error responses", async () => {
		const received: unknown[] = [];
		await readQuickAskResponse(Response.json({ text: "Answer", model: "test/model" }), (event) => received.push(event));
		expect(received).toEqual([{ type: "done", text: "Answer", model: "test/model" }]);
		await expect(readQuickAskResponse(Response.json({ error: "No model" }, { status: 400 }), () => {})).rejects.toThrow(
			"No model",
		);
	});
});

describe("quick ask explanation template", () => {
	it("inserts the selected text literally without treating dollar sequences as replacements", () => {
		const selection = "price=$&; {{input}}; $` $'";
		expect(explainSelectionPrompt(undefined, selection)).toBe(`解释下: ${selection}`);
		expect(explainSelectionPrompt("Explain {{input}} / {{input}}", selection)).toBe(
			`Explain ${selection} / ${selection}`,
		);
	});

	it("restores the default for a blank template", () => {
		expect(explainSelectionPrompt("   ", "text")).toBe("解释下: text");
	});
});

describe("quick ask translation requests", () => {
	it("uses the interface language for automatic translation and preserves literal selection placeholders", () => {
		const input = "price=$&; {{targetLanguage}}; {{input}}; $` $'";
		const prompt = translateSelectionPrompt(
			{
				quickAskTranslatePrompt: "Translate into {{targetLanguage}}: {{input}}",
				quickAskTranslateTarget: "auto",
				quickAskTranslateStyle: "natural",
			},
			input,
			"zh-TW",
		);
		expect(prompt).toContain(`Translate into Traditional Chinese: ${input}`);
		expect(prompt).toContain("natural, fluent");
	});
	it("allows a result-card language override without changing saved preferences", () => {
		const settings = {
			quickAskTranslatePrompt: "{{input}} → {{targetLanguage}}",
			quickAskTranslateTarget: "en" as const,
			quickAskTranslateStyle: "technical" as const,
		};
		expect(translateSelectionPrompt(settings, "CLI", "zh", "ja")).toContain("CLI → Japanese");
		expect(translateSelectionPrompt(settings, "CLI", "zh", "ja")).toContain("precise technical terminology");
		expect(settings.quickAskTranslateTarget).toBe("en");
	});
});

describe("quick ask immutable reference turns", () => {
	const reference: QuickAskAttachment = {
		id: "file:readme",
		kind: "file",
		name: "README.md",
		content: "Original file snapshot",
	};
	it("sends unchanged references only once while keeping the original user turn snapshot", () => {
		const first = appendQuickAskQuestion([], "Read this", [reference]);
		const history = [...first, { role: "assistant" as const, content: "First answer" }];
		const follow = appendQuickAskQuestion(history, "Explain more", [{ ...reference }]);
		expect(follow.at(-1)?.attachments).toBeUndefined();
		expect(follow[0].attachments).toEqual([reference]);
		expect(history).toHaveLength(2);
	});
	it("keeps revised file contents separate instead of rewriting earlier context", () => {
		const history = [
			{ role: "user" as const, content: "First", attachments: [reference] },
			{ role: "assistant" as const, content: "Answer" },
		];
		const changed = { ...reference, content: "Updated file snapshot" };
		const follow = appendQuickAskQuestion(history, "Review the update", [changed]);
		expect(follow.at(-1)?.attachments).toEqual([changed]);
		expect(follow[0].attachments?.[0].content).toBe("Original file snapshot");
	});
});

describe("quick ask follow-ups after an interrupted turn", () => {
	it("keeps completed turns and replaces the unanswered question without mutating existing history", () => {
		const messages = [
			{ role: "user" as const, content: "first question" },
			{ role: "assistant" as const, content: "first answer" },
			{ role: "user" as const, content: "cancelled question" },
		];
		const next = appendQuickAskQuestion(messages, "revised question");
		expect(next).toEqual([...messages.slice(0, -1), { role: "user", content: "revised question" }]);
		expect(messages.at(-1)?.content).toBe("cancelled question");
	});

	it("adds follow-up questions after completed answers", () => {
		const messages = [{ role: "assistant" as const, content: "answer" }];
		expect(appendQuickAskQuestion(messages, "follow-up")).toEqual([
			...messages,
			{ role: "user", content: "follow-up" },
		]);
	});
});
