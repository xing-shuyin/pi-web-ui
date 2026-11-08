import { describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { makeCommunicateTool } from "../../server/communicate-tool.js";

function json(value: unknown): string {
	return JSON.stringify(value);
}

describe("communicate tool", () => {
	it("forwards structured requests and cancellation without binding a conversation holder", async () => {
		const communicate = vi.fn(async () => ({ requestId: "q", result: null }));
		const tool = makeCommunicateTool({ communicate });
		const signal = new AbortController().signal;
		const args = { to: "root", questions: [{ id: "q", question: "Choose?" }], timeoutSeconds: 0 };
		const result = await tool.execute("call", { action: "request", ...args }, signal, undefined, {} as any);
		expect(communicate).toHaveBeenCalledWith("request", args, signal);
		expect(result.details).toEqual({ requestId: "q", result: null });
	});

	it("keeps the exported schema flat: enum action, no nested question shapes, no bounds", () => {
		const tool = makeCommunicateTool({ communicate: vi.fn() });
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(tool.promptSnippet!.length).toBeLessThanOrEqual(80);
		const schema = tool.parameters as any;
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties).sort()).toEqual(["action", "message", "requestId", "timeoutSeconds", "to"]);
		expect(schema.properties.action.enum).toEqual(["read", "send", "request", "reply", "escalate"]);
		expect(schema.properties.action.anyOf).toBeUndefined();
		expect(schema.required).toEqual(["action"]);
		expect(json(schema)).not.toMatch(/"(anyOf|oneOf|allOf|minLength|minItems|maxItems|minimum|maximum)"/);
		expect(json(schema).length).toBeLessThan(600);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["primitive", "read"],
		["array", []],
		["missing action", {}],
		["unknown action", { action: "unknown" }],
		["non-string target", { action: "send", to: 1, message: "hello" }],
		["non-string message", { action: "send", to: "root", message: 1 }],
		["non-string request", { action: "reply", requestId: 1 }],
		["non-numeric timeout", { action: "request", to: "root", message: "q", timeoutSeconds: "1" }],
	])("rejects %s before dispatch, including direct execute calls", async (_label, params) => {
		const communicate = vi.fn(async () => ({ messages: [], remaining: 0 }));
		const tool = makeCommunicateTool({ communicate });
		await expect(tool.execute("call", params, undefined, undefined, {} as any)).rejects.toThrow(
			/^Invalid communicate arguments:/,
		);
		expect(communicate).not.toHaveBeenCalled();
	});

	it.each([
		["below range", -1, 0],
		["above range", 86401, 86400],
		["fractional", 12.6, 13],
	])("clamps timeoutSeconds (%s) in the handler instead of the schema", async (_label, given, expected) => {
		const communicate = vi.fn(async () => ({ requestId: "q", result: null }));
		const tool = makeCommunicateTool({ communicate });
		await tool.execute(
			"call",
			{ action: "escalate", requestId: "q", timeoutSeconds: given },
			undefined,
			undefined,
			{} as any,
		);
		expect(communicate).toHaveBeenCalledWith("escalate", { requestId: "q", timeoutSeconds: expected }, undefined);
	});

	it.each([
		{ action: "read" },
		{ action: "send", to: "parent", message: "hello" },
		{ action: "request", to: "root", message: "Choose?" },
		{
			action: "request",
			to: "root",
			message: "",
			questions: [{ id: "q", question: "Choose?" }],
			timeoutSeconds: 86400,
		},
		{
			action: "request",
			to: "root",
			questions: [
				{
					id: "q",
					question: "Choose?",
					options: [{ label: "A" }, { label: "B" }],
					dependsOn: { questionId: "first", value: ["A"] },
					optionsMap: { A: [{ label: "A" }, { label: "B" }] },
				},
			],
		},
		{ action: "reply", requestId: "q", message: "go with A" },
		{ action: "reply", requestId: "q", answers: [{ id: "q", selected: [], custom: "Other" }] },
		{ action: "escalate", requestId: "q" },
	])("dispatches valid $action arguments unchanged", async (params) => {
		const communicate = vi.fn(async () => ({ messages: [], remaining: 0 }));
		const tool = makeCommunicateTool({ communicate });
		await tool.execute("call", params, undefined, undefined, {} as any);
		const { action, ...args } = params;
		expect(communicate).toHaveBeenCalledWith(action, args, undefined);
	});

	it("keeps per-action requirements in the runtime state machine, not in the serialized schema", async () => {
		const communicate = vi.fn(async () => ({ messages: [], remaining: 0 }));
		const tool = makeCommunicateTool({ communicate });
		const declaration = JSON.parse(JSON.stringify(tool));
		expect(() =>
			validateToolArguments(declaration, {
				type: "toolCall",
				id: "call",
				name: "communicate",
				arguments: { action: "unknown" },
			}),
		).toThrow();
		const incomplete = validateToolArguments(declaration, {
			type: "toolCall",
			id: "call",
			name: "communicate",
			arguments: { action: "send", to: "root" },
		});
		await tool.execute("call", incomplete, undefined, undefined, {} as any);
		expect(communicate).toHaveBeenCalledWith("send", { to: "root" }, undefined);
		const valid = validateToolArguments(declaration, {
			type: "toolCall",
			id: "call",
			name: "communicate",
			arguments: { action: "send", to: "root", message: "hello" },
		});
		await tool.execute("call", valid, undefined, undefined, {} as any);
		expect(communicate).toHaveBeenCalledWith("send", { to: "root", message: "hello" }, undefined);
	});

	it("bounds adapter results before adding wire details", async () => {
		const tool = makeCommunicateTool({
			communicate: vi.fn(async () => ({
				requestId: "q",
				result: [{ id: "x", selected: [], custom: "x".repeat(50000) }],
			})),
		});
		await expect(
			tool.execute("call", { action: "escalate", requestId: "q" }, undefined, undefined, {} as any),
		).rejects.toThrow("byte limit");
	});
});
