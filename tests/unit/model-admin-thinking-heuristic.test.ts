import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService } from "../../server/model-admin.js";

function stubModels(payload: unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("thinking 名字兜底（OpenAI 形状）", () => {
	it("id 含 thinking（忽略大小写）→ reasoning=true；其余字段不动", async () => {
		stubModels({
			data: [
				{ id: "claude-sonnet-4-5-thinking" },
				{ id: "gemini-3-flash" },
				{ id: "Qwen-Thinking-Large" },
				{ id: "plain-model", reasoning: true },
			],
		});
		const models = await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8045/v1");
		const byId = new Map(models.map((m) => [m.id, m]));
		expect(byId.get("claude-sonnet-4-5-thinking")?.reasoning).toBe(true);
		expect(byId.get("Qwen-Thinking-Large")?.reasoning).toBe(true);
		expect(byId.get("plain-model")?.reasoning).toBe(true);
		const flash = byId.get("gemini-3-flash");
		expect(flash?.reasoning).toBeUndefined();
		expect(flash?.input).toBeUndefined();
		expect(flash?.contextWindow).toBeUndefined();
		const thinking = byId.get("claude-sonnet-4-5-thinking");
		expect(thinking?.input).toBeUndefined();
		expect(thinking?.contextWindow).toBeUndefined();
	});
});

describe("thinking 名字兜底（Google 形状）", () => {
	it("models[].name 含 thinking → reasoning=true", async () => {
		stubModels({
			models: [
				{ name: "models/gemini-3-pro-thinking", displayName: "Pro Thinking" },
				{ name: "models/gemini-flash", displayName: "Flash" },
			],
		});
		const models = await ModelAdminService.probeModelsEndpoint(
			"http://127.0.0.1:8045",
			undefined,
			undefined,
			"google-generative-ai",
		);
		const byId = new Map(models.map((m) => [m.id, m]));
		expect(byId.get("gemini-3-pro-thinking")?.reasoning).toBe(true);
		expect(byId.get("gemini-flash")?.reasoning).toBeUndefined();
	});
});
