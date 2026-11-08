import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertTools as convertGoogleTools } from "@earendil-works/pi-ai/api/google-shared";
import { makeCommunicateTool } from "../../server/communicate-tool.js";

const baseModel = {
	id: "communicate-schema-test",
	name: "Communicate schema test",
	provider: "mock",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 128,
} as const;

function expectObjectSchema(schema: any) {
	expect(schema.type).toBe("object");
	expect(schema.anyOf).toBeUndefined();
	expect(schema.required).toContain("action");
	expect(Object.keys(schema.properties).sort()).toEqual(["action", "message", "requestId", "timeoutSeconds", "to"]);
	expect(schema.properties.action.enum).toEqual(["read", "send", "request", "reply", "escalate"]);
	expect(JSON.stringify(schema)).not.toMatch(/"(anyOf|minLength|minItems|maxItems|minimum|maximum)"/);
}

describe("communicate provider schema", () => {
	it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
		"sends a usable object through the SDK %s HTTP path",
		async (api) => {
			const received: { path: string; body: any }[] = [];
			const server = createServer(async (req, res) => {
				const chunks = [];
				for await (const chunk of req) chunks.push(chunk);
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				received.push({ path: new URL(req.url!, "http://localhost").pathname, body });
				const schema =
					req.url === "/v1/chat/completions"
						? body.tools[0].function.parameters
						: req.url === "/v1/responses"
							? body.tools[0].parameters
							: body.tools[0].input_schema;
				if (schema.type !== "object" || !schema.properties?.action) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								message: "communicate parameters must be an object with action properties",
								type: "invalid_request_error",
							},
						}),
					);
					return;
				}
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				if (req.url === "/v1/chat/completions") {
					res.end(
						`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: baseModel.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					);
				} else if (req.url === "/v1/responses") {
					res.end(
						`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "mock", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
					);
				} else {
					res.end(
						`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "mock", type: "message", role: "assistant", model: baseModel.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
					);
				}
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const tool = makeCommunicateTool({ communicate: vi.fn() });
			const context = normalizeContext({
				messages: [{ role: "user", content: "Read inbox", timestamp: 0 }],
				tools: [tool],
			});
			const options = { apiKey: "mock-key", maxTokens: 32, maxRetries: 0, signal: AbortSignal.timeout(10000) };
			try {
				const result =
					api === "openai-completions"
						? await streamCompletions(
								{ ...baseModel, input: ["text"], api, baseUrl: `${baseUrl}/v1` } satisfies Model<"openai-completions">,
								context,
								options,
							).result()
						: api === "openai-responses"
							? await streamResponses(
									{ ...baseModel, input: ["text"], api, baseUrl: `${baseUrl}/v1` } satisfies Model<"openai-responses">,
									context,
									options,
								).result()
							: await streamAnthropic(
									{ ...baseModel, input: ["text"], api, baseUrl } satisfies Model<"anthropic-messages">,
									context,
									options,
								).result();
				expect(received).toHaveLength(1);
				const { path, body } = received[0];
				expect(path).toBe(
					api === "openai-completions"
						? "/v1/chat/completions"
						: api === "openai-responses"
							? "/v1/responses"
							: "/v1/messages",
				);
				expectObjectSchema(
					api === "openai-completions"
						? body.tools[0].function.parameters
						: api === "openai-responses"
							? body.tools[0].parameters
							: body.tools[0].input_schema,
				);
				expect(result.errorMessage).toBeUndefined();
				expect(result.stopReason).toBe("stop");
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
		20000,
	);

	it.each([false, true])("preserves fields in Google's converted schema (legacy parameters: %s)", (legacy) => {
		const tool = makeCommunicateTool({ communicate: vi.fn() });
		const declaration = convertGoogleTools([tool], legacy)![0].functionDeclarations![0];
		expectObjectSchema(legacy ? declaration.parameters : declaration.parametersJsonSchema);
	});
});
